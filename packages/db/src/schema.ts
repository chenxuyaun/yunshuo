import type {
  ChapterPlan,
  GateEvaluationResult,
  GateRulesetConfig,
} from '@yunshuo/domain';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const vector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'vector';
  },
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('human'),
  passwordHash: text('password_hash'),
  passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userIdentities = pgTable('user_identities', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  provider: text('provider').notNull(),
  subject: text('subject').notNull(),
  email: text('email'),
  emailVerified: boolean('email_verified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  settingsVersion: integer('settings_version').notNull().default(1),
  ledgerVersion: integer('ledger_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable('memberships', {
  workspaceId: uuid('workspace_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  authMethod: text('auth_method').notNull().default('dev'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const workspaceInvites = pgTable('workspace_invites', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  email: text('email').notNull(),
  role: text('role').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  invitedBy: uuid('invited_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedBy: uuid('accepted_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authEvents = pgTable('auth_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id'),
  action: text('action').notNull(),
  result: text('result').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  requestedIp: text('requested_ip'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mailMessages = pgTable('mail_messages', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id'),
  userId: uuid('user_id'),
  toEmail: text('to_email').notNull(),
  template: text('template').notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const works = pgTable('works', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const volumes = pgTable('volumes', {
  id: uuid('id').primaryKey(),
  workId: uuid('work_id').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chapters = pgTable('chapters', {
  id: uuid('id').primaryKey(),
  workId: uuid('work_id').notNull(),
  volumeId: uuid('volume_id').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull().default('planned'),
  currentVersionId: uuid('current_version_id'),
  plan: jsonb('plan').$type<ChapterPlan>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chapterLeases = pgTable('chapter_leases', {
  chapterId: uuid('chapter_id').primaryKey(),
  userId: uuid('user_id').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const draftBranches = pgTable('draft_branches', {
  id: uuid('id').primaryKey(),
  chapterId: uuid('chapter_id').notNull(),
  ownerId: uuid('owner_id').notNull(),
  name: text('name').notNull().default('main'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const draftRevisions = pgTable('draft_revisions', {
  id: uuid('id').primaryKey(),
  branchId: uuid('branch_id').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  wordCount: integer('word_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const gateRulesets = pgTable('gate_rulesets', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull(),
  version: integer('version').notNull(),
  description: text('description').notNull(),
  rules: jsonb('rules').$type<GateRulesetConfig>().notNull(),
  isProduction: boolean('is_production').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const gateEvaluations = pgTable('gate_evaluations', {
  id: uuid('id').primaryKey(),
  chapterId: uuid('chapter_id').notNull(),
  contentHash: text('content_hash').notNull(),
  rulesetId: uuid('ruleset_id').notNull(),
  contextHash: text('context_hash').notNull(),
  status: text('status').notNull(),
  results: jsonb('results').$type<GateEvaluationResult>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const stagedDrafts = pgTable('staged_drafts', {
  id: uuid('id').primaryKey(),
  chapterId: uuid('chapter_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  revisionId: uuid('revision_id').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  wordCount: integer('word_count').notNull(),
  evaluationId: uuid('evaluation_id').notNull(),
  stagedBy: uuid('staged_by').notNull(),
  stagedAt: timestamp('staged_at', { withTimezone: true }).notNull().defaultNow(),
});

export const canonVersions = pgTable('canon_versions', {
  id: uuid('id').primaryKey(),
  chapterId: uuid('chapter_id').notNull(),
  versionNo: integer('version_no').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  wordCount: integer('word_count').notNull(),
  parentVersionId: uuid('parent_version_id'),
  source: text('source').notNull(),
  actorId: uuid('actor_id'),
  evaluationId: uuid('evaluation_id'),
  waiverId: uuid('waiver_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const canonCurrent = pgTable('canon_current', {
  chapterId: uuid('chapter_id').primaryKey(),
  versionId: uuid('version_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const canonChunks = pgTable('canon_chunks', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  workId: uuid('work_id').notNull(),
  chapterId: uuid('chapter_id').notNull(),
  versionId: uuid('version_id').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  paragraphStart: integer('paragraph_start').notNull(),
  paragraphEnd: integer('paragraph_end').notNull(),
  charStart: integer('char_start').notNull(),
  charEnd: integer('char_end').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  lexicalText: text('lexical_text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chunkEmbeddings = pgTable('chunk_embeddings', {
  chunkId: uuid('chunk_id').primaryKey(),
  providerId: uuid('provider_id'),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  embedding: vector('embedding').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const waivers = pgTable('waivers', {
  id: uuid('id').primaryKey(),
  chapterId: uuid('chapter_id').notNull(),
  targetVersionId: uuid('target_version_id'),
  gateKey: text('gate_key').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('pending'),
  requestedBy: uuid('requested_by').notNull(),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  decidedBy: uuid('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const commitIntents = pgTable('commit_intents', {
  id: uuid('id').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  chapterId: uuid('chapter_id').notNull(),
  operation: text('operation').notNull().default('commit'),
  stagedDraftId: uuid('staged_draft_id'),
  targetVersionId: uuid('target_version_id'),
  expectedCurrentVersionId: uuid('expected_current_version_id'),
  status: text('status').notNull(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const commits = pgTable('commits', {
  id: uuid('id').primaryKey(),
  intentId: uuid('intent_id').notNull().unique(),
  chapterId: uuid('chapter_id').notNull(),
  versionId: uuid('version_id').notNull(),
  actorId: uuid('actor_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  actorId: uuid('actor_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  actorId: uuid('actor_id'),
  actorType: text('actor_type').notNull(),
  role: text('role').notNull(),
  action: text('action').notNull(),
  objectType: text('object_type').notNull(),
  objectId: uuid('object_id'),
  result: text('result').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  dedupeKey: text('dedupe_key'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

export const indexStatus = pgTable('index_status', {
  chapterId: uuid('chapter_id').primaryKey(),
  versionId: uuid('version_id').notNull(),
  status: text('status').notNull(),
  detail: text('detail'),
  chunkCount: integer('chunk_count').notNull().default(0),
  providerName: text('provider_name'),
  model: text('model'),
  dimensions: integer('dimensions'),
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chapterMetadata = pgTable('chapter_metadata', {
  chapterId: uuid('chapter_id').primaryKey(),
  wordCount: integer('word_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const modelProviders = pgTable('model_providers', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  model: text('model').notNull(),
  purpose: text('purpose').notNull().default('chat'),
  isEnabled: boolean('is_enabled').notNull().default(true),
  priority: integer('priority').notNull().default(100),
  promptPricePer1m: numeric('prompt_price_per_1m', { precision: 12, scale: 4 }),
  completionPricePer1m: numeric('completion_price_per_1m', { precision: 12, scale: 4 }),
  priceCurrency: text('price_currency').notNull().default('CNY'),
  apiKeyCiphertext: text('api_key_ciphertext'),
  apiKeyHint: text('api_key_hint'),
  lastTestStatus: text('last_test_status'),
  lastTestMessage: text('last_test_message'),
  lastTestLatencyMs: integer('last_test_latency_ms'),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiProposals = pgTable('ai_proposals', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  chapterId: uuid('chapter_id').notNull(),
  providerId: uuid('provider_id'),
  providerName: text('provider_name').notNull(),
  model: text('model').notNull(),
  mode: text('mode').notNull(),
  instruction: text('instruction').notNull().default(''),
  targetWords: integer('target_words').notNull(),
  baseDraftHash: text('base_draft_hash'),
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  content: text('content').notNull().default(''),
  contentHash: text('content_hash'),
  wordCount: integer('word_count').notNull().default(0),
  status: text('status').notNull(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  attempts: integer('attempts').notNull().default(0),
  cost: numeric('cost', { precision: 12, scale: 4 }),
  costCurrency: text('cost_currency'),
  latencyMs: integer('latency_ms'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const aiGenerationLocks = pgTable('ai_generation_locks', {
  chapterId: uuid('chapter_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  userId: uuid('user_id').notNull(),
  proposalId: uuid('proposal_id'),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const modelCalls = pgTable('model_calls', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  providerId: uuid('provider_id'),
  chapterId: uuid('chapter_id'),
  jobId: uuid('job_id'),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  cost: numeric('cost', { precision: 12, scale: 4 }),
  costCurrency: text('cost_currency'),
  reservedCost: numeric('reserved_cost', { precision: 12, scale: 4 }),
  reservedCurrency: text('reserved_currency'),
  attemptNo: integer('attempt_no').notNull().default(1),
  latencyMs: integer('latency_ms'),
  status: text('status').notNull(),
  actorId: uuid('actor_id'),
  purpose: text('purpose'),
  proposalId: uuid('proposal_id'),
  suggestionId: uuid('suggestion_id'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const workspaceBudgets = pgTable('workspace_budgets', {
  workspaceId: uuid('workspace_id').primaryKey(),
  monthlyLimit: numeric('monthly_limit', { precision: 12, scale: 4 }).notNull(),
  currency: text('currency').notNull().default('CNY'),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const providerBills = pgTable('provider_bills', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  providerName: text('provider_name').notNull(),
  invoiceNo: text('invoice_no').notNull(),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  currency: text('currency').notNull(),
  declaredTotal: numeric('declared_total', { precision: 18, scale: 6 }),
  status: text('status').notNull().default('imported'),
  reviewNote: text('review_note'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  importedBy: uuid('imported_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const providerBillLines = pgTable('provider_bill_lines', {
  id: uuid('id').primaryKey(),
  billId: uuid('bill_id').notNull(),
  lineNo: integer('line_no').notNull(),
  model: text('model').notNull(),
  inputTokens: bigint('input_tokens', { mode: 'number' }),
  outputTokens: bigint('output_tokens', { mode: 'number' }),
  amount: numeric('amount', { precision: 18, scale: 6 }).notNull(),
  note: text('note'),
});

export const automationMandates = pgTable('automation_mandates', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  workId: uuid('work_id').notNull(),
  name: text('name').notNull(),
  mode: text('mode').notNull().default('continue'),
  chapterMin: integer('chapter_min').notNull(),
  chapterMax: integer('chapter_max').notNull(),
  maxChapters: integer('max_chapters').notNull(),
  targetWords: integer('target_words').notNull(),
  instruction: text('instruction').notNull().default(''),
  allowAutoCommit: boolean('allow_auto_commit').notNull().default(false),
  allowRemoteModels: boolean('allow_remote_models').notNull().default(false),
  allowNonProductionGates: boolean('allow_non_production_gates').notNull().default(false),
  budgetLimit: numeric('budget_limit', { precision: 12, scale: 4 }),
  budgetCurrency: text('budget_currency').notNull().default('CNY'),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by').notNull(),
  revokedBy: uuid('revoked_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const automationJobs = pgTable('automation_jobs', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  workId: uuid('work_id').notNull(),
  mandateId: uuid('mandate_id').notNull(),
  status: text('status').notNull(),
  preflight: jsonb('preflight').$type<Record<string, unknown>>().notNull().default({}),
  totalChapters: integer('total_chapters').notNull().default(0),
  committedChapters: integer('committed_chapters').notNull().default(0),
  stagedChapters: integer('staged_chapters').notNull().default(0),
  failedChapters: integer('failed_chapters').notNull().default(0),
  skippedChapters: integer('skipped_chapters').notNull().default(0),
  spent: numeric('spent', { precision: 12, scale: 4 }).notNull().default('0'),
  costCurrency: text('cost_currency').notNull().default('CNY'),
  costUnknown: boolean('cost_unknown').notNull().default(false),
  runnerId: text('runner_id'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  currentChapterId: uuid('current_chapter_id'),
  pauseRequested: boolean('pause_requested').notNull().default(false),
  stopRequested: boolean('stop_requested').notNull().default(false),
  lastError: text('last_error'),
  createdBy: uuid('created_by').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const automationJobChapters = pgTable(
  'automation_job_chapters',
  {
    jobId: uuid('job_id').notNull(),
    chapterId: uuid('chapter_id').notNull(),
    chapterNumber: integer('chapter_number').notNull(),
    status: text('status').notNull().default('pending'),
    proposalId: uuid('proposal_id'),
    versionId: uuid('version_id'),
    evaluationId: uuid('evaluation_id'),
    reason: text('reason'),
    cost: numeric('cost', { precision: 12, scale: 4 }),
    costCurrency: text('cost_currency'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.chapterId] })],
);

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  workId: uuid('work_id'),
  kind: text('kind').notNull(),
  scope: text('scope').notNull(),
  name: text('name').notNull(),
  aliases: text('aliases').array().notNull().default([]),
  summary: text('summary').notNull().default(''),
  status: text('status').notNull().default('draft'),
  sourceChapterId: uuid('source_chapter_id'),
  currentVersionId: uuid('current_version_id'),
  draftVersionId: uuid('draft_version_id'),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerEntryAliases = pgTable(
  'ledger_entry_aliases',
  {
    entryId: uuid('entry_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind').notNull(),
    workId: uuid('work_id'),
    aliasKey: text('alias_key').notNull(),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.aliasKey] })],
);

export const ledgerEntryVersions = pgTable('ledger_entry_versions', {
  id: uuid('id').primaryKey(),
  entryId: uuid('entry_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  versionNo: integer('version_no').notNull(),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
  changeSummary: text('change_summary').notNull().default(''),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerSuggestions = pgTable('ledger_suggestions', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  entryId: uuid('entry_id').notNull(),
  kind: text('kind').notNull(),
  baseVersionId: uuid('base_version_id'),
  basisChapterId: uuid('basis_chapter_id'),
  basisCanonVersionId: uuid('basis_canon_version_id'),
  instruction: text('instruction').notNull().default(''),
  providerId: uuid('provider_id'),
  providerName: text('provider_name').notNull().default(''),
  model: text('model').notNull().default(''),
  promptVersion: text('prompt_version').notNull().default(''),
  proposal: jsonb('proposal').$type<Record<string, unknown>>(),
  rationale: text('rationale').notNull().default(''),
  evidence: jsonb('evidence').$type<unknown[]>().notNull().default([]),
  attempts: integer('attempts').notNull().default(0),
  status: text('status').notNull().default('generating'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  cost: numeric('cost', { precision: 12, scale: 4 }),
  costCurrency: text('cost_currency'),
  latencyMs: integer('latency_ms'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  decidedBy: uuid('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note').notNull().default(''),
  resultDraftVersionId: uuid('result_draft_version_id'),
});
