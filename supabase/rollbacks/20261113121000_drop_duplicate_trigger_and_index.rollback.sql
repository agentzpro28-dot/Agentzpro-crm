-- Undo 20261113121000_drop_duplicate_trigger_and_index.sql: puts back the second updated_at trigger on lead_data
-- and the plain user_id index on tenant_memberships, exactly as they were.
--
-- Not needed for correctness (both were duplicates). The plain index only matters again if the one-company-per-login
-- unique key tenant_memberships_user_id_key is ever dropped.

begin;
set local lock_timeout = '5s';

create trigger set_lead_data_updated_at
before update on public.lead_data
for each row execute function public.set_updated_at();

create index if not exists tenant_memberships_user_id_idx on public.tenant_memberships using btree (user_id);

commit;
