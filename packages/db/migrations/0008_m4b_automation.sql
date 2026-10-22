ALTER TABLE users
  ADD COLUMN kind text NOT NULL DEFAULT 'human';

ALTER TABLE users
  ADD CONSTRAINT users_kind_check
    CHECK (kind IN ('human', 'ai'));

CREATE TABLE automation_mandates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  name text NOT NULL,
  mode text NOT NULL DEFAULT 'continue',
  chapter_min integer NOT NULL CHECK (chapter_min > 0),
  chapter_max integer NOT NULL CHECK (chapter_max >= chapter_min),
  max_chapters integer NOT NULL CHECK (max_chapters BETWEEN 1 AND 50),
  target_words integer NOT NULL CHECK (target_words BETWEEN 300 AND 4000),
  instruction text NOT NULL DEFAULT '',
  allow_auto_commit boolean NOT NULL DEFAULT false,
  allow_remote_models boolean NOT NULL DEFAULT false,
  budget_limit numeric(12,4),
  budget_currency text NOT NULL DEFAULT 'CNY',
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_mandates_mode_check CHECK (mode IN ('continue')),
  CONSTRAINT automation_mandates_status_check CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT automation_mandates_budget_currency_check CHECK (budget_currency IN ('CNY', 'USD')),
  CONSTRAINT automation_mandates_budget_positive_check CHECK (budget_limit IS NULL OR budget_limit > 0)
);

CREATE INDEX automation_mandates_workspace_status_idx
  ON automation_mandates (workspace_id, status, created_at DESC);

CREATE TABLE automation_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  mandate_id uuid NOT NULL REFERENCES automation_mandates(id) ON DELETE RESTRICT,
  status text NOT NULL,
  preflight jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_chapters integer NOT NULL DEFAULT 0,
  committed_chapters integer NOT NULL DEFAULT 0,
  staged_chapters integer NOT NULL DEFAULT 0,
  failed_chapters integer NOT NULL DEFAULT 0,
  skipped_chapters integer NOT NULL DEFAULT 0,
  spent numeric(12,4) NOT NULL DEFAULT 0,
  cost_currency text NOT NULL DEFAULT 'CNY',
  cost_unknown boolean NOT NULL DEFAULT false,
  runner_id text,
  heartbeat_at timestamptz,
  current_chapter_id uuid REFERENCES chapters(id) ON DELETE SET NULL,
  pause_requested boolean NOT NULL DEFAULT false,
  stop_requested boolean NOT NULL DEFAULT false,
  last_error text,
  created_by uuid NOT NULL REFERENCES users(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_jobs_status_check CHECK (
    status IN (
      'queued', 'precheck_failed', 'running', 'paused',
      'stopped', 'completed', 'failed', 'interrupted'
    )
  ),
  CONSTRAINT automation_jobs_cost_currency_check CHECK (cost_currency IN ('CNY', 'USD'))
);

CREATE INDEX automation_jobs_workspace_status_idx
  ON automation_jobs (workspace_id, status, created_at DESC);

CREATE INDEX automation_jobs_runner_idx
  ON automation_jobs (status, heartbeat_at);

CREATE TABLE automation_job_chapters (
  job_id uuid NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  chapter_number integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  proposal_id uuid REFERENCES ai_proposals(id) ON DELETE SET NULL,
  version_id uuid REFERENCES canon_versions(id) ON DELETE SET NULL,
  evaluation_id uuid REFERENCES gate_evaluations(id) ON DELETE SET NULL,
  reason text,
  cost numeric(12,4),
  cost_currency text,
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (job_id, chapter_id),
  CONSTRAINT automation_job_chapters_status_check CHECK (
    status IN (
      'pending', 'running', 'committed', 'staged', 'gate_failed',
      'no_output', 'failed', 'skipped', 'interrupted'
    )
  ),
  CONSTRAINT automation_job_chapters_cost_currency_check CHECK (
    cost_currency IS NULL OR cost_currency IN ('CNY', 'USD')
  )
);

CREATE INDEX automation_job_chapters_status_idx
  ON automation_job_chapters (job_id, status);

CREATE INDEX automation_job_chapters_chapter_idx
  ON automation_job_chapters (chapter_id);
