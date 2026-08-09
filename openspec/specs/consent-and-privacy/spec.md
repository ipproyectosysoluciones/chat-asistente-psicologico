# Consent and Privacy Specification

## Purpose

Enforces the per-jurisdiction privacy framework before ANY data is stored: jurisdiction resolved by IP geolocation plus explicit user confirmation (VPN mitigation), privacy notice shown at session start, and consent captured via checkbox → backend AES-256-CBC (Node `crypto`) → Base64 → QR image sent in chat. A consent registry records terms version per jurisdiction. Dual persistence separates HC-registered (persistent, encrypted, exportable) from anonymous (ephemeral, purged 24–48h) data.

## Requirements

### Requirement: REQ-CONSENT-1 — Jurisdiction selection

The system MUST resolve the user's jurisdiction by IP geolocation (MaxMind/IPStack) AND obtain explicit user confirmation; the user MUST be able to correct the jurisdiction before any data is stored.

#### Scenario: Confirmed jurisdiction

- GIVEN an IP resolving to Colombia
- WHEN the session starts
- THEN the system proposes Colombia's framework
- AND waits for the user's confirmation before proceeding

#### Scenario: VPN mitigation

- GIVEN an IP that conflicts with the user's stated country
- WHEN the user confirms a different jurisdiction
- THEN the confirmed jurisdiction is used for the notice
- AND the discrepancy is logged (PII-stripped)

### Requirement: REQ-CONSENT-2 — Notice before any data storage

The privacy notice for the confirmed jurisdiction MUST be shown at session start; no user data MAY be stored before the notice is accepted.

#### Scenario: Notice-first session

- GIVEN a new anonymous user
- WHEN the session starts
- THEN the privacy notice for the jurisdiction is displayed
- AND no message content is persisted until acceptance

#### Scenario: Notice is not bypassable

- GIVEN a user who skips or dismisses the notice
- WHEN they send messages
- THEN data storage remains disabled
- AND the bot redirects to the notice/consent flow

### Requirement: REQ-CONSENT-3 — Consent capture to QR

HC-registration consent MUST be captured as a checkbox acceptance, encrypted with AES-256-CBC on the backend (Node `crypto`), encoded Base64, and rendered as a QR image (node-qrcode) sent in chat; crypto MUST never run on the client.

#### Scenario: HC consent end-to-end

- GIVEN a user accepts HC registration with the checkbox
- WHEN the consent flow completes
- THEN the record is AES-256-CBC encrypted on the backend
- AND a Base64-encoded QR image is sent in chat

#### Scenario: Backend-only crypto

- GIVEN a consent submission
- WHEN encryption is invoked
- THEN no plain-text consent data is transmitted or stored
- AND no encryption occurs in the chat client

### Requirement: REQ-CONSENT-4 — Consent registry

Every consent record MUST be stored with the legal terms version, jurisdiction, timestamp, `key_version`, and an integrity hash; consent MUST NOT be stored in plain text.

#### Scenario: Registry row created

- GIVEN an accepted consent
- WHEN the registry write completes
- THEN the row includes terms version, jurisdiction, key_version, and integrity hash
- AND the stored payload is encrypted

### Requirement: REQ-CONSENT-5 — Dual persistence

HC-registered data MUST persist encrypted and be exportable on request; anonymous data MUST use an ephemeral identifier and MUST be auto-purged within 24–48h.

#### Scenario: HC history export

- GIVEN an HC-registered user requests their clinical history
- WHEN the export is prepared
- THEN the encrypted history is decrypted server-side and delivered securely
- AND the access is audit-logged

#### Scenario: Anonymous purge

- GIVEN an anonymous session older than the purge window
- WHEN the cleanup job runs
- THEN the ephemeral data is deleted within 24–48h
- AND HC data is untouched

### Requirement: REQ-CONSENT-6 — Multi-jurisdiction legal frameworks

The system MUST handle the six frameworks — Colombia Ley 1581/Res. 1995, México LFPDPPP, EEUU HIPAA, UE RGPD, Argentina Ley 25.326, Chile Ley 19.628 — each with its own notice text and terms version.

#### Scenario: Per-jurisdiction notice

- GIVEN a confirmed jurisdiction of Mexico
- WHEN the notice is rendered
- THEN the LFPDPPP notice text with its terms version is shown

#### Scenario: Unknown jurisdiction

- GIVEN a jurisdiction outside the six supported frameworks
- WHEN the notice would be shown
- THEN the system applies a conservative default (highest-privacy framework)
- AND flags the session for legal review

