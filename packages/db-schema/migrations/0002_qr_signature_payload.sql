-- Up Migration
-- qr_signatures chain-of-trust persistence (REQ-KEY-7, design §6.1): store
-- the full chain record (payload + issued_at) so a QR presented later — even
-- after key rotations — can be replayed and verified against the canonical
-- string. `payload` is ids/timestamps only (never health data), so no
-- encryption is required; access stays RBAC-scoped (dashboard QR validate).

ALTER TABLE qr_signatures
  ADD COLUMN payload jsonb,
  ADD COLUMN issued_at bigint;

CREATE INDEX idx_qr_signatures_consent_id ON qr_signatures (consent_id, issued_at);

-- Down Migration
ALTER TABLE qr_signatures
  DROP COLUMN IF EXISTS issued_at,
  DROP COLUMN IF EXISTS payload;
