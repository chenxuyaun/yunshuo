import type {
  AbandonRevisionResponse,
  AiProposalAttemptEvent,
  AuthConfigResponse,
  AiProposalDoneEvent,
  AiProposalDeltaEvent,
  AiProposalErrorEvent,
  AiProposalMeta,
  AiProposalMode,
  AiProposalView,
  AuditReport,
  AutomationJobInput,
  AutomationJobListResponse,
  AutomationJobView,
  AutomationMandateInput,
  AutomationMandateListResponse,
  AutomationMandateView,
  AutomationPreflightView,
  BillingBudgetView,
  BillingProviderPriceView,
  BillingReportResponse,
  ChapterDetail,
  ChapterListItem,
  ChangePasswordResponse,
  CommitResponse,
  CompletePasswordResetResponse,
  CreateInviteResponse,
  DevMailboxResponse,
  EmbeddingProbeResponse,
  GateEvaluationView,
  ImportChaptersInput,
  ImportChaptersResponse,
  InvitePreviewResponse,
  InviteView,
  LeaseResponse,
  LedgerEntryDetail,
  LedgerEntryKind,
  LedgerEntryListResponse,
  LedgerEntryStatus,
  LedgerEntryVersionListResponse,
  LedgerCharacterContext,
  LedgerCharacterTimeline,
  MemberView,
  MeResponse,
  ModelDiscoveryResponse,
  ModelProviderListResponse,
  ModelProviderPurpose,
  ModelProviderTestResponse,
  ModelProviderView,
  PasswordResetRequestResponse,
  ProviderBillListResponse,
  ProviderBillReconciliationResponse,
  ProviderBillView,
  PublishLedgerEntryInput,
  ReindexResponse,
  RollbackLedgerEntryInput,
  RollbackResponse,
  SaveDraftResponse,
  SearchResponse,
  StageResponse,
  StartRevisionResponse,
  UpdateLedgerDraftInput,
  VersionDetail,
  WaiverGateKey,
  WaiverView,
  WorkspaceMembershipsResponse,
  ArchiveLedgerEntryInput,
  CreateLedgerEntryInput,
} from '@yunshuo/contracts';
import type { HumanRole, Role } from '@yunshuo/domain';
import type { PriceCurrency } from '@yunshuo/contracts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      body?.error?.details,
    );
  }

  return payload as T;
}

export interface DevUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export function getMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/me');
}

export function getAuthConfig(): Promise<AuthConfigResponse> {
  return request<AuthConfigResponse>('/api/auth/config');
}

export function login(email: string, password?: string): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(password === undefined ? { email } : { email, password }),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResponse> {
  return request<ChangePasswordResponse>('/api/auth/password/change', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function requestPasswordReset(email: string): Promise<PasswordResetRequestResponse> {
  return request<PasswordResetRequestResponse>('/api/auth/password/reset-request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function completePasswordReset(
  token: string,
  newPassword: string,
): Promise<CompletePasswordResetResponse> {
  return request<CompletePasswordResetResponse>('/api/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });
}

export function getDevMailbox(): Promise<DevMailboxResponse> {
  return request<DevMailboxResponse>('/api/dev/mailbox');
}

export function listDevUsers(): Promise<DevUser[]> {
  return request<DevUser[]>('/api/dev/users');
}

export function getMyWorkspaces(): Promise<WorkspaceMembershipsResponse> {
  return request<WorkspaceMembershipsResponse>('/api/auth/workspaces');
}

export function switchWorkspace(workspaceId: string): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/workspace', {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  });
}

export function previewInvite(token: string): Promise<InvitePreviewResponse> {
  return request<InvitePreviewResponse>(`/api/invites/${encodeURIComponent(token)}`);
}

export function acceptInvite(
  token: string,
  payload: { name?: string; password?: string },
): Promise<MeResponse> {
  return request<MeResponse>(`/api/invites/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listMembers(): Promise<{ members: MemberView[] }> {
  return request<{ members: MemberView[] }>('/api/workspace/members');
}

export function updateMemberRole(userId: string, role: HumanRole): Promise<MemberView> {
  return request<MemberView>(`/api/workspace/members/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export function removeMember(userId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/workspace/members/${userId}`, {
    method: 'DELETE',
  });
}

export function listInvites(): Promise<{ invites: InviteView[] }> {
  return request<{ invites: InviteView[] }>('/api/workspace/invites');
}

export function createInvite(payload: {
  email: string;
  role: HumanRole;
  expiresInHours?: number;
}): Promise<CreateInviteResponse> {
  return request<CreateInviteResponse>('/api/workspace/invites', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function revokeInvite(inviteId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/workspace/invites/${inviteId}`, {
    method: 'DELETE',
  });
}

export function listChapters(): Promise<ChapterListItem[]> {
  return request<ChapterListItem[]>('/api/chapters');
}

export function importChapters(input: ImportChaptersInput): Promise<ImportChaptersResponse> {
  return request<ImportChaptersResponse>('/api/chapters/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getChapter(chapterId: string): Promise<ChapterDetail> {
  return request<ChapterDetail>(`/api/chapters/${chapterId}`);
}

export function getVersion(versionId: string): Promise<VersionDetail> {
  return request<VersionDetail>(`/api/versions/${versionId}`);
}

export function acquireLease(chapterId: string): Promise<LeaseResponse> {
  return request<LeaseResponse>(`/api/chapters/${chapterId}/lease`, { method: 'POST' });
}

export function releaseLease(chapterId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/chapters/${chapterId}/lease`, { method: 'DELETE' });
}

export function saveDraft(chapterId: string, content: string): Promise<SaveDraftResponse> {
  return request<SaveDraftResponse>(`/api/chapters/${chapterId}/draft`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

export function runGates(chapterId: string): Promise<GateEvaluationView> {
  return request<GateEvaluationView>(`/api/chapters/${chapterId}/gates`, { method: 'POST' });
}

export function runAudits(chapterId: string): Promise<AuditReport> {
  return request<AuditReport>(`/api/chapters/${chapterId}/audits`);
}

export function stageDraft(
  chapterId: string,
  evaluationId: string,
  expectedContentHash: string,
): Promise<StageResponse> {
  return request<StageResponse>(`/api/chapters/${chapterId}/stage`, {
    method: 'POST',
    body: JSON.stringify({ evaluationId, expectedContentHash }),
  });
}

export function unstageDraft(chapterId: string): Promise<{ ok: boolean; status: string }> {
  return request<{ ok: boolean; status: string }>(`/api/chapters/${chapterId}/stage`, {
    method: 'DELETE',
  });
}

export interface CommitPayload {
  idempotencyKey: string;
  targetChapterId: string;
  expectedCurrentVersionId: string | null;
  stagedDraftId: string;
}

export function commitChapter(chapterId: string, payload: CommitPayload): Promise<CommitResponse> {
  return request<CommitResponse>(`/api/chapters/${chapterId}/commit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function startRevision(chapterId: string): Promise<StartRevisionResponse> {
  return request<StartRevisionResponse>(`/api/chapters/${chapterId}/revision`, {
    method: 'POST',
  });
}

export function abandonRevision(chapterId: string): Promise<AbandonRevisionResponse> {
  return request<AbandonRevisionResponse>(`/api/chapters/${chapterId}/revision/abandon`, {
    method: 'POST',
  });
}

export interface RollbackPayload {
  idempotencyKey: string;
  targetVersionId: string;
  expectedCurrentVersionId: string;
  reason: string;
  waiverId?: string | null;
}

export function rollbackChapter(
  chapterId: string,
  payload: RollbackPayload,
): Promise<RollbackResponse> {
  return request<RollbackResponse>(`/api/chapters/${chapterId}/rollback`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface WaiverRequestPayload {
  targetVersionId: string;
  gateKey: WaiverGateKey;
  reason: string;
}

export function requestWaiver(
  chapterId: string,
  payload: WaiverRequestPayload,
): Promise<WaiverView> {
  return request<WaiverView>(`/api/chapters/${chapterId}/waivers`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function decideWaiver(
  chapterId: string,
  waiverId: string,
  decision: 'approve' | 'reject',
  note: string,
): Promise<WaiverView> {
  return request<WaiverView>(
    `/api/chapters/${chapterId}/waivers/${waiverId}/${decision}`,
    {
      method: 'POST',
      body: JSON.stringify({ note }),
    },
  );
}

export interface ProviderPayload {
  name: string;
  baseUrl: string;
  model: string;
  purpose?: ModelProviderPurpose;
  apiKey?: string;
  reuseKeyFromProviderId?: string;
  isEnabled: boolean;
  priority: number;
  promptPricePer1m: number | null;
  completionPricePer1m: number | null;
  priceCurrency: PriceCurrency;
}

export function listModelProviders(): Promise<ModelProviderListResponse> {
  return request<ModelProviderListResponse>('/api/model-providers');
}

export function createModelProvider(payload: ProviderPayload): Promise<ModelProviderView> {
  return request<ModelProviderView>('/api/model-providers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateModelProvider(
  providerId: string,
  payload: Partial<ProviderPayload>,
): Promise<ModelProviderView> {
  return request<ModelProviderView>(`/api/model-providers/${providerId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function deleteModelProvider(providerId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/model-providers/${providerId}`, {
    method: 'DELETE',
  });
}

export function testModelProvider(providerId: string): Promise<ModelProviderTestResponse> {
  return request<ModelProviderTestResponse>(`/api/model-providers/${providerId}/test`, {
    method: 'POST',
  });
}

export interface DiscoverModelsPayload {
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
}

export function discoverProviderModels(payload: DiscoverModelsPayload): Promise<ModelDiscoveryResponse> {
  return request<ModelDiscoveryResponse>('/api/model-providers/discover-models', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface ProbeEmbeddingPayload {
  baseUrl: string;
  model: string;
  apiKey?: string;
  providerId?: string;
}

export function probeEmbeddingEndpoint(
  payload: ProbeEmbeddingPayload,
): Promise<EmbeddingProbeResponse> {
  return request<EmbeddingProbeResponse>('/api/model-providers/probe-embedding', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface SearchCanonParams {
  q: string;
  workId?: string;
  excludeChapterId?: string;
  limit?: number;
}

export function searchCanon(params: SearchCanonParams): Promise<SearchResponse> {
  const search = new URLSearchParams({ q: params.q });
  if (params.workId) search.set('workId', params.workId);
  if (params.excludeChapterId) search.set('excludeChapterId', params.excludeChapterId);
  if (params.limit) search.set('limit', String(params.limit));
  return request<SearchResponse>(`/api/search?${search.toString()}`);
}

export function reindexChapter(chapterId: string): Promise<ReindexResponse> {
  return request<ReindexResponse>(`/api/chapters/${chapterId}/reindex`, { method: 'POST' });
}

export function reindexWorkspace(workId?: string): Promise<ReindexResponse> {
  return request<ReindexResponse>('/api/index/reindex', {
    method: 'POST',
    body: JSON.stringify(workId ? { workId } : {}),
  });
}

export interface AiProposalPayload {
  mode: AiProposalMode;
  instruction?: string;
  targetWords: number;
}

export interface AiProposalStreamHandlers {
  onMeta?: (meta: AiProposalMeta) => void;
  onDelta?: (text: string) => void;
  onAttempt?: (event: AiProposalAttemptEvent) => void;
  onDone?: (proposal: AiProposalView) => void;
  onError?: (error: AiProposalErrorEvent) => void;
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

function parseSseBlock(raw: string): ParsedSseEvent | null {
  const lines = raw.split(/\r?\n/);
  let event = 'message';
  const data: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

function dispatchAiEvent(
  parsed: ParsedSseEvent,
  handlers: AiProposalStreamHandlers,
): 'continue' | 'terminal' {
  let payload: unknown;
  try {
    payload = JSON.parse(parsed.data) as unknown;
  } catch {
    return 'continue';
  }
  if (parsed.event === 'meta') {
    handlers.onMeta?.(payload as AiProposalMeta);
    return 'continue';
  }
  if (parsed.event === 'delta') {
    const event = payload as AiProposalDeltaEvent;
    if (typeof event.text === 'string' && event.text.length > 0) handlers.onDelta?.(event.text);
    return 'continue';
  }
  if (parsed.event === 'attempt') {
    handlers.onAttempt?.(payload as AiProposalAttemptEvent);
    return 'continue';
  }
  if (parsed.event === 'done') {
    handlers.onDone?.((payload as AiProposalDoneEvent).proposal);
    return 'terminal';
  }
  if (parsed.event === 'error') {
    handlers.onError?.(payload as AiProposalErrorEvent);
    return 'terminal';
  }
  return 'continue';
}

export async function streamAiProposal(
  chapterId: string,
  payload: AiProposalPayload,
  handlers: AiProposalStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/chapters/${chapterId}/ai/proposals`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    type ApiErrorBody = { error?: { code?: string; message?: string; details?: unknown } };
    let body: ApiErrorBody | null = null;
    try {
      body = text ? (JSON.parse(text) as ApiErrorBody) : null;
    } catch {
      body = null;
    }
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? `生成请求失败（HTTP ${response.status}）`,
      body?.error?.details,
    );
  }

  if (!response.body) throw new Error('生成连接没有响应体');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const parsed = parseSseBlock(raw);
        if (parsed && dispatchAiEvent(parsed, handlers) === 'terminal') {
          terminal = true;
          await reader.cancel().catch(() => undefined);
          return;
        }
        separator = /\r?\n\r?\n/.exec(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed && dispatchAiEvent(parsed, handlers) === 'terminal') terminal = true;
    }
  } finally {
    reader.releaseLock();
  }

  if (!terminal) throw new Error('生成连接中断，提案未完成');
}

export function listAiProposals(chapterId: string): Promise<AiProposalView[]> {
  return request<AiProposalView[]>(`/api/chapters/${chapterId}/ai/proposals`);
}

export function listAutomationMandates(workId?: string): Promise<AutomationMandateListResponse> {
  const suffix = workId ? `?workId=${encodeURIComponent(workId)}` : '';
  return request<AutomationMandateListResponse>(`/api/automation/mandates${suffix}`);
}

export function createAutomationMandate(
  payload: AutomationMandateInput,
): Promise<AutomationMandateView> {
  return request<AutomationMandateView>('/api/automation/mandates', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function revokeAutomationMandate(mandateId: string): Promise<AutomationMandateView> {
  return request<AutomationMandateView>(`/api/automation/mandates/${mandateId}/revoke`, {
    method: 'POST',
  });
}

export function automationPreflight(
  payload: AutomationJobInput,
): Promise<AutomationPreflightView> {
  return request<AutomationPreflightView>('/api/automation/preflight', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listAutomationJobs(workId?: string): Promise<AutomationJobListResponse> {
  const suffix = workId ? `?workId=${encodeURIComponent(workId)}` : '';
  return request<AutomationJobListResponse>(`/api/automation/jobs${suffix}`);
}

export function getAutomationJob(jobId: string): Promise<AutomationJobView> {
  return request<AutomationJobView>(`/api/automation/jobs/${jobId}`);
}

export function createAutomationJob(payload: AutomationJobInput): Promise<AutomationJobView> {
  return request<AutomationJobView>('/api/automation/jobs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function pauseAutomationJob(jobId: string): Promise<AutomationJobView> {
  return request<AutomationJobView>(`/api/automation/jobs/${jobId}/pause`, { method: 'POST' });
}

export function resumeAutomationJob(jobId: string): Promise<AutomationJobView> {
  return request<AutomationJobView>(`/api/automation/jobs/${jobId}/resume`, { method: 'POST' });
}

export function stopAutomationJob(jobId: string): Promise<AutomationJobView> {
  return request<AutomationJobView>(`/api/automation/jobs/${jobId}/stop`, { method: 'POST' });
}

export function getBillingReport(): Promise<BillingReportResponse> {
  return request<BillingReportResponse>('/api/billing/report');
}

export function updateBillingBudget(payload: {
  monthlyLimit: number | null;
  currency: PriceCurrency;
}): Promise<BillingBudgetView> {
  return request<BillingBudgetView>('/api/billing/budget', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function updateBillingPrice(
  providerId: string,
  payload: {
    promptPricePer1m?: number | null;
    completionPricePer1m?: number | null;
    priceCurrency?: PriceCurrency;
  },
): Promise<BillingProviderPriceView> {
  return request<BillingProviderPriceView>(`/api/billing/prices/${providerId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function listProviderBills(): Promise<ProviderBillListResponse> {
  return request<ProviderBillListResponse>('/api/billing/bills');
}

export function importProviderBill(payload: {
  providerId: string;
  invoiceNo: string;
  periodStart: string;
  periodEnd: string;
  currency: PriceCurrency;
  declaredTotal?: number | null;
  csv: string;
}): Promise<ProviderBillView> {
  return request<ProviderBillView>('/api/billing/bills/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getProviderBillReconciliation(
  billId: string,
): Promise<ProviderBillReconciliationResponse> {
  return request<ProviderBillReconciliationResponse>(
    `/api/billing/bills/${billId}/reconciliation`,
  );
}

export function reviewProviderBill(
  billId: string,
  payload: { status: 'reviewed' | 'disputed'; note: string },
): Promise<ProviderBillView> {
  return request<ProviderBillView>(`/api/billing/bills/${billId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export interface LedgerListParams {
  kind?: LedgerEntryKind;
  status?: LedgerEntryStatus;
  workId?: string;
  q?: string;
  limit?: number;
}

export function listLedgerEntries(
  params: LedgerListParams = {},
): Promise<LedgerEntryListResponse> {
  const search = new URLSearchParams();
  if (params.kind) search.set('kind', params.kind);
  if (params.status) search.set('status', params.status);
  if (params.workId) search.set('workId', params.workId);
  if (params.q) search.set('q', params.q);
  if (params.limit) search.set('limit', String(params.limit));
  const suffix = search.toString();
  return request<LedgerEntryListResponse>(
    `/api/ledger/entries${suffix ? `?${suffix}` : ''}`,
  );
}

export function getLedgerEntry(entryId: string): Promise<LedgerEntryDetail> {
  return request<LedgerEntryDetail>(`/api/ledger/entries/${entryId}`);
}

export function listLedgerVersions(
  entryId: string,
): Promise<LedgerEntryVersionListResponse> {
  return request<LedgerEntryVersionListResponse>(
    `/api/ledger/entries/${entryId}/versions`,
  );
}

export function getCharacterTimeline(entryId: string): Promise<LedgerCharacterTimeline> {
  return request<LedgerCharacterTimeline>(`/api/ledger/entries/${entryId}/timeline`);
}

export function getCharacterContext(chapterId: string): Promise<LedgerCharacterContext> {
  return request<LedgerCharacterContext>(
    `/api/ledger/character-context?chapterId=${encodeURIComponent(chapterId)}`,
  );
}

export function createLedgerEntry(
  input: CreateLedgerEntryInput,
): Promise<LedgerEntryDetail> {
  return request<LedgerEntryDetail>('/api/ledger/entries', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function saveLedgerDraft(
  entryId: string,
  input: UpdateLedgerDraftInput,
): Promise<LedgerEntryDetail> {
  return request<LedgerEntryDetail>(`/api/ledger/entries/${entryId}/draft`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function publishLedgerEntry(
  entryId: string,
  input: PublishLedgerEntryInput,
): Promise<LedgerEntryDetail> {
  return request<LedgerEntryDetail>(`/api/ledger/entries/${entryId}/publish`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function archiveLedgerEntry(
  entryId: string,
  input: ArchiveLedgerEntryInput,
): Promise<LedgerEntryDetail> {
  return request<LedgerEntryDetail>(`/api/ledger/entries/${entryId}/archive`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function rollbackLedgerEntry(
  entryId: string,
  input: RollbackLedgerEntryInput,
): Promise<LedgerEntryDetail> {
  return request<LedgerEntryDetail>(`/api/ledger/entries/${entryId}/rollback`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
