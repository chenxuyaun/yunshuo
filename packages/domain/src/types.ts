export type Role =
  | 'owner'
  | 'lead'
  | 'author'
  | 'reviewer'
  | 'viewer'
  | 'billing'
  | 'ai';

export type ChapterStatus =
  | 'planned'
  | 'writing'
  | 'staged'
  | 'canon'
  | 'revision'
  | 'commit_failed'
  | 'archived';

export const GATE_KEYS = [
  'word_count',
  'ai_tone',
  'core_entity',
  'chapter_hook',
  'causality',
] as const;

export type GateKey = (typeof GATE_KEYS)[number];

export type GateStatus =
  | 'passed'
  | 'failed'
  | 'not_configured'
  | 'error';

export type GateEvaluationStatus = 'passed' | 'failed' | 'blocked';

export interface GateResult {
  key: GateKey;
  label: string;
  status: GateStatus;
  message: string;
  evidence: Record<string, unknown>;
}

export interface GateEvaluationResult {
  status: GateEvaluationStatus;
  results: GateResult[];
}

export interface ChapterPlan {
  requiredEntities?: string[];
  goalKeywords?: string[];
  obstacleKeywords?: string[];
}

// 门禁只读 ChapterPlan 那三项；摘要与节拍只服务界面、历史与生成提示。
// 两者分开是为了让 chapters.plan 的哈希语义保持不变。
export interface ChapterPlanDocument extends ChapterPlan {
  summary: string;
  beats: string[];
  requiredEntities: string[];
  goalKeywords: string[];
  obstacleKeywords: string[];
}

export interface GateRulesetConfig {
  wordCount?: {
    min: number;
    label?: string;
  };
  aiTone?: {
    bannedPhrases: string[];
    maxHits: number;
  };
  coreEntity?: {
    requiredEntities?: string[];
  };
  chapterHook?: {
    markers: string[];
    tailChars: number;
  };
  causality?: {
    goalKeywords?: string[];
    obstacleKeywords?: string[];
  };
}

export type AuditStatus = 'ok' | 'warning' | 'not_connected';

export interface AuditResult {
  key: string;
  label: string;
  status: AuditStatus;
  message: string;
  hits?: number;
  examples?: string[];
  advisoryOnly: true;
}

export interface Actor {
  id: string;
  email: string;
  name: string;
  role: Role;
  workspaceId: string;
}

export const GATE_LABELS: Record<GateKey, string> = {
  word_count: '字数',
  ai_tone: 'AI 腔调',
  core_entity: '核心实体连续性',
  chapter_hook: '章末悬念钩子',
  causality: '底层因果律',
};
