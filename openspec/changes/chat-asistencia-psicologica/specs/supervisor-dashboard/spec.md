# Supervisor Dashboard Specification

## Purpose

Internal-only supervisor console (React + Vite, Node/Express + Socket.io, Recharts/D3) with a dual chat view including injected RAG context, per-chat takeover (AI disabled, human replies through the bot), a live alert semaphore, a vector explorer, a key-rotation monitor, a QR validator, audit/access logs, and RBAC (supervisor/admin). Every async view MUST have loading and error states; data exposure MUST be role-scoped.

## Requirements

### Requirement: REQ-DASH-1 — RBAC scoping

Access MUST be role-scoped (supervisor vs admin); supervisor-only data (chat logs, consent records, alert details) MUST be denied to unauthorized roles at every data fetch.

#### Scenario: Admin-only action

- GIVEN a supervisor without admin role
- WHEN the supervisor requests key-management or legal-framework actions
- THEN the request is denied
- AND the denial is audit-logged

#### Scenario: Role-scoped data fetch

- GIVEN a dashboard data request
- WHEN the backend resolves the caller role
- THEN only data within that role's scope is returned

### Requirement: REQ-DASH-2 — Dual chat view with RAG context

The dashboard MUST show the live chat between user and bot alongside the injected RAG context (retrieved chunks, gate scores, alert level) for that chat.

#### Scenario: Reviewing a flagged answer

- GIVEN an orange-blocked or yellow-flagged answer
- WHEN the supervisor opens the chat
- THEN the user messages, bot messages, and the exact RAG context are shown side by side

### Requirement: REQ-DASH-3 — Takeover per chat

A supervisor MUST be able to take over any chat: AI disabled for that chat, supervisor replies sent through the bot provider, AI resumes only on explicit release.

#### Scenario: Takeover session

- GIVEN an active chat with AI running
- WHEN the supervisor clicks Takeover
- THEN AI generation is disabled for that chat
- AND supervisor replies are delivered through the bot provider

#### Scenario: Release after takeover

- GIVEN a chat in takeover state
- WHEN the supervisor releases the chat
- THEN AI resumes
- AND the takeover/release events are audit-logged

### Requirement: REQ-DASH-4 — Alert semaphore

The dashboard MUST display red/orange/yellow alerts in real time via Socket.io with per-alert details and acknowledge/resolve actions.

#### Scenario: Red alert appears

- GIVEN a red alert raised
- WHEN the Socket.io event reaches the dashboard
- THEN the semaphore shows the red alert immediately (< 1s)
- AND the supervisor can open and acknowledge it

### Requirement: REQ-DASH-5 — Vector explorer and re-vectorization

The dashboard MUST allow searching the knowledge base, inspecting chunk metadata, and triggering re-vectorization; manual removal of chunks MUST be possible.

#### Scenario: Manual chunk removal

- GIVEN a flagged chunk in the vector explorer
- WHEN the supervisor removes it
- THEN the chunk is deleted from the vector store
- AND the removal is audit-logged

### Requirement: REQ-DASH-6 — Key-rotation monitor

The dashboard MUST show the 7-day key countdown, the 12h forced re-encryption clock, and per-batch re-encryption progress.

#### Scenario: Forced clock visible

- GIVEN a key past its 7-day lifecycle
- WHEN the monitor renders
- THEN the remaining 12h forced window is shown
- AND batch progress updates in real time

### Requirement: REQ-DASH-7 — QR validator

The dashboard MUST validate a patient's QR and inspect the consent/signature chain (consent record, terms version, key_version, signatures).

#### Scenario: Valid QR scanned

- GIVEN a QR payload submitted by the supervisor
- WHEN the validator checks the chain
- THEN the consent record, terms version, and signature chain are shown
- AND the validation is audit-logged

#### Scenario: Expired or tampered QR

- GIVEN a QR that fails signature or expiry checks
- WHEN the validator runs
- THEN the validation fails with the reason
- AND the failure is audit-logged

### Requirement: REQ-DASH-8 — Audit access logs

Access to encrypted records, QR validations, key access, takeovers, and forced re-encryptions MUST be audit-logged (who/when/why) with PII stripped.

#### Scenario: Audit trail query

- GIVEN an admin views the audit panel
- WHEN a filter is applied
- THEN matching audit events are returned with actor, timestamp, and reason
- AND no message content or PII appears in the log payload

### Requirement: REQ-DASH-9 — View robustness and privacy

Every async view MUST have loading and error states; WebSocket connections MUST be cleaned up on unmount; the dashboard MUST display anonymized user identifiers, never full phone numbers or raw message content outside authorized views.

#### Scenario: Alert feed error

- GIVEN the alert feed fails to load
- WHEN the view renders
- THEN an error state with retry is shown
- AND the WebSocket connection is released on unmount

