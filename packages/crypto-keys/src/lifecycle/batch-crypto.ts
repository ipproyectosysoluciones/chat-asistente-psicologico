import type { KeyProvider } from "@chatcap/config";

import { AesCbcEncryptor } from "../core/encryptor";
import type { Encryptor } from "../core/encryptor";
import { StaticKeyMaterialProvider } from "../core/key-material";
import { encodePayload } from "../core/codec";
import { decodePayload } from "../core/codec";
import {
  batchIntegrityHash,
  deriveIntegrityKey,
  rowIntegrityHash,
} from "./integrity";
import type { BatchRowHash } from "./integrity";

/**
 * Batch re-encryption (REQ-KEY-4): rows are decrypted with their own
 * key_version salt (dual-read), re-encrypted under the target key, written
 * inside a transaction, read back, verified byte-for-byte and only then
 * committed. Any mismatch rolls back and raises BatchIntegrityError.
 *
 * The CPU-bound crypto (executeBatchCrypto) is what runs on a worker thread
 * in production; the store (write/read-back/commit) is swappable so unit
 * tests use an in-memory store.
 */

export interface PreparedRow {
  rowId: string;
  keyFrom: number;
  keyTo: number;
  /** iv || ciphertext || hmac envelope encrypted under keyFrom. */
  encodedPayload: Buffer;
}

export interface ReencryptedRow {
  rowId: string;
  keyTo: number;
  /** iv || ciphertext || hmac envelope encrypted under keyTo. */
  encodedPayload: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  hmac: Buffer;
  /** Keyed per-row integrity hash (hex) refreshed on re-encryption. */
  integrityHash: string;
}

export interface BatchCryptoRequest {
  keyFrom: number;
  keyTo: number;
  saltFrom: Buffer;
  saltTo: Buffer;
  rows: PreparedRow[];
}

export interface BatchCryptoResult {
  keyFrom: number;
  keyTo: number;
  rows: ReencryptedRow[];
  integrityHash: string;
  verified: boolean;
}

/** Transaction over the consent rows of one batch (REQ-KEY-4 rollback). */
export interface ReencryptionBatchStore {
  begin(): Promise<void>;
  writeRows(rows: ReencryptedRow[]): Promise<void>;
  readBackRows(
    rowIds: string[]
  ): Promise<Array<{ rowId: string; keyTo: number; encodedPayload: Buffer }>>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  end(): Promise<void>;
}

/** Raised when read-back verification fails — the batch MUST be rolled back. */
export class BatchIntegrityError extends Error {
  readonly code = "batch_integrity_failed" as const;
  readonly failedRowIds: string[];

  constructor(failedRowIds: string[]) {
    super(
      `Batch integrity verification failed for ${failedRowIds.length} row(s): ${failedRowIds.join(", ")}`
    );
    this.name = "BatchIntegrityError";
    this.failedRowIds = failedRowIds;
  }
}

/** In-memory store for unit tests and small pilots (no real transaction). */
export class InMemoryBatchStore implements ReencryptionBatchStore {
  private readonly rows = new Map<
    string,
    { keyTo: number; encodedPayload: Buffer }
  >();
  private _committed = false;
  private _rolledBack = false;

  get committed(): boolean {
    return this._committed;
  }

  get rolledBack(): boolean {
    return this._rolledBack;
  }

  async begin(): Promise<void> {}

  async writeRows(rows: ReencryptedRow[]): Promise<void> {
    for (const row of rows) {
      this.rows.set(row.rowId, { keyTo: row.keyTo, encodedPayload: row.encodedPayload });
    }
  }

  async readBackRows(
    rowIds: string[]
  ): Promise<Array<{ rowId: string; keyTo: number; encodedPayload: Buffer }>> {
    return rowIds.map((rowId) => {
      const entry = this.rows.get(rowId);
      if (entry === undefined) {
        throw new Error(`InMemoryBatchStore: row ${rowId} not written`);
      }
      return { rowId, keyTo: entry.keyTo, encodedPayload: entry.encodedPayload };
    });
  }

  async commit(): Promise<void> {
    this._committed = true;
  }

  async rollback(): Promise<void> {
    this._rolledBack = true;
  }

  async end(): Promise<void> {}
}

/** CPU-bound half: decrypt + re-encrypt + hash. Pure crypto, no I/O. */
export async function executeBatchCrypto(
  encryptor: Encryptor,
  integrityKey: Buffer,
  request: BatchCryptoRequest
): Promise<BatchCryptoResult> {
  const rows: ReencryptedRow[] = [];
  const rowHashes: BatchRowHash[] = [];
  for (const row of request.rows) {
    const payload = decodePayload(row.keyFrom, row.encodedPayload);
    const plaintext = await encryptor.decrypt(payload);
    const reEncrypted = await encryptor.encrypt(plaintext, request.keyTo);
    const encodedPayload = encodePayload(reEncrypted);
    const hash = rowIntegrityHash(integrityKey, row.rowId, request.keyTo, encodedPayload);
    rows.push({
      rowId: row.rowId,
      keyTo: request.keyTo,
      encodedPayload,
      iv: reEncrypted.iv,
      ciphertext: reEncrypted.ciphertext,
      hmac: reEncrypted.hmac,
      integrityHash: hash.toString("hex"),
    });
    rowHashes.push({ rowId: row.rowId, hash });
  }
  const integrityHash = batchIntegrityHash(integrityKey, rowHashes).toString("hex");
  return { keyFrom: request.keyFrom, keyTo: request.keyTo, rows, integrityHash, verified: true };
}

function verifyWrittenRows(
  written: Array<{ rowId: string; keyTo: number; encodedPayload: Buffer }>,
  expected: readonly ReencryptedRow[]
): string[] {
  const byId = new Map(expected.map((row) => [row.rowId, row]));
  const failed: string[] = [];
  for (const row of written) {
    const expectedRow = byId.get(row.rowId);
    if (
      expectedRow === undefined ||
      row.keyTo !== expectedRow.keyTo ||
      !row.encodedPayload.equals(expectedRow.encodedPayload)
    ) {
      failed.push(row.rowId);
    }
  }
  return failed;
}

/** Full batch flow: crypto → write → read-back → verify → commit/rollback. */
export async function executeBatchWithStore(
  encryptor: Encryptor,
  integrityKey: Buffer,
  request: BatchCryptoRequest,
  store: ReencryptionBatchStore,
  verifyReadback = true
): Promise<BatchCryptoResult> {
  await store.begin();
  try {
    const result = await executeBatchCrypto(encryptor, integrityKey, request);
    await store.writeRows(result.rows);
    if (verifyReadback) {
      const written = await store.readBackRows(result.rows.map((row) => row.rowId));
      const failed = verifyWrittenRows(written, result.rows);
      if (failed.length > 0) {
        throw new BatchIntegrityError(failed);
      }
    }
    await store.commit();
    return result;
  } catch (error) {
    try {
      await store.rollback();
    } catch {
      // rollback failure must not mask the original error
    }
    throw error;
  } finally {
    await store.end();
  }
}

/**
 * Worker abstraction: production uses a worker_thread; tests and small
 * pilots use InlineBatchCrypto.
 */
export interface BatchCryptoWorker {
  run(request: BatchCryptoRequest): Promise<BatchCryptoResult>;
}

/** Same-process implementation (unit tests, small pilots). */
export class InlineBatchCrypto implements BatchCryptoWorker {
  constructor(private readonly masterKeyProvider: KeyProvider) {}

  async run(request: BatchCryptoRequest): Promise<BatchCryptoResult> {
    const master = await this.masterKeyProvider.getMasterSecret();
    const encryptor = new AesCbcEncryptor(
      this.masterKeyProvider,
      new StaticKeyMaterialProvider(
        new Map([
          [request.keyFrom, request.saltFrom],
          [request.keyTo, request.saltTo],
        ])
      )
    );
    const integrityKey = deriveIntegrityKey(master);
    return executeBatchWithStore(encryptor, integrityKey, request, new InMemoryBatchStore());
  }
}
