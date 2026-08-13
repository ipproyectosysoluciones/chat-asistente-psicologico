import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import { runMigrations } from "../src/migrate";
import { upsertSession, setSessionPersistence, getSession, setSessionConsentState, setSessionAiState } from "../src/repositories/sessions";
import {
  createConsentRecord,
  findActiveConsentBySession,
  deactivateConsent,
} from "../src/repositories/consent";
import {
  createAlert,
  findAlertById,
  findOpenAlertByDedupeKey,
  acknowledgeAlert,
  resolveAlert,
  touchAlert,
} from "../src/repositories/alerts";
import { insertAuditEntry, listAuditByResource } from "../src/repositories/audit";
import {
  createNextKeyVersion,
  currentActiveKeyVersion,
  retireKeyVersion,
} from "../src/repositories/key-versions";
import { searchVectorChunks, EF_SEARCH } from "../src/repositories/chunks";
import {
  createReEncryptionBatch,
  claimNextPendingBatch,
  completeBatch,
  rollbackBatch,
} from "../src/repositories/reencryption";
import { purgeAnonymousSessions } from "../src/repositories/purge";
import { findUserRole } from "../src/repositories/users";

const execFileAsync = promisify(execFile);

/**
 * Repository integration suite (task 1.6 AC) against a real pgvector
 * container. Gated behind RUN_PG_INTEGRATION=1.
 */
const RUN_INTEGRATION = process.env.RUN_PG_INTEGRATION === "1";
const run = RUN_INTEGRATION ? describe : describe.skip;

const CONTAINER_PREFIX = "chatcap-pg-repos-";
// Distinct port band from the migrations integration file (55432 + pid % 1000).
const port = 56432 + (process.pid % 700);
const databaseUrl = `postgres://chatcap:chatcap_test@127.0.0.1:${port}/chatcap_test`;
const containerName = `${CONTAINER_PREFIX}${process.pid}-${Date.now()}`;

async function dockerRun(args: string[]): Promise<void> {
  await execFileAsync("docker", args, { timeout: 120_000 });
}

async function waitForPg(attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const { stdout } = await execFileAsync("docker", [
        "exec", containerName, "pg_isready", "-U", "chatcap", "-d", "chatcap_test",
      ]);
      if (stdout.includes("accepting connections")) {
        return;
      }
    } catch {
      // container still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("pg container not ready");
}

run("repositories vs test PG", () => {
  let pool: Pool;

  beforeAll(async () => {
    await dockerRun([
      "run", "-d", "--name", containerName,
      "-e", "POSTGRES_USER=chatcap",
      "-e", "POSTGRES_PASSWORD=chatcap_test",
      "-e", "POSTGRES_DB=chatcap_test",
      "-p", `127.0.0.1:${port}:5432`,
      "pgvector/pgvector:pg16",
    ]);
    await waitForPg();
    await runMigrations({ databaseUrl, direction: "up" });
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    try {
      await dockerRun(["rm", "-f", containerName]);
    } catch {
      // best-effort cleanup
    }
  });

  it("sessions: find-or-create + dual persistence switch", async () => {
    const first = await upsertSession(pool, { contactKeyAnon: "anon-key-sess-1", jurisdiction: "AR" });
    const second = await upsertSession(pool, { contactKeyAnon: "anon-key-sess-1" });
    expect(second.id).toBe(first.id);

    const asHc = await setSessionPersistence(pool, first.id, "hc");
    expect(asHc.purgeAt).toBeUndefined();
    const asAnon = await setSessionPersistence(pool, first.id, "anonymous");
    expect(asAnon.purgeAt).toBeDefined();
    await expect(getSession(pool, first.id)).resolves.toMatchObject({ id: first.id });
  });

  it("sessions: ai_state takeover round-trip (REQ-ALERT-4)", async () => {
    const session = await upsertSession(pool, { contactKeyAnon: "anon-key-ai-1", jurisdiction: "CO" });
    expect(session.aiState).toBe("auto");
    const forced = await setSessionAiState(pool, session.id, "takeover");
    expect(forced.aiState).toBe("takeover");
    await expect(getSession(pool, session.id)).resolves.toMatchObject({
      aiState: "takeover",
    });
  });

  it("consent: create, find active by session, deactivate (REQ-CONSENT-4)", async () => {
    const session = await upsertSession(pool, { contactKeyAnon: "anon-key-consent-1", jurisdiction: "AR" });
    const created = await createConsentRecord(pool, {
      sessionId: session.id,
      jurisdiction: "AR",
      termsVersion: 1,
      keyVersion: 1,
      encryptedPayload: Buffer.from("cipher-bytes"),
      integrityHash: "hmac-1",
    });
    const found = await findActiveConsentBySession(pool, session.id);
    expect(found?.id).toBe(created.id);
    expect(found?.keyVersion).toBe(1);

    await deactivateConsent(pool, created.id);
    await expect(findActiveConsentBySession(pool, session.id)).resolves.toBeUndefined();
  });

  it("consent e2e: registry row + session consent_state + QR chain (REQ-CONSENT-2/3/4, REQ-KEY-7)", async () => {
    const session = await upsertSession(pool, { contactKeyAnon: "anon-key-consent-e2e", jurisdiction: "MX" });

    const created = await createConsentRecord(pool, {
      sessionId: session.id,
      jurisdiction: "MX",
      termsVersion: 1,
      keyVersion: 2,
      encryptedPayload: Buffer.from("aes-ciphertext"),
      integrityHash: "a".repeat(64),
    });
    await setSessionConsentState(pool, session.id, "accepted");

    await pool.query(
      `INSERT INTO qr_signatures (consent_id, key_version, signature, status, payload, issued_at)
       VALUES ($1, $2, $3, 'active', $4::jsonb, $5);`,
      [
        created.id,
        2,
        "sig-1",
        JSON.stringify({ v: 1, consent_id: created.id, terms_version: 1, key_version: 2, iat: 1723230000 }),
        1723230000,
      ]
    );

    const rows = await pool.query<{
      consent_id: string;
      payload: Record<string, unknown>;
      issued_at: number;
    }>(
      `SELECT consent_id, payload, issued_at
         FROM qr_signatures
        WHERE consent_id = $1 AND status = 'active';`,
      [created.id]
    );
    expect(rows.rows[0]?.consent_id).toBe(created.id);
    expect(rows.rows[0]?.payload).toMatchObject({
      v: 1,
      consent_id: created.id,
      terms_version: 1,
      key_version: 2,
      iat: 1723230000,
    });
    // node-postgres returns BIGINT as a string; the QR chain round-trips it.
    expect(rows.rows[0]?.issued_at).toBe("1723230000");

    const sessionAfter = await getSession(pool, session.id);
    expect(sessionAfter?.consentState).toBe("accepted");
  });

  it("alerts: one-open-alert lifecycle per dedupe key (REQ-ALERT-5/6)", async () => {
    const session = await upsertSession(pool, { contactKeyAnon: "anon-key-alert-1", jurisdiction: "AR" });
    // acknowledged_by references users(id) — seed a supervisor user.
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role)
       VALUES ('00000000-0000-7000-8000-0000000000aa', 'supervisor@test.local', 'hash-test', 'supervisor');`
    );
    const alert = await createAlert(pool, {
      level: "red", category: "suicide", sessionId: session.id, dedupeKey: "dedupe-1",
    });
    const open = await findOpenAlertByDedupeKey(pool, "dedupe-1");
    expect(open?.id).toBe(alert.id);

    await acknowledgeAlert(pool, alert.id, "00000000-0000-7000-8000-0000000000aa");
    await expect(findOpenAlertByDedupeKey(pool, "dedupe-1")).resolves.toBeUndefined();
    await resolveAlert(pool, alert.id);

    const reopened = await createAlert(pool, {
      level: "orange", category: "suicide", sessionId: session.id, dedupeKey: "dedupe-1",
    });
    const afterReopen = await findOpenAlertByDedupeKey(pool, "dedupe-1");
    expect(afterReopen?.id).toBe(reopened.id);
    expect(afterReopen?.level).toBe("orange");
  });

  it("alerts: follow-up touch bumps updated_at; duplicate open insert rejected (REQ-ALERT-5)", async () => {
    const session = await upsertSession(pool, { contactKeyAnon: "anon-key-alert-touch", jurisdiction: "AR" });
    const alert = await createAlert(pool, {
      level: "red", category: "suicide", sessionId: session.id, dedupeKey: "dedupe-touch-1",
    });

    const before = await findAlertById(pool, alert.id);
    expect(before?.status).toBe("open");

    await new Promise((resolve) => setTimeout(resolve, 20));
    await touchAlert(pool, alert.id);
    const after = await findAlertById(pool, alert.id);
    expect(after?.id).toBe(alert.id);
    expect(after?.status).toBe("open");
    expect(new Date(after?.updatedAt ?? "").getTime()).toBeGreaterThan(
      new Date(before?.updatedAt ?? "").getTime()
    );

    // DB-level one-open guarantee: a second open INSERT for the same dedupe
    // key is rejected by the partial unique index, not silently duplicated.
    await expect(
      createAlert(pool, {
        level: "red", category: "suicide", sessionId: session.id, dedupeKey: "dedupe-touch-1",
      })
    ).rejects.toThrow(/duplicate key/i);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM alerts WHERE dedupe_key = 'dedupe-touch-1' AND status = 'open';`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(alert.id);
  });

  it("audit: insert + query by resource, meta preserved (REQ-DASH-8)", async () => {
    const entry = await insertAuditEntry(pool, {
      actorType: "supervisor",
      actorId: "00000000-0000-7000-8000-0000000000bb",
      action: "key_access",
      resourceType: "key_version",
      resourceId: "1",
      reason: "rotation audit",
      meta: { keyVersion: 1, outcome: "ok" },
    });
    const listed = await listAuditByResource(pool, "key_version", "1");
    expect(listed[0]?.id).toBe(entry.id);
    expect(listed[0]?.meta).toEqual({ keyVersion: 1, outcome: "ok" });
    expect(listed[0]?.actorType).toBe("supervisor");
  });

  it("key versions: next = max+1, current active, retire (REQ-KEY-1/8)", async () => {
    const v1 = await createNextKeyVersion(pool, {
      salt: "salt-v1", expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    expect(v1.keyVersion).toBe(1);
    const current = await currentActiveKeyVersion(pool);
    expect(current?.keyVersion).toBe(1);

    await retireKeyVersion(pool, 1);
    await expect(currentActiveKeyVersion(pool)).resolves.toBeUndefined();

    const v2 = await createNextKeyVersion(pool, {
      salt: "salt-v2", expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    expect(v2.keyVersion).toBe(2);
  });

  it("chunks: parameterized vector search with metadata + ef_search=40 (REQ-RAG-2/3)", async () => {
    const client: PoolClient = await pool.connect();
    try {
      const embedding = Array(1536).fill(1); // non-zero: cosine=1 against itself
      const vectorLiteral = `[${embedding.join(",")}]`;
      const docId = "00000000-0000-7000-8000-00000000000c";
      await client.query(
        `INSERT INTO documents (id, title, source_url, source_type, language, legal_framework, status)
         VALUES ($1, 'crisis guide', 'https://example.test/crisis', 'manual', 'es', 'AR', 'vectorized');`,
        [docId]
      );
      await client.query(
        `INSERT INTO vector_chunks (id, doc_id, chunk_index, content, embedding, category, source, language, legal_framework)
         VALUES ($1, $2, 0, 'pensamientos de crisis', $3::vector, 'crisis', 'guide-a', 'es', 'AR'),
                ($4, $2, 1, 'tecnicas de respiracion', $3::vector, 'wellness', 'guide-a', 'es', 'AR');`,
        [
          "00000000-0000-7000-8000-00000000000d",
          docId,
          vectorLiteral,
          "00000000-0000-7000-8000-00000000000e",
        ]
      );

      const hits = await searchVectorChunks(client, embedding, {
        categories: ["crisis"],
        language: "es",
        legalFramework: "AR",
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.content).toBe("pensamientos de crisis");
      expect(hits[0]?.category).toBe("crisis");
      expect(hits[0]?.language).toBe("es");
      expect(hits[0]?.legalFramework).toBe("AR");
      expect(hits[0]?.score).toBeCloseTo(1, 5);

      const wrongLanguage = await searchVectorChunks(client, embedding, { language: "en" });
      expect(wrongLanguage).toHaveLength(0);

      const { rows } = await client.query<{ setting: string }>(
        `SELECT current_setting('hnsw.ef_search') AS setting;`
      );
      expect(rows[0]?.setting).toBe(String(EF_SEARCH));
    } finally {
      client.release();
    }
  });

  it("re-encryption batches: pending → running → verified | rolled_back (REQ-KEY-4)", async () => {
    const batch = await createReEncryptionBatch(pool, { keyFrom: 1, keyTo: 2 });
    expect(batch.status).toBe("pending");

    const claimed = await claimNextPendingBatch(pool);
    expect(claimed?.id).toBe(batch.id);
    expect(claimed?.status).toBe("running");

    const done = await completeBatch(pool, batch.id, 5, "integrity-hash-1");
    expect(done.status).toBe("verified");
    expect(done.rowsCount).toBe(5);
    expect(done.integrityHash).toBe("integrity-hash-1");

    // Version 3 must exist for the second batch's key_to FK.
    await createNextKeyVersion(pool, {
      salt: "salt-v3", expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    const bad = await createReEncryptionBatch(pool, { keyFrom: 2, keyTo: 3 });    await claimNextPendingBatch(pool);
    const rolled = await rollbackBatch(pool, bad.id, "hash mismatch");
    expect(rolled.status).toBe("rolled_back");
    expect(rolled.error).toBe("hash mismatch");

    await expect(claimNextPendingBatch(pool)).resolves.toBeUndefined();
  });

  it("purge: batched anonymous cleanup respects bounds (REQ-CONSENT-5)", async () => {
    // 150 past-due anonymous rows: with the 100-row batch floor this must
    // take exactly 2 batches (100 + 50) — proves LIMIT batching, not a sweep.
    await pool.query(
      `INSERT INTO sessions (contact_key_anon, jurisdiction, persistence_class, consent_state, ai_state, purge_at)
       SELECT 'anon-key-bulk-' || g, 'AR', 'anonymous', 'notice_shown', 'auto', now() - interval '1 hour'
         FROM generate_series(1, 150) AS g;`
    );
    const hc = await upsertSession(pool, { contactKeyAnon: "anon-key-purge-hc", jurisdiction: "AR" });
    await setSessionPersistence(pool, hc.id, "hc");
    const future = await upsertSession(pool, { contactKeyAnon: "anon-key-purge-future", jurisdiction: "AR" });

    const result = await purgeAnonymousSessions(pool, { batchSize: 2 }); // clamped to 100
    expect(result.purgedSessions).toBe(150);
    expect(result.purgedHistory).toBe(0);
    expect(result.batches).toBe(2);

    const { rows: remaining } = await pool.query<{ id: string }>(
      `SELECT id FROM sessions WHERE contact_key_anon LIKE 'anon-key-bulk-%';`
    );
    expect(remaining).toHaveLength(0);
    await expect(getSession(pool, hc.id)).resolves.toBeDefined();
    await expect(getSession(pool, future.id)).resolves.toBeDefined();

    const secondRun = await purgeAnonymousSessions(pool, { batchSize: 2 });
    expect(secondRun.purgedSessions).toBe(0);
  });

  it("users: findUserRole resolves role for RBAC preflight (REQ-DASH-1)", async () => {
    const actorId = "00000000-0000-7000-8000-0000000000bb";
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role)
       VALUES ($1, 'admin@test.local', 'hash-test', 'admin');`,
      [actorId]
    );

    await expect(findUserRole(pool, actorId)).resolves.toBe("admin");
    await expect(findUserRole(pool, "00000000-0000-7000-8000-0000000000cc")).resolves.toBeUndefined();
  });
});
