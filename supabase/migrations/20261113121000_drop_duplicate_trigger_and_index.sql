-- Remove two exact duplicates that every write paid for twice. Nothing else changes.
--
-- 1. lead_data had two BEFORE UPDATE triggers running public.set_updated_at() (new.updated_at = now()):
--    lead_data_set_updated_at and set_lead_data_updated_at (created by 20260902045159_phase_2_lead_webhooks). Same
--    timing, same function, no column list, no WHEN clause (checked live in pg_trigger on 2026-11-13), and now() is
--    the same value within a transaction, so the second one only repeated the first. lead_data_set_updated_at stays,
--    so updated_at still moves on every update.
-- 2. tenant_memberships_user_id_idx (20260924120000_multi_membership) is a plain btree (user_id), the same as the
--    unique index behind tenant_memberships_user_id_key (one login = one company), which stays and still serves
--    every lookup by user_id. Every membership write maintained both.
--
-- lock_timeout: dropping a trigger briefly locks lead_data. If a long query holds the table, this fails after 5 s
-- instead of making lead saves wait behind it.
-- Undo: supabase/rollbacks/20261113121000_drop_duplicate_trigger_and_index.rollback.sql.

begin;
set local lock_timeout = '5s';

drop trigger if exists set_lead_data_updated_at on public.lead_data;
drop index if exists public.tenant_memberships_user_id_idx;

commit;
