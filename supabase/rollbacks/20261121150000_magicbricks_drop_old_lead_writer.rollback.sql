-- ROLLBACK for supabase/migrations/20261121150000_magicbricks_drop_old_lead_writer.sql. Never applied automatically:
-- this folder is not supabase/migrations. Run by hand, only on the owner's explicit OK: when the app is rolled back to
-- a version before main 8949e78, which still saves MagicBricks leads with ingest_magicbricks_lead.
--
-- Recreates ingest_magicbricks_lead exactly as 20261118170000_magicbricks_leads.sql created it (the live definition
-- matched that file on 2026-11-21), with the same grants. Nothing else changes.

begin;
set local lock_timeout = '5s';

create function public.ingest_magicbricks_lead(
  p_tenant_id uuid, p_integration_id uuid, p_log_id uuid, p_lead_ref text, p_project_name text,
  p_enquiry_summary text, p_field_data jsonb, p_raw_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ref text := nullif(pg_catalog.btrim(coalesce(p_lead_ref, '')), '');
  v_project text := pg_catalog.left(nullif(pg_catalog.btrim(coalesce(p_project_name, '')), ''), 200);
  v_summary text := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(coalesce(p_enquiry_summary, '')), ''), 'New MagicBricks enquiry'), 500);
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
    select 1 from public.magicbricks_integrations as i
    where i.id = p_integration_id and i.tenant_id = p_tenant_id and i.is_active
  ) then
    raise exception 'MagicBricks integration not found' using errcode = 'P0002';
  end if;
  perform 1 from public.magicbricks_webhook_logs as l
  where l.id = p_log_id and l.tenant_id = p_tenant_id and l.integration_id = p_integration_id and l.status = 'received'
  for update;
  if not found then
    raise exception 'Webhook log not found' using errcode = '55000';
  end if;

  select contact.lead_phone_normalized, pg_catalog.lower(contact.lead_email) into v_phone, v_email
  from public.extract_meta_lead_contact_fields(p_field_data) as contact;
  if v_phone is null and v_email is null then
    raise exception 'Mobile number or email not found' using errcode = '22023';
  end if;

  -- Always in this order (enquiry id, then phone), so two calls can never wait on each other. The phone lock name
  -- (tenant id + ':' + phone) is the one every phone-checking lead writer takes, so a lead from another source and a
  -- MagicBricks lead for one phone cannot both be created at the same moment.
  if v_ref is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || ':magicbricks_lead:' || v_ref, 0));
  end if;
  if v_phone is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || ':' || v_phone, 0));
  end if;

  -- A retry: this enquiry id was already read for this integration and led to a lead with the same phone (or, with no
  -- phone, the same email). The id alone never counts.
  if v_ref is not null then
    select l.parsed_lead_id into v_lead_id
    from public.magicbricks_webhook_logs as l
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
        pg_catalog.jsonb_build_object('source', 'magicbricks', 'magicbricks_log_id', p_log_id), null);
      v_outcome := 'merged';
    end if;
  end if;

  if v_outcome is null then
    insert into public.lead_data (
      tenant_id, lead_source, magicbricks_integration_id, magicbricks_lead_ref, magicbricks_project_name,
      lead_created_time, field_data, raw_lead_payload, retrieved_at
    ) values (
      p_tenant_id, 'magicbricks', p_integration_id, v_ref, v_project,
      pg_catalog.clock_timestamp(), p_field_data, p_raw_payload, pg_catalog.clock_timestamp()
    )
    returning id into v_lead_id;
    v_outcome := 'stored';
  end if;

  update public.magicbricks_webhook_logs
  set status = case when v_outcome = 'stored' then 'processed' else 'duplicate' end,
      parsed_lead_id = v_lead_id, external_lead_id = v_ref, error_message = null,
      processed_at = pg_catalog.clock_timestamp()
  where id = p_log_id and tenant_id = p_tenant_id;

  update public.magicbricks_integrations set last_received_at = pg_catalog.clock_timestamp()
  where id = p_integration_id and tenant_id = p_tenant_id;
  return pg_catalog.jsonb_build_object('outcome', v_outcome, 'lead_id', v_lead_id);
end;
$$;

revoke all on function public.ingest_magicbricks_lead(uuid, uuid, uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_magicbricks_lead(uuid, uuid, uuid, text, text, text, jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
