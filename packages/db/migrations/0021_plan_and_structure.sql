-- P0 写作动线：章纲版本化与"计划已改、正文待改"标记。
-- chapters.plan 仍只放三项门禁关键词，context_hash 与回滚证据复用语义不变；
-- 摘要与节拍另存两列，只服务界面与生成提示；完整文档写进 chapter_plan_revisions（只追加）。
ALTER TABLE chapters
  ADD COLUMN plan_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN plan_summary text NOT NULL DEFAULT '',
  ADD COLUMN plan_beats jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN plan_updated_at timestamptz,
  ADD COLUMN body_needs_revision boolean NOT NULL DEFAULT false,
  ADD COLUMN marked_plan_revision integer,
  ADD COLUMN marked_canon_version_id uuid REFERENCES canon_versions(id),
  ADD CONSTRAINT chapters_plan_beats_chk CHECK (jsonb_typeof(plan_beats) = 'array'),
  -- 三列同生同灭：不允许出现"有标记无版本"或"有版本无标记"的脏行。
  ADD CONSTRAINT chapters_plan_marker_chk CHECK (
    (body_needs_revision
      AND marked_plan_revision IS NOT NULL
      AND marked_canon_version_id IS NOT NULL)
    OR ((NOT body_needs_revision)
      AND marked_plan_revision IS NULL
      AND marked_canon_version_id IS NULL)
  );

CREATE TABLE chapter_plan_revisions (
  id uuid PRIMARY KEY,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  body_policy text CHECK (body_policy IN ('plan_only', 'mark_body_for_revision')),
  canon_version_id uuid REFERENCES canon_versions(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chapter_id, revision),
  -- 选了策略就说明编辑时已有正典，必须记下当时基于哪一版正文。
  CONSTRAINT chapter_plan_revisions_policy_canon_chk
    CHECK (body_policy IS NULL OR canon_version_id IS NOT NULL)
);

CREATE INDEX chapter_plan_revisions_chapter_idx
  ON chapter_plan_revisions (chapter_id, revision DESC);
