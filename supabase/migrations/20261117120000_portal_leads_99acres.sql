-- Real-estate portal leads, starting with 99acres. The portal (99acres today; MagicBricks, NoBroker and RoofandFloor
-- later) pushes each enquiry to a secret URL unique to the company, the same lead_data table as Meta, Google Ads,
-- call-in and webhook leads, with lead_source '99acres'.
--
-- One integration per company per portal. The secret is the URL itself: its random token is never stored in plain text,
-- only its SHA-256 (url_token_hash, used to find the company) and an AES-GCM copy (encrypted_url_token, so the owner can
-- copy the URL again). The tenant comes only from that lookup, never from the request.
--
-- Every request that reaches a company's integration is first written as-is to portal_webhook_logs (headers, query
-- string, body), before it is read, so an enquiry sent with unexpected field names is never lost: the owner sees the
-- exact keys in the Integrations card. Logs older than 30 days are deleted every night (crm-portal-webhook-log-purge).
--
-- Additive only. Nothing Meta, Google Ads, call-in or the custom webhook writes changes:
--   1. lead_data gets 3 nullable portal_* columns. Every existing row leaves them NULL. No default, so adding them is a
--      catalog change only (no table rewrite).
--   2. lead_data_lead_source_check and lead_data_source_fields_check are recreated as supersets. The facebook,
--      telecaller, google_ads and custom_webhook branches are the live text (pg_get_constraintdef, read 2026-11-17)
--      unchanged; a '99acres' branch is added. ad_id stays NULL for portal rows, so the ad assignment rule, the Meta ad
--      filters and the Meta ad-name resolver never see them.
--   3. lead_data_portal_fields_check (new) keeps the portal_* columns NULL on every other source, without editing the
--      existing branches. lead_data_custom_webhook_fields_check already keeps custom_* NULL on portal rows.
--   4. portal_integrations and portal_webhook_logs (new) are service-role only (RLS forced, no policies, nothing granted
--      to anon/authenticated), the same model as custom_lead_webhooks and lead_data.
--   5. ingest_portal_lead (new) is the only writer of portal leads.
-- lead_platform (generated) becomes '99acres' for these rows and lead_ad_ref stays NULL, so the /leads Source filter and
-- the dashboard's platform view work with no change; get_dashboard_platform_stats_v2 is not touched.
--
-- Contact fields: the intake stores answers in Meta's field_data shape and under Meta's keys (full_name, first_name,
-- last_name, email, phone_number), so populate_meta_lead_contact_fields, search, phone normalising and the AI-label
-- redaction work on portal leads with no change. The existing insert triggers also queue the AI label, write the
-- "Lead created" timeline row and send the live new-lead signal; a portal lead arrives Unassigned.
--
-- Same phone again: when an enquiry's phone already belongs to a lead of this company (any source), no second lead is
-- made. A timeline note ("New 99acres enquiry ...") is added to that lead instead, as a lead_activities row of type
-- note_added with no author (shown as System). lead_notes is not used: its created_by is a required member.
--
-- Undo: supabase/rollbacks/20261117120000_portal_leads_99acres.rollback.sql.
-- Check after applying (read-only): scripts/sql/portal-leads-verify.sql.
--
-- Locks: from the first ALTER TABLE lead_data until COMMIT this transaction holds ACCESS EXCLUSIVE on lead_data
-- (42 rows on prod at 2026-11-17, so milliseconds). lock_timeout makes it fail and roll back cleanly instead of
-- queueing every lead read/write behind it if a long query already holds lead_data. The checks and the foreign key
-- are added NOT VALID and validated after COMMIT (SHARE UPDATE EXCLUSIVE: reads and writes continue).

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- The company's portal integrations (one per portal).
-- ---------------------------------------------------------------------------
create table public.portal_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
  -- Adding a portal: widen this check and lead_data_lead_source_check / lead_data_portal_fields_check.
  portal_name text not null check (portal_name in ('99acres')),
  url_token_hash text not null unique check (url_token_hash ~ '^[0-9a-f]{64}$'),
  encrypted_url_token text not null check (encrypted_url_token <> ''),
  is_active boolean not null default true,
  last_received_at timestamptz,
  url_rotated_at timestamptz,
  -- Optional per-company overrides of the field names the intake looks for, e.g. {"phone": ["custMobile"]}. Set by
  -- support when a portal sends a key the default lists do not know; the app never writes it.
  field_mapping jsonb not null default '{}'::jsonb check (jsonb_typeof(field_mapping) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portal_integrations_tenant_portal_key unique (tenant_id, portal_name),
  constraint portal_integrations_tenant_id_id_key unique (tenant_id, id)
);

create trigger portal_integrations_set_updated_at before update on public.portal_integrations
  for each row execute function public.set_updated_at();

alter table public.portal_integrations enable row level security;
alter table public.portal_integrations force row level security;

-- Supabase's default privileges give service_role ALL (including TRUNCATE) on new tables; grant back only what the
-- server uses. Rows are never deleted by the app (a new URL replaces the token in place); a tenant delete cascades.
revoke all on table public.portal_integrations from public, anon, authenticated, service_role;
grant select, insert, update on table public.portal_integrations to service_role;

-- ---------------------------------------------------------------------------
-- lead_data
-- ---------------------------------------------------------------------------
alter table public.lead_data
  add column portal_integration_id uuid,
  add column portal_lead_ref text,
  add column portal_project_name text;

-- Backs the foreign key below (a tenant's cascade delete checks it).
create index lead_data_tenant_portal_integration_idx
  on public.lead_data (tenant_id, portal_integration_id) where portal_integration_id is not null;

-- NO ACTION (checked at the end of the statement), so a tenant's cascade delete, which removes both the leads and the
-- integration in one statement, always succeeds.
alter table public.lead_data add constraint lead_data_portal_integration_fk
  foreign key (tenant_id, portal_integration_id) references public.portal_integrations (tenant_id, id) not valid;

alter table public.lead_data drop constraint lead_data_lead_source_check;
alter table public.lead_data add constraint lead_data_lead_source_check
  check (lead_source in ('facebook', 'telecaller', 'google_ads', 'custom_webhook', '99acres')) not valid;

-- The facebook, telecaller, google_ads and custom_webhook branches below are the live constraint's branches, unchanged.
alter table public.lead_data drop constraint lead_data_source_fields_check;
alter table public.lead_data add constraint lead_data_source_fields_check check (
  (lead_source = 'facebook'
    and webhook_notification_event_id is not null and leadgen_id is not null
    and facebook_page_record_id is not null and facebook_page_id is not null
    and form_id is not null and raw_lead_payload is not null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = 'telecaller'
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and raw_lead_payload is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = 'google_ads'
    and google_lead_event_id is not null and google_lead_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null and ad_id is null)
  or
  (lead_source = 'custom_webhook'
    and custom_webhook_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = '99acres'
    and portal_integration_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
) not valid;

-- The portal_* columns belong to portal leads only. Every existing row has them NULL, so it passes.
alter table public.lead_data add constraint lead_data_portal_fields_check check (
  (portal_integration_id is null and portal_lead_ref is null and portal_project_name is null)
  or
  (lead_source in ('99acres') and portal_integration_id is not null
    and (portal_lead_ref is null or char_length(portal_lead_ref) between 1 and 200)
    and (portal_project_name is null or char_length(portal_project_name) between 1 and 200))
) not valid;

-- ---------------------------------------------------------------------------
-- The raw request log: every request that reached a company's integration, exactly as sent.
-- ---------------------------------------------------------------------------
create table public.portal_webhook_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
  integration_id uuid not null,
  portal_name text not null,
  http_method text not null check (http_method in ('GET', 'POST')),
  headers jsonb not null default '{}'::jsonb check (jsonb_typeof(headers) = 'object'),
  query_params jsonb not null default '{}'::jsonb check (jsonb_typeof(query_params) = 'object'),
  raw_body text not null default '' check (char_length(raw_body) <= 65536),
  -- The portal's own id for the enquiry, filled when the request is read (a retry of it is never saved twice).
  external_lead_id text check (external_lead_id is null or char_length(external_lead_id) between 1 and 200),
  parsed_lead_id uuid,
  -- received: written, not yet read. processed: a new lead. duplicate: the same enquiry again, or the phone of an
  -- existing lead (a note was added to it). failed: never became a lead (error_message says why).
  status text not null default 'received' check (status in ('received', 'processed', 'duplicate', 'failed')),
  error_message text check (error_message is null or char_length(error_message) between 1 and 500),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint portal_webhook_logs_integration_fk foreign key (tenant_id, integration_id)
    references public.portal_integrations (tenant_id, id) on delete cascade,
  -- Deleting a lead keeps its log rows and clears only the link. The column list matters: a plain SET NULL would also
  -- clear tenant_id (NOT NULL) and make every such lead delete fail.
  constraint portal_webhook_logs_parsed_lead_fk foreign key (tenant_id, parsed_lead_id)
    references public.lead_data (tenant_id, id) on delete set null (parsed_lead_id)
);

-- The Integrations card's "last 10 requests".
create index portal_webhook_logs_integration_created_idx on public.portal_webhook_logs (integration_id, created_at desc);
-- A retry of the same enquiry.
create index portal_webhook_logs_integration_ref_idx
  on public.portal_webhook_logs (integration_id, external_lead_id) where external_lead_id is not null;
-- Backs the lead foreign key (every lead delete checks it).
create index portal_webhook_logs_parsed_lead_idx
  on public.portal_webhook_logs (tenant_id, parsed_lead_id) where parsed_lead_id is not null;
-- The nightly 30-day delete.
create index portal_webhook_logs_created_idx on public.portal_webhook_logs (created_at);

alter table public.portal_webhook_logs enable row level security;
alter table public.portal_webhook_logs force row level security;

-- The server writes and reads logs; only the nightly job (postgres) deletes them.
revoke all on table public.portal_webhook_logs from public, anon, authenticated, service_role;
grant select, insert, update on table public.portal_webhook_logs to service_role;

-- ---------------------------------------------------------------------------
-- ingest_portal_lead: the only writer of portal leads. Called by the intake after it has matched the URL token's hash
-- to this tenant's active integration, written the raw request to portal_webhook_logs (p_log_id) and mapped it.
-- Returns {"outcome": "stored" | "merged" | "duplicate", "lead_id": <uuid>}:
--   stored     a new lead
--   merged     the phone belongs to an existing lead of this company: a timeline note was added to it
--   duplicate  the same enquiry was already received (a retry): nothing new was written
-- The log row is updated in the same transaction. Errors (the whole call rolls back; the intake marks the log failed):
--   P0002  the integration is gone, stopped, of another portal or of another company (the intake answers 404)
--   22023  the lead is unusable: no phone and no email, or a malformed argument (the intake answers 400)
--   55000  the log row is missing or was already read (the intake answers 500)
-- ---------------------------------------------------------------------------
create function public.ingest_portal_lead(
  p_tenant_id uuid, p_integration_id uuid, p_log_id uuid, p_portal text, p_lead_ref text, p_project_name text,
  p_enquiry_summary text, p_field_data jsonb, p_raw_payload jsonb, p_is_test boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ref text := nullif(pg_catalog.btrim(coalesce(p_lead_ref, '')), '');
  v_project text := pg_catalog.left(nullif(pg_catalog.btrim(coalesce(p_project_name, '')), ''), 200);
  v_summary text := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(coalesce(p_enquiry_summary, '')), ''), 'New enquiry'), 500);
  v_test boolean := coalesce(p_is_test, false);
  v_phone text;
  v_email text;
  v_lead_id uuid;
  v_outcome text;
begin
  if p_field_data is null or pg_catalog.jsonb_typeof(p_field_data) <> 'array' then
    raise exception 'Lead fields must be a list' using errcode = '22023';
  end if;
  if p_raw_payload is null or pg_catalog.jsonb_typeof(p_raw_payload) <> 'object' then
    raise exception 'Lead payload must be an object' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_ref) > 200 then
    raise exception 'lead id must be 200 characters or fewer' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.portal_integrations as i
    where i.id = p_integration_id and i.tenant_id = p_tenant_id and i.portal_name = p_portal and i.is_active
  ) then
    raise exception 'Portal integration not found' using errcode = 'P0002';
  end if;
  perform 1 from public.portal_webhook_logs as l
  where l.id = p_log_id and l.tenant_id = p_tenant_id and l.integration_id = p_integration_id and l.status = 'received'
  for update;
  if not found then
    raise exception 'Webhook log not found' using errcode = '55000';
  end if;

  select contact.lead_phone_normalized, pg_catalog.lower(contact.lead_email) into v_phone, v_email
  from public.extract_meta_lead_contact_fields(p_field_data) as contact;
  if v_phone is null and v_email is null then
    raise exception 'Send mobile or email' using errcode = '22023';
  end if;

  -- Always in this order (enquiry id, then phone), so two calls can never wait on each other. The phone lock is the
  -- one create_telecaller_lead takes, so a call-in lead and a portal lead for one phone cannot both be created.
  if v_ref is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || ':portal_lead:' || p_portal || ':' || v_ref, 0));
  end if;
  if v_phone is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || ':' || v_phone, 0));
  end if;

  -- A retry: this enquiry id was already read for this integration and led to a lead with the same phone (or, with no
  -- phone, the same email). The id alone never counts: a portal may send a property id that many enquiries share.
  if v_ref is not null then
    select l.parsed_lead_id into v_lead_id
    from public.portal_webhook_logs as l
    join public.lead_data as ld on ld.tenant_id = l.tenant_id and ld.id = l.parsed_lead_id
    where l.integration_id = p_integration_id and l.tenant_id = p_tenant_id
      and l.external_lead_id = v_ref and l.id <> p_log_id
      and l.status in ('processed', 'duplicate')
      and case when v_phone is not null then ld.lead_phone_normalized = v_phone
               else ld.lead_phone_normalized is null and pg_catalog.lower(ld.lead_email) = v_email end
    order by l.created_at
    limit 1;
    if v_lead_id is not null then
      v_outcome := 'duplicate';
    end if;
  end if;

  -- The same person enquired before (from any source): a note on their lead instead of a second lead.
  if v_outcome is null and v_phone is not null then
    select ld.id into v_lead_id from public.lead_data as ld
    where ld.tenant_id = p_tenant_id and ld.lead_phone_normalized = v_phone
    order by ld.created_at, ld.id
    limit 1;
    if v_lead_id is not null then
      insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by)
      values (p_tenant_id, v_lead_id, 'note_added', v_summary,
        pg_catalog.jsonb_build_object('source', p_portal, 'portal_log_id', p_log_id), null);
      v_outcome := 'merged';
    end if;
  end if;

  if v_outcome is null then
    insert into public.lead_data (
      tenant_id, lead_source, portal_integration_id, portal_lead_ref, portal_project_name,
      lead_created_time, field_data, raw_lead_payload, retrieved_at
    ) values (
      p_tenant_id, p_portal, p_integration_id, v_ref, v_project,
      pg_catalog.clock_timestamp(), p_field_data, p_raw_payload, pg_catalog.clock_timestamp()
    )
    returning id into v_lead_id;
    v_outcome := 'stored';
  end if;

  update public.portal_webhook_logs
  set status = case when v_outcome = 'stored' then 'processed' else 'duplicate' end,
      parsed_lead_id = v_lead_id, external_lead_id = v_ref, error_message = null,
      processed_at = pg_catalog.clock_timestamp()
  where id = p_log_id and tenant_id = p_tenant_id;

  -- A test lead from the Integrations card never makes the card say the portal is connected.
  if not v_test then
    update public.portal_integrations set last_received_at = pg_catalog.clock_timestamp()
    where id = p_integration_id and tenant_id = p_tenant_id;
  end if;
  return pg_catalog.jsonb_build_object('outcome', v_outcome, 'lead_id', v_lead_id);
end;
$$;

revoke all on function public.ingest_portal_lead(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.ingest_portal_lead(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Nightly: raw request logs older than 30 days are deleted. The leads they created stay.
-- ---------------------------------------------------------------------------
create or replace function private.purge_portal_webhook_logs()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.portal_webhook_logs where created_at < pg_catalog.now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  -- Quiet nights stay silent. cron.job_run_details only records "1 row" for a select, so the count is logged here.
  if v_deleted > 0 then
    raise warning 'crm-portal-webhook-log-purge: % portal request log(s) older than 30 days deleted', v_deleted;
  end if;
  return v_deleted;
end;
$$;

-- Same access as the other private timer functions: only postgres (the cron job owner) may run it.
revoke all on function private.purge_portal_webhook_logs() from public, anon, authenticated, service_role;

-- 03:30 India time (IST = GMT + 5:30; cron.timezone is GMT). No other nightly job runs at this minute.
select cron.schedule('crm-portal-webhook-log-purge', '0 22 * * *',
  $$ select private.purge_portal_webhook_logs() $$);

notify pgrst, 'reload schema';

commit;

-- Outside the transaction: validate against every existing row. SHARE UPDATE EXCLUSIVE (reads and writes continue).
-- Every existing row has the portal_* columns NULL and a facebook / telecaller / google_ads / custom_webhook source, so
-- all pass.
alter table public.lead_data validate constraint lead_data_portal_integration_fk;
alter table public.lead_data validate constraint lead_data_lead_source_check;
alter table public.lead_data validate constraint lead_data_source_fields_check;
alter table public.lead_data validate constraint lead_data_portal_fields_check;
