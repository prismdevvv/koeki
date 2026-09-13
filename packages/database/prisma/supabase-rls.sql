-- Defence in depth for hosting the Postgres database on Supabase.
--
-- Koeki never talks to Supabase's PostgREST/anon-key API — Prisma connects
-- directly over Postgres (DATABASE_URL / DIRECT_URL) using its own role, and
-- all access control lives server-side in NextAuth + packages/domain
-- permissions. This script exists purely so that, if the project's anon or
-- service_role key were ever exposed or misused, every table still refuses
-- access by default: RLS is enabled with zero permissive policies, which
-- denies all access to Postgres roles other than the table owner (the role
-- Prisma connects as, which is unaffected by RLS on the tables it owns).
--
-- Run this once against the Supabase database after `prisma migrate deploy`
-- (e.g. via the Supabase SQL editor, or `psql "$DIRECT_URL" -f supabase-rls.sql`).
-- Safe to re-run: ENABLE ROW LEVEL SECURITY is idempotent and no policies are
-- created, so nothing here can accidentally grant access.
DO $$
DECLARE
  table_name text;
BEGIN
  FOR table_name IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;
