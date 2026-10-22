import type { ChapterStatus, GateStatus, Role } from '@yunshuo/domain';
import type {
  AutomationJobChapterStatus,
  AutomationJobStatus,
  AutomationMandateStatus,
  VersionSummary,
  WaiverStatus,
} from '@yunshuo/contracts';

export const WAIVER_STATUS_LABELS: Record<WaiverStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: '所有者',
  lead: '主笔',
  author: '作者',
  reviewer: '审阅者',
  viewer: '读者',
  billing: '计费管理员',
  ai: 'AI 主体',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: '工作区与预算控制；可写入、可审批',
  lead: '质量裁决与豁免审批；可写入',
  author: '写稿、跑门禁、提交自己的章节',
  reviewer: '阅读、评论、跑审计；不直接入库',
  viewer: '只读',
  billing: '供应商与预算；不接触正文',
  ai: '受限服务账号；在授权范围内提案',
};

export const CHAPTER_STATUS_LABELS: Record<ChapterStatus, string> = {
  planned: '计划中',
  writing: '写作中',
  staged: '已暂存',
  canon: '正典',
  revision: '修订中',
  commit_failed: '提交待修复',
  archived: '已归档',
};

export const GATE_STATUS_LABELS: Record<GateStatus, string> = {
  passed: '通过',
  failed: '未通过',
  not_configured: '未配置',
  error: '错误',
};

export const SOURCE_LABELS: Record<VersionSummary['source'], string> = {
  human: '人工提交',
  ai: 'AI 提交',
  rollback: '回滚',
  import: '迁移导入',
  batch: '批量补写',
};

export const VERSION_GATE_LABELS: Record<VersionSummary['gateStatus'], string> = {
  passed: '门禁通过',
  waived: '已豁免',
  not_evaluated: '未评估',
};

export const AUTOMATION_MANDATE_STATUS_LABELS: Record<AutomationMandateStatus, string> = {
  active: '有效',
  revoked: '已撤销',
  expired: '已过期',
};

export const AUTOMATION_JOB_STATUS_LABELS: Record<AutomationJobStatus, string> = {
  queued: '排队中',
  precheck_failed: '预检失败',
  running: '运行中',
  paused: '已暂停',
  stopped: '已停止',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
};

export const AUTOMATION_CHAPTER_STATUS_LABELS: Record<AutomationJobChapterStatus, string> = {
  pending: '待处理',
  running: '生成中',
  committed: '已入库',
  staged: '已暂存',
  gate_failed: '门禁未通过',
  no_output: '空正文',
  failed: '失败',
  skipped: '已跳过',
  interrupted: '已中断',
};

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function formatClock(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function countChars(text: string): number {
  return Array.from(text.replace(/\s/g, '')).length;
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return hash.slice(0, 10);
}
