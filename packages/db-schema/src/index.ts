export { runMigrations, type RunMigrationsOptions } from "./migrate";
export {
  assertVectorIndexPresent,
  VectorIndexMissingError,
} from "./startup-assertions";
export type { DbQueryable, QueryResult, QueryResultRow } from "./repositories/db";
export {
  upsertSession,
  getSession,
  setSessionPersistence,
  setSessionJurisdiction,
  setSessionConsentState,
  setSessionAiState,
  touchSessionActivity,
  type SessionInput,
} from "./repositories/sessions";
export {
  createConsentRecord,
  findActiveConsentBySession,
  findActiveConsentWithPayload,
  deactivateConsent,
  listConsentRowsForReEncryption,
  updateConsentEncryption,
  countConsentRowsByKeyVersion,
  type NewConsentRecord,
  type ReEncryptionRow,
  type ConsentRecordWithPayload,
} from "./repositories/consent";
export {
  createAlert,
  findOpenAlertByDedupeKey,
  findAlertById,
  acknowledgeAlert,
  resolveAlert,
  touchAlert,
  type NewAlert,
  type AlertRow,
} from "./repositories/alerts";
export {
  insertAuditEntry,
  listAuditByResource,
  type NewAuditEntry,
} from "./repositories/audit";
export {
  createNextKeyVersion,
  currentActiveKeyVersion,
  getKeyVersion,
  retireKeyVersion,
  listKeysPastForcedDue,
  type NewKeyVersion,
} from "./repositories/key-versions";
export {
  searchVectorChunks,
  EF_SEARCH,
  type VectorSearchOptions,
} from "./repositories/chunks";
export {
  createReEncryptionBatch,
  claimNextPendingBatch,
  completeBatch,
  rollbackBatch,
  type NewReEncryptionBatch,
} from "./repositories/reencryption";
export {
  purgeAnonymousSessions,
  type PurgeOptions,
  type PurgeResult,
} from "./repositories/purge";
export {
  saveHistoryEntry,
  listHistoryForExport,
  type HistoryEntry,
  type ExportedHistoryRow,
  type HistoryMessage,
} from "./repositories/history";
export { findUserRole } from "./repositories/users";
