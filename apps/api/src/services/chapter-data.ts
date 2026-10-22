import type { Sql, TransactionSql } from 'postgres';
import { hashJson, type ChapterPlan, type GateRulesetConfig } from '@yunshuo/domain';
import { sql } from '@yunshuo/db';
import { DEV_RULESET_KEY } from '@yunshuo/gates';
import { conflict } from '../errors.js';
import type { AuthContext } from '../auth.js';
import type { EvaluationRow, LeaseRow, RulesetRow } from '../views.js';

export type Executor = Sql<any> | TransactionSql<any>;

export const LEASE_MINUTES = 15;

export interface ChapterRow {
  id: string;
  work_id: string;
  volume_id: string;
  number: number;
  title: string;
  status: 'planned' | 'writing' | 'staged' | 'canon' | 'revision' | 'commit_failed' | 'archived';
  plan: ChapterPlan;
  current_version_id: string | null;
  updated_at: Date | string;
  workspace_id: string;
  settings_version: number;
  ledger_version: number;
}

export async function loadChapter(
  exec: Executor,
  workspaceId: string,
  chapterId: string,
  lock = false,
): Promise<ChapterRow | null> {
  const rows = lock
    ? await exec<ChapterRow[]>`
        SELECT
          c.id, c.work_id, c.volume_id, c.number, c.title, c.status, c.plan,
          c.current_version_id, c.updated_at,
          w.workspace_id, ws.settings_version, ws.ledger_version
        FROM chapters c
        JOIN works w ON w.id = c.work_id
        JOIN workspaces ws ON ws.id = w.workspace_id
        WHERE c.id = ${chapterId} AND w.workspace_id = ${workspaceId}
        FOR UPDATE OF c
      `
    : await exec<ChapterRow[]>`
        SELECT
          c.id, c.work_id, c.volume_id, c.number, c.title, c.status, c.plan,
          c.current_version_id, c.updated_at,
          w.workspace_id, ws.settings_version, ws.ledger_version
        FROM chapters c
        JOIN works w ON w.id = c.work_id
        JOIN workspaces ws ON ws.id = w.workspace_id
        WHERE c.id = ${chapterId} AND w.workspace_id = ${workspaceId}
      `;
  return rows[0] ?? null;
}

export async function loadRuleset(exec: Executor = sql): Promise<RulesetRow | null> {
  const rows = await exec<RulesetRow[]>`
    SELECT id, key, version, description, rules, is_production
    FROM gate_rulesets
    WHERE key = ${DEV_RULESET_KEY}
    ORDER BY version DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export function contextHashOf(chapter: ChapterRow, rulesetId: string): string {
  return hashJson({
    chapterId: chapter.id,
    rulesetId,
    plan: chapter.plan,
    settingsVersion: chapter.settings_version,
    ledgerVersion: chapter.ledger_version,
  });
}

export interface DraftRow {
  id: string;
  branch_id: string;
  content: string;
  content_hash: string;
  word_count: number;
  created_at: Date | string;
}

export async function loadLatestDraft(
  exec: Executor,
  chapterId: string,
  userId: string,
  lock = false,
): Promise<DraftRow | null> {
  const rows = lock
    ? await exec<DraftRow[]>`
        SELECT dr.id, dr.branch_id, dr.content, dr.content_hash, dr.word_count, dr.created_at
        FROM draft_revisions dr
        JOIN draft_branches db ON db.id = dr.branch_id
        WHERE db.chapter_id = ${chapterId} AND db.owner_id = ${userId} AND db.name = 'main'
        ORDER BY dr.created_at DESC, dr.id DESC
        LIMIT 1
        FOR UPDATE OF dr
      `
    : await exec<DraftRow[]>`
        SELECT dr.id, dr.branch_id, dr.content, dr.content_hash, dr.word_count, dr.created_at
        FROM draft_revisions dr
        JOIN draft_branches db ON db.id = dr.branch_id
        WHERE db.chapter_id = ${chapterId} AND db.owner_id = ${userId} AND db.name = 'main'
        ORDER BY dr.created_at DESC, dr.id DESC
        LIMIT 1
      `;
  return rows[0] ?? null;
}

export interface EvaluationWithRules extends EvaluationRow {
  rules: GateRulesetConfig;
}

export async function loadEvaluation(
  exec: Executor,
  evaluationId: string,
  chapterId: string,
): Promise<EvaluationWithRules | null> {
  const rows = await exec<EvaluationWithRules[]>`
    SELECT
      e.id, e.chapter_id, e.content_hash, e.context_hash, e.status, e.results, e.created_at,
      r.id AS ruleset_id, r.key AS ruleset_key, r.version AS ruleset_version,
      r.description AS ruleset_description, r.is_production AS ruleset_is_production,
      r.rules
    FROM gate_evaluations e
    JOIN gate_rulesets r ON r.id = e.ruleset_id
    WHERE e.id = ${evaluationId} AND e.chapter_id = ${chapterId}
  `;
  return rows[0] ?? null;
}

export async function loadLease(
  exec: Executor,
  chapterId: string,
  lock = false,
): Promise<LeaseRow | null> {
  const rows = lock
    ? await exec<LeaseRow[]>`
        SELECT cl.user_id, u.name AS user_name, cl.expires_at
        FROM chapter_leases cl
        JOIN users u ON u.id = cl.user_id
        WHERE cl.chapter_id = ${chapterId}
        FOR UPDATE OF cl
      `
    : await exec<LeaseRow[]>`
        SELECT cl.user_id, u.name AS user_name, cl.expires_at
        FROM chapter_leases cl
        JOIN users u ON u.id = cl.user_id
        WHERE cl.chapter_id = ${chapterId}
      `;
  return rows[0] ?? null;
}

export function isLeaseActive(row: LeaseRow | null): boolean {
  return Boolean(row && new Date(row.expires_at).getTime() > Date.now());
}

export async function upsertLease(
  exec: Executor,
  chapterId: string,
  userId: string,
): Promise<{ expires_at: Date | string }> {
  const rows = await exec<{ expires_at: Date | string }[]>`
    INSERT INTO chapter_leases (chapter_id, user_id, acquired_at, expires_at)
    VALUES (${chapterId}, ${userId}, now(), now() + ${`${LEASE_MINUTES} minutes`}::interval)
    ON CONFLICT (chapter_id) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          acquired_at = now(),
          expires_at = EXCLUDED.expires_at
    RETURNING expires_at
  `;
  return rows[0]!;
}

export async function assertLeaseHeld(
  exec: Executor,
  chapterId: string,
  auth: AuthContext,
): Promise<void> {
  const lease = await loadLease(exec, chapterId, true);
  if (!isLeaseActive(lease)) {
    throw conflict('LEASE_REQUIRED', '该章节没有有效租约，请先取得编辑租约', {
      holder: null,
    });
  }
  if (lease!.user_id !== auth.user.id) {
    throw conflict('LEASE_HELD', `章节租约由 ${lease!.user_name} 持有`, {
      holder: lease!.user_name,
      expiresAt: new Date(lease!.expires_at).toISOString(),
    });
  }
}
