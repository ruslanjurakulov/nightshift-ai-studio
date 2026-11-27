-- 0227_owner_model_terms_acceptance.sql
-- WHY. "Make one checkbox per model in my profile so I can open or hide
-- models myself, without you going into the code each time."
-- LIVE ON APPLY. No model, terms gate, or availability changes on apply.
-- The owner can clear a reviewed gate, then use the existing availability
-- control. The probe and price checks continue to apply.
-- APPLY AS ONE TRANSACTION. Rollback: docs/sql/rollback_0227_owner_model_terms_acceptance.sql.
set local lock_timeout = '5s';

create table if not exists public.model_terms_acceptance (
  model_id text primary key references public.model_registry(id),
  gate text not null,
  accepted_by uuid not null,
  accepted_at timestamptz not null default now(),
  note text
);

alter table public.model_terms_acceptance enable row level security;
revoke all on table public.model_terms_acceptance from public, anon, authenticated, service_role;

create or replace function public.model_terms_acceptance_admin()
  returns table (model_id text, gate text, accepted_at timestamptz, accepted_by_you boolean)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'operator_required' using errcode = '42501';
  end if;

  return query
    select a.model_id, a.gate, a.accepted_at, a.accepted_by = auth.uid()
      from public.model_terms_acceptance a;
end
$$;

create or replace function public.owner_accept_model_terms(p_model text, p_gate text, p_confirm text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  m public.model_registry;
  acceptance_time timestamptz;
begin
  if auth.uid() is null or public.platform_role() is distinct from 'owner' then
    raise exception 'owner_required' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'terms_mfa_required' using errcode = '42501';
  end if;

  select * into m from public.model_registry where id = p_model for update;
  if not found then
    raise exception 'unknown_model' using errcode = 'P0002';
  end if;
  if m.provider = 'bytedance' then
    raise exception 'bytedance_forbidden' using errcode = 'P2271';
  end if;
  if p_confirm is distinct from m.id then
    raise exception 'bad_confirm' using errcode = '22023';
  end if;
  if coalesce(m.spec ->> 'terms_gate', '') = '' or m.spec ->> 'terms_gate' is distinct from p_gate then
    raise exception 'gate_changed' using errcode = 'P2272';
  end if;

  insert into public.model_terms_acceptance (model_id, gate, accepted_by)
  values (m.id, p_gate, auth.uid())
  on conflict (model_id) do update
    set gate = excluded.gate, accepted_by = excluded.accepted_by,
        accepted_at = excluded.accepted_at, note = excluded.note
  returning accepted_at into acceptance_time;

  update public.model_registry set spec = spec - 'terms_gate' where id = m.id;
  return jsonb_build_object('model_id', m.id, 'gate', p_gate, 'accepted_at', acceptance_time,
                            'availability', m.availability);
end
$$;

create or replace function public.owner_revoke_model_terms(p_model text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  m public.model_registry;
  recorded_gate text;
  restored_gate text;
begin
  if auth.uid() is null or public.platform_role() is distinct from 'owner' then
    raise exception 'owner_required' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'terms_mfa_required' using errcode = '42501';
  end if;

  select * into m from public.model_registry where id = p_model for update;
  if not found then
    raise exception 'unknown_model' using errcode = 'P0002';
  end if;

  -- Delete first so the registry trigger keeps the restored gate.
  delete from public.model_terms_acceptance where model_id = m.id returning gate into recorded_gate;
  if not found then
    raise exception 'no_acceptance' using errcode = 'P2273';
  end if;

  -- The new vendor gate remains in force if the registry already supplied one.
  restored_gate := coalesce(nullif(m.spec ->> 'terms_gate', ''), recorded_gate);
  update public.model_registry
     set availability = case when availability in ('beta', 'ga') then 'hidden' else availability end,
         spec = jsonb_set(spec, '{terms_gate}', to_jsonb(restored_gate))
   where id = m.id
   returning availability into m.availability;

  return jsonb_build_object('model_id', m.id, 'gate', restored_gate, 'availability', m.availability);
end
$$;

create or replace function public.model_terms_acceptance_guard()
  returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  incoming_gate text := nullif(new.spec ->> 'terms_gate', '');
  accepted_gate text;
begin
  if incoming_gate is null then
    return new;
  end if;

  -- An upsert uses the BEFORE INSERT result as EXCLUDED on conflict. Lock
  -- the existing row before changing that result, so revoke cannot restore
  -- a gate between the INSERT and UPDATE phases of the sync.
  if tg_op = 'INSERT' then
    perform 1 from public.model_registry where id = new.id for update;
  end if;
  select a.gate into accepted_gate
    from public.model_terms_acceptance a where a.model_id = new.id;

  if incoming_gate = accepted_gate and new.provider <> 'bytedance' then
    new.spec := new.spec - 'terms_gate';
  elsif tg_op = 'UPDATE' and accepted_gate is not null and new.availability in ('beta', 'ga')
        and incoming_gate is distinct from old.spec ->> 'terms_gate' then
    -- Changed terms must take effect even if the model is already on sale.
    new.availability := 'hidden';
  end if;

  return new;
end
$$;

drop trigger if exists model_terms_acceptance_guard on public.model_registry;
create trigger model_terms_acceptance_guard
  before insert or update on public.model_registry
  for each row execute function public.model_terms_acceptance_guard();

revoke all on function public.model_terms_acceptance_guard() from public, anon, authenticated, service_role;
revoke all on function public.model_terms_acceptance_admin() from public, anon, authenticated, service_role;
revoke all on function public.owner_accept_model_terms(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_revoke_model_terms(text) from public, anon, authenticated, service_role;
grant execute on function public.model_terms_acceptance_admin() to authenticated;
grant execute on function public.owner_accept_model_terms(text, text, text) to authenticated;
grant execute on function public.owner_revoke_model_terms(text) to authenticated;

-- Preserve the existing allow-list and refuse to overwrite a newer version.
do $$
declare
  body_hash text;
begin
  select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) into body_hash
    from pg_proc where oid = to_regprocedure('public.audit_action_allowed(text)');
  if body_hash is null or body_hash not in ('b29589ccc124c05b32097d5cfe989434', '0789d4af8fabee6208c8f6830fa73547') then
    raise exception '0227: unexpected audit_action_allowed() body (md5 %)', body_hash;
  end if;
end
$$;

create or replace function public.audit_action_allowed(p_action text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_action, '') = any (array[
    'agent.run', 'api.activate', 'api.monthly_limit', 'api.topup_checkout', 'api_key.access', 'api_key.create',
    'api_key.revoke', 'billing.portal', 'billing.refresh', 'billing.settings', 'billing.topup', 'captions.delete',
    'channel.dna.update', 'channel.youtube.connect', 'channel.youtube.connect_failed', 'channel.youtube.disconnect',
    'character.create', 'character.delete', 'character.update', 'creative.cancel', 'creative.generate',
    'editor.export_request', 'editor.project_create', 'editor.project_delete', 'editor.send_asset',
    'media.delete', 'media.folder_create', 'media.folder_delete', 'media.folder_rename', 'media.move',
    'media.upload_request', 'model.availability', 'model.terms_accept', 'model.terms_revoke', 'scene.regenerate', 'secret.write', 'series.create',
    'series.update', 'storyboard.approve', 'storyboard.discard', 'storyboard.edit', 'storyboard.reopen',
    'style_kit.add_library', 'style_kit.attach', 'style_kit.create', 'style_kit.delete', 'style_kit.detach',
    'style_kit.update', 'variable.write', 'video.download_request', 'video.publish_request', 'video.repurpose',
    'workflow.cancel', 'workflow.delete', 'workflow.run', 'workflow.save',
    -- 0093: connecting, disconnecting and re-limiting an AI app (oauth_* functions).
    'mcp.connect', 'mcp.disconnect', 'mcp.disconnect_all', 'mcp.limit',
    -- 0107: the owner actions (owner_* functions) and the second-factor gate.
    'credits.grant', 'credits.reverse', 'credits.price', 'member.add', 'member.role', 'member.remove', 'security.gate',
    -- 0108: the brand-channel posts (owner_marketing_*, the poster worker) and the showcase marking (later).
    'marketing.edit', 'marketing.approve', 'marketing.reject', 'marketing.send', 'marketing.fail', 'marketing.kill',
    'showcase.mark', 'showcase.revoke',
    -- 0110: the owner types a post (owner_marketing_create).
    'marketing.create',
    -- 0112: a person approves the exact cut of an uploaded video (approve_video_publish).
    'video.approve',
    -- 0116: the per-channel switch, a queued request, the worker's results, a person's retry.
    'channel.publish_on_approve', 'video.publish_queued', 'video.visibility_applied', 'video.visibility_refused',
    'video.visibility_failed', 'video.visibility_expired', 'video.visibility_retry',
    -- 0117: a custom voice (request, the worker's result, approve, attach, detach, delete, sample delete, purge).
    'voice.clone_request', 'voice.clone_result', 'voice.approve', 'voice.attach', 'voice.detach', 'voice.delete',
    'voice.sample_delete', 'voice.purge',
    -- 0145: a person sets a video's YouTube "made for kids" declaration (set_video_made_for_kids).
    'video.made_for_kids',
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;
