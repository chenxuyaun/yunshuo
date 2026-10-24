-- 账本建议（规划 B.5）：AI 只能提出建议，人类确认后才写入草稿。
-- 建议本身不是账本事实：accepted 只代表“人已采纳并生成草稿”，发布仍是独立的人工步骤。
-- base_version_id 记录建议生成时的生效版本；版本变化后采纳一律 409，避免用旧快照覆盖新事实。
CREATE TABLE ledger_suggestions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('character_state', 'foreshadowing_state')),
  base_version_id uuid REFERENCES ledger_entry_versions(id) ON DELETE SET NULL,
  basis_chapter_id uuid REFERENCES chapters(id) ON DELETE SET NULL,
  instruction text NOT NULL DEFAULT '',
  provider_id uuid REFERENCES model_providers(id) ON DELETE SET NULL,
  provider_name text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  proposal jsonb,
  rationale text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'ready', 'failed', 'applying', 'accepted', 'rejected')),
  error_code text,
  error_message text,
  prompt_tokens integer,
  completion_tokens integer,
  cost numeric(12, 4),
  cost_currency text CHECK (cost_currency IS NULL OR cost_currency IN ('CNY', 'USD')),
  latency_ms integer,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text NOT NULL DEFAULT '',
  result_draft_version_id uuid REFERENCES ledger_entry_versions(id) ON DELETE SET NULL,
  CHECK (status <> 'accepted' OR decided_by IS NOT NULL)
);

CREATE INDEX ledger_suggestions_entry_idx
  ON ledger_suggestions (workspace_id, entry_id, created_at DESC);

CREATE INDEX ledger_suggestions_status_idx
  ON ledger_suggestions (workspace_id, status, created_at DESC);

-- 建议生成也是花钱的模型调用：按建议归属，与章节提案、嵌入用途并列可查。
ALTER TABLE model_calls
  ADD COLUMN suggestion_id uuid REFERENCES ledger_suggestions(id) ON DELETE SET NULL;

CREATE INDEX model_calls_suggestion_idx
  ON model_calls (suggestion_id)
  WHERE suggestion_id IS NOT NULL;
