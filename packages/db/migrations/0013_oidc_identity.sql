-- OIDC 身份与本地账号分离：subject 以 issuer + sub 唯一，邮箱只用于首次绑定或受邀开通。
-- 不存 ID Token、access token、授权码或客户端密钥。
CREATE TABLE user_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  subject text NOT NULL,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CONSTRAINT user_identities_provider_subject_key UNIQUE (provider, subject)
);

CREATE INDEX user_identities_user_idx ON user_identities (user_id);

ALTER TABLE sessions DROP CONSTRAINT sessions_auth_method_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_auth_method_check CHECK (auth_method IN ('dev', 'password', 'oidc'));
