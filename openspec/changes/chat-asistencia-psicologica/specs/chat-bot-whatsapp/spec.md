# Chat Bot WhatsApp Specification

## Purpose

WhatsApp-first chat bot built on BuilderBot with the three-pillar contract (Flow / Provider / Database must stay swappable). Hosts the welcome, privacy/consent, crisis-keyword, and menu flows; sends consent QR images directly in chat; persists conversation history to PostgreSQLDB; and reconnects gracefully on Baileys session loss. Provider swap (Baileys ↔ Meta) must be configuration-only.

## Requirements

### Requirement: REQ-CHATBOT-1 — BuilderBot three-pillar composition

The chat bot MUST be composed with `createBot({ flow, provider, database })`, keeping the Flow, Provider, and Database pillars independently swappable; no pillar MAY embed logic owned by another pillar.

#### Scenario: Pillars wired independently

- GIVEN a BuilderBot composition with a flow, a provider, and a database adapter
- WHEN the bot starts
- THEN each pillar is initialized separately
- AND swapping any pillar does not require changes to the others

#### Scenario: Provider replaced with Meta

- GIVEN the bot running with the Baileys provider
- WHEN the provider configuration is switched to the Meta provider
- THEN flows and database adapters run unchanged
- AND no flow logic references Baileys-specific APIs

### Requirement: REQ-CHATBOT-2 — Message lifecycle via addAction

LLM/RAG calls, validation, database writes, and media (QR) sends MUST be executed through `addAction` callbacks; the flow MUST NOT perform these operations outside the action lifecycle.

#### Scenario: Grounded answer emission

- GIVEN a user message that matched a flow
- WHEN the `addAction` callback invokes the RAG service and the answer passes the coherence gate
- THEN the grounded answer is emitted via `flowDynamic`
- AND the conversation is persisted to the PostgreSQLDB sink

### Requirement: REQ-CHATBOT-3 — Welcome and menu flow

On session start, the bot MUST present a welcome message and a menu (support topics, privacy info, crisis option); the menu MUST be reachable at any point via a menu keyword.

#### Scenario: First contact

- GIVEN an anonymous user sends a first message
- WHEN the welcome flow matches
- THEN a welcome message and menu options are sent
- AND no user data is stored yet

#### Scenario: Menu re-entry

- GIVEN a user in any flow
- WHEN the user types the menu keyword
- THEN the menu is presented again without losing the session context

### Requirement: REQ-CHATBOT-4 — Privacy/consent flow integration

The chat bot MUST NOT store any user data before the per-jurisdiction privacy notice is shown and consent is handled; the consent flow MUST be triggered by the geolocation/jurisdiction result.

#### Scenario: Consent not yet accepted

- GIVEN a new user whose jurisdiction was resolved
- WHEN the user attempts to start a support topic
- THEN the privacy notice for that jurisdiction is displayed
- AND data storage is deferred until the consent flow completes

### Requirement: REQ-CHATBOT-5 — Crisis keyword flow

Crisis keywords (derived from OMS/mhGAP and reviewed) MUST trigger an immediate crisis-support response with local emergency lines by geolocation, and MUST raise a red-level alert through the alert-escalation service.

#### Scenario: Crisis keyword detected

- GIVEN a user message containing a crisis keyword
- WHEN the crisis flow matches
- THEN the crisis response with local help lines is emitted
- AND a red alert is pushed to the supervisor

### Requirement: REQ-CHATBOT-6 — QR media send

The bot MUST send the consent QR image directly in chat as media via `addAction` after the consent record is created.

#### Scenario: Consent QR delivered

- GIVEN a consent record successfully created for an HC-registered user
- WHEN the QR image is generated
- THEN the QR image is sent as a chat media message
- AND the consent registry row is referenced in the delivery trace

### Requirement: REQ-CHATBOT-7 — Provider abstraction

All channel communication MUST go through the provider abstraction; Baileys ↔ Meta MUST be a configuration-only swap with no flow or database changes.

#### Scenario: Meta migration gate

- GIVEN the pilot running on Baileys with a dedicated number
- WHEN the Meta provider is configured for production
- THEN the same flows and database run unchanged
- AND webhook source validation is enabled for the Meta endpoint

### Requirement: REQ-CHATBOT-8 — Session persistence and graceful reconnect

The bot MUST persist Baileys session state, keep the connection alive, and auto-reconnect on session loss or `auth_failure`; users MUST NOT observe data loss across reconnects.

#### Scenario: Reconnect after auth failure

- GIVEN an `auth_failure` or dropped connection event
- WHEN the provider emits the reconnect event
- THEN the bot restores the session and resumes message processing
- AND pending conversation history is intact

#### Scenario: Session loss requiring re-pair

- GIVEN a session that cannot be restored
- WHEN re-pairing is needed
- THEN the bot surfaces the re-pair QR/pairing code
- AND a supervisor is notified through the fallback channel

### Requirement: REQ-CHATBOT-9 — PostgreSQLDB sink and anonymous purge

Conversation history MUST be persisted through the `@builderbot/database-postgres` adapter; conversations of anonymous users MUST be automatically purged within 24–48 hours.

#### Scenario: Anonymous history purged

- GIVEN an anonymous conversation older than the purge window
- WHEN the purge job runs
- THEN the history rows are deleted
- AND the HC-registered histories are untouched

#### Scenario: Purge window bounds

- GIVEN an anonymous conversation created at time T
- WHEN T+24h elapses
- THEN purging MAY begin
- AND purging MUST be complete by T+48h

