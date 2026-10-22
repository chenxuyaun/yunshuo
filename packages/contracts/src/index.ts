import { z } from 'zod';
import type {
  AuditResult,
  ChapterPlan,
  ChapterStatus,
  GateEvaluationResult,
  GateKey,
  HumanRole,
  Role,
} from '@yunshuo/domain';

export const passwordSchema = z
  .string()
  .min(10, '密码至少 10 位')
  .max(200, '密码过长');

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请填写当前密码').max(200),
  newPassword: passwordSchema,
});

export const requestPasswordResetSchema = z.object({
  email: z.string().trim().email('请填写有效邮箱').max(320),
});

export const completePasswordResetSchema = z.object({
  token: z.string().trim().min(20, '重置链接无效').max(200),
  newPassword: passwordSchema,
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().max(200).optional(),
});

export const switchWorkspaceSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const inviteRoleSchema = z.enum([
  'owner',
  'lead',
  'author',
  'reviewer',
  'viewer',
  'billing',
]);

export const createInviteSchema = z.object({
  email: z.string().trim().email('请填写有效邮箱').max(320),
  role: inviteRoleSchema,
  expiresInHours: z.number().int().min(1).max(168).optional().default(72),
});

export const acceptInviteSchema = z.object({
  name: z.string().trim().min(1, '请填写称呼').max(40).optional(),
  password: passwordSchema.optional(),
});

export const updateMemberRoleSchema = z.object({
  role: inviteRoleSchema,
});

export const modelProviderBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, '请填写 http/https 基础地址，且不要包含账号、查询参数或片段');

export const PRICE_CURRENCIES = ['CNY', 'USD'] as const;

export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

export const priceCurrencySchema = z.enum(PRICE_CURRENCIES);

export const MODEL_PROVIDER_PURPOSES = ['chat', 'embedding'] as const;

export type ModelProviderPurpose = (typeof MODEL_PROVIDER_PURPOSES)[number];

export const modelProviderPurposeSchema = z.enum(MODEL_PROVIDER_PURPOSES);

const tokenPriceSchema = z.number().min(0).max(100_000).nullable();

export const createModelProviderSchema = z
  .object({
    name: z.string().trim().min(1, '请填写服务商名称').max(80),
    baseUrl: modelProviderBaseUrlSchema,
    model: z.string().trim().min(1, '请填写模型 ID').max(200),
    purpose: modelProviderPurposeSchema.optional().default('chat'),
    apiKey: z.string().max(600).optional(),
    reuseKeyFromProviderId: z.string().uuid().optional(),
    isEnabled: z.boolean().optional().default(true),
    priority: z.number().int().min(1).max(999).optional().default(100),
    promptPricePer1m: tokenPriceSchema.optional(),
    completionPricePer1m: tokenPriceSchema.optional(),
    priceCurrency: priceCurrencySchema.optional().default('CNY'),
  })
  .refine((value) => {
    const hasPrompt = value.promptPricePer1m !== undefined && value.promptPricePer1m !== null;
    const hasCompletion =
      value.completionPricePer1m !== undefined && value.completionPricePer1m !== null;
    if (value.purpose === 'embedding') return !hasCompletion;
    return hasPrompt === hasCompletion;
  }, 'chat 服务商的输入与输出价必须同时填写或同时留空；嵌入服务商只能填写输入价')
  .refine(
    (value) => !(value.apiKey && value.apiKey.length > 0 && value.reuseKeyFromProviderId),
    '不能同时填写新密钥与复用已有密钥',
  );

export const updateModelProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    baseUrl: modelProviderBaseUrlSchema.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    apiKey: z.string().max(600).optional(),
    isEnabled: z.boolean().optional(),
    priority: z.number().int().min(1).max(999).optional(),
    promptPricePer1m: tokenPriceSchema.optional(),
    completionPricePer1m: tokenPriceSchema.optional(),
    priceCurrency: priceCurrencySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少提供一个更新字段');

export const discoverModelsSchema = z.object({
  baseUrl: modelProviderBaseUrlSchema,
  apiKey: z.string().max(600).optional(),
  providerId: z.string().uuid().optional(),
});

export const updateBillingBudgetSchema = z.object({
  monthlyLimit: z.number().min(0).max(1_000_000_000).nullable(),
  currency: priceCurrencySchema,
});

export const updateBillingPriceSchema = z
  .object({
    promptPricePer1m: tokenPriceSchema.optional(),
    completionPricePer1m: tokenPriceSchema.optional(),
    priceCurrency: priceCurrencySchema.optional(),
  })
  .refine(
    (value) =>
      value.promptPricePer1m !== undefined ||
      value.completionPricePer1m !== undefined ||
      value.priceCurrency !== undefined,
    '至少提供一个价表字段',
  );

export type UpdateBillingBudgetInput = z.infer<typeof updateBillingBudgetSchema>;
export type UpdateBillingPriceInput = z.infer<typeof updateBillingPriceSchema>;

export const importProviderBillSchema = z.object({
  providerId: z.string().uuid(),
  invoiceNo: z.string().trim().min(1).max(120),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '账期开始日期必须为 YYYY-MM-DD'),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '账期结束日期必须为 YYYY-MM-DD'),
  currency: priceCurrencySchema,
  declaredTotal: z.number().min(0).max(1_000_000_000).nullable().optional(),
  csv: z.string().min(1).max(1_000_000),
});

export const reviewProviderBillSchema = z.object({
  status: z.enum(['reviewed', 'disputed']),
  note: z.string().trim().max(1000).optional().default(''),
});

export type ImportProviderBillInput = z.infer<typeof importProviderBillSchema>;
export type ReviewProviderBillInput = z.infer<typeof reviewProviderBillSchema>;

export const probeEmbeddingSchema = z.object({
  baseUrl: modelProviderBaseUrlSchema,
  model: z.string().trim().min(1, '请填写嵌入模型 ID').max(200),
  apiKey: z.string().max(600).optional(),
  providerId: z.string().uuid().optional(),
});

export const searchCanonSchema = z.object({
  q: z.string().trim().min(1, '请输入检索词').max(200),
  workId: z.string().uuid().optional(),
  excludeChapterId: z.string().uuid().optional(),
  mode: z.enum(['auto', 'lexical']).optional().default('auto'),
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
});

export const reindexWorkspaceSchema = z.object({
  workId: z.string().uuid().optional(),
});

export const AI_PROPOSAL_MODES = ['continue', 'expand'] as const;

export type AiProposalMode = (typeof AI_PROPOSAL_MODES)[number];

export const aiProposalModeSchema = z.enum(AI_PROPOSAL_MODES);

export const createAiProposalSchema = z.object({
  mode: aiProposalModeSchema,
  instruction: z.string().trim().max(2000, '补充要求不能超过 2000 字').optional().default(''),
  targetWords: z.number().int().min(300).max(4000).optional().default(1200),
});

export const importChaptersSchema = z.object({
  workTitle: z.string().trim().min(1, '请填写作品名').max(200),
  volumeNumber: z.number().int().min(1).max(999).default(1),
  volumeTitle: z.string().trim().min(1, '请填写卷名').max(200),
  chapters: z
    .array(
      z.object({
        number: z.number().int().min(1).max(99_999),
        title: z.string().trim().min(1, '请填写章节标题').max(200),
        content: z.string().trim().min(1, '章节正文不能为空').max(500_000),
      }),
    )
    .min(1, '至少导入一章')
    .max(1000, '一次最多导入 1000 章'),
});

export const saveDraftSchema = z.object({
  content: z.string().min(1, '空草稿不落盘'),
});

export const stageDraftSchema = z.object({
  evaluationId: z.string().uuid(),
  expectedContentHash: z.string().length(64),
});

export const commitSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  targetChapterId: z.string().uuid(),
  expectedCurrentVersionId: z.string().uuid().nullable(),
  stagedDraftId: z.string().uuid(),
});

export const rollbackSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  targetVersionId: z.string().uuid(),
  expectedCurrentVersionId: z.string().uuid(),
  reason: z.string().trim().min(4, '请填写至少 4 个字的回滚原因').max(2000),
  waiverId: z.string().uuid().nullable().optional(),
});

export const WAIVER_GATE_KEYS = [
  'word_count',
  'ai_tone',
  'core_entity',
  'chapter_hook',
  'causality',
  'rollback',
] as const;

export const waiverGateKeySchema = z.enum(WAIVER_GATE_KEYS);

export const WAIVER_STATUSES = ['pending', 'approved', 'rejected'] as const;

export type WaiverStatus = (typeof WAIVER_STATUSES)[number];

export const createWaiverSchema = z.object({
  targetVersionId: z.string().uuid(),
  gateKey: waiverGateKeySchema,
  reason: z.string().trim().min(4, '请填写至少 4 个字的豁免原因').max(2000),
});

export const decideWaiverSchema = z.object({
  note: z.string().trim().max(1000).optional().default(''),
});

export type WaiverGateKey = (typeof WAIVER_GATE_KEYS)[number];

export interface UserSummary {
  id: string;
  email: string;
  name: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  settingsVersion: number;
  ledgerVersion: number;
}

export interface MeResponse {
  user: UserSummary;
  workspace: WorkspaceSummary;
  role: Role;
}

export interface AuthConfigResponse {
  oidcEnabled: boolean;
  oidcProviderName: string;
  oidcAutoProvision: boolean;
}

export interface WorkspaceMembershipView {
  id: string;
  name: string;
  role: HumanRole;
}

export interface WorkspaceMembershipsResponse {
  workspaces: WorkspaceMembershipView[];
}

export interface MemberView {
  userId: string;
  email: string;
  name: string;
  role: Role;
  kind: 'human' | 'ai';
  joinedAt: string;
}

export type InviteStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

export interface InviteView {
  id: string;
  email: string;
  role: HumanRole;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
  invitedBy: { id: string; name: string };
}

export interface CreateInviteResponse {
  invite: InviteView;
  acceptUrl: string;
  mail: MailDeliveryView;
}

export const MAIL_PROVIDERS = ['smtp', 'memory', 'off'] as const;

export type MailProvider = (typeof MAIL_PROVIDERS)[number];

export const MAIL_DELIVERY_STATUSES = [
  'sent',
  'captured',
  'failed',
  'not_configured',
] as const;

export type MailDeliveryStatus = (typeof MAIL_DELIVERY_STATUSES)[number];

export interface MailDeliveryView {
  id: string;
  provider: MailProvider;
  status: MailDeliveryStatus;
  errorCode: string | null;
  message: string;
  sentAt: string | null;
}

export interface PasswordResetRequestResponse {
  ok: true;
  message: string;
  devMailbox: boolean;
}

export interface ChangePasswordResponse {
  ok: true;
  revokedOtherSessions: number;
}

export interface CompletePasswordResetResponse {
  ok: true;
}

export interface DevMailboxMessage {
  id: string;
  to: string;
  subject: string;
  text: string;
  template: 'workspace_invite' | 'password_reset';
  createdAt: string;
}

export interface DevMailboxResponse {
  mode: 'memory';
  delivered: false;
  messages: DevMailboxMessage[];
}

export interface InvitePreviewResponse {
  workspaceName: string;
  email: string;
  role: HumanRole;
  expiresAt: string;
  accountExists: boolean;
}

export type ImportChaptersInput = z.infer<typeof importChaptersSchema>;

export interface ImportedChapterSummary {
  id: string;
  number: number;
  title: string;
  wordCount: number;
}

export interface ImportChaptersResponse {
  workId: string;
  workTitle: string;
  volumeId: string;
  volumeTitle: string;
  imported: ImportedChapterSummary[];
}

export interface ChapterListItem {
  id: string;
  workId: string;
  workTitle: string;
  number: number;
  title: string;
  status: ChapterStatus;
  volumeTitle: string;
  wordCount: number | null;
  currentVersionNo: number | null;
  updatedAt: string;
}

export interface DraftView {
  id: string;
  branchId: string;
  content: string;
  contentHash: string;
  wordCount: number;
  updatedAt: string;
}

export interface LeaseView {
  userId: string;
  userName: string;
  expiresAt: string;
}

export interface RulesetView {
  id: string;
  key: string;
  version: number;
  description: string;
  isProduction: boolean;
}

export interface GateLedgerHintEntryView {
  id: string;
  kind: LedgerEntryKind;
  name: string;
  scope: LedgerEntryScope;
  versionNo: number;
}

export interface GateHintView {
  gate: 'core_entity' | 'causality';
  terms: string[];
  message: string;
  entries: GateLedgerHintEntryView[];
}

export interface GateEvaluationView {
  id: string;
  chapterId: string;
  contentHash: string;
  contextHash: string;
  ruleset: RulesetView;
  status: GateEvaluationResult['status'];
  results: GateEvaluationResult['results'];
  hints: GateHintView[];
  createdAt: string;
}

export interface StagedDraftView {
  id: string;
  chapterId: string;
  contentHash: string;
  wordCount: number;
  evaluationId: string;
  stagedBy: string;
  stagedByName: string;
  stagedAt: string;
}

export interface VersionSummary {
  id: string;
  versionNo: number;
  source: 'human' | 'ai' | 'rollback' | 'import' | 'batch';
  wordCount: number;
  contentHash: string;
  actorName: string | null;
  gateStatus: 'passed' | 'waived' | 'not_evaluated';
  evaluationId: string | null;
  waiverId: string | null;
  contentPreview: string;
  createdAt: string;
}

export interface WaiverView {
  id: string;
  chapterId: string;
  targetVersionId: string | null;
  gateKey: WaiverGateKey;
  reason: string;
  status: WaiverStatus;
  requestedBy: string;
  requestedByName: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface VersionDetail extends VersionSummary {
  content: string;
  parentVersionId: string | null;
  evaluation: GateEvaluationView | null;
  waiver: WaiverView | null;
}

export interface IndexStatusView {
  status: 'pending' | 'indexing' | 'ready' | 'failed' | 'not_configured';
  detail: string | null;
  versionId: string;
  versionNo: number | null;
  chunkCount: number;
  providerName: string | null;
  model: string | null;
  dimensions: number | null;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface RetrievalCoverageView {
  totalCanonChapters: number;
  ready: number;
  indexing: number;
  pending: number;
  failed: number;
  notConfigured: number;
  stale: number;
  chunks: number;
  vectorChunks: number;
  vectorModel: string | null;
}

export interface SearchResultView {
  chunkId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  versionId: string;
  versionNo: number;
  paragraphStart: number;
  paragraphEnd: number;
  excerpt: string;
  lexicalRank: number | null;
  vectorRank: number | null;
  lexicalScore: number | null;
  vectorScore: number | null;
  rrfScore: number;
}

export interface LedgerRetrievalCoverageView {
  activeEntries: number;
  indexedEntries: number;
  chunks: number;
  vectorChunks: number;
  vectorModel: string | null;
}

export interface SearchLedgerResultView {
  chunkId: string;
  entryId: string;
  kind: LedgerEntryKind;
  name: string;
  aliases: string[];
  scope: LedgerEntryScope;
  workId: string | null;
  sourceChapterId: string | null;
  sourceChapterNumber: number | null;
  sourceChapterTitle: string | null;
  versionId: string;
  versionNo: number;
  excerpt: string;
  lexicalRank: number | null;
  vectorRank: number | null;
  lexicalScore: number | null;
  vectorScore: number | null;
  rrfScore: number;
}

export interface SearchResponse {
  query: string;
  mode: 'hybrid' | 'lexical';
  semanticReason: string | null;
  results: SearchResultView[];
  coverage: RetrievalCoverageView;
  ledgerResults: SearchLedgerResultView[];
  ledgerCoverage: LedgerRetrievalCoverageView;
  ledgerReason: string | null;
}

export interface ReindexResponse {
  queued: number;
  alreadyQueued: number;
  skipped: number;
  message: string;
}

export interface ChapterDetail {
  id: string;
  workId: string;
  volumeId: string;
  number: number;
  title: string;
  status: ChapterStatus;
  plan: ChapterPlan;
  wordCount: number | null;
  currentVersion: VersionSummary | null;
  draft: DraftView | null;
  lease: LeaseView | null;
  latestEvaluation: GateEvaluationView | null;
  stagedDraft: StagedDraftView | null;
  versions: VersionSummary[];
  waivers: WaiverView[];
  indexStatus: IndexStatusView | null;
  ruleset: RulesetView | null;
  canEdit: boolean;
}

export interface AuditReport {
  audits: AuditResult[];
  advisoryOnly: true;
}

export interface SaveDraftResponse {
  draft: DraftView;
  chapterStatus: ChapterStatus;
}

export interface LeaseResponse {
  lease: LeaseView;
}

export interface StageResponse {
  stagedDraft: StagedDraftView;
  chapterStatus: 'staged';
}

export interface CommitResponse {
  chapterId: string;
  versionId: string;
  versionNo: number;
  status: 'canon';
  indexStatus: IndexStatusView;
  alreadyCommitted: boolean;
  waiverId: string | null;
}

export interface StartRevisionResponse {
  chapterId: string;
  status: 'revision';
  baseVersionId: string;
  baseVersionNo: number;
  draft: DraftView;
  lease: LeaseView;
}

export interface AbandonRevisionResponse {
  chapterId: string;
  status: 'canon';
  currentVersionId: string;
}

export interface RollbackResponse {
  chapterId: string;
  versionId: string;
  versionNo: number;
  status: 'canon';
  targetVersionId: string;
  previousVersionId: string;
  evidence: 'reused' | 'waived';
  evaluationId: string | null;
  waiverId: string | null;
  indexStatus: IndexStatusView;
  alreadyCommitted: boolean;
}

export interface ModelProviderLastTest {
  status: 'ok' | 'failed';
  message: string;
  latencyMs: number | null;
  testedAt: string;
}

export interface ModelProviderView {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  purpose: ModelProviderPurpose;
  isEnabled: boolean;
  priority: number;
  promptPricePer1m: number | null;
  completionPricePer1m: number | null;
  priceCurrency: PriceCurrency;
  hasKey: boolean;
  keyHint: string | null;
  lastTest: ModelProviderLastTest | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderListResponse {
  providers: ModelProviderView[];
  keyEncryption: {
    algorithm: 'aes-256-gcm';
    secretSource: 'dedicated' | 'session';
  };
}

export interface ModelProviderTestResult {
  status: 'ok' | 'failed';
  message: string;
  latencyMs: number;
  modelCount: number | null;
  configuredModelAvailable: boolean | null;
  testedAt: string;
}

export interface ModelProviderTestResponse {
  result: ModelProviderTestResult;
  provider: ModelProviderView;
}

export interface ModelDiscoveryResponse {
  models: string[];
  latencyMs: number;
  message: string;
}

export interface EmbeddingProbeResponse {
  supported: boolean;
  model: string;
  dimensions: number | null;
  latencyMs: number;
  usage: AiProposalUsageView | null;
  message: string;
}

export interface AiContextSectionView {
  key: string;
  label: string;
  chars: number;
  usedChars: number;
  truncated: boolean;
}

export interface AiRetrievalCitationView {
  ref: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  versionId: string;
  versionNo: number;
  paragraphStart: number;
  paragraphEnd: number;
  chars: number;
}

export interface AiRetrievalView {
  status: 'ok' | 'lexical' | 'unavailable';
  reason: string | null;
  citations: AiRetrievalCitationView[];
  coverage: RetrievalCoverageView | null;
}

export interface AiLedgerCitationView {
  ref: string;
  entryId: string;
  kind: LedgerEntryKind;
  name: string;
  scope: LedgerEntryScope;
  workId: string | null;
  versionId: string;
  versionNo: number;
  chars: number;
  truncated: boolean;
}

export interface AiLedgerContextView {
  status: 'ok' | 'unavailable';
  reason: string | null;
  citations: AiLedgerCitationView[];
  usedCharacters: string[];
  truncated: boolean;
}

export interface AiProposalContextView {
  promptVersion: string;
  sections: AiContextSectionView[];
  unavailable: string[];
  retrieval?: AiRetrievalView;
  ledger?: AiLedgerContextView;
}

export interface AiProposalUsageView {
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface AiProposalMeta {
  proposalId: string;
  providerName: string;
  model: string;
  mode: AiProposalMode;
  context: AiProposalContextView;
  baseDraftHash: string | null;
  candidateCount: number;
  skippedProviderCount: number;
  startedAt: string;
}

export interface AiProposalView {
  id: string;
  chapterId: string;
  mode: AiProposalMode;
  providerName: string;
  model: string;
  status: 'generating' | 'ready' | 'failed';
  content: string;
  contentHash: string | null;
  wordCount: number;
  instruction: string;
  targetWords: number;
  context: AiProposalContextView;
  usage: AiProposalUsageView;
  attempts: number;
  cost: number | null;
  costCurrency: string | null;
  latencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  baseDraftHash: string | null;
  createdByName: string;
  createdAt: string;
  completedAt: string | null;
}

export interface AiProposalDeltaEvent {
  text: string;
}

export interface AiProposalAttemptEvent {
  attempt: number;
  status: 'retrying' | 'failover';
  providerName: string;
  model: string;
  errorCode: string;
  message: string;
  nextProviderName: string;
  nextModel: string;
}

export interface AiProposalDoneEvent {
  proposal: AiProposalView;
}

export interface AiProposalErrorEvent {
  code: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type GateKeyName = GateKey;

export const AUTOMATION_JOB_STATUSES = [
  'queued',
  'precheck_failed',
  'running',
  'paused',
  'stopped',
  'completed',
  'failed',
  'interrupted',
] as const;

export type AutomationJobStatus = (typeof AUTOMATION_JOB_STATUSES)[number];

export const AUTOMATION_JOB_CHAPTER_STATUSES = [
  'pending',
  'running',
  'committed',
  'staged',
  'gate_failed',
  'no_output',
  'failed',
  'skipped',
  'interrupted',
] as const;

export type AutomationJobChapterStatus = (typeof AUTOMATION_JOB_CHAPTER_STATUSES)[number];

export const AUTOMATION_MANDATE_STATUSES = ['active', 'revoked', 'expired'] as const;

export type AutomationMandateStatus = (typeof AUTOMATION_MANDATE_STATUSES)[number];

export const automationMandateInputSchema = z
  .object({
    workId: z.string().uuid(),
    name: z.string().trim().min(1, '请填写授权名称').max(80),
    mode: z.literal('continue').optional().default('continue'),
    chapterMin: z.number().int().min(1).max(10_000),
    chapterMax: z.number().int().min(1).max(10_000),
    maxChapters: z.number().int().min(1).max(50),
    targetWords: z.number().int().min(300).max(4000),
    instruction: z.string().trim().max(2000).optional().default(''),
    allowAutoCommit: z.boolean().optional().default(false),
    allowRemoteModels: z.boolean().optional().default(false),
    allowNonProductionGates: z.boolean().optional().default(false),
    budgetLimit: z.number().positive().max(1_000_000).nullable().optional().default(null),
    budgetCurrency: priceCurrencySchema.optional().default('CNY'),
    expiresInHours: z.number().int().min(1).max(720).optional().default(24),
  })
  .refine((value) => value.chapterMax >= value.chapterMin, '结束章号不能小于起始章号');

export type AutomationMandateInput = z.infer<typeof automationMandateInputSchema>;

export const automationJobInputSchema = z.object({
  mandateId: z.string().uuid(),
  chapterIds: z.array(z.string().uuid()).min(1).max(50),
});

export type AutomationJobInput = z.infer<typeof automationJobInputSchema>;

export type AutomationCheckStatus = 'pass' | 'warn' | 'fail';

export interface AutomationPreflightCheck {
  key: string;
  label: string;
  status: AutomationCheckStatus;
  detail: string;
}

export interface AutomationPreflightChapter {
  id: string;
  number: number;
  title: string;
  status: ChapterStatus;
}

export interface AutomationPreflightView {
  ok: boolean;
  checks: AutomationPreflightCheck[];
  chapters: AutomationPreflightChapter[];
  providerNames: string[];
  unknownCost: boolean;
  budgetRemaining: number | null;
  budgetCurrency: PriceCurrency;
  generatedAt: string;
}

export interface AutomationMandateView {
  id: string;
  workId: string;
  workTitle: string;
  name: string;
  mode: 'continue';
  chapterMin: number;
  chapterMax: number;
  maxChapters: number;
  targetWords: number;
  instruction: string;
  allowAutoCommit: boolean;
  allowRemoteModels: boolean;
  allowNonProductionGates: boolean;
  budgetLimit: number | null;
  budgetCurrency: PriceCurrency;
  status: AutomationMandateStatus;
  expiresAt: string;
  createdBy: string;
  createdByName: string;
  revokedAt: string | null;
  revokedByName: string | null;
  createdAt: string;
}

export interface AutomationJobChapterView {
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  status: AutomationJobChapterStatus;
  proposalId: string | null;
  versionId: string | null;
  evaluationId: string | null;
  reason: string | null;
  cost: number | null;
  costCurrency: PriceCurrency | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AutomationJobView {
  id: string;
  workspaceId: string;
  workId: string;
  workTitle: string;
  mandateId: string;
  mandateName: string;
  status: AutomationJobStatus;
  preflight: AutomationPreflightView;
  totalChapters: number;
  committedChapters: number;
  stagedChapters: number;
  failedChapters: number;
  skippedChapters: number;
  spent: number;
  costCurrency: PriceCurrency;
  costUnknown: boolean;
  runnerId: string | null;
  heartbeatAt: string | null;
  currentChapterId: string | null;
  pauseRequested: boolean;
  stopRequested: boolean;
  lastError: string | null;
  createdBy: string;
  createdByName: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  chapters: AutomationJobChapterView[];
}

export interface AutomationMandateListResponse {
  mandates: AutomationMandateView[];
}

export interface AutomationJobListResponse {
  jobs: AutomationJobView[];
}

export type BillingBudgetState = 'not_configured' | 'ok' | 'exhausted' | 'unpriced_calls';

export interface BillingBudgetView {
  monthlyLimit: number | null;
  currency: PriceCurrency;
  updatedAt: string | null;
  updatedBy: UserSummary | null;
}

export interface BillingBudgetUsageView {
  state: BillingBudgetState;
  currency: PriceCurrency;
  monthlyLimit: number | null;
  knownSpent: number;
  reserved: number;
  remaining: number | null;
  unknownGenerationCalls: number;
  otherCurrencyGenerationCalls: number;
  note: string;
}

export interface BillingMoneyView {
  currency: PriceCurrency;
  knownCost: number;
  calls: number;
  reservedCost: number;
  activeCalls: number;
}

export interface BillingBreakdownView {
  key: string;
  label: string;
  detail: string | null;
  costs: BillingMoneyView[];
  unknownCalls: number;
}

export interface BillingProviderPriceView {
  id: string;
  name: string;
  model: string;
  purpose: ModelProviderPurpose;
  isEnabled: boolean;
  priority: number;
  promptPricePer1m: number | null;
  completionPricePer1m: number | null;
  priceCurrency: PriceCurrency;
  pricingStatus: 'complete' | 'incomplete';
  updatedAt: string;
}

export interface BillingUnknownCallView {
  id: string;
  createdAt: string;
  purpose: string;
  purposeLabel: string;
  providerName: string | null;
  model: string;
  status: string;
  errorCode: string | null;
  actorName: string | null;
  chapterId: string | null;
  chapterNumber: number | null;
  chapterTitle: string | null;
  jobId: string | null;
}

export interface BillingReportResponse {
  workspaceId: string;
  month: string;
  rangeStart: string;
  rangeEnd: string;
  generatedAt: string;
  budget: BillingBudgetView;
  budgetUsage: BillingBudgetUsageView;
  providers: BillingProviderPriceView[];
  totals: BillingMoneyView[];
  totalCalls: number;
  unknownCallTotal: number;
  blockedCallTotal: number;
  byPurpose: BillingBreakdownView[];
  byMember: BillingBreakdownView[];
  byJob: BillingBreakdownView[];
  byChapter: BillingBreakdownView[];
  unknownCalls: BillingUnknownCallView[];
}

export type ProviderBillStatus = 'imported' | 'reviewed' | 'disputed';

export interface ProviderBillView {
  id: string;
  providerId: string;
  providerName: string;
  invoiceNo: string;
  periodStart: string;
  periodEnd: string;
  currency: PriceCurrency;
  declaredTotal: number | null;
  linesTotal: number;
  lineCount: number;
  status: ProviderBillStatus;
  reviewNote: string | null;
  reviewedBy: UserSummary | null;
  reviewedAt: string | null;
  importedBy: UserSummary | null;
  createdAt: string;
}

export interface ProviderBillListResponse {
  bills: ProviderBillView[];
}

export type ProviderBillModelStatus =
  | 'match'
  | 'amount_mismatch'
  | 'local_only'
  | 'bill_only'
  | 'local_unknown'
  | 'currency_mismatch';

export interface ProviderBillModelComparison {
  model: string;
  status: ProviderBillModelStatus;
  billLineCount: number;
  billAmount: number;
  billInputTokens: number | null;
  billOutputTokens: number | null;
  localCalls: number;
  localAmount: number;
  localInputTokens: number | null;
  localOutputTokens: number | null;
  deltaAmount: number;
  inputTokenDelta: number | null;
  outputTokenDelta: number | null;
  tokenStatus: 'match' | 'mismatch' | 'not_comparable';
  unknownCalls: number;
  otherCurrencyCalls: number;
}

export interface ProviderBillReconciliationSummary {
  billLinesTotal: number;
  declaredTotal: number | null;
  declaredVsLines: number | null;
  localKnownTotal: number;
  deltaTotal: number;
  mismatchModels: number;
  unknownCalls: number;
  otherCurrencyCalls: number;
  blockedCalls: number;
}

export interface ProviderBillReconciliationResponse {
  bill: ProviderBillView;
  rangeStart: string;
  rangeEnd: string;
  summary: ProviderBillReconciliationSummary;
  models: ProviderBillModelComparison[];
  note: string;
}

export const LEDGER_ENTRY_KINDS = ['setting', 'character', 'foreshadowing'] as const;

export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

export const ledgerEntryKindSchema = z.enum(LEDGER_ENTRY_KINDS);

export const LEDGER_ENTRY_STATUSES = ['draft', 'active', 'archived'] as const;

export type LedgerEntryStatus = (typeof LEDGER_ENTRY_STATUSES)[number];

export const ledgerEntryStatusSchema = z.enum(LEDGER_ENTRY_STATUSES);

export const LEDGER_ENTRY_SCOPES = ['workspace', 'work'] as const;

export type LedgerEntryScope = (typeof LEDGER_ENTRY_SCOPES)[number];

export const LEDGER_SETTING_CATEGORIES = [
  'world',
  'location',
  'faction',
  'rule',
  'item',
  'other',
] as const;

export type LedgerSettingCategory = (typeof LEDGER_SETTING_CATEGORIES)[number];

export const LEDGER_VERIFICATION_STATES = [
  'verified',
  'unverified',
  'to_design',
  'deprecated',
] as const;

export type LedgerVerificationState = (typeof LEDGER_VERIFICATION_STATES)[number];

export const LEDGER_CHARACTER_LIFE_STATES = ['alive', 'dead', 'unknown'] as const;

export type LedgerCharacterLifeState = (typeof LEDGER_CHARACTER_LIFE_STATES)[number];

export const LEDGER_FORESHADOWING_STATES = [
  'planted',
  'reinforced',
  'paid_off',
  'abandoned',
] as const;

export type LedgerForeshadowingState = (typeof LEDGER_FORESHADOWING_STATES)[number];

export const LEDGER_FORESHADOWING_IMPORTANCE = ['low', 'medium', 'high'] as const;

export type LedgerForeshadowingImportance =
  (typeof LEDGER_FORESHADOWING_IMPORTANCE)[number];

const ledgerNameSchema = z.string().trim().min(1, '请填写名称').max(120, '名称不能超过 120 字');
const ledgerAliasSchema = z.string().trim().min(1).max(120, '别名不能超过 120 字');
const ledgerAliasesSchema = z.array(ledgerAliasSchema).max(20, '别名最多 20 个').default([]);

export const ledgerSettingPayloadSchema = z.object({
  category: z.enum(LEDGER_SETTING_CATEGORIES),
  details: z.string().trim().max(20_000, '详细说明不能超过 20000 字').default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(20, '标签最多 20 个').default([]),
  verification: z.enum(LEDGER_VERIFICATION_STATES).default('unverified'),
});

export const ledgerCharacterStateSchema = z.object({
  asOfChapterId: z.string().uuid(),
  life: z.enum(LEDGER_CHARACTER_LIFE_STATES).default('unknown'),
  location: z.string().trim().max(200).default(''),
  knowledge: z.string().trim().max(5000).default(''),
  possessions: z.string().trim().max(2000).default(''),
  relationshipChanges: z.string().trim().max(2000).default(''),
});

export const ledgerCharacterPayloadSchema = z.object({
  role: z.string().trim().max(80).default(''),
  appearance: z.string().trim().max(5000).default(''),
  personality: z.string().trim().max(5000).default(''),
  goals: z.string().trim().max(5000).default(''),
  faction: z.string().trim().max(200).default(''),
  abilities: z.string().trim().max(5000).default(''),
  speechStyle: z.string().trim().max(2000).default(''),
  relationships: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        relation: z.string().trim().min(1).max(200),
        notes: z.string().trim().max(1000).default(''),
      }),
    )
    .max(50, '关系最多 50 条')
    .default([]),
  states: z.array(ledgerCharacterStateSchema).max(200, '状态时间线最多 200 条').default([]),
});

export const ledgerForeshadowingPayloadSchema = z
  .object({
    seedChapterId: z.string().uuid(),
    payoffChapterMin: z.number().int().min(1).max(99_999).nullable().default(null),
    payoffChapterMax: z.number().int().min(1).max(99_999).nullable().default(null),
    importance: z.enum(LEDGER_FORESHADOWING_IMPORTANCE).default('medium'),
    state: z.enum(LEDGER_FORESHADOWING_STATES).default('planted'),
    payoffChapterId: z.string().uuid().nullable().default(null),
    note: z.string().trim().max(10_000, '伏笔说明不能超过 10000 字').default(''),
    resolutionNote: z
      .string()
      .trim()
      .max(5000, '回收或放弃说明不能超过 5000 字')
      .default(''),
  })
  .superRefine((value, ctx) => {
    if (
      value.payoffChapterMin !== null &&
      value.payoffChapterMax !== null &&
      value.payoffChapterMin > value.payoffChapterMax
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '计划回收起始章不能大于结束章',
        path: ['payoffChapterMin'],
      });
    }
    if (value.state === 'paid_off') {
      if (!value.payoffChapterId) {
        ctx.addIssue({
          code: 'custom',
          message: '已回收伏笔必须填写回收章节',
          path: ['payoffChapterId'],
        });
      }
      if (value.resolutionNote.length < 4) {
        ctx.addIssue({
          code: 'custom',
          message: '已回收伏笔必须填写至少 4 个字的回收说明',
          path: ['resolutionNote'],
        });
      }
    }
    if (value.state === 'abandoned' && value.resolutionNote.length < 4) {
      ctx.addIssue({
        code: 'custom',
        message: '已放弃伏笔必须填写至少 4 个字的放弃原因',
        path: ['resolutionNote'],
      });
    }
    if (value.state !== 'paid_off' && value.payoffChapterId) {
      ctx.addIssue({
        code: 'custom',
        message: '只有已回收的伏笔可以绑定回收章节',
        path: ['payoffChapterId'],
      });
    }
  });

export type LedgerSettingPayload = z.infer<typeof ledgerSettingPayloadSchema>;
export type LedgerCharacterPayload = z.infer<typeof ledgerCharacterPayloadSchema>;
export type LedgerForeshadowingPayload = z.infer<typeof ledgerForeshadowingPayloadSchema>;
export type LedgerEntryPayload =
  | LedgerSettingPayload
  | LedgerCharacterPayload
  | LedgerForeshadowingPayload;

export interface LedgerEntrySnapshot {
  name: string;
  aliases: string[];
  summary: string;
  sourceChapterId: string | null;
  payload: LedgerEntryPayload;
}

const ledgerEntryBaseShape = {
  name: ledgerNameSchema,
  aliases: ledgerAliasesSchema,
  summary: z.string().trim().max(2000, '摘要不能超过 2000 字').default(''),
  sourceChapterId: z.string().uuid().nullable().optional(),
};

export const createLedgerEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('setting'),
    workId: z.string().uuid().nullable().optional(),
    payload: ledgerSettingPayloadSchema,
    ...ledgerEntryBaseShape,
  }),
  z.object({
    kind: z.literal('character'),
    workId: z.string().uuid(),
    payload: ledgerCharacterPayloadSchema,
    ...ledgerEntryBaseShape,
  }),
  z.object({
    kind: z.literal('foreshadowing'),
    workId: z.string().uuid(),
    payload: ledgerForeshadowingPayloadSchema,
    ...ledgerEntryBaseShape,
  }),
]);

export type CreateLedgerEntryInput = z.infer<typeof createLedgerEntrySchema>;

export const updateLedgerDraftSchema = z
  .object({
    expectedDraftVersionId: z.string().uuid().nullable(),
    name: ledgerNameSchema.optional(),
    aliases: ledgerAliasesSchema.optional(),
    summary: z.string().trim().max(2000, '摘要不能超过 2000 字').optional(),
    sourceChapterId: z.string().uuid().nullable().optional(),
    payload: z.unknown().optional(),
    changeSummary: z.string().trim().max(500).optional().default(''),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.aliases !== undefined ||
      value.summary !== undefined ||
      value.sourceChapterId !== undefined ||
      value.payload !== undefined,
    '至少提供一个修改字段',
  );

export type UpdateLedgerDraftInput = z.infer<typeof updateLedgerDraftSchema>;

export const publishLedgerEntrySchema = z.object({
  expectedDraftVersionId: z.string().uuid(),
  changeSummary: z.string().trim().max(500).optional().default(''),
});

export type PublishLedgerEntryInput = z.infer<typeof publishLedgerEntrySchema>;

export const archiveLedgerEntrySchema = z.object({
  reason: z.string().trim().max(1000).optional().default(''),
  discardDraft: z.boolean().optional().default(false),
});

export type ArchiveLedgerEntryInput = z.infer<typeof archiveLedgerEntrySchema>;

export const rollbackLedgerEntrySchema = z.object({
  targetVersionNo: z.number().int().min(1),
  expectedDraftVersionId: z.string().uuid().nullable(),
  reason: z.string().trim().min(4, '请填写至少 4 个字的回滚原因').max(1000),
});

export type RollbackLedgerEntryInput = z.infer<typeof rollbackLedgerEntrySchema>;

export const listLedgerEntriesQuerySchema = z.object({
  kind: ledgerEntryKindSchema.optional(),
  status: ledgerEntryStatusSchema.optional(),
  workId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

export type ListLedgerEntriesQuery = z.infer<typeof listLedgerEntriesQuerySchema>;

export interface LedgerEntryVersionView {
  id: string;
  versionNo: number;
  snapshot: LedgerEntrySnapshot;
  changeSummary: string;
  createdBy: UserSummary | null;
  createdAt: string;
}

export interface LedgerEntrySummary {
  id: string;
  workId: string | null;
  kind: LedgerEntryKind;
  scope: LedgerEntryScope;
  name: string;
  aliases: string[];
  summary: string;
  status: LedgerEntryStatus;
  sourceChapterId: string | null;
  currentVersionNo: number | null;
  draftVersionNo: number | null;
  foreshadowing?: LedgerForeshadowingSummary | null;
  updatedAt: string;
}

export interface LedgerEntryDetail extends LedgerEntrySummary {
  currentVersion: LedgerEntryVersionView | null;
  draftVersion: LedgerEntryVersionView | null;
  createdBy: UserSummary | null;
  updatedBy: UserSummary | null;
  createdAt: string;
}

export interface LedgerEntryListResponse {
  entries: LedgerEntrySummary[];
}

export const createChapterLedgerLinkSchema = z.object({
  entryId: z.string().uuid(),
  note: z.string().trim().max(500, '关联备注不能超过 500 字').optional().default(''),
});

export type CreateChapterLedgerLinkInput = z.infer<typeof createChapterLedgerLinkSchema>;

export interface ChapterLedgerLinkView {
  id: string;
  chapterId: string;
  entryId: string;
  kind: LedgerEntryKind;
  name: string;
  status: LedgerEntryStatus;
  scope: LedgerEntryScope;
  workId: string | null;
  versionId: string | null;
  versionNo: number | null;
  note: string;
  createdByName: string | null;
  createdAt: string;
}

export interface ChapterLedgerLinksResponse {
  links: ChapterLedgerLinkView[];
  note: string;
}

export const LEDGER_SUGGESTION_KINDS = ['character_state', 'foreshadowing_state'] as const;

export type LedgerSuggestionKind = (typeof LEDGER_SUGGESTION_KINDS)[number];

export const LEDGER_SUGGESTION_STATUSES = [
  'generating',
  'ready',
  'failed',
  'applying',
  'accepted',
  'rejected',
] as const;

export type LedgerSuggestionStatus = (typeof LEDGER_SUGGESTION_STATUSES)[number];

export const ledgerCharacterStateSuggestionSchema = z.object({
  kind: z.literal('character_state'),
  asOfChapterNumber: z.number().int().min(1).max(99_999),
  life: z.enum(LEDGER_CHARACTER_LIFE_STATES),
  location: z.string().trim().max(200).default(''),
  knowledge: z.string().trim().max(5000).default(''),
  possessions: z.string().trim().max(2000).default(''),
  relationshipChanges: z.string().trim().max(2000).default(''),
});

export const ledgerForeshadowingStateSuggestionSchema = z
  .object({
    kind: z.literal('foreshadowing_state'),
    state: z.enum(['reinforced', 'paid_off', 'abandoned']),
    payoffChapterNumber: z.number().int().min(1).max(99_999).nullable().default(null),
    resolutionNote: z.string().trim().max(5000).default(''),
  })
  .superRefine((value, ctx) => {
    if (value.state === 'paid_off' && value.payoffChapterNumber === null) {
      ctx.addIssue({
        code: 'custom',
        message: '建议标记为已回收时必须给出回收章节',
        path: ['payoffChapterNumber'],
      });
    }
    if (value.state === 'paid_off' && value.resolutionNote.trim().length < 4) {
      ctx.addIssue({
        code: 'custom',
        message: '建议标记为已回收时必须填写至少 4 个字的回收说明',
        path: ['resolutionNote'],
      });
    }
    if (value.state === 'abandoned' && value.resolutionNote.trim().length < 4) {
      ctx.addIssue({
        code: 'custom',
        message: '建议标记为已放弃时必须填写至少 4 个字的说明',
        path: ['resolutionNote'],
      });
    }
  });

export const ledgerSuggestionProposalSchema = z.discriminatedUnion('kind', [
  ledgerCharacterStateSuggestionSchema,
  ledgerForeshadowingStateSuggestionSchema,
]);

export type LedgerSuggestionProposal = z.infer<typeof ledgerSuggestionProposalSchema>;

export const createLedgerSuggestionSchema = z.object({
  basisChapterId: z.string().uuid(),
  instruction: z.string().trim().max(500, '补充说明不能超过 500 字').optional().default(''),
});

export type CreateLedgerSuggestionInput = z.infer<typeof createLedgerSuggestionSchema>;

export const decideLedgerSuggestionSchema = z.object({
  note: z.string().trim().max(1000, '确认说明不能超过 1000 字').optional().default(''),
});

export type DecideLedgerSuggestionInput = z.infer<typeof decideLedgerSuggestionSchema>;

export interface LedgerSuggestionEvidenceView {
  type: 'chapter' | 'ledger_version';
  label: string;
  detail: string | null;
  truncated: boolean;
}

export interface LedgerSuggestionView {
  id: string;
  entryId: string;
  entryName: string;
  entryKind: LedgerEntryKind;
  kind: LedgerSuggestionKind;
  status: LedgerSuggestionStatus;
  baseVersionNo: number | null;
  basisChapter: LedgerChapterRef | null;
  instruction: string;
  providerName: string;
  model: string;
  promptVersion: string;
  proposal: LedgerSuggestionProposal | null;
  rationale: string;
  evidence: LedgerSuggestionEvidenceView[];
  usage: AiProposalUsageView;
  cost: number | null;
  costCurrency: PriceCurrency | null;
  latencyMs: number | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdByName: string | null;
  createdAt: string;
  completedAt: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string;
  resultDraftVersionNo: number | null;
}

export interface LedgerSuggestionListResponse {
  suggestions: LedgerSuggestionView[];
  note: string;
}

export interface LedgerEntryVersionListResponse {
  versions: LedgerEntryVersionView[];
}

export interface LedgerChapterRef {
  id: string;
  number: number;
  title: string;
}

export interface LedgerForeshadowingSummary {
  state: LedgerForeshadowingState;
  importance: LedgerForeshadowingImportance;
  seedChapter: LedgerChapterRef;
  payoffChapterMin: number | null;
  payoffChapterMax: number | null;
  payoffChapter: LedgerChapterRef | null;
  resolutionNote: string;
  latestCanonChapter: LedgerChapterRef | null;
  overdue: boolean;
  overdueBy: number | null;
  basis: 'current' | 'draft';
}

export interface LedgerForeshadowingReportItem extends LedgerForeshadowingSummary {
  id: string;
  workId: string;
  name: string;
  summary: string;
  note: string;
  versionNo: number;
}

export interface LedgerForeshadowingReportSummary {
  total: number;
  unresolved: number;
  overdue: number;
  paidOff: number;
  abandoned: number;
}

export interface LedgerForeshadowingReport {
  workId: string | null;
  items: LedgerForeshadowingReportItem[];
  summary: LedgerForeshadowingReportSummary;
  note: string;
}

export type LedgerForeshadowingReminderReason = 'in_window' | 'overdue';

export interface LedgerForeshadowingReminderItem extends LedgerForeshadowingSummary {
  id: string;
  workId: string;
  name: string;
  summary: string;
  note: string;
  versionNo: number;
  reason: LedgerForeshadowingReminderReason;
  message: string;
}

export interface LedgerForeshadowingReminders {
  chapterId: string;
  chapter: LedgerChapterRef;
  latestCanonChapter: LedgerChapterRef | null;
  reminders: LedgerForeshadowingReminderItem[];
  note: string;
}

export interface LedgerCharacterStateEntry {
  chapter: LedgerChapterRef;
  life: LedgerCharacterLifeState;
  location: string;
  knowledge: string;
  possessions: string;
  relationshipChanges: string;
}

export interface LedgerCharacterAppearance {
  chapter: LedgerChapterRef;
  matches: number;
}

export type LedgerCharacterWarningCode =
  | 'dead_revived'
  | 'dead_appears_later'
  | 'relationship_conflict';

export interface LedgerCharacterWarning {
  code: LedgerCharacterWarningCode;
  severity: 'warning';
  message: string;
  chapterId: string | null;
}

export interface LedgerCharacterTimeline {
  entryId: string;
  workId: string;
  name: string;
  aliases: string[];
  versionNo: number;
  states: LedgerCharacterStateEntry[];
  appearances: LedgerCharacterAppearance[];
  firstAppearance: LedgerChapterRef | null;
  latestAppearance: LedgerChapterRef | null;
  warnings: LedgerCharacterWarning[];
  scanScope: 'canon_current';
}

export interface LedgerCharacterContextItem {
  id: string;
  name: string;
  state: LedgerCharacterStateEntry;
  stale: boolean;
}

export interface LedgerCharacterContext {
  chapterId: string;
  chapter: LedgerChapterRef;
  asOfChapter: LedgerChapterRef | null;
  characters: LedgerCharacterContextItem[];
  omittedCharacters: number;
  note: string;
}
