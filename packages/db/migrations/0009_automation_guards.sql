ALTER TABLE automation_mandates
  ADD COLUMN allow_non_production_gates boolean NOT NULL DEFAULT false;
