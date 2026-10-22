-- 账号级安全事件与浏览器会话分开记录：会话绑定工作区，安全事件属于账号本人。
-- 不记录密码、密码哈希、重置令牌明文或邮件正文。
CREATE TABLE auth_events (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'password.change',
    'password.reset.request',
    'password.reset.complete'
  )),
  result text NOT NULL CHECK (result IN ('success', 'failure')),
  ip text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_events_user_created_idx ON auth_events (user_id, created_at DESC);
CREATE INDEX auth_events_created_idx ON auth_events (created_at);

-- 只存 SHA-256 摘要；同一账号同时最多一个未使用令牌，补发即作废旧令牌。
CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  requested_ip text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX password_reset_tokens_active_user
  ON password_reset_tokens (user_id)
  WHERE used_at IS NULL;

CREATE INDEX password_reset_tokens_user_created_idx
  ON password_reset_tokens (user_id, created_at DESC);

-- 邮件投递仅保留可排障的元数据；正文、邀请令牌与重置令牌一律不入库。
CREATE TABLE mail_messages (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  to_email text NOT NULL,
  template text NOT NULL CHECK (template IN ('workspace_invite', 'password_reset')),
  provider text NOT NULL CHECK (provider IN ('smtp', 'memory', 'off')),
  status text NOT NULL CHECK (status IN ('sent', 'captured', 'failed', 'not_configured')),
  error_code text,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mail_messages_workspace_created_idx
  ON mail_messages (workspace_id, created_at DESC);

CREATE INDEX mail_messages_email_created_idx
  ON mail_messages (lower(to_email), created_at DESC);
