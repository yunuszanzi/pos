-- The browser talks only to our API (technical-plan 1 and 3.3). Supabase grants the anon and
-- authenticated roles full table privileges in public by default, which let any signed-in user
-- read business tables through PostgREST, bypassing API permission checks. Remove those grants;
-- the RLS policies stay as a second line of defence if access is ever granted again.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- Every business table records who created and last updated it (technical-plan 2).
-- These reference auth.users because the first business row is written before its owner's profile.
ALTER TABLE businesses
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE branches
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE locations
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE terminals
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE roles
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE users
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE document_series
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE business_settings
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
