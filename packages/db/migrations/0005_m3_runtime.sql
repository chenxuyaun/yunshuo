ALTER TABLE model_providers
  ADD COLUMN priority integer NOT NULL DEFAULT 100,
  ADD COLUMN prompt_price_per_1m numeric(12,4),
  ADD COLUMN completion_price_per_1m numeric(12,4),
  ADD COLUMN price_currency text NOT NULL DEFAULT 'CNY';

ALTER TABLE model_providers
  ADD CONSTRAINT model_providers_priority_check
    CHECK (priority BETWEEN 1 AND 999),
  ADD CONSTRAINT model_providers_pricing_pair_check
    CHECK (
      (prompt_price_per_1m IS NULL AND completion_price_per_1m IS NULL)
      OR (prompt_price_per_1m IS NOT NULL AND completion_price_per_1m IS NOT NULL)
    ),
  ADD CONSTRAINT model_providers_price_nonnegative_check
    CHECK (
      (prompt_price_per_1m IS NULL OR prompt_price_per_1m >= 0)
      AND (completion_price_per_1m IS NULL OR completion_price_per_1m >= 0)
    ),
  ADD CONSTRAINT model_providers_price_currency_check
    CHECK (price_currency IN ('CNY', 'USD'));

ALTER TABLE ai_proposals
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN cost numeric(12,4),
  ADD COLUMN cost_currency text;

ALTER TABLE model_calls
  ADD COLUMN attempt_no integer NOT NULL DEFAULT 1,
  ADD COLUMN cost_currency text;

CREATE TABLE ai_generation_locks (
  chapter_id uuid PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_id uuid REFERENCES ai_proposals(id) ON DELETE SET NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX ai_generation_locks_expires_idx ON ai_generation_locks (expires_at);

CREATE INDEX model_calls_proposal_attempt_idx ON model_calls (proposal_id, attempt_no);
