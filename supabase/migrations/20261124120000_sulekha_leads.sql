-- Sulekha leads: a pipeline of its own. Sulekha pushes each customer enquiry to a secret URL unique to the company
-- (/api/webhooks/sulekha/<token>); it is saved in lead_data, the table every lead platform shares, with lead_source
-- 'sulekha'. Nothing here reads, calls or changes any other platform's tables or functions: Sulekha has its own
-- integration table, request log, URL save / lookup functions, save function and nightly cleanup job.
--
-- One integration per company. The secret is the URL itself: its random token is never stored in plain text, only its
-- SHA-256 (url_token_hash, used to find the company) and an AES-GCM copy (encrypted_url_token, so the owner can copy the
-- URL again). The company comes only from that lookup, never from the request.
--
-- New URL, 7-day handover: when the owner regenerates the URL, the old one keeps working for 7 days
-- (previous_url_token_hash + previous_valid_until), because Sulekha keeps sending to it until the account manager
-- changes it. Leads on each URL are timed apart (last_received_at = the current URL, previous_last_received_at = the old
-- one), so the card can tell which URL Sulekha is really using. A second regenerate ends the oldest URL at once (only
-- one previous URL is kept).
--
-- Every request that reaches a company's integration is first written as-is to sulekha_webhook_logs (headers, URL
-- parameters, body, content type, user agent, source IP and which URL it came on), before it is read, so an enquiry
-- sent with unexpected field names is never lost. Nightly at 04:15 IST (crm-sulekha-webhook-log-purge) saved copies
-- older than 30 days are deleted, and copies that were never saved (failed, or stuck at received) after 90 days.
--
-- Additive only. No existing lead changes and no other platform's writer changes:
--   1. lead_data gets 3 nullable sulekha_* columns. Every existing row leaves them NULL. No default, so adding them is a
--      catalog change only (no table rewrite). sulekha_integration_id is only the link to the integration (foreign
--      key); the leads page reads sulekha_lead_ref and sulekha_service_name (the service or category the customer
--      asked for, e.g. "Interior Designers").
--   2. lead_data_lead_source_check and lead_data_source_fields_check are recreated as supersets. Every existing branch is
--      the live text (pg_get_constraintdef, read 2026-11-24) unchanged; a 'sulekha' branch is added at the end.
--      ad_id stays NULL on Sulekha rows, so the ad assignment rule and the Facebook ad filters never see them.
--   3. lead_data_sulekha_fields_check (new) keeps the sulekha_* columns NULL on every other source.
--   4. sulekha_integrations and sulekha_webhook_logs (new) are service-role only (RLS forced, no policies, nothing
--      granted to anon/authenticated).
--   5. save_sulekha_url, find_sulekha_integration and ingest_sulekha_lead (new) are service-role only.
-- lead_platform (generated: lead_source for every non-telecaller row) becomes 'sulekha' for these rows and lead_ad_ref
-- stays NULL, so the /leads Source filter and the dashboard's platform view need no database change (no database
-- function lists the lead sources; checked on prod 2026-11-24).
--
-- Shared lead parts it uses, unchanged: public.extract_meta_lead_contact_fields (reads name / email / phone from the
-- answers for every lead; "meta" is only its historical name), lead_data's own insert triggers (AI label, "Lead created",
-- live new-lead signal, phone cleanup) and lead_activities (the lead's timeline).
--
-- Same phone again: when an enquiry's phone already belongs to a lead of this company (any source), no second lead is
-- made. A timeline note ("New Sulekha enquiry ...") is added to that lead instead. The phone lock is the same lock name
-- every phone-checking writer takes (tenant id + ':' + phone). A phone with no digits (e.g. "NA") normalises to '' and
-- is treated as no phone: it never takes the lock and never merges.
--
-- Undo: supabase/rollbacks/20261124120000_sulekha_leads.rollback.sql.
-- Check after applying (read-only): scripts/sql/sulekha-leads-verify.sql.
--
-- Locks: lock_timeout is set first. From the first ALTER TABLE lead_data until COMMIT this transaction holds ACCESS
-- EXCLUSIVE on lead_data (milliseconds); if a long query already holds lead_data it fails after 5 s and rolls back
-- cleanly instead of queueing every lead read/write behind it. The checks and the foreign key are added NOT VALID and
-- validated after COMMIT (SHARE UPDATE EXCLUSIVE: reads and writes continue).

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- The company's Sulekha integration (one per company).
-- ---------------------------------------------------------------------------
create table public.sulekha_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
  url_token_hash text not null unique check (url_token_hash ~ '^[0-9a-f]{64}$'),
  encrypted_url_token text not null check (encrypted_url_token <> ''),
  -- The URL before the last regenerate: still accepted until previous_valid_until (7 days).
  previous_url_token_hash text check (previous_url_token_hash is null or previous_url_token_hash ~ '^[0-9a-f]{64}$'),
  previous_valid_until timestamptz,
  is_active boolean not null default true,
  -- The last lead on the current URL, and on the previous URL since it was replaced.
  last_received_at timestamptz,
  previous_last_received_at timestamptz,
  url_rotated_at timestamptz,
  -- Optional per-company extra field names the intake looks for, e.g. {"phone": ["customerMobile"]}. Set by support
  -- when Sulekha sends a key the default lists do not know; the app never writes it.
  field_mapping jsonb not null default '{}'::jsonb check (jsonb_typeof(field_mapping) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sulekha_integrations_tenant_key unique (tenant_id),
  constraint sulekha_integrations_tenant_id_id_key unique (tenant_id, id),
  constraint sulekha_integrations_previous_pair_check
    check ((previous_url_token_hash is null) = (previous_valid_until is null)),
  constraint sulekha_integrations_previous_differs_check
    check (previous_url_token_hash is null or previous_url_token_hash <> url_token_hash)
);

-- The old-URL lookup.
create unique index sulekha_integrations_previous_hash_key
  on public.sulekha_integrations (previous_url_token_hash) where previous_url_token_hash is not null;

-- public.set_updated_at is the app-wide "touch updated_at" trigger function (lead_data uses it too).
create trigger sulekha_integrations_set_updated_at before update on public.sulekha_integrations
  for each row execute function public.set_updated_at();

alter table public.sulekha_integrations enable row level security;
alter table public.sulekha_integrations force row level security;

-- Supabase's default privileges give service_role ALL (including TRUNCATE) on new tables; grant back only what the
-- server uses. Rows are never deleted by the app (a new URL replaces the token in place); a company delete cascades.
revoke all on table public.sulekha_integrations from public, anon, authenticated, service_role;
grant select, insert, update on table public.sulekha_integrations to service_role;

-- ---------------------------------------------------------------------------
-- lead_data
-- ---------------------------------------------------------------------------
alter table public.lead_data
  add column sulekha_integration_id uuid,
  add column sulekha_lead_ref text,
  add column sulekha_service_name text;

-- Backs the foreign key below (a company's cascade delete checks it).
create index lead_data_tenant_sulekha_integration_idx
  on public.lead_data (tenant_id, sulekha_integration_id) where sulekha_integration_id is not null;

-- NO ACTION (checked at the end of the statement), so a company's cascade delete, which removes both the leads and the
-- integration in one statement, always succeeds.
alter table public.lead_data add constraint lead_data_sulekha_integration_fk
  foreign key (tenant_id, sulekha_integration_id) references public.sulekha_integrations (tenant_id, id) not valid;

alter table public.lead_data drop constraint lead_data_lead_source_check;
alter table public.lead_data add constraint lead_data_lead_source_check
  check (lead_source in ('facebook', 'telecaller', 'google_ads', 'custom_webhook', '99acres', 'magicbricks', 'housing', 'sulekha')) not valid;

-- Every branch before the 'sulekha' one is the live constraint's branch, unchanged (read 2026-11-24).
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
  or
  (lead_source = 'magicbricks'
    and magicbricks_integration_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = 'housing'
    and housing_integration_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = 'sulekha'
    and sulekha_integration_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
) not valid;

-- The sulekha_* columns belong to Sulekha leads only. Every existing row has them NULL, so it passes.
alter table public.lead_data add constraint lead_data_sulekha_fields_check check (
  (sulekha_integration_id is null and sulekha_lead_ref is null and sulekha_service_name is null)
  or
  (lead_source = 'sulekha' and sulekha_integration_id is not null
    and (sulekha_lead_ref is null or char_length(sulekha_lead_ref) between 1 and 200)
    and (sulekha_service_name is null or char_length(sulekha_service_name) between 1 and 200))
) not valid;

-- ---------------------------------------------------------------------------
-- The raw request log: every request that reached a company's Sulekha integration, exactly as sent.
-- ---------------------------------------------------------------------------
create table public.sulekha_webhook_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
  integration_id uuid not null,
  http_method text not null check (http_method in ('GET', 'POST')),
  -- Which URL the request came on: the current one, or the old one during its 7-day handover.
  url_version text not null check (url_version in ('current', 'previous')),
  headers jsonb not null default '{}'::jsonb check (jsonb_typeof(headers) = 'object'),
  query_params jsonb not null default '{}'::jsonb check (jsonb_typeof(query_params) = 'object'),
  raw_body text not null default '' check (char_length(raw_body) <= 65536),
  content_type text check (content_type is null or char_length(content_type) <= 300),
  user_agent text check (user_agent is null or char_length(user_agent) <= 500),
  -- The sender's IP as our hosting saw it (first x-forwarded-for value), so the URL can later be limited to Sulekha's
  -- servers.
  source_ip text check (source_ip is null or char_length(source_ip) <= 100),
  -- Sulekha's own id for the enquiry, filled when the request is read (a retry of it is never saved twice).
  external_lead_id text check (external_lead_id is null or char_length(external_lead_id) between 1 and 200),
  parsed_lead_id uuid,
  -- received: written, not yet read. processed: a new lead. duplicate: the same enquiry again, or the phone of an
  -- existing lead (a note was added to it). failed: never became a lead (error_message says why).
  status text not null default 'received' check (status in ('received', 'processed', 'duplicate', 'failed')),
  error_message text check (error_message is null or char_length(error_message) between 1 and 500),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint sulekha_webhook_logs_integration_fk foreign key (tenant_id, integration_id)
    references public.sulekha_integrations (tenant_id, id) on delete cascade,
  -- Deleting a lead keeps its log rows and clears only the link. The column list matters: a plain SET NULL would also
  -- clear tenant_id (NOT NULL) and make every such lead delete fail.
  constraint sulekha_webhook_logs_parsed_lead_fk foreign key (tenant_id, parsed_lead_id)
    references public.lead_data (tenant_id, id) on delete set null (parsed_lead_id)
);

-- The Integrations card's "last 10 failed requests".
create index sulekha_webhook_logs_integration_created_idx
  on public.sulekha_webhook_logs (integration_id, created_at desc);
-- A retry of the same enquiry.
create index sulekha_webhook_logs_integration_ref_idx
  on public.sulekha_webhook_logs (integration_id, external_lead_id) where external_lead_id is not null;
-- Backs the lead foreign key (every lead delete checks it).
create index sulekha_webhook_logs_parsed_lead_idx
  on public.sulekha_webhook_logs (tenant_id, parsed_lead_id) where parsed_lead_id is not null;
-- The nightly delete.
create index sulekha_webhook_logs_created_idx on public.sulekha_webhook_logs (created_at);

alter table public.sulekha_webhook_logs enable row level security;
alter table public.sulekha_webhook_logs force row level security;

-- The server writes and reads logs; only the nightly job (postgres) deletes them.
revoke all on table public.sulekha_webhook_logs from public, anon, authenticated, service_role;
grant select, insert, update on table public.sulekha_webhook_logs to service_role;

-- ---------------------------------------------------------------------------
-- save_sulekha_url: creates the company's URL, or replaces it. On a replace the current URL becomes the previous one,
-- accepted for 7 more days; an older previous URL ends at once. One statement, so two clicks at the same moment can
-- never leave a half-replaced row. Returns {"replaced": bool, "previous_valid_until": timestamptz | null}.
-- ---------------------------------------------------------------------------
create function public.save_sulekha_url(p_tenant_id uuid, p_token_hash text, p_encrypted_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.sulekha_integrations;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or coalesce(p_encrypted_token, '') = '' then
    raise exception 'Malformed URL token' using errcode = '22023';
  end if;
  insert into public.sulekha_integrations as i (tenant_id, url_token_hash, encrypted_url_token)
  values (p_tenant_id, p_token_hash, p_encrypted_token)
  on conflict (tenant_id) do update set
    previous_url_token_hash = i.url_token_hash,
    previous_valid_until = pg_catalog.now() + interval '7 days',
    previous_last_received_at = null,
    url_token_hash = excluded.url_token_hash,
    encrypted_url_token = excluded.encrypted_url_token,
    last_received_at = null,
    is_active = true,
    url_rotated_at = pg_catalog.now()
  returning * into v_row;
  return pg_catalog.jsonb_build_object('replaced', v_row.url_rotated_at is not null and v_row.previous_url_token_hash is not null,
    'previous_valid_until', v_row.previous_valid_until);
end;
$$;

revoke all on function public.save_sulekha_url(uuid, text, text) from public, anon, authenticated;
grant execute on function public.save_sulekha_url(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- find_sulekha_integration: the active integration a URL token hash belongs to, and which URL it is. The old URL counts
-- only until previous_valid_until, checked with the database's own clock. No row = unknown, stopped or expired URL.
-- ---------------------------------------------------------------------------
create function public.find_sulekha_integration(p_token_hash text)
returns table (id uuid, tenant_id uuid, field_mapping jsonb, url_version text)
language sql stable security definer set search_path = '' as $$
  select i.id, i.tenant_id, i.field_mapping, 'current'::text
  from public.sulekha_integrations as i
  where i.url_token_hash = p_token_hash and i.is_active
  union all
  select i.id, i.tenant_id, i.field_mapping, 'previous'::text
  from public.sulekha_integrations as i
  where i.previous_url_token_hash = p_token_hash and i.previous_valid_until > pg_catalog.now() and i.is_active
  limit 1;
$$;

revoke all on function public.find_sulekha_integration(text) from public, anon, authenticated;
grant execute on function public.find_sulekha_integration(text) to service_role;

-- ---------------------------------------------------------------------------
-- ingest_sulekha_lead: the only writer of Sulekha leads. Called by the Sulekha intake after it has found the
-- integration (find_sulekha_integration), written the raw request to sulekha_webhook_logs (p_log_id) and read its
-- fields. p_token_hash is checked again here, so a URL replaced or expired between the lookup and the save is refused.
-- Returns {"outcome": "stored" | "merged" | "duplicate", "lead_id": <uuid>}:
--   stored     a new lead
--   merged     the phone belongs to an existing lead of this company: a timeline note was added to it
--   duplicate  the same enquiry was already received (a retry): nothing new was written
-- The log row is updated in the same transaction. Errors (the whole call rolls back; the intake marks the log failed):
--   P0002  the URL is no longer valid, or the integration is stopped or of another company
--   22023  the lead is unusable: no phone and no email, or a malformed argument
--   55000  the log row is missing or was already read
-- ---------------------------------------------------------------------------
create function public.ingest_sulekha_lead(
  p_tenant_id uuid, p_integration_id uuid, p_log_id uuid, p_token_hash text, p_lead_ref text, p_service_name text,
  p_enquiry_summary text, p_field_data jsonb, p_raw_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ref text := nullif(pg_catalog.btrim(coalesce(p_lead_ref, '')), '');
  v_service text := pg_catalog.left(nullif(pg_catalog.btrim(coalesce(p_service_name, '')), ''), 200);
  v_summary text := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(coalesce(p_enquiry_summary, '')), ''), 'New Sulekha enquiry'), 500);
  v_version text;
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
  select case when i.url_token_hash = p_token_hash then 'current' else 'previous' end into v_version
  from public.sulekha_integrations as i
  where i.id = p_integration_id and i.tenant_id = p_tenant_id and i.is_active
    and (i.url_token_hash = p_token_hash
      or (i.previous_url_token_hash = p_token_hash and i.previous_valid_until > pg_catalog.now()));
  if v_version is null then
    raise exception 'Sulekha integration not found' using errcode = 'P0002';
  end if;
  perform 1 from public.sulekha_webhook_logs as l
  where l.id = p_log_id and l.tenant_id = p_tenant_id and l.integration_id = p_integration_id and l.status = 'received'
  for update;
  if not found then
    raise exception 'Webhook log not found' using errcode = '55000';
  end if;

  -- A phone with no digits normalises to '' and counts as no phone.
  select nullif(contact.lead_phone_normalized, ''), pg_catalog.lower(nullif(pg_catalog.btrim(contact.lead_email), ''))
  into v_phone, v_email
  from public.extract_meta_lead_contact_fields(p_field_data) as contact;
  if v_phone is null and v_email is null then
    raise exception 'Mobile number or email not found' using errcode = '22023';
  end if;

  -- Always in this order (enquiry id, then phone), so two calls can never wait on each other. The phone lock name
  -- (tenant id + ':' + phone) is the one every phone-checking lead writer takes.
  if v_ref is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || ':sulekha_lead:' || v_ref, 0));
  end if;
  if v_phone is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || ':' || v_phone, 0));
  end if;

  -- A retry: this enquiry id was already read for this integration and led to a lead with the same phone (or, with no
  -- phone, the same email). The id alone never counts.
  if v_ref is not null then
    select l.parsed_lead_id into v_lead_id
    from public.sulekha_webhook_logs as l
    join public.lead_data as ld on ld.tenant_id = l.tenant_id and ld.id = l.parsed_lead_id
    where l.integration_id = p_integration_id and l.tenant_id = p_tenant_id
      and l.external_lead_id = v_ref and l.id <> p_log_id
      and l.status in ('processed', 'duplicate')
      and case when v_phone is not null then ld.lead_phone_normalized = v_phone
               else nullif(ld.lead_phone_normalized, '') is null and pg_catalog.lower(ld.lead_email) = v_email end
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
        pg_catalog.jsonb_build_object('source', 'sulekha', 'sulekha_log_id', p_log_id), null);
      v_outcome := 'merged';
    end if;
  end if;

  if v_outcome is null then
    insert into public.lead_data (
      tenant_id, lead_source, sulekha_integration_id, sulekha_lead_ref, sulekha_service_name,
      lead_created_time, field_data, raw_lead_payload, retrieved_at
    ) values (
      p_tenant_id, 'sulekha', p_integration_id, v_ref, v_service,
      pg_catalog.clock_timestamp(), p_field_data, p_raw_payload, pg_catalog.clock_timestamp()
    )
    returning id into v_lead_id;
    v_outcome := 'stored';
  end if;

  update public.sulekha_webhook_logs
  set status = case when v_outcome = 'stored' then 'processed' else 'duplicate' end,
      parsed_lead_id = v_lead_id, external_lead_id = v_ref, error_message = null,
      processed_at = pg_catalog.clock_timestamp()
  where id = p_log_id and tenant_id = p_tenant_id;

  if v_version = 'current' then
    update public.sulekha_integrations set last_received_at = pg_catalog.clock_timestamp()
    where id = p_integration_id and tenant_id = p_tenant_id;
  else
    update public.sulekha_integrations set previous_last_received_at = pg_catalog.clock_timestamp()
    where id = p_integration_id and tenant_id = p_tenant_id;
  end if;
  return pg_catalog.jsonb_build_object('outcome', v_outcome, 'lead_id', v_lead_id);
end;
$$;

revoke all on function public.ingest_sulekha_lead(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_sulekha_lead(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Nightly: saved Sulekha request copies are deleted after 30 days; copies that never became a lead (failed, or stuck
-- at received) after 90 days, so the first real payloads stay long enough to be read. The leads stay.
-- ---------------------------------------------------------------------------
create or replace function private.purge_sulekha_webhook_logs()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.sulekha_webhook_logs
  where (status in ('processed', 'duplicate') and created_at < pg_catalog.now() - interval '30 days')
     or (status in ('failed', 'received') and created_at < pg_catalog.now() - interval '90 days');
  get diagnostics v_deleted = row_count;
  -- Quiet nights stay silent. cron.job_run_details only records "1 row" for a select, so the count is logged here.
  if v_deleted > 0 then
    raise warning 'crm-sulekha-webhook-log-purge: % Sulekha request log(s) deleted (30 days saved / 90 days failed)', v_deleted;
  end if;
  return v_deleted;
end;
$$;

-- Same access as the other private timer functions: only postgres (the cron job owner) may run it.
revoke all on function private.purge_sulekha_webhook_logs() from public, anon, authenticated, service_role;

-- 04:15 India time (IST = GMT + 5:30; cron.timezone is GMT). No other job runs at this minute (cron.job read
-- 2026-11-24).
select cron.schedule('crm-sulekha-webhook-log-purge', '45 22 * * *',
  $$ select private.purge_sulekha_webhook_logs() $$);

notify pgrst, 'reload schema';

commit;

-- Outside the transaction: validate against every existing row. SHARE UPDATE EXCLUSIVE (reads and writes continue).
-- Every existing row has the sulekha_* columns NULL and a source the restated branches already accept, so all pass.
alter table public.lead_data validate constraint lead_data_sulekha_integration_fk;
alter table public.lead_data validate constraint lead_data_lead_source_check;
alter table public.lead_data validate constraint lead_data_source_fields_check;
alter table public.lead_data validate constraint lead_data_sulekha_fields_check;
