DO $$
DECLARE
  rec record;
  parsed jsonb;
BEGIN
  FOR rec IN
    SELECT id, metadata FROM audit_log WHERE jsonb_typeof(metadata) <> 'object'
  LOOP
    BEGIN
      IF jsonb_typeof(rec.metadata) = 'string' THEN
        parsed := (rec.metadata #>> '{}')::jsonb;
        IF jsonb_typeof(parsed) = 'object' THEN
          UPDATE audit_log SET metadata = parsed WHERE id = rec.id;
        ELSE
          UPDATE audit_log
          SET metadata = jsonb_build_object('legacyValue', rec.metadata)
          WHERE id = rec.id;
        END IF;
      ELSE
        UPDATE audit_log
        SET metadata = jsonb_build_object('legacyValue', rec.metadata)
        WHERE id = rec.id;
      END IF;
    EXCEPTION WHEN others THEN
      UPDATE audit_log
      SET metadata = jsonb_build_object('legacyValue', rec.metadata)
      WHERE id = rec.id;
    END;
  END LOOP;
END $$;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_metadata_object
  CHECK (jsonb_typeof(metadata) = 'object') NOT VALID;

ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_metadata_object;
