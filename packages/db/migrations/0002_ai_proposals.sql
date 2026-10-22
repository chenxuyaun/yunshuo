CREATE TABLE ai_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  provider_id uuid REFERENCES model_providers(id),
  provider_name text NOT NULL,
  model text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('continue', 'expand')),
  instruction text NOT NULL DEFAULT '',
  target_words integer NOT NULL,
  base_draft_hash text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  content text NOT NULL DEFAULT '',
  content_hash text,
  word_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  error_code text,
  error_message text,
  prompt_tokens integer,
  completion_tokens integer,
  latency_ms integer,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX ai_proposals_chapter_created_idx ON ai_proposals (chapter_id, created_at DESC);
CREATE INDEX ai_proposals_workspace_created_idx ON ai_proposals (workspace_id, created_at DESC);

ALTER TABLE model_calls
  ADD COLUMN actor_id uuid REFERENCES users(id),
  ADD COLUMN purpose text,
  ADD COLUMN proposal_id uuid REFERENCES ai_proposals(id) ON DELETE SET NULL,
  ADD COLUMN error_code text,
  ADD COLUMN error_message text,
  ADD COLUMN completed_at timestamptz;

CREATE INDEX model_calls_workspace_created_idx ON model_calls (workspace_id, created_at DESC);
CREATE INDEX model_calls_proposal_idx ON model_calls (proposal_id);
