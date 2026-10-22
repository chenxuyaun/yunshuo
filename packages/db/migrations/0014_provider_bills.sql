-- 供应商账单由人工导入，只用于与本地估算对账。
-- 账单是费用事实，本地 model_calls 仍是估算；对账不反向改写调用记录或预算。
CREATE TABLE provider_bills (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES model_providers(id) ON DELETE RESTRICT,
  provider_name text NOT NULL,
  invoice_no text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency text NOT NULL CHECK (currency IN ('CNY', 'USD')),
  declared_total numeric(18, 6) CHECK (declared_total IS NULL OR declared_total >= 0),
  status text NOT NULL DEFAULT 'imported'
    CHECK (status IN ('imported', 'reviewed', 'disputed')),
  review_note text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  imported_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_bills_period_check CHECK (period_end >= period_start),
  CONSTRAINT provider_bills_invoice_unique UNIQUE (workspace_id, provider_id, invoice_no)
);

CREATE INDEX provider_bills_workspace_period_idx
  ON provider_bills (workspace_id, period_start DESC, period_end DESC);

CREATE TABLE provider_bill_lines (
  id uuid PRIMARY KEY,
  bill_id uuid NOT NULL REFERENCES provider_bills(id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
  model text NOT NULL,
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  amount numeric(18, 6) NOT NULL CHECK (amount >= 0),
  note text,
  CONSTRAINT provider_bill_lines_line_unique UNIQUE (bill_id, line_no)
);

CREATE INDEX provider_bill_lines_bill_model_idx
  ON provider_bill_lines (bill_id, model);
