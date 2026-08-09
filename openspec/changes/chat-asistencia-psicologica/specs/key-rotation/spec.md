# Key Rotation Specification

## Purpose

Manages the 7-day AES-256 key lifecycle with `key_version` metadata on every encrypted row: deferred re-encryption at 30-min inactivity or session end, FORCED re-encryption at 12h post-expiry, worker-thread batches of 100–500 rows with per-batch rollback and integrity hash, silent operation, and a new QR per rotation delivered only after a 6-digit OTP (10-min validity). The old key and signature remain available during transition (dual-read) and the previous signature is archived for chain of trust.

## Requirements

### Requirement: REQ-KEY-1 — Key lifecycle and versioning

Keys MUST follow a 7-day lifecycle with forward secrecy; every encrypted row MUST carry `key_version`; at most one active key MUST be used for new writes.

#### Scenario: New key issued

- GIVEN the 7-day lifecycle of key N ends
- WHEN the rotation scheduler runs
- THEN key N+1 is created and marked active
- AND key N remains available for dual-read during transition

### Requirement: REQ-KEY-2 — Deferred re-encryption

Re-encryption MUST run in the low-traffic window, waiting for 30-min inactivity or session end before re-encrypting a user's rows.

#### Scenario: Deferred on inactivity

- GIVEN a user inactive for 30 minutes
- WHEN the deferred queue triggers
- THEN the user's rows are re-encrypted with the new key
- AND the operation is silent to the user

### Requirement: REQ-KEY-3 — Forced re-encryption at 12h

If deferred re-encryption is incomplete, re-encryption MUST be forced at 12h post-expiry regardless of traffic.

#### Scenario: Forced path

- GIVEN rows still encrypted with the expired key 12h after expiry
- WHEN the forced job runs
- THEN the remaining rows are re-encrypted
- AND the forced run is audit-logged

### Requirement: REQ-KEY-4 — Batches with rollback and integrity hash

Re-encryption MUST process rows in batches of 100–500; each batch MUST compute an integrity hash and MUST roll back on hash failure; a failed batch MUST NOT leave mixed encryption in that batch.

#### Scenario: Batch success

- GIVEN a batch of 200 rows
- WHEN the batch completes
- THEN each row carries the new key_version
- AND the integrity hash verifies

#### Scenario: Batch failure rollback

- GIVEN an integrity-hash mismatch mid-batch
- WHEN the batch fails
- THEN the batch is rolled back to the prior state
- AND the previous key is still valid for those rows

### Requirement: REQ-KEY-5 — Worker-thread silent execution

Re-encryption MUST run in a worker thread and MUST NOT block the event loop; operations MUST be silent with no user-visible interruption.

#### Scenario: Event loop unaffected

- GIVEN a re-encryption batch running
- WHEN normal chat traffic arrives
- THEN chat latency is not degraded by the crypto work

### Requirement: REQ-KEY-6 — OTP-gated QR renewal

A new QR per rotation MUST be delivered only after a 6-digit OTP (10-min validity) is verified; expired or failed OTP attempts MUST NOT deliver the QR.

#### Scenario: Valid OTP renewal

- GIVEN a user requests their renewed QR
- WHEN a valid 6-digit OTP (within 10 min) is submitted
- THEN the new QR is generated and sent

#### Scenario: Expired OTP

- GIVEN an OTP older than 10 minutes
- WHEN the user submits it
- THEN the QR is not delivered
- AND a fresh OTP is issued

### Requirement: REQ-KEY-7 — Signature archive and chain of trust

The old signature MUST be archived when a new QR is issued; the chain of trust MUST remain verifiable across rotations.

#### Scenario: Chain verification

- GIVEN a QR from a previous rotation
- WHEN the QR validator inspects it
- THEN the archived signature chain verifies against the consent record

### Requirement: REQ-KEY-8 — Dual-read transition and audit

During transition, reads MUST succeed under either the old or new key; key access and forced re-encryption MUST be audit-logged.

#### Scenario: Dual-read during transition

- GIVEN rows in transition between key N and key N+1
- WHEN a record is read
- THEN the read succeeds using the row's own key_version

