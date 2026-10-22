import type {
  GateEvaluationResult,
  GateRulesetConfig,
  ChapterPlan,
} from '@yunshuo/domain';
import type {
  GateEvaluationView,
  IndexStatusView,
  LeaseView,
  RulesetView,
  StagedDraftView,
  VersionDetail,
  VersionSummary,
  WaiverView,
} from '@yunshuo/contracts';

export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export interface RulesetRow {
  id: string;
  key: string;
  version: number;
  description: string;
  rules: GateRulesetConfig;
  is_production: boolean;
}

export function mapRuleset(row: RulesetRow): RulesetView {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    description: row.description,
    isProduction: row.is_production,
  };
}

export interface EvaluationRow {
  id: string;
  chapter_id: string;
  content_hash: string;
  context_hash: string;
  status: GateEvaluationResult['status'];
  results: GateEvaluationResult['results'];
  created_at: Date | string;
  ruleset_id: string;
  ruleset_key: string;
  ruleset_version: number;
  ruleset_description: string;
  ruleset_is_production: boolean;
}

export function mapEvaluation(row: EvaluationRow): GateEvaluationView {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    contentHash: row.content_hash,
    contextHash: row.context_hash,
    ruleset: {
      id: row.ruleset_id,
      key: row.ruleset_key,
      version: row.ruleset_version,
      description: row.ruleset_description,
      isProduction: row.ruleset_is_production,
    },
    status: row.status,
    results: row.results,
    createdAt: iso(row.created_at),
  };
}

export interface VersionRow {
  id: string;
  chapter_id: string;
  version_no: number;
  source: VersionSummary['source'];
  word_count: number;
  content_hash: string;
  content: string;
  parent_version_id: string | null;
  actor_name: string | null;
  evaluation_id: string | null;
  evaluation_status: GateEvaluationResult['status'] | null;
  waiver_id: string | null;
  created_at: Date | string;
}

export function gateStatusOf(row: VersionRow): VersionSummary['gateStatus'] {
  if (row.waiver_id) return 'waived';
  if (row.evaluation_id && row.evaluation_status === 'passed') return 'passed';
  return 'not_evaluated';
}

export function previewOf(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

export function mapVersionSummary(row: VersionRow): VersionSummary {
  return {
    id: row.id,
    versionNo: row.version_no,
    source: row.source,
    wordCount: row.word_count,
    contentHash: row.content_hash,
    actorName: row.actor_name,
    gateStatus: gateStatusOf(row),
    evaluationId: row.evaluation_id,
    waiverId: row.waiver_id,
    contentPreview: previewOf(row.content),
    createdAt: iso(row.created_at),
  };
}

export interface WaiverRow {
  id: string;
  chapter_id: string;
  target_version_id: string | null;
  gate_key: WaiverView['gateKey'];
  reason: string;
  status: WaiverView['status'];
  requested_by: string;
  requested_by_name: string;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: Date | string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: Date | string | null;
  decision_note: string | null;
  created_at: Date | string;
}

export function mapWaiver(row: WaiverRow): WaiverView {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    targetVersionId: row.target_version_id,
    gateKey: row.gate_key,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at ? iso(row.approved_at) : null,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    decisionNote: row.decision_note,
    createdAt: iso(row.created_at),
  };
}

export interface StagedRow {
  id: string;
  chapter_id: string;
  content_hash: string;
  word_count: number;
  evaluation_id: string;
  staged_by: string;
  staged_by_name: string;
  staged_at: Date | string;
}

export function mapStaged(row: StagedRow): StagedDraftView {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    contentHash: row.content_hash,
    wordCount: row.word_count,
    evaluationId: row.evaluation_id,
    stagedBy: row.staged_by,
    stagedByName: row.staged_by_name,
    stagedAt: iso(row.staged_at),
  };
}

export interface LeaseRow {
  user_id: string;
  user_name: string;
  expires_at: Date | string;
}

export function mapLease(row: LeaseRow): LeaseView {
  return {
    userId: row.user_id,
    userName: row.user_name,
    expiresAt: iso(row.expires_at),
  };
}

export interface IndexRow {
  status: IndexStatusView['status'];
  detail: string | null;
  version_id: string;
  version_no: number | null;
  chunk_count: number;
  provider_name: string | null;
  model: string | null;
  dimensions: number | null;
  attempts: number;
  next_retry_at: Date | string | null;
  last_error: string | null;
  updated_at: Date | string;
}

export function mapIndex(row: IndexRow): IndexStatusView {
  return {
    status: row.status,
    detail: row.detail,
    versionId: row.version_id,
    versionNo: row.version_no,
    chunkCount: row.chunk_count,
    providerName: row.provider_name,
    model: row.model,
    dimensions: row.dimensions,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at ? iso(row.next_retry_at) : null,
    lastError: row.last_error,
    updatedAt: iso(row.updated_at),
  };
}

export function pendingIndexStatus(
  versionId: string,
  detail: string | null = null,
): IndexStatusView {
  return {
    status: 'pending',
    detail,
    versionId,
    versionNo: null,
    chunkCount: 0,
    providerName: null,
    model: null,
    dimensions: null,
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
}

export interface ChapterBaseRow {
  id: string;
  work_id: string;
  volume_id: string;
  number: number;
  title: string;
  status: string;
  plan: ChapterPlan;
  updated_at: Date | string;
  word_count: number | null;
  current_version_id: string | null;
  version_no: number | null;
}

export function mapVersionDetail(
  row: VersionRow,
  evaluation: EvaluationRow | null,
  waiver: WaiverRow | null,
): VersionDetail {
  return {
    ...mapVersionSummary(row),
    content: row.content,
    parentVersionId: row.parent_version_id,
    evaluation: evaluation ? mapEvaluation(evaluation) : null,
    waiver: waiver ? mapWaiver(waiver) : null,
  };
}
