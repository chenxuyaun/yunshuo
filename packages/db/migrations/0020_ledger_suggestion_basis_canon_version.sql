-- 建议的"依据"原来只记章节，不记当时的正典版本：章节在建议生成后被重新提交或回滚后，
-- 采纳仍会写入一个由已失效正文支撑的草稿。补记版本身份，让依据侧也能像 base_version_id
-- 那样在采纳时拒绝过期建议。
-- 置 NULL 表示"无法判定"（迁移前的历史行，或该版本已被删除）：这类建议沿用旧的章节解析校验，
-- 不因取不到版本身份而拒绝采纳。
ALTER TABLE ledger_suggestions
  ADD COLUMN basis_canon_version_id uuid REFERENCES canon_versions(id) ON DELETE SET NULL;
