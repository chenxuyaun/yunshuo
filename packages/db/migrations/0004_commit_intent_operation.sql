ALTER TABLE commit_intents
  ADD COLUMN operation text NOT NULL DEFAULT 'commit'
    CHECK (operation IN ('commit', 'rollback')),
  ADD COLUMN target_version_id uuid REFERENCES canon_versions(id);
