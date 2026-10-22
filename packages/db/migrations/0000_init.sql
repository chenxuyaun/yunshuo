CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  settings_version integer NOT NULL DEFAULT 1,
  ledger_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'lead', 'author', 'reviewer', 'viewer', 'billing', 'ai')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE works (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE volumes (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  number integer NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, number)
);

CREATE TABLE chapters (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  volume_id uuid NOT NULL REFERENCES volumes(id),
  number integer NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'writing', 'staged', 'canon', 'revision', 'commit_failed', 'archived')),
  current_version_id uuid,
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, number)
);

CREATE TABLE chapter_leases (
  chapter_id uuid PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE draft_branches (
  id uuid PRIMARY KEY,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL DEFAULT 'main',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chapter_id, owner_id, name)
);

CREATE TABLE draft_revisions (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES draft_branches(id) ON DELETE CASCADE,
  content text NOT NULL,
  content_hash text NOT NULL,
  word_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gate_rulesets (
  id uuid PRIMARY KEY,
  key text NOT NULL,
  version integer NOT NULL,
  description text NOT NULL,
  rules jsonb NOT NULL,
  is_production boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);

CREATE TABLE gate_evaluations (
  id uuid PRIMARY KEY,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  ruleset_id uuid NOT NULL REFERENCES gate_rulesets(id),
  context_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'blocked')),
  results jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staged_drafts (
  id uuid PRIMARY KEY,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES draft_branches(id),
  revision_id uuid NOT NULL REFERENCES draft_revisions(id),
  content text NOT NULL,
  content_hash text NOT NULL,
  word_count integer NOT NULL,
  evaluation_id uuid NOT NULL REFERENCES gate_evaluations(id),
  staged_by uuid NOT NULL REFERENCES users(id),
  staged_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE canon_versions (
  id uuid PRIMARY KEY,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  word_count integer NOT NULL,
  parent_version_id uuid REFERENCES canon_versions(id),
  source text NOT NULL CHECK (source IN ('human', 'ai', 'rollback', 'import', 'batch')),
  actor_id uuid REFERENCES users(id),
  evaluation_id uuid REFERENCES gate_evaluations(id),
  waiver_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chapter_id, version_no)
);

CREATE TABLE canon_current (
  chapter_id uuid PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES canon_versions(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE waivers (
  id uuid PRIMARY KEY,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  target_version_id uuid REFERENCES canon_versions(id),
  gate_key text NOT NULL CHECK (gate_key IN ('word_count', 'ai_tone', 'core_entity', 'chapter_hook', 'causality', 'rollback')),
  reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commit_intents (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  staged_draft_id uuid REFERENCES staged_drafts(id),
  expected_current_version_id uuid REFERENCES canon_versions(id),
  status text NOT NULL CHECK (status IN ('pending', 'committing', 'committed', 'failed')),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commits (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE REFERENCES commit_intents(id),
  chapter_id uuid NOT NULL REFERENCES chapters(id),
  version_id uuid NOT NULL REFERENCES canon_versions(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  actor_type text NOT NULL,
  role text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id uuid,
  result text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE index_status (
  chapter_id uuid PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES canon_versions(id),
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'not_configured')),
  detail text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chapter_metadata (
  chapter_id uuid PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  word_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_providers (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_url text NOT NULL,
  model text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_calls (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id uuid REFERENCES model_providers(id),
  chapter_id uuid REFERENCES chapters(id),
  model text NOT NULL,
  prompt_tokens integer,
  completion_tokens integer,
  cost numeric(12, 4),
  latency_ms integer,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chapters
  ADD CONSTRAINT chapters_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES canon_versions(id);

ALTER TABLE canon_versions
  ADD CONSTRAINT canon_versions_waiver_fk
  FOREIGN KEY (waiver_id) REFERENCES waivers(id);

CREATE INDEX chapters_work_number_idx ON chapters (work_id, number);
CREATE INDEX draft_revisions_branch_time_idx ON draft_revisions (branch_id, created_at DESC);
CREATE INDEX gate_evaluations_chapter_time_idx ON gate_evaluations (chapter_id, created_at DESC);
CREATE INDEX canon_versions_chapter_number_idx ON canon_versions (chapter_id, version_no DESC);
CREATE INDEX staged_drafts_chapter_time_idx ON staged_drafts (chapter_id, staged_at DESC);
CREATE INDEX chapter_leases_expiry_idx ON chapter_leases (expires_at);
CREATE INDEX events_workspace_time_idx ON events (workspace_id, created_at DESC);
CREATE INDEX audit_log_workspace_time_idx ON audit_log (workspace_id, created_at DESC);
CREATE INDEX outbox_status_id_idx ON outbox (status, id);
CREATE INDEX waivers_chapter_idx ON waivers (chapter_id, created_at DESC);
