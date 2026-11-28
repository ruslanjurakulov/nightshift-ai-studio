-- 0235_film_operator_preview.sql — Film Studio lets the platform operator use an operator-preview model in the operator's own
-- organization, exactly where 0139 already lets the Studio do it, and nowhere else.
--
-- *** LIVE ON APPLY, and dark until the registry says so. *** It changes no answer for any customer, and none for the operator either
--   until a model row carries `"operator_preview": true` (schemas/model_registry.json, copied by `python tools/probe_models.py --sync`).
--
-- EVIDENCE (measured on a lab built from main at 948c2f31c; md5 of prosrc with every run of white space folded to one space):
--   * 0166's film_check_model(model, caps, field) (864da632969ae05f964eee1b568a671f) passes only a model sellable_models(cap, 'web')
--     lists, and sellable_models never lists a hidden model. 0171's film_model_problem (d828ee349aa5da3aa05ea9db4d8f1b94) wraps it.
--     Every Film path calls one of them with no organization: film_price (0218's body, 3c22f87be736c073d17d93e040e914e1), film_precheck
--     (0171's, ff4fa7e8a6386420f32ab6a3a85a778c), film_resume_precheck (0215's, aa7275ed5e8520af52cabd03c2f930d8), and, when a person
--     picks a model, film_apply_settings (0166's, 248ffb76f60f3a6f4e8b34b85cd0c92b) and film_save_scenes (0166's,
--     c836631256f669318c9ef499d7c4c54b). So a hidden model is refused at save, quote, start and resume, for everyone.
--   * 0139 lets the operator use exactly such a model in the Studio: creative_operator_preview(org, availability, spec)
--     (ca8654e202cf46029350aaa3111c4c5d) is hidden (never disabled) + spec.operator_preview the JSON true + is_platform_admin() from the
--     JWT + credits_exempt(org) + is_org_member(org), and creative_price (which film_price's lines call through film_try_price) already
--     quotes it. The member check adds nothing for a platform admin: 0043's accessible_org_ids makes every platform owner/admin a member
--     of every organization (Breach 0235-I1, informational).
--   * So an operator-only test film narrated by ElevenLabs v3 or v4 (hidden, terms-gated, verified, uz/ru/en) is refused at
--     voice.model before creative_price is ever asked.
-- DIAGNOSIS. Film's own model check is the only gate that does not know the organization; creative_price, which prices every line,
--   already applies 0139's rule. The check needs the film's organization, and nothing else.
-- CHANGE.
--   film_check_model(model, caps, field, org)   NEW overload (internal). Exactly the three-argument check — the id's shape, then
--                                               Seedance refused first, whoever asks — except that a model sellable_models does not list
--                                               passes when creative_operator_preview(org, availability, spec) holds AND the row has the
--                                               same proofs 0139's operator_preview_models asks (verified_at and verified_probe_id set,
--                                               not past its shutdown date, model_is_available: not switched off) AND it lists one of
--                                               the capabilities the role needs. Anything else: the same model_not_available, same words.
--   film_model_problem(model, caps, field, org) NEW overload (internal): 0171's wrapper around the four-argument check.
--   film_price, film_precheck, film_resume_precheck, film_apply_settings, film_save_scenes
--                                               REPLACED, each on its live body above, with only its film_check_model / film_model_problem
--                                               call(s) given the film's organization (f.org_id or p_film.org_id), each call marked
--                                               `-- 0235` (film_price: 3 calls, key frame / clip / voice; film_apply_settings: 2, the
--                                               key-frame or clip model and the voice; the other three: 1 each). Nothing else changes.
--   The three-argument film_check_model and film_model_problem are NOT changed (any other caller keeps 0166's/0171's answer).
--   Inherited, not replaced: quote_film and start_film (0215/0198: film_price, film_precheck), quote_film_resume, start_film_resume and
--   film_resume_price (0215: film_resume_precheck, film_price), save_film and create_film_draft (0166: film_apply_settings,
--   film_save_scenes).
-- WHO GETS WHAT. creative_operator_preview reads is_platform_admin() from the caller's own JWT, so the widening reaches only a platform
--   owner/admin acting in the credits-exempt organization: every platform owner/admin, seat or not (0139's member check is vacuous for
--   them, 0043), the same people start_film's exempt branch lets start a film there. A customer, a member of the exempt organization who is
--   not a platform admin, and a platform admin acting in any other organization get model_not_available, as before. The service role
--   (no JWT) never passes it. start_film already lets only a platform admin start a film in the exempt organization, which holds
--   nothing (0171), so a preview film costs no customer anything; its lines are quoted by creative_price as the Studio quotes a preview
--   (the vendor's cost, `"preview": true`), and no credit_prices row is written.
-- TAKE TIME. No database function at take or claim time asks whether a model is on sale: film_claim_segment, film_begin_take and
--   film_take_job (0198) check the switch, the hold, the inputs and the voice, not the model's sale, so they neither refuse a preview nor
--   need widening. The one check at take time is the worker's (modules/film_orchestrator.py _still_on_sale, creative_worker.not_on_sale):
--   from this file on it passes previews only for the exempt organization (credits.is_exempt), and only for a row that is still hidden,
--   operator_preview, verified, listing the take's capability, not past its shutdown date and not switched off — the same rule the
--   Studio's worker applies (operator_preview_runnable). Every segment of the exempt organization was started by a platform admin
--   (start_film's own rule), so that is the operator's film. A customer organization's take is asked with previews=False, as before.
-- OVERLAP. Draft #920 (0220, the film voice's language) also replaces film_price and film_precheck. Whichever of the two merges second
--   must be rebased on the other's bodies: its drift guard, end state and rollback must name the other file's md5s, and the security
--   lab must take the later one off first (sec_db.take_off_0235 / take_off_0220). This file accepts only the bodies listed above.
-- NUMBER. 0235, provisional. Needs 0139 (creative_operator_preview), 0124/0125 (model_is_available, model_past_shutdown), 0166, 0171,
--   0215 and 0218 (the bodies above), and refuses to apply without them.
-- NO BACKSLASH anywhere in this file (0219's header: the live apply path once rewrote backslash escapes in SQL text). White space is
--   folded with [[:space:]]+, and the one backslash film_price's body holds (0218's clip-length pattern) is written @@0235_BACKSLASH@@
--   and put back with chr(92) before the body is executed, so the body that reaches the database is byte for byte the one hashed below.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_price(public.films)'::regprocedure)
--            = '3c22f87be736c073d17d93e040e914e1' as film_price_is_0218s,
--          (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_precheck(public.films)'::regprocedure)
--            = 'ff4fa7e8a6386420f32ab6a3a85a778c' as film_precheck_is_0171s,
--          (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_resume_precheck(public.films, uuid)'::regprocedure)
--            = 'aa7275ed5e8520af52cabd03c2f930d8' as film_resume_precheck_is_0215s,
--          (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_apply_settings(public.films, jsonb, text[])'::regprocedure)
--            = '248ffb76f60f3a6f4e8b34b85cd0c92b' as film_apply_settings_is_0166s,
--          (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_save_scenes(public.films, jsonb)'::regprocedure)
--            = 'c836631256f669318c9ef499d7c4c54b' as film_save_scenes_is_0166s,
--          to_regprocedure('public.film_check_model(text, text[], text, uuid)') is null as check_is_new,
--          to_regprocedure('public.film_model_problem(text, text[], text, uuid)') is null as problem_is_new;
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- assumes it, and the last block asserts the end state. Idempotent: a replay finds this file's bodies and writes them again.
-- AFTER APPLYING, the registry: `"operator_preview": true` is set on elevenlabs-v3 and elevenlabs-v4 in schemas/model_registry.json by
-- the same pull request; the owner (or Atlas) runs `python tools/probe_models.py --sync` (no vendor call) to copy it into the database.
-- Rollback: docs/sql/rollback_0235_film_operator_preview.sql (owner-applied; puts the five bodies back byte for byte and drops the two
-- overloads). Docs: docs/MIGRATIONS.md, "Film Studio: the operator's preview models (0235, provisional)".

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.creative_operator_preview(uuid, text, jsonb)') is null then
    raise exception '0235 needs 0139_operator_preview.sql (creative_operator_preview): apply it first';
  end if;
  if to_regprocedure('public.model_is_available(text)') is null or to_regprocedure('public.model_past_shutdown(jsonb)') is null
     or to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0235 needs 0124_model_switch.sql and 0125_model_shutdown.sql: apply them first';
  end if;
  if to_regprocedure('public.film_check_model(text, text[], text)') is null
     or to_regprocedure('public.film_model_problem(text, text[], text)') is null
     or to_regprocedure('public.film_price(public.films)') is null
     or to_regprocedure('public.film_resume_precheck(public.films, uuid)') is null then
    raise exception '0235 needs 0166, 0171, 0215 and 0218 (Film Studio): apply them first';
  end if;
end $$;

-- Each body this file replaces must be the one it was written on, or this file's own (a replay). Anything else was changed since, and
-- replacing it would silently undo that change (the 0064/0103 lesson). The two overloads must be absent or this file's.
do $$
declare
  r record;
  h text;
begin
  for r in
    select * from (values
      ('public.film_price(public.films)', '3c22f87be736c073d17d93e040e914e1', '399372f5f151dcef1fa5a590b2f413eb', '0218'),
      ('public.film_precheck(public.films)', 'ff4fa7e8a6386420f32ab6a3a85a778c', '826a4c57a5a97ef44634cb7e25d1f11d', '0171'),
      ('public.film_resume_precheck(public.films, uuid)', 'aa7275ed5e8520af52cabd03c2f930d8', 'ca3ccf2b51ddd0b4e3cc71aedee216e4', '0215'),
      ('public.film_apply_settings(public.films, jsonb, text[])', '248ffb76f60f3a6f4e8b34b85cd0c92b', 'f5cdf963343a4b722333eaf0d13bd840', '0166'),
      ('public.film_save_scenes(public.films, jsonb)', 'c836631256f669318c9ef499d7c4c54b', 'd2d32abea21beb742eea14d92ad6e9fd', '0166'),
      ('public.film_check_model(text, text[], text, uuid)', null, '5a2c4ed8d8b56bc63d6d095085ab0361', ''),
      ('public.film_model_problem(text, text[], text, uuid)', null, '48d25f5cb4f21b9cea72658968d9c952', '')
    ) v(sig, was, now_, src)
  loop
    select md5(regexp_replace(x.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc x where x.oid = to_regprocedure(r.sig);
    if r.was is null then
      if h is not null and h <> r.now_ then
        raise exception '0235 found a % that is not this file''s (md5 %): read the live body first', r.sig, h;
      end if;
    elsif h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0235 found a % that is neither %''s body nor 0235''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  -- The three-argument check and wrapper stay 0166's and 0171's: this file is written on them and does not change them.
  if (select md5(regexp_replace(x.prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc x
       where x.oid = 'public.film_check_model(text, text[], text)'::regprocedure) <> '864da632969ae05f964eee1b568a671f'
     or (select md5(regexp_replace(x.prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc x
          where x.oid = 'public.film_model_problem(text, text[], text)'::regprocedure) <> 'd828ee349aa5da3aa05ea9db4d8f1b94'
     or (select md5(regexp_replace(x.prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc x
          where x.oid = 'public.creative_operator_preview(uuid, text, jsonb)'::regprocedure) <> 'ca8654e202cf46029350aaa3111c4c5d' then
    raise exception '0235 found a film_check_model, film_model_problem or creative_operator_preview that is not 0166''s, 0171''s or 0139''s: read the live bodies first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The check with the film's organization (new overloads; internal)
-- ───────────────────────────────────────────────────────────────────────────

-- 0166's check, with the film's organization: the same id rule and the same Seedance refusal, asked first and of everyone (a preview is
-- never a way round the vendor's terms), then on sale now for one of the role's capabilities, OR 0139's operator preview in this
-- organization with the proofs operator_preview_models asks (a real probe, no shutdown date passed, not switched off) and the role's
-- capability listed. creative_operator_preview reads the caller's JWT: the service role and every customer are answered as before.
create or replace function public.film_check_model(p_model text, p_caps text[], p_field text, p_org uuid) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_model is null or p_model !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    perform public.creative_refuse('invalid_params', format('%s must be a model id', p_field));
  end if;
  -- Seedance by name, adapter or the vendor's own model id; not every ByteDance model (a Seedream key-frame model is not Seedance,
  -- and is held by its own terms gate through sellable_models below, with its own refusal).
  if p_model ilike '%seedance%'
     or exists (select 1 from public.model_registry m
                 where m.id = p_model
                   and (m.adapter ilike 'video.seedance%' or coalesce(m.spec ->> 'vendor_model', '') ilike '%seedance%')) then
    perform public.creative_refuse('model_not_offered',
      format('%s: Seedance models are not offered in Film Studio (the vendor''s terms forbid it)', p_field));
  end if;
  if exists (select 1 from unnest(p_caps) c, lateral public.sellable_models(c, 'web') s where s.id = p_model) then
    return;
  end if;
  -- 0235: not on sale, but the operator's own preview in the exempt organization (0139's rule, from the caller's JWT), with the proofs
  -- operator_preview_models asks and the role's capability listed. Nobody else, and no caller without a JWT, ever passes here.
  if p_org is not null
     and exists (select 1 from public.model_registry m
                  where m.id = p_model
                    and public.creative_operator_preview(p_org, m.availability, m.spec)
                    and m.verified_at is not null
                    and m.verified_probe_id is not null
                    and not public.model_past_shutdown(m.spec)
                    and public.model_is_available(m.id)
                    and m.capabilities && p_caps) then
    return;
  end if;
  perform public.creative_refuse('model_not_available', format('%s: %s is not on sale for this', p_field, p_model));
end
$$;

-- 0171's wrapper, around the check above: the refusal as {priced: false, reason, detail}, or NULL when the model may be used.
create or replace function public.film_model_problem(p_model text, p_caps text[], p_field text, p_org uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  w text;
  d text;
begin
  begin
    perform public.film_check_model(p_model, p_caps, p_field, p_org);
  exception when sqlstate 'NS400' then
    get stacked diagnostics w = message_text, d = pg_exception_detail;
    return jsonb_build_object('priced', false, 'reason', case when w ~ '^[a-z0-9_]{1,64}$' then w else 'model_not_available' end,
                              'detail', left(coalesce(nullif(d, ''), w), 300));
  end;
  return null;
end
$$;

revoke all on function public.film_check_model(text, text[], text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.film_model_problem(text, text[], text, uuid) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The five callers, each on its live body with its call(s) marked 0235
-- ───────────────────────────────────────────────────────────────────────────

-- 0166's settings of a patch (save_film, create_film_draft): a model is checked when it changes, now in the film's organization.
create or replace function public.film_apply_settings(p_film public.films, p_patch jsonb, p_keys text[])
  returns public.films
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f   public.films := p_film;
  kv  record;
  v   jsonb;
  k   text;
  m   text;
  lim jsonb := public.film_limits();
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform public.creative_refuse('invalid_params', 'the settings must be an object');
  end if;
  for kv in select key, value from jsonb_each(p_patch) loop
    v := kv.value;
    if not kv.key = any (p_keys) then
      perform public.creative_refuse('invalid_params', format('unknown field %s', kv.key));
    end if;
    case kv.key
      when 'title' then
        f.title := public.film_text(v, 'title', 1, (lim ->> 'max_title_chars')::integer, false);
      when 'source_text' then
        f.source_text := public.film_text(v, 'source_text', 1,
          case when f.source_kind = 'topic' then (lim ->> 'max_topic_chars')::integer else (lim ->> 'max_script_chars')::integer end,
          true);
      when 'channel_id' then
        if jsonb_typeof(v) = 'null' then
          f.channel_id := null;
        elsif jsonb_typeof(v) <> 'string' or public.channel_org(v #>> '{}') is distinct from f.org_id then
          -- Another organization's channel and a channel that does not exist answer the same.
          perform public.creative_refuse('invalid_params', 'channel_id is not a channel of this organization');
        else
          f.channel_id := v #>> '{}';
        end if;
      when 'language' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('en', 'ru', 'uz') then
          perform public.creative_refuse('invalid_params', 'language must be en, ru or uz');
        end if;
        f.language := v #>> '{}';
      when 'aspect' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('16:9', '9:16', '1:1') then
          perform public.creative_refuse('invalid_params', 'aspect must be 16:9, 9:16 or 1:1');
        end if;
        f.aspect := v #>> '{}';
      when 'target_seconds' then
        if not public.creative_json_int(v, (lim ->> 'target_seconds_min')::numeric, (lim ->> 'target_seconds_max')::numeric) then
          perform public.creative_refuse('invalid_params',
            format('target_seconds must be a whole number from %s to %s', lim ->> 'target_seconds_min', lim ->> 'target_seconds_max'));
        end if;
        f.target_seconds := (v #>> '{}')::numeric::integer;
      when 'resolution' then
        if jsonb_typeof(v) = 'null' then
          f.resolution := null;
        elsif jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('480p', '720p', '768p', '1080p', '2k', '4k') then
          perform public.creative_refuse('invalid_params', 'resolution must be one of 480p, 720p, 768p, 1080p, 2k, 4k');
        else
          f.resolution := v #>> '{}';
        end if;
      when 'style_kit_id' then
        f.style_kit_id := public.film_uuid(v, 'style_kit_id');
        if f.style_kit_id is not null
           and not exists (select 1 from public.style_kits s where s.id = f.style_kit_id and s.org_id = f.org_id) then
          perform public.creative_refuse('invalid_params', 'style_kit_id is not a style kit of this organization');
        end if;
      when 'keyframe_model', 'clip_model' then
        if jsonb_typeof(v) = 'null' then
          m := null;
        elsif jsonb_typeof(v) <> 'string' then
          perform public.creative_refuse('invalid_params', format('%s must be a model id', kv.key));
        else
          m := v #>> '{}';
          if m is distinct from (case when kv.key = 'keyframe_model' then p_film.keyframe_model else p_film.clip_model end) then
            -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
            perform public.film_check_model(m, case when kv.key = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             kv.key, f.org_id);
          end if;
        end if;
        if kv.key = 'keyframe_model' then f.keyframe_model := m; else f.clip_model := m; end if;
      when 'voice' then
        if jsonb_typeof(v) = 'null' then
          f.voice := null;
        else
          if jsonb_typeof(v) <> 'object' then
            perform public.creative_refuse('invalid_params', 'voice must be an object');
          end if;
          for k in select jsonb_object_keys(v) loop
            if k not in ('source', 'model', 'voice_id') then
              perform public.creative_refuse('invalid_params', format('voice: unknown field %s', k));
            end if;
          end loop;
          if (v ->> 'source') is distinct from 'creative_tts' and (v ->> 'source') is distinct from 'channel' then
            perform public.creative_refuse('invalid_params', 'voice.source must be creative_tts or channel');
          end if;
          if v ->> 'source' = 'channel' then
            -- The channel's own configured voice: nothing else to name (the run checks it with verify_voice, rule 4).
            if v ? 'model' or v ? 'voice_id' then
              perform public.creative_refuse('invalid_params', 'voice: a channel voice takes no model or voice_id');
            end if;
          else
            if jsonb_typeof(v -> 'voice_id') is distinct from 'string' or (v ->> 'voice_id') !~ '^[A-Za-z0-9_-]{1,64}$' then
              perform public.creative_refuse('invalid_params', 'voice.voice_id must be a voice id from the list');
            end if;
            if jsonb_typeof(v -> 'model') is distinct from 'string' then
              perform public.creative_refuse('invalid_params', 'voice.model must be a model id');
            end if;
            if (v ->> 'model') is distinct from (p_film.voice ->> 'model') then
              -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
              perform public.film_check_model(v ->> 'model', array['tts'], 'voice.model', f.org_id);
            end if;
          end if;
          f.voice := v;
        end if;
      when 'music_asset_id' then
        f.music_asset_id := public.film_check_asset(f.org_id, v, 'audio', 'music_asset_id');
      when 'music_gain_db', 'duck_db' then
        if jsonb_typeof(v) = 'null' then
          m := null;
        elsif jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric not between -40 and 0
              or (v #>> '{}')::numeric <> round((v #>> '{}')::numeric, 1) then
          perform public.creative_refuse('invalid_params', format('%s must be a number from -40 to 0, in steps of 0.1', kv.key));
        else
          m := v #>> '{}';
        end if;
        if kv.key = 'music_gain_db' then f.music_gain_db := m::numeric; else f.duck_db := m::numeric; end if;
      when 'captions_mode' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('sidecar', 'burn', 'both', 'none') then
          perform public.creative_refuse('invalid_params', 'captions_mode must be sidecar, burn, both or none');
        end if;
        f.captions_mode := v #>> '{}';
      when 'transition_default' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('cut', 'dip_to_black', 'crossfade') then
          perform public.creative_refuse('invalid_params', 'transition_default must be cut, dip_to_black or crossfade');
        end if;
        f.transition_default := v #>> '{}';
    end case;
  end loop;
  if f.voice ->> 'source' = 'channel' and f.channel_id is null then
    perform public.creative_refuse('invalid_params', 'voice: a channel voice needs the film to have a channel');
  end if;
  return f;
end
$$;
revoke all on function public.film_apply_settings(public.films, jsonb, text[]) from public, anon, authenticated, service_role;

-- 0166's scenes of a patch: a scene's own key-frame or clip model, checked in the film's organization.
create or replace function public.film_save_scenes(p_film public.films, p_scenes jsonb) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim    jsonb := public.film_limits();
  r      record;
  k      text;
  ids    uuid[] := '{}';
  sid    uuid;
  sc     public.film_scenes;
  old    public.film_scenes;
  label  text;
  x      jsonb;
  m      text;
  ck     text;
  is_new boolean;
begin
  if p_scenes is null or jsonb_typeof(p_scenes) <> 'array' then
    perform public.creative_refuse('invalid_params', 'scenes must be a list');
  end if;
  if jsonb_array_length(p_scenes) > (lim ->> 'max_scenes')::integer then
    perform public.creative_refuse('limit_reached', format('a film has at most %s scenes', lim ->> 'max_scenes'));
  end if;

  -- Which existing scenes the list keeps: each named once, each this film's.
  for r in select v, ord from jsonb_array_elements(p_scenes) with ordinality as t(v, ord) loop
    label := format('scene %s', r.ord);
    if jsonb_typeof(r.v) <> 'object' then
      perform public.creative_refuse('invalid_params', format('%s must be an object', label));
    end if;
    for k in select jsonb_object_keys(r.v) loop
      if k not in ('id', 'title', 'narration', 'visual_prompt', 'negative_prompt', 'planned_seconds', 'shot_count',
                   'first_frame', 'first_frame_asset_id', 'last_frame', 'last_frame_asset_id', 'keyframe_model', 'clip_model',
                   'clip_params', 'transition_in', 'refs') then
        perform public.creative_refuse('invalid_params', format('%s: unknown field %s', label, k));
      end if;
    end loop;
    if r.v ? 'id' then
      sid := public.film_uuid(r.v -> 'id', label || ' id');
      if sid is null or not exists (select 1 from public.film_scenes s where s.id = sid and s.film_id = p_film.id) then
        perform public.creative_refuse('invalid_params', format('%s: id is not a scene of this film', label));
      end if;
      if sid = any (ids) then
        perform public.creative_refuse('invalid_params', format('%s: the same scene is listed twice', label));
      end if;
      ids := ids || sid;
    end if;
  end loop;

  -- The scenes left out are deleted (their own references with them), unless something was already made for them.
  if exists (select 1 from public.film_takes t
              where t.film_id = p_film.id and t.scene_id is not null and not (t.scene_id = any (ids))) then
    perform public.creative_refuse('scene_has_takes', 'a scene that has takes cannot be deleted', 'NS409');
  end if;
  delete from public.film_scenes where film_id = p_film.id and not (id = any (ids));

  set constraints public.film_scenes_position_key deferred;
  for r in select v, ord from jsonb_array_elements(p_scenes) with ordinality as t(v, ord) loop
    label := format('scene %s', r.ord);
    is_new := not (r.v ? 'id');
    if is_new then
      old := null;
      sc := null;
      sc.id := gen_random_uuid();
      sc.title := ''; sc.narration := ''; sc.visual_prompt := ''; sc.negative_prompt := '';
      sc.shot_count := 1; sc.first_frame := 'keyframe'; sc.last_frame := 'none';
      sc.clip_params := '{}'::jsonb; sc.status := 'draft';
      if not (r.v ? 'planned_seconds') then
        perform public.creative_refuse('invalid_params', format('%s: planned_seconds is required', label));
      end if;
    else
      select * into old from public.film_scenes where id = (r.v ->> 'id')::uuid;
      sc := old;
    end if;
    sc.position := r.ord - 1;

    if r.v ? 'title' then
      sc.title := public.film_text(r.v -> 'title', label || ' title', 0, (lim ->> 'max_title_chars')::integer, false);
    end if;
    if r.v ? 'narration' then
      sc.narration := public.film_text(r.v -> 'narration', label || ' narration', 0, (lim ->> 'max_narration_chars')::integer, true);
    end if;
    if r.v ? 'visual_prompt' then
      sc.visual_prompt := public.film_text(r.v -> 'visual_prompt', label || ' visual_prompt', 0,
                                           (lim ->> 'max_prompt_chars')::integer, true);
    end if;
    if r.v ? 'negative_prompt' then
      sc.negative_prompt := public.film_text(r.v -> 'negative_prompt', label || ' negative_prompt', 0,
                                             (lim ->> 'max_negative_chars')::integer, true);
    end if;
    if r.v ? 'planned_seconds' then
      if not public.creative_json_int(r.v -> 'planned_seconds', (lim ->> 'scene_seconds_min')::numeric,
                                      (lim ->> 'scene_seconds_max')::numeric) then
        perform public.creative_refuse('invalid_params', format('%s: planned_seconds must be a whole number from %s to %s',
                                                                label, lim ->> 'scene_seconds_min', lim ->> 'scene_seconds_max'));
      end if;
      sc.planned_seconds := (r.v ->> 'planned_seconds')::numeric::integer;
    end if;
    if r.v ? 'shot_count' then
      if not public.creative_json_int(r.v -> 'shot_count', 1, (lim ->> 'max_shots')::numeric) then
        perform public.creative_refuse('invalid_params', format('%s: shot_count must be 1 to %s', label, lim ->> 'max_shots'));
      end if;
      sc.shot_count := (r.v ->> 'shot_count')::numeric::smallint;
    end if;
    if r.v ? 'first_frame' then
      if jsonb_typeof(r.v -> 'first_frame') is distinct from 'string'
         or (r.v ->> 'first_frame') not in ('keyframe', 'asset', 'previous') then
        perform public.creative_refuse('invalid_params', format('%s: first_frame must be keyframe, asset or previous', label));
      end if;
      sc.first_frame := r.v ->> 'first_frame';
    end if;
    if r.v ? 'first_frame_asset_id' then
      sc.first_frame_asset_id := public.film_check_asset(p_film.org_id, r.v -> 'first_frame_asset_id', 'image',
                                                          label || ' first_frame_asset_id');
    end if;
    if r.v ? 'last_frame' then
      if jsonb_typeof(r.v -> 'last_frame') is distinct from 'string'
         or (r.v ->> 'last_frame') not in ('none', 'asset', 'next_keyframe') then
        perform public.creative_refuse('invalid_params', format('%s: last_frame must be none, asset or next_keyframe', label));
      end if;
      sc.last_frame := r.v ->> 'last_frame';
    end if;
    if r.v ? 'last_frame_asset_id' then
      sc.last_frame_asset_id := public.film_check_asset(p_film.org_id, r.v -> 'last_frame_asset_id', 'image',
                                                         label || ' last_frame_asset_id');
    end if;
    -- A picture is kept only while its mode uses it, so switching a scene back to `keyframe` or `none` needs no second field.
    if sc.first_frame <> 'asset' then sc.first_frame_asset_id := null; end if;
    if sc.last_frame <> 'asset' then sc.last_frame_asset_id := null; end if;
    if sc.position = 0 and sc.first_frame = 'previous' then
      perform public.creative_refuse('invalid_params', format('%s: the first scene has no previous scene to continue from', label));
    end if;
    if sc.first_frame = 'asset' and sc.first_frame_asset_id is null then
      perform public.creative_refuse('invalid_params', format('%s: first_frame asset needs first_frame_asset_id', label));
    end if;
    if sc.last_frame = 'asset' and sc.last_frame_asset_id is null then
      perform public.creative_refuse('invalid_params', format('%s: last_frame asset needs last_frame_asset_id', label));
    end if;

    foreach ck in array array['keyframe_model', 'clip_model'] loop
      if r.v ? ck then
        x := r.v -> ck;
        if jsonb_typeof(x) = 'null' then
          m := null;
        elsif jsonb_typeof(x) <> 'string' then
          perform public.creative_refuse('invalid_params', format('%s: %s must be a model id', label, ck));
        else
          m := x #>> '{}';
          if m is distinct from (case when ck = 'keyframe_model' then old.keyframe_model else old.clip_model end) then
            -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
            perform public.film_check_model(m, case when ck = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             format('%s %s', label, ck), p_film.org_id);
          end if;
        end if;
        if ck = 'keyframe_model' then sc.keyframe_model := m; else sc.clip_model := m; end if;
      end if;
    end loop;

    if r.v ? 'clip_params' then
      x := r.v -> 'clip_params';
      if jsonb_typeof(x) <> 'object' then
        perform public.creative_refuse('invalid_params', format('%s: clip_params must be an object', label));
      end if;
      for k in select jsonb_object_keys(x) loop
        -- Our narration is the soundtrack, so a clip's own audio is a choice a person makes, never a default.
        if k = 'audio' then
          if jsonb_typeof(x -> 'audio') <> 'boolean' then
            perform public.creative_refuse('invalid_params', format('%s: clip_params.audio must be true or false', label));
          end if;
        elsif k = 'resolution' then
          if jsonb_typeof(x -> 'resolution') <> 'string'
             or (x ->> 'resolution') not in ('480p', '720p', '768p', '1080p', '2k', '4k') then
            perform public.creative_refuse('invalid_params', format('%s: clip_params.resolution is not one of the resolutions', label));
          end if;
        else
          perform public.creative_refuse('invalid_params', format('%s: clip_params: unknown field %s', label, k));
        end if;
      end loop;
      sc.clip_params := x;
    end if;
    if r.v ? 'transition_in' then
      x := r.v -> 'transition_in';
      if jsonb_typeof(x) = 'null' then
        sc.transition_in := null;
      elsif jsonb_typeof(x) <> 'string' or (x #>> '{}') not in ('cut', 'dip_to_black', 'crossfade') then
        perform public.creative_refuse('invalid_params', format('%s: transition_in must be cut, dip_to_black or crossfade', label));
      else
        sc.transition_in := x #>> '{}';
      end if;
    end if;

    if is_new then
      insert into public.film_scenes (id, film_id, org_id, position, title, narration, visual_prompt, negative_prompt,
                                      planned_seconds, shot_count, first_frame, first_frame_asset_id, last_frame,
                                      last_frame_asset_id, keyframe_model, clip_model, clip_params, transition_in, status)
      values (sc.id, p_film.id, p_film.org_id, sc.position, sc.title, sc.narration, sc.visual_prompt, sc.negative_prompt,
              sc.planned_seconds, sc.shot_count, sc.first_frame, sc.first_frame_asset_id, sc.last_frame,
              sc.last_frame_asset_id, sc.keyframe_model, sc.clip_model, sc.clip_params, sc.transition_in, sc.status);
    else
      update public.film_scenes
         set position = sc.position, title = sc.title, narration = sc.narration, visual_prompt = sc.visual_prompt,
             negative_prompt = sc.negative_prompt, planned_seconds = sc.planned_seconds, shot_count = sc.shot_count,
             first_frame = sc.first_frame, first_frame_asset_id = sc.first_frame_asset_id, last_frame = sc.last_frame,
             last_frame_asset_id = sc.last_frame_asset_id, keyframe_model = sc.keyframe_model, clip_model = sc.clip_model,
             clip_params = sc.clip_params, transition_in = sc.transition_in, updated_at = now()
       where id = sc.id;
    end if;
    if r.v ? 'refs' then
      perform public.film_save_refs(p_film, sc.id, r.v -> 'refs', (lim ->> 'max_scene_refs')::integer, label || ' ref');
    end if;
  end loop;
  set constraints public.film_scenes_position_key immediate;
  return jsonb_array_length(p_scenes);
end
$$;
revoke all on function public.film_save_scenes(public.films, jsonb) from public, anon, authenticated, service_role;

-- 0171's cheap refusals before start_film counts and prices anything.
create or replace function public.film_precheck(p_film public.films) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  mm  record;
  bad jsonb;
begin
  for mm in select distinct m.model, m.caps, m.field from (
             select coalesce(s.keyframe_model, p_film.keyframe_model) as model, array['t2i', 'edit'] as caps, 'keyframe_model' as field
               from public.film_scenes s where s.film_id = p_film.id and s.first_frame = 'keyframe'
             union all
             select coalesce(s.clip_model, p_film.clip_model), array['i2v'], 'clip_model'
               from public.film_scenes s where s.film_id = p_film.id
             union all
             select p_film.voice ->> 'model', array['tts'], 'voice.model'
              where p_film.voice ->> 'source' = 'creative_tts'
                and exists (select 1 from public.film_scenes s where s.film_id = p_film.id and s.narration <> '')) m
            where m.model is not null order by m.field, m.model loop
    -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
    bad := public.film_model_problem(mm.model, mm.caps, mm.field, p_film.org_id);
    if bad is not null then
      return bad;
    end if;
  end loop;
  if exists (select 1 from public.film_refs r where r.film_id = p_film.id
                and ((r.character_id is not null
                      and not exists (select 1 from public.characters c where c.id = r.character_id and c.org_id = r.org_id))
                     or (r.asset_id is not null and not public.film_asset_live(r.org_id, r.asset_id, 'image')))) then
    return jsonb_build_object('reason', 'reference_missing',
                              'detail', 'a reference picture or character no longer exists; remove it or choose another');
  end if;
  if exists (select 1 from public.film_scenes s where s.film_id = p_film.id
                and ((s.first_frame = 'asset' and not public.film_asset_live(s.org_id, s.first_frame_asset_id, 'image'))
                     or (s.last_frame = 'asset' and not public.film_asset_live(s.org_id, s.last_frame_asset_id, 'image')))) then
    return jsonb_build_object('reason', 'asset_not_usable',
                              'detail', 'a scene''s first or last frame is no longer in the library; choose another picture');
  end if;
  return null;
end
$$;
revoke all on function public.film_precheck(public.films) from public, anon, authenticated, service_role;

-- 0215's cheap refusals before a resume.
create or replace function public.film_resume_precheck(p_film public.films, p_segment uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  mm  record;
  bad jsonb;
begin
  if p_segment is null then
    return jsonb_build_object('reason', 'nothing_to_resume', 'detail', 'this film has never run; start it instead');
  end if;
  if not exists (select 1 from public.film_takes t where t.segment_id = p_segment
                  group by t.kind, t.scene_id, t.shot_index having not bool_or(public.film_resume_done(t)))
     and exists (select 1 from public.film_segments g where g.id = p_segment and g.assembly_status = 'completed') then
    return jsonb_build_object('reason', 'nothing_to_resume', 'detail', 'every take and the assembly of this film are made');
  end if;
  for mm in select distinct x.model, x.caps, x.field from (
             select min(t.model) as model,
                    case t.kind when 'keyframe' then array['t2i', 'edit'] when 'narration' then array['tts'] else array['i2v'] end as caps,
                    case t.kind when 'keyframe' then 'keyframe_model' when 'narration' then 'voice.model' else 'clip_model' end as field
               from public.film_takes t where t.segment_id = p_segment
              group by t.kind, t.scene_id, t.shot_index having not bool_or(public.film_resume_done(t))) x
            where x.model is not null order by x.field, x.model loop
    -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
    bad := public.film_model_problem(mm.model, mm.caps, mm.field, p_film.org_id);
    if bad is not null then
      return bad - 'priced';
    end if;
  end loop;
  if exists (select 1 from public.film_takes t where t.segment_id = p_segment and t.kind = 'keyframe'
              group by t.scene_id having not bool_or(public.film_resume_done(t)))
     and exists (select 1 from public.film_refs r where r.film_id = p_film.id
                    and ((r.character_id is not null
                          and not exists (select 1 from public.characters c where c.id = r.character_id and c.org_id = r.org_id))
                         or (r.asset_id is not null and not public.film_asset_live(r.org_id, r.asset_id, 'image')))) then
    return jsonb_build_object('reason', 'reference_missing',
                              'detail', 'a reference picture or character no longer exists; the key frames still to make need it');
  end if;
  if exists (select 1 from public.film_scenes s
              where s.film_id = p_film.id
                and ((s.first_frame = 'asset' and not public.film_asset_live(s.org_id, s.first_frame_asset_id, 'image'))
                     or (s.last_frame = 'asset' and not public.film_asset_live(s.org_id, s.last_frame_asset_id, 'image')))
                and exists (select 1 from public.film_takes t where t.segment_id = p_segment and t.scene_id = s.id
                               and t.kind in ('clip', 'extend')
                             group by t.shot_index having not bool_or(public.film_resume_done(t)))) then
    return jsonb_build_object('reason', 'asset_not_usable',
                              'detail', 'a scene still to shoot starts or ends on a picture that is no longer in the library');
  end if;
  return null;
end
$$;
revoke all on function public.film_resume_precheck(public.films, uuid) from public, anon, authenticated, service_role;

-- 0218's film price. Built as text with its one backslash written @@0235_BACKSLASH@@ and put back with chr(92) (see the header), then
-- executed; the end state below checks the md5 of the body that results.
do $fp$
begin
  execute replace($fp0235$create or replace function public.film_price(p_film public.films) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f        public.films := p_film;
  sc       record;
  lines    jsonb := '[]'::jsonb;
  refusals jsonb := '[]'::jsonb;
  scenes_  jsonb := '[]'::jsonb;
  ln       jsonb;
  q        jsonb;
  bad      jsonb;
  params   jsonb;
  stand    uuid := public.film_stand_in(p_film.org_id);
  kmodel   text;
  cmodel   text;
  caps     text[];
  spec     jsonb;
  cap      text;
  refs_n   integer;
  ref_max  integer;
  target   numeric;
  dur      numeric;
  longest  numeric;
  sub      numeric;
  sub_ok   boolean;
  i        integer;
  total    numeric := 0;
  chars    integer;
  seconds  integer;
  minutes  integer;
  rate     public.credit_prices;
  sample   text;
  credits  numeric;
  res      text;
  label    text;
  n_scenes integer := 0;
begin
  for sc in select s.* from public.film_scenes s where s.film_id = f.id order by s.position loop
    n_scenes := n_scenes + 1;
    label := format('scene %s', sc.position + 1);
    sub := 0;
    sub_ok := true;
    kmodel := coalesce(sc.keyframe_model, f.keyframe_model);
    cmodel := coalesce(sc.clip_model, f.clip_model);

    -- The key frame (only a scene that makes its own).
    if sc.first_frame = 'keyframe' then
      ln := jsonb_build_object('line', 'keyframe', 'scene_id', sc.id, 'position', sc.position, 'shot_index', 0, 'model', kmodel);
      -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
      q := case when kmodel is not null then public.film_model_problem(kmodel, array['t2i', 'edit'], label || ' keyframe_model', f.org_id) end;
      if kmodel is null then
        ln := ln || jsonb_build_object('priced', false, 'reason', 'model_not_set',
                                       'detail', format('%s: choose a key-frame model', label));
      elsif q is not null then
        ln := ln || q;
      elsif btrim(sc.visual_prompt) = '' then
        ln := ln || jsonb_build_object('priced', false, 'reason', 'prompt_missing',
                                       'detail', format('%s: a key frame is made from the visual prompt; write one', label));
      else
        select m.capabilities, m.spec into caps, spec from public.model_registry m where m.id = kmodel;
        cap := case when 't2i' = any (coalesce(caps, '{}')) then 't2i' else 'edit' end;
        -- The references reach a clip through its key frame (0166): a model that cannot take them all is refused, never handed
        -- fewer than the person chose (CLAUDE.md #4).
        -- A 0047 character is all of its pictures, never one: each reaches the model.
        refs_n := (select coalesce(sum(case when r.character_id is null then 1
                                            else greatest((select count(*) from public.character_references cr
                                                            where cr.character_id = r.character_id), 1) end), 0)
                     from public.film_refs r where r.film_id = f.id and (r.scene_id is null or r.scene_id = sc.id));
        ref_max := case when jsonb_typeof(spec -> 'inputs' -> 'image_refs_max') = 'number'
                        then (spec -> 'inputs' ->> 'image_refs_max')::numeric::integer else 0 end;
        params := jsonb_build_object('prompt', sc.visual_prompt, 'aspect_ratio', f.aspect)
                  || case when f.style_kit_id is null then '{}'::jsonb else jsonb_build_object('style_kit_id', f.style_kit_id) end
                  -- 0218: the negative prompt the take carries (0198), so the quote asks whether this model takes one.
                  || case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)
                          else '{}'::jsonb end
                  || case when cap = 'edit' and stand is not null then jsonb_build_object('source_asset_id', stand) else '{}'::jsonb end;
        if refs_n > ref_max then
          q := jsonb_build_object('priced', false, 'reason', 'refs_not_supported',
                                  'detail', format('%s: %s takes %s reference pictures and this scene has %s; choose a model that takes them all or remove some',
                                                   label, kmodel, ref_max, refs_n));
        elsif cap = 'edit' and stand is null then
          q := jsonb_build_object('priced', false, 'reason', 'source_unavailable',
                                  'detail', format('%s: an edit model is priced against a picture of this library; add one picture', label));
        else
          q := public.film_try_price(f.org_id, cap, kmodel, params);
        end if;
        ln := ln || jsonb_build_object('capability', cap,
                                       'params', (params - 'prompt' - 'negative_prompt' - 'source_asset_id')
                                                 || jsonb_strip_nulls(jsonb_build_object('quality', q -> 'quality')))
              || q;
      end if;
      lines := lines || jsonb_build_array(ln);
    elsif sc.first_frame = 'asset' and not public.film_asset_live(f.org_id, sc.first_frame_asset_id, 'image') then
      refusals := refusals || jsonb_build_array(jsonb_build_object(
        'line', 'scene', 'scene_id', sc.id, 'position', sc.position, 'reason', 'asset_not_usable',
        'detail', format('%s: its first frame is no longer in the library; choose another picture', label)));
      sub_ok := false;
    end if;
    if sc.last_frame = 'asset' and not public.film_asset_live(f.org_id, sc.last_frame_asset_id, 'image') then
      refusals := refusals || jsonb_build_array(jsonb_build_object(
        'line', 'scene', 'scene_id', sc.id, 'position', sc.position, 'reason', 'asset_not_usable',
        'detail', format('%s: its last frame is no longer in the library; choose another picture', label)));
      sub_ok := false;
    end if;

    -- The clip shots: shot 1 from the first frame, shots 2-3 extend from the shot before.
    select m.spec into spec from public.model_registry m where m.id = cmodel;
    -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
    bad := case when cmodel is not null then public.film_model_problem(cmodel, array['i2v'], label || ' clip_model', f.org_id) end;
    target := ceil(sc.planned_seconds::numeric / sc.shot_count);
    select min(x::numeric) filter (where x::numeric >= target), max(x::numeric) into dur, longest
      from jsonb_array_elements_text(case when jsonb_typeof(spec -> 'durations_s') = 'array' then spec -> 'durations_s'
                                          else '[]'::jsonb end) x
     where x ~ '^[0-9]{1,3}(@@0235_BACKSLASH@@.[0-9]+)?$';
    for i in 1 .. sc.shot_count loop
      ln := jsonb_build_object('line', case when i = 1 then 'clip' else 'extend' end, 'scene_id', sc.id, 'position', sc.position,
                               'shot_index', i, 'model', cmodel, 'capability', 'i2v');
      if cmodel is null then
        q := jsonb_build_object('priced', false, 'reason', 'model_not_set', 'detail', format('%s: choose a clip model', label));
      elsif bad is not null then
        q := bad;
      elsif dur is null then
        q := jsonb_build_object('priced', false, 'reason', 'scene_too_long_for_model',
                                'detail', case when longest is null
                                               then format('%s: %s lists no clip lengths', label, cmodel)
                                               else format('%s: %s makes at most %s s a shot, and %s s over %s shots needs %s s; give the scene more shots or fewer seconds',
                                                           label, cmodel, longest, sc.planned_seconds, sc.shot_count, target) end);
      elsif stand is null then
        q := jsonb_build_object('priced', false, 'reason', 'source_unavailable',
                                'detail', format('%s: a clip is priced against a picture of this library; add one picture', label));
      else
        res := coalesce(sc.clip_params ->> 'resolution', f.resolution);
        params := jsonb_build_object('source_asset_id', stand, 'duration_s', dur)
                  || case when res is null then '{}'::jsonb else jsonb_build_object('resolution', res) end
                  || case when sc.clip_params ? 'audio' then jsonb_build_object('audio', sc.clip_params -> 'audio') else '{}'::jsonb end
                  || case when i = sc.shot_count and sc.last_frame <> 'none' then jsonb_build_object('end_asset_id', stand)
                          else '{}'::jsonb end
                  -- 0218: the words the take sends (0198: the scene's visual prompt, and its negative prompt when it has one), so the
                  -- clip model's own prompt limit and whether it takes a negative prompt are asked here, not by the worker after the hold.
                  || case when btrim(sc.visual_prompt) <> '' then jsonb_build_object('prompt', sc.visual_prompt) else '{}'::jsonb end
                  || case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)
                          else '{}'::jsonb end;
        q := public.film_try_price(f.org_id, 'i2v', cmodel, params);
        -- The variant creative_price settled on (the model's pinned resolution, silent or with sound) is part of what was priced.
        ln := ln || jsonb_build_object('duration_s', dur,
                                       'params', (params - 'source_asset_id' - 'end_asset_id' - 'prompt' - 'negative_prompt')
                                                 || case when params ? 'end_asset_id' then '{"end_frame": true}'::jsonb else '{}'::jsonb end
                                                 || jsonb_strip_nulls(jsonb_build_object('resolution', q -> 'resolution',
                                                                                         'audio', q -> 'audio')));
      end if;
      lines := lines || jsonb_build_array(ln || q);
    end loop;

    -- The scene's subtotal: NULL when any of its lines is.
    select coalesce(bool_and((l ->> 'priced')::boolean), true) and sub_ok, sum((l ->> 'credits')::numeric)
      into sub_ok, sub
      from jsonb_array_elements(lines) l where l ->> 'scene_id' = sc.id::text;
    scenes_ := scenes_ || jsonb_build_array(jsonb_build_object(
      'scene_id', sc.id, 'position', sc.position, 'priced', sub_ok, 'credits', case when sub_ok then coalesce(sub, 0) end));
  end loop;
  if n_scenes = 0 then
    refusals := refusals || jsonb_build_array(jsonb_build_object('line', 'film', 'reason', 'no_scenes',
                                                                 'detail', 'the film has no scenes yet; add at least one'));
  end if;

  -- A reference that no longer exists is refused here, never dropped (0166: "the quote refuses it").
  if exists (select 1 from public.film_refs r where r.film_id = f.id
                and ((r.character_id is not null
                      and not exists (select 1 from public.characters c where c.id = r.character_id and c.org_id = r.org_id))
                     or (r.asset_id is not null and not public.film_asset_live(r.org_id, r.asset_id, 'image')))) then
    refusals := refusals || jsonb_build_array(jsonb_build_object('line', 'film', 'reason', 'reference_missing',
      'detail', 'a reference picture or character no longer exists; remove it or choose another'));
  end if;

  -- The narration: one film-level take of every scene's narration, at the voice model's rate as charged (see the header).
  select coalesce(sum(char_length(s.narration)), 0), min(s.narration) filter (where s.narration <> '')
    into chars, sample from public.film_scenes s where s.film_id = f.id;
  if chars > 0 then
    ln := jsonb_build_object('line', 'narration', 'scene_id', null, 'position', null, 'shot_index', 0,
                             'model', f.voice ->> 'model', 'capability', 'tts', 'quantity', chars);
    if f.voice is null then
      q := jsonb_build_object('priced', false, 'reason', 'voice_not_set', 'detail', 'the narration needs a voice; choose one');
    elsif f.voice ->> 'source' = 'channel' then
      q := jsonb_build_object('priced', false, 'reason', 'channel_voice_not_priced',
                              'detail', 'a channel''s own voice is not priced here; choose a voice for the film');
    else
      -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
      q := coalesce(public.film_model_problem(f.voice ->> 'model', array['tts'], 'voice.model', f.org_id),
                    public.film_try_price(f.org_id, 'tts', f.voice ->> 'model',
                                          jsonb_build_object('prompt', left(sample, (public.film_money_limits() ->> 'tts_sample_chars')::integer),
                                                             'voice_id', f.voice ->> 'voice_id')));
      if (q ->> 'priced')::boolean then
        credits := public.credits_round_up(round(chars * (q ->> 'credits_per_unit')::numeric, 6));
        -- One provider call carries at most tts_sample_chars characters, and the Studio charges each call its minimum.
        if credits > 0 then
          credits := greatest(credits, ceil(chars / (public.film_money_limits() ->> 'tts_sample_chars')::numeric)
                                       * (q ->> 'minimum')::numeric);
        end if;
        q := q || jsonb_build_object('quantity', chars, 'credits', credits,
                                     'params', jsonb_build_object('voice_id', f.voice ->> 'voice_id'));
      end if;
    end if;
    lines := lines || jsonb_build_array(ln || q);
  end if;

  -- The assembly (with the captions our own pipeline makes from the narration): film_assembly_minute times the planned minutes,
  -- rounded up. No row: unpriced, never 0.
  select coalesce(sum(s.planned_seconds), 0) into seconds from public.film_scenes s where s.film_id = f.id;
  minutes := greatest(ceil(seconds / 60.0)::integer, 1);
  select * into rate from public.credit_prices where unit = 'film_assembly_minute';
  ln := jsonb_build_object('line', 'assembly', 'scene_id', null, 'position', null, 'shot_index', null, 'model', null,
                           'capability', null, 'quantity', minutes, 'unit', 'film_assembly_minute', 'minimum', 0,
                           'includes', case when f.captions_mode = 'none' then '[]'::jsonb else '["captions"]'::jsonb end);
  if rate.unit is null then
    ln := ln || jsonb_build_object('priced', false, 'reason', 'unpriced',
      'detail', 'film assembly has no credit price yet; a platform admin sets film_assembly_minute on the Credits page');
  else
    ln := ln || jsonb_build_object('priced', true, 'credits_per_unit', rate.credits_per_unit * (1 + rate.margin),
      'credits', public.credits_round_up(round(minutes * rate.credits_per_unit * (1 + rate.margin), 6)));
  end if;
  lines := lines || jsonb_build_array(ln);
  -- An unpriced line says so in its own credits: null, never a missing key a client could read as 0.
  select jsonb_agg(case when (l ->> 'priced')::boolean then l else l || '{"credits": null}'::jsonb end order by o)
    into lines from jsonb_array_elements(lines) with ordinality t(l, o);

  for ln in select l from jsonb_array_elements(lines) l where not (l ->> 'priced')::boolean loop
    refusals := refusals || jsonb_build_array(jsonb_build_object(
      'line', ln ->> 'line', 'scene_id', ln -> 'scene_id', 'position', ln -> 'position', 'shot_index', ln -> 'shot_index',
      'reason', ln ->> 'reason', 'detail', ln ->> 'detail'));
  end loop;
  if jsonb_array_length(refusals) = 0 then
    select sum((l ->> 'credits')::numeric) into total from jsonb_array_elements(lines) l;
  else
    total := null;
  end if;

  return jsonb_build_object(
    'film_id', f.id, 'version', f.version, 'priced', total is not null, 'total', total,
    -- The token start_film must be handed back: the version and an md5 of exactly what was priced (jsonb text is canonical).
    'quote_id', case when total is not null
                     then format('fq-%s-%s', f.version,
                                 md5(jsonb_build_object('film', f.id, 'version', f.version, 'lines', lines, 'total', total)::text)) end,
    'lines', lines, 'scenes', scenes_, 'refusals', refusals,
    'planned_seconds', seconds, 'assembly_minutes', minutes);
end
$$;$fp0235$, '@@0235_BACKSLASH@@', chr(92));
end
$fp$;
revoke all on function public.film_price(public.films) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r   record;
  fn  oid;
  got text;
begin
  for r in
    select * from (values
      ('public.film_check_model(text, text[], text, uuid)', '5a2c4ed8d8b56bc63d6d095085ab0361'),
      ('public.film_model_problem(text, text[], text, uuid)', '48d25f5cb4f21b9cea72658968d9c952'),
      ('public.film_apply_settings(public.films, jsonb, text[])', 'f5cdf963343a4b722333eaf0d13bd840'),
      ('public.film_save_scenes(public.films, jsonb)', 'd2d32abea21beb742eea14d92ad6e9fd'),
      ('public.film_precheck(public.films)', '826a4c57a5a97ef44634cb7e25d1f11d'),
      ('public.film_resume_precheck(public.films, uuid)', 'ca3ccf2b51ddd0b4e3cc71aedee216e4'),
      ('public.film_price(public.films)', '399372f5f151dcef1fa5a590b2f413eb'),
      ('public.film_check_model(text, text[], text)', '864da632969ae05f964eee1b568a671f'),
      ('public.film_model_problem(text, text[], text)', 'd828ee349aa5da3aa05ea9db4d8f1b94')
    ) v(sig, want)
  loop
    fn := to_regprocedure(r.sig);
    if fn is null then
      raise exception '0235 end state: % does not exist', r.sig;
    end if;
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into got from pg_proc p where p.oid = fn;
    if got <> r.want then
      raise exception '0235 end state: % does not hold the expected body (md5 %)', r.sig, got;
    end if;
    -- No API role, and no NULL ACL (the default includes public): every one of these runs only inside a security-definer caller.
    if exists (select 1 from pg_proc p
                where p.oid = fn
                  and (p.proacl is null
                       or exists (select 1 from aclexplode(p.proacl) a
                                   where a.grantee = 0
                                      or a.grantee in (select o.oid from pg_roles o
                                                        where o.rolname in ('anon', 'authenticated', 'service_role'))))) then
      raise exception '0235 end state: % is executable by an API role', r.sig;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = fn and p.prosecdef
                      and p.proconfig @> array['search_path=public, pg_temp']) then
      raise exception '0235 end state: % is not security definer with a pinned search_path', r.sig;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_price(public.films)'::regprocedure) = '399372f5f151dcef1fa5a590b2f413eb' as film_price_is_0235s,
--   (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_precheck(public.films)'::regprocedure) = '826a4c57a5a97ef44634cb7e25d1f11d' as film_precheck_is_0235s,
--   (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_check_model(text, text[], text)'::regprocedure) = '864da632969ae05f964eee1b568a671f' as old_check_kept,
--   -- nobody signed in (the SQL editor) passes no preview: the hidden ElevenLabs rows are refused as before.
--   public.film_model_problem('elevenlabs-v3', array['tts'], 'voice.model', public.default_org_id()) ->> 'reason'
--     = 'model_not_available' as no_jwt_no_preview,
--   public.film_model_problem('seedance-anything', array['i2v'], 'clip_model', public.default_org_id()) ->> 'reason'
--     = 'model_not_offered' as seedance_first,
--   not has_function_privilege('authenticated', 'public.film_check_model(text,text[],text,uuid)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.film_check_model(text,text[],text,uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.film_model_problem(text,text[],text,uuid)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.film_model_problem(text,text[],text,uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.film_model_problem(text,text[],text,uuid)', 'EXECUTE') as internal_only;
