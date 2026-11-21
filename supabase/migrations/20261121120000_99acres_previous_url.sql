-- 99acres: new URL, 7-day handover. When the owner regenerates the 99acres webhook URL, the old one keeps working for
-- 7 days (previous_url_token_hash + previous_valid_until), because 99acres keeps sending to it until the account manager
-- changes it. Before this migration the old URL was refused at once, so every enquiry sent before the change was lost.
-- Leads on each URL are timed apart (last_received_at = the current URL, previous_last_received_at = the old one). A
-- second regenerate ends the oldest URL at once (only one previous URL is kept).
--
-- 99acres objects only: portal_integrations, portal_webhook_logs and three new functions. Nothing of MagicBricks,
-- Housing.com, Facebook, Google Ads, call-in or the custom webhook is read or changed. lead_data is not altered.
--
-- New functions (service role only, security definer, empty search_path):
--   save_portal_url             creates or replaces the URL in one statement (the old URL becomes the previous one)
--   find_portal_integration     the active integration a token hash belongs to, current URL or a still-valid old one
--   ingest_portal_lead_on_url   the 99acres lead writer that also re-checks the URL at save time
-- ingest_portal_lead stays unchanged, so the app deployed before this change keeps working until the new app is live.
-- It is dropped later in its own migration, only on the owner's OK.
--
-- Existing rows: the current URL stays as it is; previous_* stay NULL. URLs replaced before this migration stay refused.
--
-- Undo: supabase/rollbacks/20261121120000_99acres_previous_url.rollback.sql.
-- Check after applying (read-only): scripts/sql/portal-leads-verify.sql (the "previous URL" rows).
--
-- Locks: portal_integrations and portal_webhook_logs only, for the milliseconds the catalog changes need. lock_timeout
-- makes it fail and roll back cleanly instead of queueing 99acres requests behind it. The new checks are added
-- NOT VALID and validated after COMMIT (SHARE UPDATE EXCLUSIVE: reads and writes continue).

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- portal_integrations: the URL before the last regenerate.
-- ---------------------------------------------------------------------------
alter table public.portal_integrations
  -- Still accepted until previous_valid_until (7 days after the regenerate).
  add column previous_url_token_hash text check (previous_url_token_hash is null or previous_url_token_hash ~ '^[0-9a-f]{64}$'),
  add column previous_valid_until timestamptz,
  -- The last lead on the old URL since it was replaced.
  add column previous_last_received_at timestamptz;

alter table public.portal_integrations add constraint portal_integrations_previous_pair_check
  check ((previous_url_token_hash is null) = (previous_valid_until is null)) not valid;
alter table public.portal_integrations add constraint portal_integrations_previous_differs_check
  check (previous_url_token_hash is null or previous_url_token_hash <> url_token_hash) not valid;

create unique index portal_integrations_previous_hash_key
  on public.portal_integrations (previous_url_token_hash) where previous_url_token_hash is not null;

-- ---------------------------------------------------------------------------
-- portal_webhook_logs: which URL each request came on. Every existing row came on the current URL (no other URL was
-- accepted), so the constant default is exact; adding it is a catalog change only (no table rewrite).
-- ---------------------------------------------------------------------------
alter table public.portal_webhook_logs
  add column url_version text not null default 'current' check (url_version in ('current', 'previous'));

-- ---------------------------------------------------------------------------
-- save_portal_url: creates the company's URL for this portal, or replaces it. On a replace the current URL becomes the
-- previous one, accepted for 7 more days; an older previous URL ends at once. last_received_at is cleared, so the card
-- shows "Waiting for first lead" until a lead arrives on the new URL. One statement, so two clicks at the same moment
-- can never leave a half-replaced row. Returns {"replaced": bool, "previous_valid_until": timestamptz | null}.
-- ---------------------------------------------------------------------------
create function public.save_portal_url(p_tenant_id uuid, p_portal text, p_token_hash text, p_encrypted_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.portal_integrations;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or coalesce(p_encrypted_token, '') = '' then
    raise exception 'Malformed URL token' using errcode = '22023';
  end if;
  insert into public.portal_integrations as i (tenant_id, portal_name, url_token_hash, encrypted_url_token)
  values (p_tenant_id, p_portal, p_token_hash, p_encrypted_token)
  on conflict on constraint portal_integrations_tenant_portal_key do update set
    previous_url_token_hash = i.url_token_hash,
    previous_valid_until = pg_catalog.now() + interval '7 days',
    previous_last_received_at = null,
    url_token_hash = excluded.url_token_hash,
    encrypted_url_token = excluded.encrypted_url_token,
    last_received_at = null,
    is_active = true,
    url_rotated_at = pg_catalog.now()
  returning * into v_row;
  return pg_catalog.jsonb_build_object('replaced', v_row.previous_url_token_hash is not null,
    'previous_valid_until', v_row.previous_valid_until);
end;
$$;

revoke all on function public.save_portal_url(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.save_portal_url(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- find_portal_integration: the active integration of this portal a URL token hash belongs to, and which URL it is. The
-- old URL counts only until previous_valid_until, checked with the database's own clock. No row = unknown, stopped or
-- expired URL.
-- ---------------------------------------------------------------------------
create function public.find_portal_integration(p_portal text, p_token_hash text)
returns table (id uuid, tenant_id uuid, portal_name text, field_mapping jsonb, url_version text)
language sql stable security definer set search_path = '' as $$
  select i.id, i.tenant_id, i.portal_name, i.field_mapping, 'current'::text
  from public.portal_integrations as i
  where i.url_token_hash = p_token_hash and i.portal_name = p_portal and i.is_active
  union all
  select i.id, i.tenant_id, i.portal_name, i.field_mapping, 'previous'::text
  from public.portal_integrations as i
  where i.previous_url_token_hash = p_token_hash and i.portal_name = p_portal
    and i.previous_valid_until > pg_catalog.now() and i.is_active
  limit 1;
$$;

revoke all on function public.find_portal_integration(text, text) from public, anon, authenticated;
grant execute on function public.find_portal_integration(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- ingest_portal_lead_on_url: the 99acres lead writer. The same as ingest_portal_lead (20261117120000), with one
-- addition: p_token_hash is checked again here, so a URL replaced or expired between the lookup and the save is refused,
-- and the lead time is written to the URL it came on.
-- Returns {"outcome": "stored" | "merged" | "duplicate", "lead_id": <uuid>}:
--   stored     a new lead
--   merged     the phone belongs to an existing lead of this company: a timeline note was added to it
--   duplicate  the same enquiry was already received (a retry): nothing new was written
-- The log row is updated in the same transaction. Errors (the whole call rolls back; the intake marks the log failed):
--   P0002  the URL is no longer valid, or the integration is stopped, of another portal or of another company
--   22023  the lead is unusable: no phone and no email, or a malformed argument
--   55000  the log row is missing or was already read
-- ---------------------------------------------------------------------------
create function public.ingest_portal_lead_on_url(
  p_tenant_id uuid, p_integration_id uuid, p_log_id uuid, p_portal text, p_token_hash text, p_lead_ref text,
  p_project_name text, p_enquiry_summary text, p_field_data jsonb, p_raw_payload jsonb, p_is_test boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ref text := nullif(pg_catalog.btrim(coalesce(p_lead_ref, '')), '');
  v_project text := pg_catalog.left(nullif(pg_catalog.btrim(coalesce(p_project_name, '')), ''), 200);
  v_summary text := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(coalesce(p_enquiry_summary, '')), ''), 'New enquiry'), 500);
  v_test boolean := coalesce(p_is_test, false);
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
  from public.portal_integrations as i
  where i.id = p_integration_id and i.tenant_id = p_tenant_id and i.portal_name = p_portal and i.is_active
    and (i.url_token_hash = p_token_hash
      or (i.previous_url_token_hash = p_token_hash and i.previous_valid_until > pg_catalog.now()));
  if v_version is null then
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

  -- A test lead never makes the card say the portal is connected. A lead on the old URL never makes the new URL look
  -- connected: each URL has its own lead time.
  if not v_test then
    if v_version = 'current' then
      update public.portal_integrations set last_received_at = pg_catalog.clock_timestamp()
      where id = p_integration_id and tenant_id = p_tenant_id;
    else
      update public.portal_integrations set previous_last_received_at = pg_catalog.clock_timestamp()
      where id = p_integration_id and tenant_id = p_tenant_id;
    end if;
  end if;
  return pg_catalog.jsonb_build_object('outcome', v_outcome, 'lead_id', v_lead_id);
end;
$$;

revoke all on function public.ingest_portal_lead_on_url(uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.ingest_portal_lead_on_url(uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, boolean) to service_role;

notify pgrst, 'reload schema';

commit;

-- Outside the transaction: validate against every existing row (all have previous_* NULL, so all pass).
alter table public.portal_integrations validate constraint portal_integrations_previous_pair_check;
alter table public.portal_integrations validate constraint portal_integrations_previous_differs_check;
