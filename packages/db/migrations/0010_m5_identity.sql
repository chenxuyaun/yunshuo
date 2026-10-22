ALTER TABLE users
  ADD COLUMN password_hash text,
  ADD COLUMN password_updated_at timestamptz;

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

ALTER TABLE sessions
  ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD COLUMN auth_method text NOT NULL DEFAULT 'dev';

UPDATE sessions s
SET workspace_id = (
  SELECT m.workspace_id
  FROM memberships m
  WHERE m.user_id = s.user_id
  ORDER BY m.created_at ASC
  LIMIT 1
);

DELETE FROM sessions WHERE workspace_id IS NULL;

ALTER TABLE sessions
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_auth_method_check CHECK (auth_method IN ('dev', 'password'));

CREATE INDEX sessions_user_workspace_idx ON sessions (user_id, workspace_id);

CREATE TABLE workspace_invites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'lead', 'author', 'reviewer', 'viewer', 'billing')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX workspace_invites_pending_email
  ON workspace_invites (workspace_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX workspace_invites_workspace_created_idx
  ON workspace_invites (workspace_id, created_at DESC);
