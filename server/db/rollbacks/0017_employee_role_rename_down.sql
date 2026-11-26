-- DEC-114 rollback: Restore the CASHIER role code and CHECK constraint from 0017_employee_role_rename.sql
-- while preserving user IDs, usernames, credentials, and linked records.

DO $$
DECLARE
  constraint_rec record;
BEGIN
  FOR constraint_rec IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
     WHERE nsp.nspname = current_schema()
       AND rel.relname = 'app_users'
       AND att.attname = 'role'
       AND con.contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE app_users DROP CONSTRAINT %I', constraint_rec.conname);
  END LOOP;
END $$;

UPDATE app_users
   SET role = 'CASHIER'
 WHERE role = 'EMPLOYEE';

ALTER TABLE app_users
  ADD CONSTRAINT app_users_role_check CHECK (role IN ('OWNER', 'CASHIER'));

DELETE FROM schema_migrations
 WHERE name = '0017_employee_role_rename.sql';
