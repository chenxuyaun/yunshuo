ALTER TABLE model_providers
  ADD COLUMN api_key_ciphertext text,
  ADD COLUMN api_key_hint text,
  ADD COLUMN last_test_status text,
  ADD COLUMN last_test_message text,
  ADD COLUMN last_test_latency_ms integer,
  ADD COLUMN last_tested_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE model_providers
  ADD CONSTRAINT model_providers_test_status_check
  CHECK (last_test_status IS NULL OR last_test_status IN ('ok', 'failed'));

CREATE INDEX model_providers_workspace_idx ON model_providers (workspace_id);
