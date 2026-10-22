ALTER TABLE waivers
  ADD COLUMN status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN decided_by uuid REFERENCES users(id),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_note text;

UPDATE waivers
SET status = 'approved',
    decided_by = approved_by,
    decided_at = approved_at
WHERE approved_by IS NOT NULL;

CREATE UNIQUE INDEX waivers_pending_unique
  ON waivers (chapter_id, target_version_id, gate_key)
  WHERE status = 'pending' AND target_version_id IS NOT NULL;

CREATE UNIQUE INDEX canon_versions_waiver_unique
  ON canon_versions (waiver_id)
  WHERE waiver_id IS NOT NULL;

CREATE INDEX waivers_chapter_status_idx
  ON waivers (chapter_id, status, created_at DESC);
