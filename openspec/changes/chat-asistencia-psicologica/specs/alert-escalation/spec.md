# Alert Escalation Specification

## Purpose

Routes safety-relevant events into three alert levels — red (vital risk), orange (role-deviation block), yellow (incoherence) — pushes them to supervisors over Socket.io with red under 1 second, delivers the crisis response text with local emergency lines, escalates independently of WhatsApp, and dedupes/throttles repeated events with a fallback channel.

## Requirements

### Requirement: REQ-ALERT-1 — Three-level alert model

Alerts MUST be classified as red (vital risk: self-harm, overdose, suicidal ideation), orange (role-deviation block), or yellow (incoherence/borderline); each level MUST have distinct routing and SLAs.

#### Scenario: Red alert raised

- GIVEN a crisis keyword or red risk classification
- WHEN the alert service receives the event
- THEN a red alert is created and routed for immediate supervisor push

#### Scenario: Orange block alert

- GIVEN a blocked output from the coherence gate
- WHEN the alert service receives the event
- THEN an orange alert is created for human review
- AND no output was emitted to the user

### Requirement: REQ-ALERT-2 — Red push under one second

Red alerts MUST reach the supervisor dashboard over Socket.io in under 1 second from detection.

#### Scenario: Latency SLA met

- GIVEN a red alert detected at time T
- WHEN the supervisor push completes
- THEN the dashboard receives the event at T + <1s

#### Scenario: Push delivery failure

- GIVEN a Socket.io push that fails
- WHEN delivery cannot be confirmed
- THEN the fallback channel is attempted
- AND the failure is logged with PII stripped

### Requirement: REQ-ALERT-3 — Crisis response text

A red alert MUST trigger an immediate crisis-response message (grounded text + local emergency lines by geolocation); the response MUST be sent best-effort in under 5 seconds.

#### Scenario: Crisis message emitted

- GIVEN a red alert for an active session
- WHEN the crisis response is composed
- THEN the grounded message with local help lines is sent to the user
- AND the supervisor is notified in parallel

### Requirement: REQ-ALERT-4 — Escalation independent of WhatsApp

The escalation path to the supervisor MUST NOT depend on WhatsApp delivery; if the chat channel is down, the alert MUST still reach the supervisor.

#### Scenario: WhatsApp channel unavailable

- GIVEN the WhatsApp provider is offline
- WHEN a red alert is detected
- THEN the supervisor still receives the alert via dashboard push
- AND escalation is recorded in the audit log

### Requirement: REQ-ALERT-5 — Dedupe and throttle

Repeated identical alerts within a time window MUST be deduplicated or throttled; the original alert MUST remain acknowledged/resolved as a single event.

#### Scenario: Repeated crisis keywords

- GIVEN multiple messages with the same crisis keyword within the throttle window
- WHEN alerts are evaluated
- THEN only one active red alert is open for that session
- AND follow-ups update the existing alert, not new ones

### Requirement: REQ-ALERT-6 — Alert lifecycle and audit

Alerts MUST support acknowledge/resolve lifecycle and MUST be recorded in the audit log (who/when/why) without PII in the log payload.

#### Scenario: Supervisor acknowledges red alert

- GIVEN an open red alert
- WHEN a supervisor acknowledges it and takes over
- THEN the alert transitions to acknowledged
- AND the takeover event is audit-logged

