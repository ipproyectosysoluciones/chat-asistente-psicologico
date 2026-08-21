import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AesCbcEncryptor } from "../src/core/encryptor";
import { StaticKeyMaterialProvider } from "../src/core/key-material";
import {
  BatchIntegrityError,
  InMemoryBatchStore,
  InlineBatchCrypto,
  executeBatchCrypto,
  executeBatchWithStore,
} from "../src/lifecycle/batch-crypto";
import type { ReencryptionBatchStore } from "../src/lifecycle/batch-crypto";
import type { BatchCryptoRequest, PreparedRow } from "../src/lifecycle/batch-crypto";
import { deriveIntegrityKey, batchIntegrityHash } from "../src/lifecycle/integrity";
import { TEST_MASTER, staticMasterKeyProvider } from "./helpers";

const SALT_1 = randomBytes(32);
const SALT_2 = randomBytes(32);

function encryptorFor(salts: ReadonlyMap<number, Buffer>): AesCbcEncryptor {
  return new AesCbcEncryptor(
    staticMasterKeyProvider(),
    new StaticKeyMaterialProvider(salts)
  );
}

/** Pre-encrypts `count` rows under key 1 and returns them as a request. */
async function makeRequest(
  count: number
): Promise<{ request: BatchCryptoRequest; plaintexts: Buffer[] }> {
  const plaintexts = Array.from({ length: count }, (_, i) =>
    Buffer.from(`consent-${i}-${randomBytes(8).toString("hex")}`)
  );
  const encryptor = encryptorFor(new Map([[1, SALT_1]]));
  const rows: PreparedRow[] = [];
  for (let i = 0; i < count; i++) {
    const payload = await encryptor.encrypt(plaintexts[i]!, 1);
    const { iv, ciphertext, hmac } = payload;
    rows.push({
      rowId: `row-${i}`,
      keyFrom: 1,
      keyTo: 2,
      encodedPayload: Buffer.concat([iv, ciphertext, hmac]),
    });
  }
  return {
    request: {
      keyFrom: 1,
      keyTo: 2,
      saltFrom: SALT_1,
      saltTo: SALT_2,
      rows,
    },
    plaintexts,
  };
}

describe("executeBatchCrypto (REQ-KEY-4)", () => {
  it("re-encrypts every row from key 1 to key 2 preserving plaintext", async () => {
    const { request, plaintexts } = await makeRequest(3);
    const encryptor = encryptorFor(new Map([[1, SALT_1], [2, SALT_2]]));
    const integrityKey = deriveIntegrityKey(TEST_MASTER);

    const result = await executeBatchCrypto(encryptor, integrityKey, request);

    expect(result.rows).toHaveLength(3);
    const decryptor = encryptorFor(new Map([[2, SALT_2]]));
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i]!;
      expect(row.keyTo).toBe(2);
      const { iv, ciphertext, hmac } = row;
      const plaintext = await decryptor.decrypt({ keyVersion: 2, iv, ciphertext, hmac });
      expect(plaintext.equals(plaintexts[i]!)).toBe(true);
    }
    expect(result.integrityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.verified).toBe(true);
  });

  it("old key 1 can no longer decrypt after migration to key 2", async () => {
    const { request } = await makeRequest(1);
    const encryptor = encryptorFor(new Map([[1, SALT_1], [2, SALT_2]]));
    const result = await executeBatchCrypto(
      encryptor,
      deriveIntegrityKey(TEST_MASTER),
      request
    );
    const row = result.rows[0]!;
    const oldDecryptor = encryptorFor(new Map([[1, SALT_1]]));
    await expect(
      oldDecryptor.decrypt({
        keyVersion: 2,
        iv: row.iv,
        ciphertext: row.ciphertext,
        hmac: row.hmac,
      })
    ).rejects.toThrow();
  });

  it("an empty batch yields a deterministic empty-batch hash", async () => {
    const result = await executeBatchCrypto(
      encryptorFor(new Map([[1, SALT_1], [2, SALT_2]])),
      deriveIntegrityKey(TEST_MASTER),
      { keyFrom: 1, keyTo: 2, saltFrom: SALT_1, saltTo: SALT_2, rows: [] }
    );
    expect(result.rows).toHaveLength(0);
    expect(result.integrityHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** Store that silently corrupts one written row on read-back. */
class CorruptingStore implements ReencryptionBatchStore {
  private written = new Map<string, { keyTo: number; payload: Buffer }>();
  private rolledBack = false;
  private committed = false;

  get didRollback(): boolean {
    return this.rolledBack;
  }

  get didCommit(): boolean {
    return this.committed;
  }

  async begin(): Promise<void> {}

  async writeRows(rows: { rowId: string; keyTo: number; encodedPayload: Buffer }[]): Promise<void> {
    for (const row of rows) {
      const payload = row.rowId === "row-0"
        ? Buffer.from([...row.encodedPayload].map((b, i) => (i === 5 ? b ^ 0xff : b)))
        : row.encodedPayload;
      this.written.set(row.rowId, { keyTo: row.keyTo, payload });
    }
  }

  async readBackRows(rowIds: string[]): Promise<
    { rowId: string; keyTo: number; encodedPayload: Buffer }[]
  > {
    return rowIds.map((id) => {
      const entry = this.written.get(id)!;
      return { rowId: id, keyTo: entry!.keyTo, encodedPayload: entry!.payload };
    });
  }

  async commit(): Promise<void> {
    this.committed = true;
  }

  async rollback(): Promise<void> {
    this.rolledBack = true;
  }

  async end(): Promise<void> {}
}

describe("executeBatchWithStore (REQ-KEY-4: write → read-back → verify → commit/rollback)", () => {
  it("commits the transaction after verified read-back", async () => {
    const { request } = await makeRequest(3);
    const store = new InMemoryBatchStore();
    const result = await executeBatchWithStore(
      encryptorFor(new Map([[1, SALT_1], [2, SALT_2]])),
      deriveIntegrityKey(TEST_MASTER),
      request,
      store
    );
    expect(result.rows).toHaveLength(3);
    expect(store.committed).toBe(true);
    expect(store.rolledBack).toBe(false);
  });

  it("rolls back and raises BatchIntegrityError when read-back does not match", async () => {
    const { request } = await makeRequest(2);
    const store = new CorruptingStore();
    const promise = executeBatchWithStore(
      encryptorFor(new Map([[1, SALT_1], [2, SALT_2]])),
      deriveIntegrityKey(TEST_MASTER),
      request,
      store
    );
    await expect(promise).rejects.toBeInstanceOf(BatchIntegrityError);
    expect(store.didRollback).toBe(true);
    expect(store.didCommit).toBe(false);
  });

  it("rolls back when a row fails to decrypt (tampered source data)", async () => {
    const { request } = await makeRequest(1);
    const tampered = { ...request, rows: [{ ...request.rows[0]! }] };
    tampered.rows[0] = {
      ...tampered.rows[0]!,
      encodedPayload: Buffer.from([...tampered.rows[0]!.encodedPayload].map((b, i) => (i === 0 ? b ^ 0x01 : b))),
    };
    const store = new InMemoryBatchStore();
    await expect(
      executeBatchWithStore(
        encryptorFor(new Map([[1, SALT_1], [2, SALT_2]])),
        deriveIntegrityKey(TEST_MASTER),
        tampered,
        store
      )
    ).rejects.toThrow();
    expect(store.rolledBack).toBe(true);
    expect(store.committed).toBe(false);
  });

  it("InlineBatchCrypto produces a verified result usable by the coordinator", async () => {
    const { request, plaintexts } = await makeRequest(2);
    const worker = new InlineBatchCrypto(staticMasterKeyProvider());
    const result = await worker.run(request);

    expect(result.verified).toBe(true);
    const decryptor = encryptorFor(new Map([[2, SALT_2]]));
    for (let i = 0; i < 2; i++) {
      const row = result.rows[i]!;
      const { iv, ciphertext, hmac } = row;
      const plaintext = await decryptor.decrypt({ keyVersion: 2, iv, ciphertext, hmac });
      expect(plaintext.equals(plaintexts[i]!)).toBe(true);
    }
    // Batch hash must be recomputable from the emitted rows (verification contract)
    const integrityKey = deriveIntegrityKey(TEST_MASTER);
    const recomputed = batchIntegrityHash(
      integrityKey,
      result.rows.map((row) => ({
        rowId: row.rowId,
        hash: Buffer.from(row.integrityHash, "hex"),
      }))
    );
    expect(recomputed.toString("hex")).toBe(result.integrityHash);
  });
});
