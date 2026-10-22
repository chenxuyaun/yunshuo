-- M6-4：已生效账本条目的独立检索投影、索引状态与章节人工关联。
-- 只索引 current_version；草稿与归档条目不进入检索、AI 上下文或门禁提示。
CREATE TABLE ledger_chunks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES ledger_entry_versions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('setting', 'character', 'foreshadowing')),
  work_id uuid REFERENCES works(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  content_hash text NOT NULL,
  lexical_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, chunk_index)
);

CREATE INDEX ledger_chunks_entry_version_idx
  ON ledger_chunks (entry_id, version_id);

CREATE INDEX ledger_chunks_work_idx
  ON ledger_chunks (work_id);

CREATE INDEX ledger_chunks_lexical_idx
  ON ledger_chunks USING gin (to_tsvector('simple', lexical_text));

CREATE TABLE ledger_chunk_embeddings (
  chunk_id uuid PRIMARY KEY REFERENCES ledger_chunks(id) ON DELETE CASCADE,
  provider_id uuid REFERENCES model_providers(id) ON DELETE SET NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 8192),
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (vector_dims(embedding) = dimensions)
);

CREATE INDEX ledger_chunk_embeddings_model_dim_idx
  ON ledger_chunk_embeddings (model, dimensions);

CREATE TABLE ledger_index_status (
  entry_id uuid PRIMARY KEY REFERENCES ledger_entries(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES ledger_entry_versions(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (
    status IN ('pending', 'indexing', 'ready', 'failed', 'not_configured')
  ),
  detail text,
  chunk_count integer NOT NULL DEFAULT 0,
  provider_name text,
  model text,
  dimensions integer,
  attempts integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_index_status_workspace_idx
  ON ledger_index_status (workspace_id, status);

CREATE TABLE chapter_ledger_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chapter_id, entry_id)
);

CREATE INDEX chapter_ledger_links_entry_idx
  ON chapter_ledger_links (entry_id);

CREATE INDEX chapter_ledger_links_workspace_idx
  ON chapter_ledger_links (workspace_id, created_at DESC);

-- 门禁提示与硬门禁结论分列存储；提示不参与 passed/failed/blocked 判定。
ALTER TABLE gate_evaluations
  ADD COLUMN hints jsonb NOT NULL DEFAULT '[]'::jsonb;
