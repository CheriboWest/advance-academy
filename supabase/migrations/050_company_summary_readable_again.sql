-- ============================================================================
--  050 — make public_company_summary readable to visitors and coaches again
--  Run in Supabase SQL Editor. Idempotent: safe to re-run.
--
--  Applying 048 broke every page that reads public_company_summary with a
--  user's own Supabase session — /search, /companies/<slug>, the coach
--  Dashboard (where coach sign-in lands) and the coach Companies tab — with
--  "permission denied for table companies".
--
--  Why: 048 ends with `alter view ... set (security_invoker = true)`, so the
--  view checks the *reader's* rights on public.companies, and 040 revoked
--  every right on that table from anon and authenticated. Nobody noticed
--  before because 036 and 037 had re-created the view with
--  `create or replace view`, which silently drops security_invoker: production
--  ran the view with its owner's rights from 037 until 048 was applied.
--
--  This puts back that working state. It exposes nothing new: the view lists
--  only its own columns (no table access is granted), and it already applies
--  the same active/unexpired filter the jobs RLS policy does. companies stays
--  service-role only, as 040 intended.
--
--  After running, as a check (expect a number, not an error):
--    set role authenticated; select count(*) from public.public_company_summary; reset role;
-- ============================================================================

alter view public.public_company_summary set (security_invoker = false);

comment on view public.public_company_summary is
  'Every company with its count of open (active, unexpired) jobs; 0 when none (048). '
  'Runs with its owner''s rights (050): anon/authenticated read it, never public.companies (040).';
