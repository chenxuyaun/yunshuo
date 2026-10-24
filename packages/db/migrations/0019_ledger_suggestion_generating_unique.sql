-- M6-7：同一账本条目同时只允许一条"生成中"的建议。
-- 生成会真实花钱，两个人（或连点两次）同时触发同一条目就会各发一次模型调用、各留一条建议，
-- 后写的那条覆盖不了前一条，只能都留在列表里。这里把约束下推到数据库，
-- 并发写入得到 23505 而不是静默多算一次钱。
-- 先按服务层的超时口径把中断的 generating 归为失败（这些行本就该被回收），
-- 再建唯一索引；若仍有真正的并发残留，索引创建会直接报错，不静默丢弃任何行。
UPDATE ledger_suggestions
SET status = 'failed',
    error_code = 'AI_ABANDONED',
    error_message = '生成未正常结束（请求中断或进程退出），建议标记为失败',
    completed_at = now()
WHERE status = 'generating'
  AND created_at < now() - interval '10 minutes';

CREATE UNIQUE INDEX ledger_suggestions_one_generating_idx
  ON ledger_suggestions (entry_id)
  WHERE status = 'generating';
