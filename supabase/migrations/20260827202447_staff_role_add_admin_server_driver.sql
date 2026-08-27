-- Three new staff roles, values only.
--
-- Postgres cannot USE a value added by ALTER TYPE ... ADD VALUE inside the same
-- transaction that adds it, so everything that references 'admin'/'server'/'driver'
-- (the capability seed, the policies) lands in the NEXT migration.
--
-- This is the one irreversible change in this workstream: there is no
-- ALTER TYPE ... DROP VALUE, and RENAME VALUE rewrites nothing automatically.
-- The names are final.
alter type public.staff_role add value if not exists 'admin';
alter type public.staff_role add value if not exists 'server';
alter type public.staff_role add value if not exists 'driver';
