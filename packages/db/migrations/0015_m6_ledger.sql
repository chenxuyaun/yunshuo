-- 设定与连续性账本：设定条目、角色档案、伏笔台账共用一套版本与审计骨架。
-- 工作区已有 settings_version / ledger_version，发布或归档时递增，使旧的门禁上下文哈希失效。
CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_id uuid REFERENCES works(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('setting', 'character', 'foreshadowing')),
  scope text NOT NULL CHECK (scope IN ('workspace', 'work')),
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}'::text[],
  summary text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  source_chapter_id uuid REFERENCES chapters(id) ON DELETE SET NULL,
  current_version_id uuid,
  draft_version_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'workspace' AND work_id IS NULL) OR (scope = 'work' AND work_id IS NOT NULL)),
  CHECK (kind = 'setting' OR scope = 'work')
);

CREATE TABLE ledger_entry_versions (
  id uuid PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  snapshot jsonb NOT NULL,
  change_summary text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, version_no)
);

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES ledger_entry_versions(id) ON DELETE SET NULL,
  ADD CONSTRAINT ledger_entries_draft_version_fk
    FOREIGN KEY (draft_version_id) REFERENCES ledger_entry_versions(id) ON DELETE SET NULL;

-- 未归档条目在同一工作区、同一类型、同一作品范围内名称唯一；归档后释放名称。
CREATE UNIQUE INDEX ledger_entries_name_unique_idx
  ON ledger_entries (
    workspace_id,
    kind,
    COALESCE(work_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  )
  WHERE status <> 'archived';

CREATE INDEX ledger_entries_list_idx
  ON ledger_entries (workspace_id, kind, status, updated_at DESC);

CREATE INDEX ledger_entries_work_idx
  ON ledger_entries (work_id)
  WHERE work_id IS NOT NULL;

CREATE INDEX ledger_entries_aliases_idx
  ON ledger_entries USING gin (aliases);

CREATE INDEX ledger_entry_versions_entry_idx
  ON ledger_entry_versions (entry_id, version_no DESC);

CREATE INDEX ledger_entry_versions_workspace_idx
  ON ledger_entry_versions (workspace_id, created_at DESC);
