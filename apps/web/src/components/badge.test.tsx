import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChapterStatus, GateStatus } from '@yunshuo/domain';
import type {
  AutomationJobChapterStatus,
  AutomationJobStatus,
  AutomationMandateStatus,
  VersionSummary,
  WaiverStatus,
} from '@yunshuo/contracts';
import {
  AutomationChapterStatusBadge,
  AutomationJobStatusBadge,
  AutomationMandateStatusBadge,
  Badge,
  ChapterStatusBadge,
  GateStatusBadge,
  VersionGateBadge,
  WaiverStatusBadge,
  type BadgeTone,
} from './Badge.js';

function expectBadge(html: string, tone: BadgeTone, label: string) {
  expect(html).toBe(`<span class="badge badge-${tone}">${label}</span>`);
}

const CHAPTERS: Array<[ChapterStatus, BadgeTone, string]> = [
  ['planned', 'neutral', '计划中'],
  ['writing', 'ink', '写作中'],
  ['staged', 'amber', '已暂存'],
  ['canon', 'green', '正典'],
  ['revision', 'amber', '修订中'],
  ['commit_failed', 'red', '提交待修复'],
  ['archived', 'muted', '已归档'],
];

const GATES: Array<[GateStatus, BadgeTone, string]> = [
  ['passed', 'green', '通过'],
  ['failed', 'red', '未通过'],
  ['error', 'red', '错误'],
  ['not_configured', 'amber', '未配置'],
];

const VERSION_GATES: Array<[VersionSummary['gateStatus'], BadgeTone, string]> = [
  ['passed', 'green', '门禁通过'],
  ['waived', 'amber', '已豁免'],
  ['not_evaluated', 'neutral', '未评估'],
];

const WAIVERS: Array<[WaiverStatus, BadgeTone, string]> = [
  ['approved', 'green', '已批准'],
  ['pending', 'amber', '待审批'],
  ['rejected', 'red', '已拒绝'],
];

const MANDATES: Array<[AutomationMandateStatus, BadgeTone, string]> = [
  ['active', 'green', '有效'],
  ['expired', 'amber', '已过期'],
  ['revoked', 'muted', '已撤销'],
];

const JOBS: Array<[AutomationJobStatus, BadgeTone, string]> = [
  ['queued', 'neutral', '排队中'],
  ['precheck_failed', 'red', '预检失败'],
  ['running', 'ink', '运行中'],
  ['paused', 'amber', '已暂停'],
  ['stopped', 'muted', '已停止'],
  ['completed', 'green', '已完成'],
  ['failed', 'red', '失败'],
  ['interrupted', 'amber', '已中断'],
];

const JOB_CHAPTERS: Array<[AutomationJobChapterStatus, BadgeTone, string]> = [
  ['pending', 'neutral', '待处理'],
  ['running', 'ink', '生成中'],
  ['committed', 'green', '已入库'],
  ['staged', 'amber', '已暂存'],
  ['gate_failed', 'red', '门禁未通过'],
  ['no_output', 'amber', '空正文'],
  ['failed', 'red', '失败'],
  ['skipped', 'muted', '已跳过'],
  ['interrupted', 'amber', '已中断'],
];

describe('Badge 基元', () => {
  it('默认 neutral，五种色调都能显式指定', () => {
    expectBadge(renderToStaticMarkup(<Badge>正文</Badge>), 'neutral', '正文');
    for (const tone of ['neutral', 'ink', 'green', 'amber', 'red', 'muted'] as BadgeTone[]) {
      expectBadge(renderToStaticMarkup(<Badge tone={tone}>正文</Badge>), tone, '正文');
    }
  });
});

describe('章节与门禁徽标', () => {
  it('章节七态的文案与色调', () => {
    for (const [status, tone, label] of CHAPTERS) {
      expectBadge(renderToStaticMarkup(<ChapterStatusBadge status={status} />), tone, label);
    }
  });

  it('门禁四态的文案与色调', () => {
    for (const [status, tone, label] of GATES) {
      expectBadge(renderToStaticMarkup(<GateStatusBadge status={status} />), tone, label);
    }
  });

  it('版本门禁三态：通过、豁免与未评估', () => {
    for (const [status, tone, label] of VERSION_GATES) {
      expectBadge(renderToStaticMarkup(<VersionGateBadge status={status} />), tone, label);
    }
  });
});

describe('审批与自动化徽标', () => {
  it('豁免三态的文案与色调', () => {
    for (const [status, tone, label] of WAIVERS) {
      expectBadge(renderToStaticMarkup(<WaiverStatusBadge status={status} />), tone, label);
    }
  });

  it('授权三态的文案与色调', () => {
    for (const [status, tone, label] of MANDATES) {
      expectBadge(
        renderToStaticMarkup(<AutomationMandateStatusBadge status={status} />),
        tone,
        label,
      );
    }
  });

  it('作业八态的文案与色调', () => {
    for (const [status, tone, label] of JOBS) {
      expectBadge(
        renderToStaticMarkup(<AutomationJobStatusBadge status={status} />),
        tone,
        label,
      );
    }
  });

  it('作业章节九态的文案与色调', () => {
    for (const [status, tone, label] of JOB_CHAPTERS) {
      expectBadge(
        renderToStaticMarkup(<AutomationChapterStatusBadge status={status} />),
        tone,
        label,
      );
    }
  });
});
