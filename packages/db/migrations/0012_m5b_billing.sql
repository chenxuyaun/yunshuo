-- 工作区月度预算只约束生成调用；嵌入调用照常执行并单独计费。
CREATE TABLE workspace_budgets (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  monthly_limit numeric(12, 4) NOT NULL CHECK (monthly_limit >= 0),
  currency text NOT NULL CHECK (currency IN ('CNY', 'USD')),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- job_id 让无人值守调用可按作业归属；预留成本用于并发下的工作区预算硬闸门。
-- 预留只在调用进行中存在，完成、失败或超时回收后清空，避免把预留当实际费用。
ALTER TABLE model_calls
  ADD COLUMN job_id uuid REFERENCES automation_jobs(id) ON DELETE SET NULL,
  ADD COLUMN reserved_cost numeric(12, 4),
  ADD COLUMN reserved_currency text;

ALTER TABLE model_calls
  ADD CONSTRAINT model_calls_reserved_pair CHECK (
    (reserved_cost IS NULL AND reserved_currency IS NULL)
    OR (
      reserved_cost IS NOT NULL
      AND reserved_currency IN ('CNY', 'USD')
      AND reserved_cost >= 0
    )
  );

CREATE INDEX model_calls_budget_active_idx
  ON model_calls (workspace_id, purpose, status)
  WHERE reserved_cost IS NOT NULL;

CREATE INDEX model_calls_job_idx
  ON model_calls (job_id)
  WHERE job_id IS NOT NULL;
