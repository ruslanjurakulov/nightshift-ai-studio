-- 0141_youtube_channel_one_org.sql — one YouTube channel is connected to at most ONE organization (workspace) at a time.
--
-- WHY. A YouTube channel (its YouTube id, `UC...`) could be connected under two organizations at once: the owner connected the same
-- YouTube channel under a test organization while it belonged to the main one, and the site then showed a channel that "belongs to
-- another email". Checking the Google account's email at connect time needs a new OAuth scope and Google re-verification, so that is
-- deferred. The owner's decision (option B): a given YouTube channel id may be connected to at most one organization at a time.
-- Reconnecting / refreshing the token for the same channel inside the same organization works exactly as before, and several
-- Nightshift channels of ONE organization may still name the same YouTube channel (the schema has always allowed it, and the rule is
-- about organizations, not rows).
--
-- WHAT "CONNECTED" MEANS. A Nightshift channel c (in organization channels.org_id) holds YouTube id Y when EITHER
--   (T) its Vault connection is active: channel_token_refs row for c with vault_secret_id not null AND revoked_at null AND
--       btrim(youtube_channel_id) = Y (written by store_channel_token, 0022, and store_operator_channel_token, 0115); OR
--   (V) its row is confirmed against YouTube: coalesce(credential_ref ->> 'verified_at', '') <> '' AND
--       btrim(credential_ref ->> 'youtube_channel_id') = Y (written by set_channel_credential / create_channel with the stamp, 0086 and
--       0114, and by the channel_token_refs_stamp trigger, 0086, when a customer's connection is stored).
-- The id is compared after btrim, case-sensitively (YouTube channel ids are case-sensitive). Anything else holds nothing:
--   * a disconnected channel: revoke_channel_token (0022) nulls vault_secret_id and stamps revoked_at, and for a customer's channel
--     the 0086 trigger removes verified_at, so both (T) and (V) end and Y is free for another organization at once;
--   * the YouTube id that stays pinned in credential_ref after a disconnect (WITHOUT verified_at): it is the "this channel was verified
--     against Y" pin store_channel_token checks on reconnect, not a connection;
--   * channel_credentials.youtube_channel_id (0001): the worker's status mirror, written from the token files it sees, never a
--     connection by itself.
-- An operator channel (default organization) keeps verified_at after revoke_channel_token, because its GitHub-secret token may still be
-- in use: it keeps holding Y until the operator rewrites its credential (set_channel_credential without the stamp, or another id).
--
-- THE RULE. Every write that makes channel c of organization O hold Y is refused when another channel of a DIFFERENT organization
-- holds Y. The refusal is SQLSTATE 23P01 (exclusion_violation), message prefix 'youtube_channel_in_use:', hint 'youtube_channel_in_use',
-- and the message names neither the other organization nor its channel. The Command Center maps it to one sentence in the person's
-- language (lib/channel-tokens.ts storeErrorResult, lib/connect-picker.ts). 23P01 on purpose: create_channel (0114) turns a
-- unique_violation (23505) into 'that channel id is not available', which would make the Add channel screen retry other ids.
--
-- WHY A TRIGGER AND NOT A UNIQUE INDEX. The fact "c holds Y" lives in TWO tables (T in channel_token_refs, which has no org_id; V in
-- channels), and one organization may legitimately have several rows for one Y. No single-table unique or exclusion constraint can say
-- "same Y implies same org" across both. So: a BEFORE ROW trigger on each table, both calling one check that takes
-- pg_advisory_xact_lock(hashtextextended('nightshift.youtube_channel:' || Y, 0)) and only THEN reads who holds Y. Two concurrent claims
-- of one Y wait for each other at that lock; the second re-reads after the first committed (READ COMMITTED: each statement of a
-- volatile function takes a fresh snapshot), so exactly one wins. A trigger runs for every role: the browser, the definer functions,
-- the service key, the SQL editor, an import, and a direct UPDATE of channels.org_id (the "move a channel" path 0018 allows an admin of
-- both organizations). Under REPEATABLE READ a fresh snapshot is impossible, so a claim written there is refused (0A000,
-- 'youtube_channel_isolation:') rather than checked against a stale view; SERIALIZABLE is left to SSI, which aborts one of two
-- concurrent claims. The token trigger locks the channel's row (FOR NO KEY UPDATE) before the advisory lock, so a connect and a move
-- of the same channel are serialised too, in one lock order (row, then Y) on both paths.
--
-- WHAT IT ADDS (nothing existing is replaced; no row is rewritten; no grant is widened)
--   youtube_channel_one_org_check(Y, org, channel ids)  the lock and the re-check (internal; revoked from every API role).
--   channel_token_refs_one_org()   BEFORE INSERT OR UPDATE ON channel_token_refs: a connection that becomes active for Y, or changes
--                                  Y (a token refresh for the same Y and the same row is not a new claim and is not checked).
--   channels_youtube_one_org()     BEFORE INSERT OR UPDATE OF credential_ref, org_id ON channels: a row that becomes confirmed for Y
--                                  (or changes its confirmed Y), and any move of a row that holds Y (by T or V) to another organization.
--   Both trigger functions are SECURITY DEFINER (they must see every organization's rows, which no browser role can) with search_path
--   pinned, revoked from every API role.
--
-- PRE-EXISTING DUPLICATES. Before creating anything the file locks both tables (SHARE ROW EXCLUSIVE: no write can slip in between the
-- check and the triggers) and REFUSES to apply if live data already has one Y held in two organizations. It never picks a winner. The
-- message gives counts only; the listing query is in docs/MIGRATIONS.md "One YouTube channel, one organization (0141)".
--
-- DRIFT GUARD. The rule was reviewed against the current bodies of every function that writes a connection or a confirmation:
-- store_channel_token (0022), store_operator_channel_token (0115), revoke_channel_token (0022), set_channel_credential (0086),
-- channel_credential_build (0086), create_channel (0114) and channel_stamp_from_connection (0086). None is replaced, but if one of them
-- differs from the reviewed body the file refuses (md5 of prosrc with every run of white space read as one space, as 0139 does): a
-- write path changed by hand needs its own review first. This file's own three functions, if they already exist, must be this file's.
--
-- NUMBER. 0141: the highest on main is 0139 and 0140 is reserved for another branch in flight; no open pull request adds a migration
-- (checked with gh api, 2026-11-12).
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout` and
-- the table lock assume it, and the last block asserts the end state. Idempotent: create or replace, revoke then grant (none), and
-- create or replace trigger. Rollback: docs/sql/rollback_0141_youtube_channel_one_org.sql (owner-applied; refuses bodies that are not
-- this file's; drops the two triggers and the three functions; nothing else was changed, so nothing else needs restoring).
-- REQUIRES 0018 (organizations), 0022 (channel_token_refs), 0086 (channel credential functions, the stamp trigger), 0114
-- (create_channel) and 0115 (store_operator_channel_token).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.channels') is null or to_regprocedure('public.default_org_id()') is null then
    raise exception '0141 needs 0018_organizations.sql: apply it first';
  end if;
  if to_regclass('public.channel_token_refs') is null or to_regprocedure('public.store_channel_token(text, text, jsonb)') is null
     or to_regprocedure('public.revoke_channel_token(text)') is null then
    raise exception '0141 needs 0022_channel_tokens.sql: apply it first';
  end if;
  if to_regprocedure('public.set_channel_credential(text, jsonb, boolean)') is null
     or to_regprocedure('public.channel_stamp_from_connection()') is null then
    raise exception '0141 needs 0086_channel_config_lock.sql: apply it first';
  end if;
  if to_regprocedure('public.store_operator_channel_token(text, text, jsonb)') is null then
    raise exception '0141 needs 0115_operator_channel_token.sql: apply it first';
  end if;
end $$;

-- The bodies the rule was reviewed against (none is replaced here), and this file's own if a replay finds them.
do $$
declare
  r   record;
  got text;
begin
  for r in
    select * from (values
      ('public.store_channel_token(text, text, jsonb)', 'c11d84201958b82a4aa30cfce9276538', true),
      ('public.store_operator_channel_token(text, text, jsonb)', '2c2aa8e7eac6858711d98a509669f192', true),
      ('public.revoke_channel_token(text)', '91dbbd036cdf8dcffe4e94970eecbd51', true),
      ('public.set_channel_credential(text, jsonb, boolean)', 'b82f0812294901725665bcbe70da8015', true),
      ('public.channel_credential_build(text, uuid, jsonb, boolean, jsonb, boolean)', '372c60fef1af8f57e92ee53a58ca23f0', true),
      ('public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)', 'e40317157a054c8ae467a33772d6add6', true),
      ('public.channel_stamp_from_connection()', 'c09022c704d5ad384815d063a0bdce67', true),
      ('public.youtube_channel_one_org_check(text, uuid, text[])', '8a63db3a3ba1c4d82913a73143ee7ac1', false),
      ('public.channel_token_refs_one_org()', 'af871aaa21f80887949ffb58cb04e1ac', false),
      ('public.channels_youtube_one_org()', '86f8bc74da482ad80177cf54484d0bd6', false)
    ) v(sig, want, required)
  loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = to_regprocedure(r.sig);
    if got is null and r.required then
      raise exception '0141 found no %: apply the earlier migrations first', r.sig;
    end if;
    if got is not null and got <> r.want then
      raise exception '0141 found a % that is not the reviewed body (md5 %): read the live body first', r.sig, got;
    end if;
  end loop;
end $$;

-- No write to either table between the duplicate check below and the triggers (held to the end of the transaction).
lock table public.channels, public.channel_token_refs in share row exclusive mode;

-- Refuse, never pick a winner, if one YouTube id is already held in two organizations. Counts only: no id, no organization.
do $$
declare
  n_ids  integer;
  n_rows integer;
begin
  with claims as (
    select c.channel_id, c.org_id, btrim(c.credential_ref ->> 'youtube_channel_id') as yt
      from public.channels c
     where coalesce(c.credential_ref ->> 'verified_at', '') <> ''
       and coalesce(btrim(c.credential_ref ->> 'youtube_channel_id'), '') <> ''
    union
    select r.channel_id, c.org_id, btrim(r.youtube_channel_id)
      from public.channel_token_refs r
      join public.channels c on c.channel_id = r.channel_id
     where r.vault_secret_id is not null and r.revoked_at is null
       and coalesce(btrim(r.youtube_channel_id), '') <> ''
  ), shared as (
    select yt, count(distinct channel_id) as rows_
      from claims
     group by yt
    having count(distinct coalesce(org_id::text, '')) > 1
  )
  select count(*), coalesce(sum(rows_), 0) into n_ids, n_rows from shared;
  if n_ids > 0 then
    raise exception '0141 found % YouTube channel id(s) connected in more than one organization (% channel rows): nothing was applied. Run the read-only listing in docs/MIGRATIONS.md (0141), decide which connection stays, disconnect the others, then apply again', n_ids, n_rows;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The check: lock the YouTube id, then read who holds it
-- ───────────────────────────────────────────────────────────────────────────
-- p_channels: the row being written (its old and new id), left out of the read: in a BEFORE trigger the table still holds the row's
-- old version, which would otherwise count against a move of that very row. VOLATILE on purpose: every statement takes a fresh
-- snapshot, so the read after the lock sees a claim committed while this transaction waited for it.
create or replace function public.youtube_channel_one_org_check(p_youtube_id text, p_org uuid, p_channels text[]) returns void
  language plpgsql volatile set search_path = public, pg_temp as $$
declare
  y   text := nullif(btrim(coalesce(p_youtube_id, '')), '');
  ids text[] := array_remove(coalesce(p_channels, '{}'::text[]), null);
begin
  if y is null then
    return;
  end if;
  if current_setting('transaction_isolation') = 'repeatable read' then
    raise exception 'youtube_channel_isolation: a YouTube connection is written under READ COMMITTED or SERIALIZABLE, not REPEATABLE READ'
      using errcode = '0A000', hint = 'youtube_channel_isolation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('nightshift.youtube_channel:' || y, 0));
  if exists (
       select 1 from public.channels c
        where c.channel_id <> all (ids)
          and c.org_id is distinct from p_org
          and coalesce(c.credential_ref ->> 'verified_at', '') <> ''
          and btrim(c.credential_ref ->> 'youtube_channel_id') = y)
     or exists (
       select 1 from public.channel_token_refs r
         join public.channels c on c.channel_id = r.channel_id
        where r.channel_id <> all (ids)
          and c.org_id is distinct from p_org
          and r.vault_secret_id is not null
          and r.revoked_at is null
          and btrim(r.youtube_channel_id) = y) then
    raise exception 'youtube_channel_in_use: this YouTube channel is already connected to another workspace; disconnect it there first'
      using errcode = '23P01', hint = 'youtube_channel_in_use';
  end if;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. A Vault connection (channel_token_refs)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.channel_token_refs_one_org() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  y   text;
  org uuid;
begin
  if new.vault_secret_id is null or new.revoked_at is not null then
    return new;                                   -- not (or no longer) a connection: holds nothing
  end if;
  y := nullif(btrim(coalesce(new.youtube_channel_id, '')), '');
  if y is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.vault_secret_id is not null and old.revoked_at is null
     and nullif(btrim(coalesce(old.youtube_channel_id, '')), '') is not distinct from y
     and new.channel_id is not distinct from old.channel_id then
    return new;                                   -- the same connection, refreshed: nothing new is claimed
  end if;
  -- The channel's row first (a move of this channel waits, or is waited for), then the YouTube id: the order channels_youtube_one_org
  -- has too (its UPDATE holds the row before the trigger runs).
  select c.org_id into org from public.channels c where c.channel_id = new.channel_id for no key update;
  perform public.youtube_channel_one_org_check(y, org,
    array[new.channel_id, case when tg_op = 'UPDATE' then old.channel_id end]);
  return new;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. A confirmed channel row, and a channel moved to another organization (channels)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.channels_youtube_one_org() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  yv_new text;
  yv_old text;
  yt     text;
  moved  boolean := tg_op = 'INSERT' or new.org_id is distinct from old.org_id;
  ids    text[] := array[new.channel_id, case when tg_op = 'UPDATE' then old.channel_id end];
begin
  if coalesce(new.credential_ref ->> 'verified_at', '') <> '' then
    yv_new := nullif(btrim(coalesce(new.credential_ref ->> 'youtube_channel_id', '')), '');
  end if;
  if tg_op = 'UPDATE' and coalesce(old.credential_ref ->> 'verified_at', '') <> '' then
    yv_old := nullif(btrim(coalesce(old.credential_ref ->> 'youtube_channel_id', '')), '');
  end if;
  if yv_new is not null and (moved or yv_new is distinct from yv_old) then
    perform public.youtube_channel_one_org_check(yv_new, new.org_id, ids);
  end if;
  if moved and tg_op = 'UPDATE' then
    -- The row's active Vault connection moves with it.
    select nullif(btrim(coalesce(r.youtube_channel_id, '')), '') into yt
      from public.channel_token_refs r
     where r.channel_id = any (array_remove(ids, null))
       and r.vault_secret_id is not null and r.revoked_at is null
     limit 1;
    if yt is not null and yt is distinct from yv_new then
      perform public.youtube_channel_one_org_check(yt, new.org_id, ids);
    end if;
  end if;
  return new;
end
$$;

revoke all on function public.youtube_channel_one_org_check(text, uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function public.channel_token_refs_one_org() from public, anon, authenticated, service_role;
revoke all on function public.channels_youtube_one_org() from public, anon, authenticated, service_role;

create or replace trigger channel_token_refs_one_org
  before insert or update on public.channel_token_refs
  for each row execute function public.channel_token_refs_one_org();

create or replace trigger channels_youtube_one_org
  before insert or update of credential_ref, org_id on public.channels
  for each row execute function public.channels_youtube_one_org();

-- ───────────────────────────────────────────────────────────────────────────
-- The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r   record;
  fn  oid;
  got text;
begin
  for r in
    select * from (values
      ('public.youtube_channel_one_org_check(text, uuid, text[])', '8a63db3a3ba1c4d82913a73143ee7ac1', false),
      ('public.channel_token_refs_one_org()', 'af871aaa21f80887949ffb58cb04e1ac', true),
      ('public.channels_youtube_one_org()', '86f8bc74da482ad80177cf54484d0bd6', true)
    ) v(sig, want, definer)
  loop
    fn := to_regprocedure(r.sig);
    if fn is null then
      raise exception '0141 end state: % does not exist', r.sig;
    end if;
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = fn;
    if got <> r.want then
      raise exception '0141 end state: % does not hold this file''s body (md5 %)', r.sig, got;
    end if;
    -- No API role may call it. A NULL ACL would mean "default privileges", and the default includes public.
    if exists (select 1 from pg_proc p
                where p.oid = fn
                  and (p.proacl is null
                       or exists (select 1 from aclexplode(p.proacl) a
                                   where a.grantee = 0
                                      or a.grantee in (select o.oid from pg_roles o
                                                        where o.rolname in ('anon', 'authenticated', 'service_role'))))) then
      raise exception '0141 end state: % is executable by an API role', r.sig;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = fn and p.proconfig @> array['search_path=public, pg_temp']
                                               and p.prosecdef = r.definer) then
      raise exception '0141 end state: % has no pinned search_path or the wrong security', r.sig;
    end if;
  end loop;
  -- Both triggers, enabled, BEFORE ROW, on the events above.
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.channel_token_refs'::regclass and t.tgname = 'channel_token_refs_one_org'
                    and t.tgenabled = 'O' and not t.tgisinternal
                    and t.tgfoid = 'public.channel_token_refs_one_org()'::regprocedure
                    and pg_get_triggerdef(t.oid) like '%BEFORE INSERT OR UPDATE ON public.channel_token_refs FOR EACH ROW%') then
    raise exception '0141 end state: the channel_token_refs trigger is missing or not what this file creates';
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.channels'::regclass and t.tgname = 'channels_youtube_one_org'
                    and t.tgenabled = 'O' and not t.tgisinternal
                    and t.tgfoid = 'public.channels_youtube_one_org()'::regprocedure
                    and pg_get_triggerdef(t.oid) like '%BEFORE INSERT OR UPDATE OF credential_ref, org_id ON public.channels FOR EACH ROW%') then
    raise exception '0141 end state: the channels trigger is missing or not what this file creates';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.youtube_channel_one_org_check(text, uuid, text[])'::regprocedure) = '8a63db3a3ba1c4d82913a73143ee7ac1' as check_is_0141s,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.channel_token_refs_one_org()'::regprocedure) = 'af871aaa21f80887949ffb58cb04e1ac' as token_trigger_fn_is_0141s,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.channels_youtube_one_org()'::regprocedure) = '86f8bc74da482ad80177cf54484d0bd6' as channels_trigger_fn_is_0141s,
--   exists (select 1 from pg_trigger where tgrelid = 'public.channel_token_refs'::regclass
--            and tgname = 'channel_token_refs_one_org' and tgenabled = 'O') as token_trigger_on,
--   exists (select 1 from pg_trigger where tgrelid = 'public.channels'::regclass
--            and tgname = 'channels_youtube_one_org' and tgenabled = 'O') as channels_trigger_on,
--   not has_function_privilege('authenticated', 'public.youtube_channel_one_org_check(text, uuid, text[])', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.youtube_channel_one_org_check(text, uuid, text[])', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.youtube_channel_one_org_check(text, uuid, text[])', 'EXECUTE')
--     as check_not_callable;
