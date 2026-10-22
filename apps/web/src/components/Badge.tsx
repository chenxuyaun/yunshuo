import type { ReactNode } from 'react';
import type { ChapterStatus, GateStatus } from '@yunshuo/domain';
import type {
  AutomationJobChapterStatus,
  AutomationJobStatus,
  AutomationMandateStatus,
  VersionSummary,
  WaiverStatus,
} from '@yunshuo/contracts';
import {
  AUTOMATION_CHAPTER_STATUS_LABELS,
  AUTOMATION_JOB_STATUS_LABELS,
  AUTOMATION_MANDATE_STATUS_LABELS,
  CHAPTER_STATUS_LABELS,
  GATE_STATUS_LABELS,
  VERSION_GATE_LABELS,
  WAIVER_STATUS_LABELS,
} from '../format.js';

export type BadgeTone = 'neutral' | 'ink' | 'green' | 'amber' | 'red' | 'muted';

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function chapterStatusTone(status: ChapterStatus): BadgeTone {
  switch (status) {
    case 'canon':
      return 'green';
    case 'writing':
      return 'ink';
    case 'staged':
      return 'amber';
    case 'revision':
      return 'amber';
    case 'commit_failed':
      return 'red';
    case 'archived':
      return 'muted';
    default:
      return 'neutral';
  }
}

export function ChapterStatusBadge({ status }: { status: ChapterStatus }) {
  return <Badge tone={chapterStatusTone(status)}>{CHAPTER_STATUS_LABELS[status]}</Badge>;
}

export function gateStatusTone(status: GateStatus): BadgeTone {
  switch (status) {
    case 'passed':
      return 'green';
    case 'failed':
      return 'red';
    case 'error':
      return 'red';
    case 'not_configured':
      return 'amber';
    default:
      return 'neutral';
  }
}

export function GateStatusBadge({ status }: { status: GateStatus }) {
  return <Badge tone={gateStatusTone(status)}>{GATE_STATUS_LABELS[status]}</Badge>;
}

export function versionGateTone(status: VersionSummary['gateStatus']): BadgeTone {
  switch (status) {
    case 'passed':
      return 'green';
    case 'waived':
      return 'amber';
    default:
      return 'neutral';
  }
}

export function VersionGateBadge({ status }: { status: VersionSummary['gateStatus'] }) {
  return <Badge tone={versionGateTone(status)}>{VERSION_GATE_LABELS[status]}</Badge>;
}

export function waiverStatusTone(status: WaiverStatus): BadgeTone {
  switch (status) {
    case 'approved':
      return 'green';
    case 'pending':
      return 'amber';
    case 'rejected':
      return 'red';
  }
}

export function WaiverStatusBadge({ status }: { status: WaiverStatus }) {
  return <Badge tone={waiverStatusTone(status)}>{WAIVER_STATUS_LABELS[status]}</Badge>;
}

export function automationMandateTone(status: AutomationMandateStatus): BadgeTone {
  switch (status) {
    case 'active':
      return 'green';
    case 'expired':
      return 'amber';
    case 'revoked':
      return 'muted';
  }
}

export function AutomationMandateStatusBadge({ status }: { status: AutomationMandateStatus }) {
  return (
    <Badge tone={automationMandateTone(status)}>{AUTOMATION_MANDATE_STATUS_LABELS[status]}</Badge>
  );
}

export function automationJobTone(status: AutomationJobStatus): BadgeTone {
  switch (status) {
    case 'running':
      return 'ink';
    case 'completed':
      return 'green';
    case 'precheck_failed':
    case 'failed':
      return 'red';
    case 'paused':
    case 'interrupted':
      return 'amber';
    case 'stopped':
      return 'muted';
    default:
      return 'neutral';
  }
}

export function AutomationJobStatusBadge({ status }: { status: AutomationJobStatus }) {
  return <Badge tone={automationJobTone(status)}>{AUTOMATION_JOB_STATUS_LABELS[status]}</Badge>;
}

export function automationChapterTone(status: AutomationJobChapterStatus): BadgeTone {
  switch (status) {
    case 'running':
      return 'ink';
    case 'committed':
      return 'green';
    case 'staged':
    case 'interrupted':
      return 'amber';
    case 'gate_failed':
    case 'failed':
      return 'red';
    case 'no_output':
      return 'amber';
    case 'skipped':
      return 'muted';
    default:
      return 'neutral';
  }
}

export function AutomationChapterStatusBadge({
  status,
}: {
  status: AutomationJobChapterStatus;
}) {
  return (
    <Badge tone={automationChapterTone(status)}>
      {AUTOMATION_CHAPTER_STATUS_LABELS[status]}
    </Badge>
  );
}
