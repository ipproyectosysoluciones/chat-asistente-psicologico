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
  listAlerts,
  type NewAlert,
  type AlertRow,
  type AlertPage,
  type AlertPageOptions,
} from "./repositories/alerts";
export {
  insertAuditEntry,
  listAuditByResource,
  listAuditEntries,
  type NewAuditEntry,
  type AuditQuery,
} from "./repositories/audit";
export {
  listLegalFrameworks,
  publishTermsVersion,
  type LegalFrameworkRow,
  type PublishTermsInput,
} from "./repositories/legal-frameworks";
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
export { findContactPhoneBySession } from "./repositories/contacts";
export {
  findUserRole,
  findUserByEmail,
  findUserById,
  upsertAdminUser,
  type DashboardUser,
} from "./repositories/users";
export {
  listDashboardChats,
  listDashboardMessages,
  listDashboardRagTraces,
  saveRagTrace,
  findOpenAlertLevel,
  isRagTrace,
  type ChatPage,
  type ChatPageOptions,
} from "./repositories/dashboard";
