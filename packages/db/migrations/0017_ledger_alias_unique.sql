-- M6-6：别名唯一性由数据库兜底。
-- 名称唯一已由 ledger_entries_name_unique_idx 保证；别名存在 text[] 里，无法直接建唯一索引，
-- 因此用一张规范化投影表 + 触发器维护，把并发写入的别名冲突变成数据库错误而不是静默通过。
-- 只在未归档条目之间约束，与名称索引的口径一致：条目归档后释放别名。
CREATE TABLE ledger_entry_aliases (
  entry_id uuid NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  work_id uuid,
  alias_key text NOT NULL,
  PRIMARY KEY (entry_id, alias_key)
);

CREATE UNIQUE INDEX ledger_entry_aliases_unique_idx
  ON ledger_entry_aliases (
    workspace_id,
    kind,
    COALESCE(work_id, '00000000-0000-0000-0000-000000000000'::uuid),
    alias_key
  );

CREATE INDEX ledger_entry_aliases_entry_idx
  ON ledger_entry_aliases (entry_id);

CREATE FUNCTION ledger_sync_aliases() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM ledger_entry_aliases
  WHERE entry_id = COALESCE(NEW.id, OLD.id);

  IF COALESCE(NEW.status, 'archived') <> 'archived' THEN
    INSERT INTO ledger_entry_aliases (entry_id, workspace_id, kind, work_id, alias_key)
    SELECT NEW.id, NEW.workspace_id, NEW.kind, NEW.work_id, lower(trim(alias))
    FROM unnest(COALESCE(NEW.aliases, '{}'::text[])) AS alias
    WHERE lower(trim(alias)) <> ''
    GROUP BY NEW.id, NEW.workspace_id, NEW.kind, NEW.work_id, lower(trim(alias));
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER ledger_entries_sync_aliases
AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger_sync_aliases();

-- 回填既有条目。若历史数据里已存在跨条目的重复别名，本迁移会失败并要求先人工合并，
-- 不会静默丢弃冲突行。
INSERT INTO ledger_entry_aliases (entry_id, workspace_id, kind, work_id, alias_key)
SELECT e.id, e.workspace_id, e.kind, e.work_id, lower(trim(alias))
FROM ledger_entries e
CROSS JOIN LATERAL unnest(COALESCE(e.aliases, '{}'::text[])) AS alias
WHERE e.status <> 'archived'
  AND lower(trim(alias)) <> ''
GROUP BY e.id, e.workspace_id, e.kind, e.work_id, lower(trim(alias));
