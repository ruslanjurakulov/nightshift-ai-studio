-- 0110_marketing_promo_custom.sql — two more kinds of brand-channel post (Telegram only): `custom`, a post the owner
-- types in his own page, and `promo`, a post drafted by the poster worker from a reviewed repository file. NOTHING
-- CALLS EITHER NEW FUNCTION YET. Design: docs/MARKETING_POSTS.md ("Promo and custom posts, migration 0110").
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies it
-- *** automatically, and an applied migration is never edited: fix by a new forward
-- *** migration (docs/MIGRATIONS.md).
--
-- *** MERGE ORDER. Depends on #526 (deployed). After this file is applied a row may exist whose kind is `promo` or
-- *** `custom`. The owner page (lib/marketing-posts.ts) and the operator bot (modules/operator_bot/analysis.py) must
-- *** already be tolerant of a kind they do not know BEFORE that can happen: a page that rejects one unknown kind
-- *** reads the WHOLE list as "could not read". PR #526 (the tolerant approval page and bot) makes them tolerant:
-- *** merge it, and let it deploy, first. Nothing in this file depends on it for correctness, and nothing creates such
-- *** a row until a later change calls owner_marketing_create() or marketing_draft_upsert_v2().
--
-- WHAT "DORMANT" MEANS HERE
--   * marketing_settings.enabled is still whatever it is (FALSE until the owner re-arms the poster); this file does
--     not read or write it. Nothing in the app, the workers or the workflows calls a new function.
--   * Both new kinds go through the SAME status machine as news and price: a draft, the owner's approval of the
--     exact words (approved_hash), the 72 hour expiry, the kill switch, the claim under the cap. None of those
--     functions or triggers is redefined here: marketing_posts_guard(), owner_marketing_edit / approve / reject / kill,
--     claim_marketing_post(), complete_marketing_post() and marketing_draft_upsert() (9 arguments) are byte-for-byte
--     what 0108 made, and the live worker keeps calling them unchanged.
--   * NO existing table is created, no existing policy, grant or trigger is changed. On marketing_posts two existing
--     CHECKs are widened (kind, source_ref) and one is added (key_shape); every value the two old ones allowed
--     before they still allow. audit_action_allowed(text) is redefined to ADD one name (its whole 0108 list is
--     copied verbatim).
--
-- WHAT IT ADDS
--  1. marketing_posts.kind        news | showcase | price | promo | custom.
--  2. marketing_posts.source_ref  promo:<slug>  (slug: lower-case letters, digits, hyphen, 1 to 60)
--                                 owner:<auth user id>  (who typed a custom post)
--  3. Idempotency keys            promo:<slug>:telegram            one repository file, one row per target
--                                 custom:<request id>:telegram     the page makes the request id once per
--                                                                  "New post" screen, so a double tap or a retry
--                                                                  finds the same row and never makes a second
--     (marketing_posts_key_shape_check; the 0108 key check, "starts with the kind", still holds.)
--     A promo key promo:<slug>:telegram is PERMANENT: a post is never deleted, so a rejected or expired promo cannot
--     be redrafted. marketing_draft_upsert_v2 then returns the old row (created: false, updated: false). The worker
--     slice must log "already exists (status X)" and not treat it as an error.
--  4. owner_marketing_create(p_request_id, p_texts, p_link, p_kind default 'custom')   SIGNED-IN OWNER ONLY
--       owner_guard() (platform owner/admin, second factor, per-person rate limit), then the same checks as a draft:
--       exactly the keys uz, ru, en, trimmed, no control, invisible or direction-changing characters, the message
--       limits of marketing_texts_ok(); a link is a path on our own site, like the worker's. It makes a DRAFT, never an
--       approved post: approving stays a separate act on the card. p_kind may only be 'custom' (what the owner types);
--       a `promo` row can only come from the worker. Idempotent on the key. Audited as marketing.create (the lengths
--       and the hash, never the text).
--  5. marketing_draft_upsert_v2(...)   service_role ONLY. The 9-argument marketing_draft_upsert of 0108 is not
--       touched (a version with one more default argument would make PostgREST calls by name ambiguous). v2 takes the
--       same arguments, in the same order, and accepts kind news | price | promo. news and price are handed to the
--       0108 function unchanged; promo has its own checks. A promo draft follows the same freeze rule: only a draft no
--       person has edited is ever updated, so the worker can never overwrite the owner's words. `showcase` and
--       `custom` are refused here (custom is the owner's; showcase stays with the 0108 function).
--  6. audit_action_allowed()   0108's list verbatim plus marketing.create.
--
-- THE WEEKLY CAP IS SHARED. marketing_cap_used() (counts sending, sent and dead posts in the last 7 days) and the
-- approval check in owner_marketing_approve() (that count plus the approved posts still waiting) look at every row,
-- whatever its kind. So news, price, promo and custom together share the 2 posts per rolling 7 days (the owner's
-- decision, and marketing_settings.max_per_7d is still limited to 0..2 by its CHECK). Neither function is changed.
--
-- Known limits, stated plainly
--   * Owner-typed text is not checked against docs/news/banned-claims.json by the database (a repository file SQL
--     cannot read). For a custom post the page shows the hits and the owner decides; for a promo post the worker
--     applies the check before it drafts. This file only enforces the structural rules (languages, size, characters).
--   * The `promo` slug and the request id are shapes, not proofs: the database cannot know a promo file exists in the
--     repository. The worker is the only caller that can create one, and a person approves what it made.
--   * A rollback while promo or custom rows exist keeps the widened CHECKs (a row cannot be deleted, and the narrow
--     CHECK would refuse the table): docs/sql/rollback_0110_marketing_promo_custom.sql says so when it happens.
--
-- Additive and idempotent: create or replace for the new functions and the one permitted redefinition,
-- drop-then-create for the three constraints, revoke then grant (a replay leaves the same ACL).
-- REQUIRES 0108 (marketing_posts, marketing_texts_ok, marketing_draft_upsert, audit_action_allowed) and 0107
-- (owner_guard, owner_audit, owner_err, admin_aal_ok).

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.owner_guard(text, integer)') is null
     or to_regprocedure('public.owner_audit(text, text, jsonb, text)') is null
     or to_regprocedure('public.owner_err(text, text, jsonb)') is null
     or to_regprocedure('public.admin_aal_ok()') is null then
    raise exception '0110 needs 0107_owner_safety.sql (owner_guard, owner_audit, owner_err, admin_aal_ok): apply it first';
  end if;
  if to_regclass('public.marketing_posts') is null
     or to_regprocedure('public.marketing_texts_ok(jsonb, boolean)') is null
     or to_regprocedure('public.marketing_draft_upsert(text, text, jsonb, text, jsonb, timestamptz, text, text, text)') is null
     or to_regprocedure('public.audit_action_allowed(text)') is null then
    raise exception '0110 needs 0108_marketing_posts.sql (marketing_posts, marketing_texts_ok, marketing_draft_upsert, audit_action_allowed): apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The two new kinds on the table
-- ───────────────────────────────────────────────────────────────────────────

alter table public.marketing_posts drop constraint if exists marketing_posts_kind_check;
alter table public.marketing_posts add constraint marketing_posts_kind_check
  check (kind in ('news', 'showcase', 'price', 'promo', 'custom'));

-- 0108's three source shapes, unchanged, plus promo:<slug> (a reviewed repository file) and owner:<user id> (typed
-- by a person on the page).
alter table public.marketing_posts drop constraint if exists marketing_posts_source_check;
alter table public.marketing_posts add constraint marketing_posts_source_check
  check ((kind = 'news' and source_ref ~ '^pr:#[0-9]{1,7}$')
      or (kind = 'price' and source_ref ~ '^plan:[a-z0-9_.:,-]{1,100}$')
      or (kind = 'showcase' and source_ref ~ '^asset:[0-9a-f-]{36}$')
      or (kind = 'promo' and source_ref ~ '^promo:[a-z0-9-]{1,60}$')
      or (kind = 'custom' and source_ref ~ '^owner:[0-9a-f-]{36}$'));

-- A promo key IS its source and its target (one repository file, one row per target); a custom key is the request id
-- of the "New post" screen. 0108's key check (starts with the kind, safe characters, 120 at most) still applies to
-- every row; this one narrows the two new kinds only.
alter table public.marketing_posts drop constraint if exists marketing_posts_key_shape_check;
alter table public.marketing_posts add constraint marketing_posts_key_shape_check
  check ((kind <> 'promo' or idempotency_key = source_ref || ':' || target)
     and (kind <> 'custom' or idempotency_key ~ ('^custom:[A-Za-z0-9_-]{16,64}:' || target || '$')));

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The owner types a post (a draft, once per request id)
-- ───────────────────────────────────────────────────────────────────────────

-- p_request_id is made once per "New post" screen by the page, so a double tap or a retry names the same post.
-- Returns {ok, id, status, kind, created, content_hash} (created false: the post already existed, nothing changed),
-- or {ok:false, error, message}. A caller who is not a platform owner/admin is refused with 42501 by owner_guard().
create or replace function public.owner_marketing_create(
  p_request_id text, p_texts jsonb, p_link text, p_kind text default 'custom'
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g       jsonb;
  v_key   text;
  v_texts jsonb;
  v_id    uuid;
  p       public.marketing_posts;
begin
  g := public.owner_guard('marketing_create', 20);
  if g is not null then return g; end if;

  -- The owner types custom posts. A promo post is the worker's (marketing_draft_upsert_v2), from a reviewed file.
  if p_kind is distinct from 'custom' then
    return public.owner_err('bad_kind', 'Only a custom post can be created here. Promo posts come from the drafting worker.');
  end if;
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{16,64}$' then
    return public.owner_err('bad_request_id', 'A request id of 16 to 64 letters, digits, - or _ is required.');
  end if;
  if p_texts is null or jsonb_typeof(p_texts) <> 'object' or coalesce(jsonb_typeof(p_texts -> 'uz'), '') <> 'string'
     or coalesce(jsonb_typeof(p_texts -> 'ru'), '') <> 'string' or coalesce(jsonb_typeof(p_texts -> 'en'), '') <> 'string' then
    return public.owner_err('bad_texts', 'Give the Uzbek, Russian and English texts.');
  end if;
  v_texts := jsonb_build_object('uz', regexp_replace(p_texts ->> 'uz', '^\s+|\s+$', '', 'g'),
                                'ru', regexp_replace(p_texts ->> 'ru', '^\s+|\s+$', '', 'g'),
                                'en', regexp_replace(p_texts ->> 'en', '^\s+|\s+$', '', 'g'));
  if (select count(*) from jsonb_object_keys(p_texts)) <> 3 or not public.marketing_texts_ok(v_texts, false) then
    return public.owner_err('bad_texts',
      'Each language needs a text without control, invisible or direction-changing characters; the three together must fit one message.');
  end if;
  if p_link is not null and (p_link !~ '^/[a-z0-9][a-z0-9/_-]{0,78}$' or p_link ~ '//' or p_link ~ '\.\.') then
    return public.owner_err('bad_link', 'The link must be a path on our own site such as /pricing.');
  end if;

  v_key := 'custom:' || p_request_id || ':telegram';
  insert into public.marketing_posts (idempotency_key, kind, target, texts, link, source_ref)
  values (v_key, 'custom', 'telegram', v_texts, p_link, 'owner:' || auth.uid()::text)
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- The same request again (a double tap, a retry, a second tab): the post that exists is the answer. A request id
    -- another person already used names that person's post, which is not ours to hand back.
    select * into p from public.marketing_posts where idempotency_key = v_key;
    if p.source_ref <> 'owner:' || auth.uid()::text then
      return public.owner_err('key_reused', 'That request id already names a different post.');
    end if;
    return jsonb_build_object('ok', true, 'id', p.id, 'status', p.status, 'kind', p.kind, 'created', false,
                              'content_hash', p.content_hash, 'same_texts', p.texts = v_texts);
  end if;

  select * into p from public.marketing_posts where id = v_id;
  perform public.owner_audit('marketing.create', p.id::text,
    jsonb_build_object('post_id', p.id, 'kind', p.kind, 'target', p.target, 'has_link', p.link is not null,
                       'chars', jsonb_build_object('uz', char_length(v_texts ->> 'uz'), 'ru', char_length(v_texts ->> 'ru'),
                                                   'en', char_length(v_texts ->> 'en')),
                       'content_hash', p.content_hash),
    'notice');
  return jsonb_build_object('ok', true, 'id', p.id, 'status', p.status, 'kind', p.kind, 'created', true,
                            'content_hash', p.content_hash);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The worker drafts a promo post (service_role only)
-- ───────────────────────────────────────────────────────────────────────────

-- The arguments and their order are marketing_draft_upsert's, so a caller changes only the function name. Returns
-- {ok, id, status, created, updated, owner_edited} or {ok:false, error}. kind news and price are handed to the 0108
-- function as they are. kind promo: the key must be promo:<slug>:<target> and the source_ref promo:<slug>; the same key
-- again changes nothing unless the post is still a draft that NO PERSON has edited (then the file's new words replace
-- the old), so the owner's words are never overwritten, and a decided post is never touched.
create or replace function public.marketing_draft_upsert_v2(
  p_idempotency_key text, p_kind text, p_texts jsonb, p_source_ref text,
  p_facts jsonb default '{}'::jsonb, p_facts_as_of timestamptz default null,
  p_media_path text default null, p_target text default 'telegram', p_link text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_id    uuid;
  p       public.marketing_posts;
  v_texts jsonb;
  v_upd   boolean := false;
begin
  if p_kind is null or p_kind not in ('news', 'price', 'promo') then
    return public.owner_err('bad_kind', 'kind must be news, price or promo.');
  end if;
  if p_kind in ('news', 'price') then
    return public.marketing_draft_upsert(p_idempotency_key, p_kind, p_texts, p_source_ref, p_facts, p_facts_as_of,
                                         p_media_path, p_target, p_link);
  end if;

  if p_target is distinct from 'telegram' then
    return public.owner_err('bad_target', 'Only the telegram target exists.');
  end if;
  if p_source_ref is null or p_source_ref !~ '^promo:[a-z0-9-]{1,60}$' then
    return public.owner_err('bad_source', 'source_ref must be promo:<slug> (lower-case letters, digits and hyphens).');
  end if;
  if p_idempotency_key is null or p_idempotency_key is distinct from p_source_ref || ':' || p_target then
    return public.owner_err('bad_key', 'The key must be the source_ref, a colon and the target, such as promo:welcome:telegram.');
  end if;
  if p_texts is null or jsonb_typeof(p_texts) <> 'object' or coalesce(jsonb_typeof(p_texts -> 'uz'), '') <> 'string'
     or coalesce(jsonb_typeof(p_texts -> 'ru'), '') <> 'string' or coalesce(jsonb_typeof(p_texts -> 'en'), '') <> 'string' then
    return public.owner_err('bad_texts', 'Give the Uzbek, Russian and English texts.');
  end if;
  v_texts := jsonb_build_object('uz', regexp_replace(p_texts ->> 'uz', '^\s+|\s+$', '', 'g'),
                                'ru', regexp_replace(p_texts ->> 'ru', '^\s+|\s+$', '', 'g'),
                                'en', regexp_replace(p_texts ->> 'en', '^\s+|\s+$', '', 'g'));
  if (select count(*) from jsonb_object_keys(p_texts)) <> 3 or not public.marketing_texts_ok(v_texts, p_media_path is not null) then
    return public.owner_err('bad_texts', 'The texts are empty, too long, or hold control, invisible or direction-changing characters.');
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' or octet_length(p_facts::text) > 8192 then
    return public.owner_err('bad_facts', 'facts must be a JSON object of at most 8192 bytes.');
  end if;
  if p_media_path is not null and (p_media_path !~ '^showcase/[A-Za-z0-9._/-]{1,200}$' or p_media_path ~ '\.\.') then
    return public.owner_err('bad_media', 'Media must live in the public showcase bucket.');
  end if;
  if p_link is not null and (p_link !~ '^/[a-z0-9][a-z0-9/_-]{0,78}$' or p_link ~ '//' or p_link ~ '\.\.') then
    return public.owner_err('bad_link', 'The link must be a path on our own site such as /pricing.');
  end if;

  insert into public.marketing_posts (idempotency_key, kind, target, texts, media_path, link, source_ref, facts, facts_as_of)
  values (p_idempotency_key, 'promo', p_target, v_texts, p_media_path, p_link, p_source_ref, p_facts, p_facts_as_of)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'id', v_id, 'status', 'draft', 'created', true, 'updated', false);
  end if;

  select * into p from public.marketing_posts where idempotency_key = p_idempotency_key for update;
  if p.kind <> 'promo' or p.target <> p_target or p.source_ref <> p_source_ref then
    return public.owner_err('key_reused', 'That key already names a different post.');
  end if;
  if p.status = 'draft' and p.edited_at is null
     and (p.texts <> v_texts or p.media_path is distinct from p_media_path or p.link is distinct from p_link
          or p.facts <> p_facts or p.facts_as_of is distinct from p_facts_as_of) then
    update public.marketing_posts
       set texts = v_texts, media_path = p_media_path, link = p_link, facts = p_facts, facts_as_of = p_facts_as_of
     where id = p.id;
    v_upd := true;
  end if;
  return jsonb_build_object('ok', true, 'id', p.id, 'status', p.status, 'created', false, 'updated', v_upd,
                            'owner_edited', p.edited_at is not null);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The audit action list: 0108's body verbatim plus marketing.create
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.audit_action_allowed(p_action text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_action, '') = any (array[
    'agent.run', 'api.activate', 'api.monthly_limit', 'api.topup_checkout', 'api_key.access', 'api_key.create',
    'api_key.revoke', 'billing.portal', 'billing.refresh', 'billing.settings', 'billing.topup', 'captions.delete',
    'channel.dna.update', 'channel.youtube.connect', 'channel.youtube.connect_failed', 'channel.youtube.disconnect',
    'character.create', 'character.delete', 'character.update', 'creative.cancel', 'creative.generate',
    'editor.export_request', 'editor.project_create', 'editor.project_delete', 'editor.send_asset',
    'media.delete', 'media.folder_create', 'media.folder_delete', 'media.folder_rename', 'media.move',
    'media.upload_request', 'model.availability', 'scene.regenerate', 'secret.write', 'series.create',
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
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Who may do what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

-- A signed-in caller (the function checks platform owner/admin itself): nobody else, the service key included.
revoke all on function public.owner_marketing_create(text, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.owner_marketing_create(text, jsonb, text, text) to authenticated;

-- The poster worker (the service key): nothing else.
revoke all on function public.marketing_draft_upsert_v2(text, text, jsonb, text, jsonb, timestamptz, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.marketing_draft_upsert_v2(text, text, jsonb, text, jsonb, timestamptz, text, text, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select pg_get_constraintdef(oid) like '%promo%' and pg_get_constraintdef(oid) like '%custom%'
--        from pg_constraint where conrelid = 'public.marketing_posts'::regclass and conname = 'marketing_posts_kind_check') as kinds_widened,
--     exists (select 1 from pg_constraint where conrelid = 'public.marketing_posts'::regclass
--                and conname = 'marketing_posts_key_shape_check') as key_shape_checked,
--     has_function_privilege('authenticated', 'public.owner_marketing_create(text,jsonb,text,text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.owner_marketing_create(text,jsonb,text,text)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.owner_marketing_create(text,jsonb,text,text)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.marketing_draft_upsert_v2(text,text,jsonb,text,jsonb,timestamptz,text,text,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.marketing_draft_upsert_v2(text,text,jsonb,text,jsonb,timestamptz,text,text,text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.marketing_draft_upsert_v2(text,text,jsonb,text,jsonb,timestamptz,text,text,text)', 'EXECUTE') as functions_scoped,
--     (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--        from pg_proc p where p.pronamespace = 'public'::regnamespace
--         and p.proname in ('owner_marketing_create', 'marketing_draft_upsert_v2')) as definer_pins_search_path,
--     public.audit_action_allowed('marketing.create') and public.audit_action_allowed('marketing.approve')
--       and public.audit_action_allowed('credits.grant') and public.audit_action_allowed('mcp.limit') as audit_list,
--     (select count(*) = 3 from pg_trigger where not tgisinternal and tgrelid = 'public.marketing_posts'::regclass) as status_triggers_unchanged;
--
-- ROLLBACK (owner-applied, docs/sql/rollback_0110_marketing_promo_custom.sql): drops the two functions, puts
-- audit_action_allowed back to 0108's body and narrows the three CHECKs again, unless a promo or custom row exists
-- (rows are never deleted, so the wide CHECKs then stay and the file says so).
