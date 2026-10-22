ALTER TABLE model_providers
  ADD COLUMN purpose text NOT NULL DEFAULT 'chat';

ALTER TABLE model_providers
  ADD CONSTRAINT model_providers_purpose_check
    CHECK (purpose IN ('chat', 'embedding'));

ALTER TABLE model_providers
  DROP CONSTRAINT model_providers_pricing_pair_check;

ALTER TABLE model_providers
  ADD CONSTRAINT model_providers_pricing_pair_check
    CHECK (
      (purpose = 'chat' AND (
        (prompt_price_per_1m IS NULL AND completion_price_per_1m IS NULL)
        OR (prompt_price_per_1m IS NOT NULL AND completion_price_per_1m IS NOT NULL)
      ))
      OR (purpose = 'embedding' AND completion_price_per_1m IS NULL)
    );

CREATE INDEX model_providers_workspace_purpose_idx
  ON model_providers (workspace_id, purpose, is_enabled, priority);

ALTER TABLE index_status
  DROP CONSTRAINT index_status_status_check;

ALTER TABLE index_status
  ADD CONSTRAINT index_status_status_check
    CHECK (status IN ('pending', 'indexing', 'ready', 'failed', 'not_configured')),
  ADD COLUMN chunk_count integer NOT NULL DEFAULT 0,
  ADD COLUMN provider_name text,
  ADD COLUMN model text,
  ADD COLUMN dimensions integer,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_retry_at timestamptz,
  ADD COLUMN last_error text;

ALTER TABLE outbox
  ADD COLUMN dedupe_key text,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN locked_at timestamptz;

ALTER TABLE outbox
  ADD CONSTRAINT outbox_dedupe_key_key UNIQUE (dedupe_key);

CREATE INDEX outbox_pending_next_idx
  ON outbox (status, next_attempt_at, id);

CREATE TABLE canon_chunks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES canon_versions(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  paragraph_start integer NOT NULL CHECK (paragraph_start >= 0),
  paragraph_end integer NOT NULL CHECK (paragraph_end >= paragraph_start),
  char_start integer NOT NULL CHECK (char_start >= 0),
  char_end integer NOT NULL CHECK (char_end > char_start),
  content text NOT NULL,
  content_hash text NOT NULL,
  lexical_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, chunk_index)
);

CREATE INDEX canon_chunks_chapter_version_idx
  ON canon_chunks (chapter_id, version_id);

CREATE INDEX canon_chunks_work_idx
  ON canon_chunks (work_id, version_id);

CREATE INDEX canon_chunks_lexical_idx
  ON canon_chunks USING gin (to_tsvector('simple', lexical_text));

CREATE TABLE chunk_embeddings (
  chunk_id uuid PRIMARY KEY REFERENCES canon_chunks(id) ON DELETE CASCADE,
  provider_id uuid REFERENCES model_providers(id) ON DELETE SET NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 8192),
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (vector_dims(embedding) = dimensions)
);

CREATE INDEX chunk_embeddings_model_dim_idx
  ON chunk_embeddings (model, dimensions);
