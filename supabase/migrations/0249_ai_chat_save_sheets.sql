-- 0249_ai_chat_save_sheets.sql — the character sheets of a Nightshift AI conversation get ONE writer in the database
-- (docs/studio/NIGHTSHIFT_AI.md "Character sheets"; the sheets route /api/brain/sheets and the chat's turn route /api/brain/turn).
--
-- *** NOT APPLIED LIVE. *** Number 0249, assigned by the coordinator.
--
-- EVIDENCE (#980, Lens M2; command-center/lib/server/brain/ref-sheets.ts saveSheets and app/api/brain/turn/route.ts carried):
--   * Both routes write the WHOLE BRIEF through 0199's ai_chat_save_brief (and the turn route through ai_chat_finish_turn). Each
--     re-reads the stored ref_sheets / film_link and puts them into the BRIEF it writes, but between that read and the write another
--     request can save: a person's Approve, a view's job id saved after its paid create, a redo. The later full-BRIEF write then puts
--     the older list back and the approval or the job id is gone. A lost approval cannot be recovered, and a lost job id is a paid
--     picture missing from the sheet until its key is looked up again.
--
-- CHANGE (additive; no body replaced):
--   * ai_chat_save_sheets(p_session, p_sheets, p_base, p_film_link) -> jsonb: NEW, authenticated only. Under the conversation's row
--     lock (FOR UPDATE, the lock 0199's ai_chat_save_brief and ai_chat_finish_turn take on the same row) it writes ONLY
--     brief -> 'ref_sheets' and brief -> 'film_link', each with jsonb_set, and leaves every other key, the step and the card as they
--     are. A null p_sheets leaves the sheets alone; a null p_film_link leaves the link alone (one of the two is required). Answers
--     {ref_sheets, film_link} as stored after the write.
--   * A BEFORE UPDATE OF brief trigger on ai_chat_sessions (ai_chat_sessions_keep_sheets): every other writer of the BRIEF gets the
--     stored ref_sheets and film_link back, whatever its BRIEF says about them (missing, an older copy, anything else). Only an update
--     made by ai_chat_save_sheets itself, which names the row in a transaction-local setting (nightshift.ai_chat_sheets = the
--     session id, cleared right after its update, the pattern of 0034's nightshift.refund_of and 0107's nightshift.owner_rpc), may
--     change them.
--   * ai_chat_sheet_problem(jsonb) -> text: internal (no API role), the shape rule of one sheet a caller sends; null = well formed.
--   * ai_chat_sheet_repair(jsonb) -> jsonb: internal, one STORED sheet read the way the app's readSheets reads it (null = dropped).
--   * 0199's CHECK on brief replaced by one that gives the sheets their own budget (SIZE below).
--
-- WHO MAY (mirrors 0199's ai_chat_save_brief, read from its body, not guessed): signed in (42501 otherwise); the conversation's
--   author (created_by = auth.uid()) and still an editor or above of its workspace (is_org_member(org, 'editor')), else
--   session_not_found (NS404: another person's conversation, another workspace's, a viewer's or a removed member's all read as
--   missing, as 0199 says them). 0226 did not change ai_chat_save_brief (it asks is_org_spender only where credits or a turn are
--   spent); a sheet write spends nothing (every picture is its own create_creative_job, which asks is_org_spender itself), so this
--   function asks no spender question either. Then the step: 'created' -> session_closed (NS409, 0199's word); anything but
--   'ready' -> plan_not_ready (NS409, detail = the step), the rule the sheets route already applies (stepRefusal). A project's own
--   storyboard conversation (BRIEF key film_plan, lib/brain/film-plan.ts) -> film_conversation (NS409): it never has sheets.
--
-- MERGE, NOT COMPARE-AND-SWAP. The database merges view by view, with the rule the app has used since #980
--   (lib/brain/ref-sheets.ts mergeConcurrent), now under the row lock so nothing can land between the read and the write:
--     for each sheet of p_sheets (key: character_id + stage), each of front / side / back:
--       only one side has the view                  -> that one;
--       the caller CHANGED it (differs from p_base) -> the caller's (an intent before its create, a revert after a refused create,
--                                                      an approval, a redo);
--       otherwise                                   -> the later attempt, and within one attempt the further state
--                                                      (planned < failed < making < ready < approved), the caller's on a tie.
--     A stored sheet the caller did not send is kept; a sent sheet the row does not have is added; at most 40 sheets.
--   Why not a compare-and-swap on a per-view version: a CAS refuses the loser, and the loser is often the write that must not fail
--   (makeSheets' phase 3, which saves the job ids of pictures that were just paid for). Refusing it means a retry loop in the app
--   with a re-read and a re-merge, which is the same merge run in the app again. Merging here never refuses on contention, keeps
--   the app's rule exactly (the vitest suite pins it), and needs no new field on every view.
--
-- WHY A TRIGGER. The turn route has three full-BRIEF writes (choose long, the kept storyboard, the priced storyboard) and the chat's
--   own turn through ai_chat_finish_turn. Changing each to "leave the sheets out" still leaves 0199's two functions writing whatever
--   BRIEF they are given, so one forgotten carry, a direct RPC, or a future writer drops the sheets again. Replacing 0199's bodies to
--   keep them would touch two guarded functions every later file pins. The trigger needs neither: it holds for every writer of the
--   row, present and future, and leaves 0199's bodies byte for byte. The flag is not a security boundary against the author (they
--   can only ever write their own conversation, and every shape rule is enforced by this function); it is how the one writer is
--   told apart from the rest. No API role can set it: PostgREST runs no SQL of a caller's, and no function takes a setting name.
--
-- CAPS (refused by name, NS400, before anything is written): p_sheets an array of at most 40 sheets (CAP.characters 8 x (4 stages +
--   the own look), lib/brain/ref-sheets SHEETS_MAX) and at most 196608 bytes -> too_many_sheets / sheets_too_large; each sheet an
--   object of exactly character_id ([A-Za-z0-9_-]{1,40}), stage (null or the same), views (an array of at most 3 -> too_many_views),
--   no two sheets with one key; each view an object of view (front | side | back, once per sheet), prompt (a string of at most 4000
--   characters -> sheet_prompt_too_long), status (planned | making | ready | approved | failed) and, optionally, asset_id / job_id
--   (null or a uuid), attempt (an integer 0..999), error (null or a machine word), key (null or sheet: + 48 hex), nothing else ->
--   invalid_sheet (detail: what). p_base, the list the caller started from, by the same rules. p_film_link an object of exactly
--   film_id (a film of the conversation's workspace) and scenes (at most 60 of {brief: [A-Za-z][A-Za-z0-9_-]{0,15}, film: a scene of
--   that film}) -> invalid_film_link. The MERGED list over 40 sheets -> too_many_sheets, never cut (a sheet may hold a paid job's
--   id); over 196608 bytes -> sheets_too_large. A stored sheet written through 0199 before this file is read the way the app's
--   readSheets reads it (ai_chat_sheet_repair): a sheet without a valid character_id, stage or views list is dropped; within a sheet
--   only a view without a valid view name or prompt is dropped, and a bad field of a kept view reads as its default (status planned,
--   ids, error and key null, attempt 0). Pre-apply count of stored lists this would touch (expect 0):
--     select count(*) from public.ai_chat_sessions where brief ? 'ref_sheets' and (jsonb_typeof(brief -> 'ref_sheets') <> 'array'
--       or jsonb_array_length(brief -> 'ref_sheets') > 40 or exists (select 1 from jsonb_array_elements(brief -> 'ref_sheets') e
--       where jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'views') is distinct from 'array'
--          or exists (select 1 from jsonb_array_elements(e -> 'views') v where jsonb_typeof(v) <> 'object'
--             or coalesce(v ->> 'view', '') not in ('front', 'side', 'back') or jsonb_typeof(v -> 'prompt') is distinct from 'string'
--             or coalesce(v ->> 'status', '') not in ('planned', 'making', 'ready', 'approved', 'failed'))));
--
-- SIZE (Breach BR-SW-08). 0199's CHECK counted the whole BRIEF against 262144 bytes. With the sheets kept by the trigger, a turn's
--   BRIEF that fits on its own (75 KB) plus sheets the writer accepted (191 KB) broke that CHECK inside ai_chat_finish_turn: a raw
--   23514, the turn rolled back, its vendor-paid call left pending, and every later turn of the conversation failing the same way.
--   The fix gives the sheets their own budget instead of a share of the turn's: 0199's CHECK (ai_chat_sessions_brief_check) is
--   replaced by ai_chat_sessions_brief_0249, which counts the BRIEF WITHOUT ref_sheets and film_link against the same 262144 that
--   0199 promised every writer, ref_sheets against 196608 and film_link against 8192 (60 scenes of {brief, film} need under 5 KB).
--   A turn is then measured exactly as before 0249, whatever sheets the row holds, so a turn can no longer fail on sheets it did
--   not write, and the only writer that can grow the sheets checks their budget by name first. A BRIEF too large on its own is
--   refused by the trigger as brief_too_large (the remedy said) rather than a raw 23514; that refusal is the turn's own size, which
--   0199 refused before 0249 too. Why not a table of its own for the sheets: it would leave every read of brief.ref_sheets (the
--   app, the lab's pins) to change at once, for the same guarantee. A row can now hold up to about 467 KB (262144 + 196608 + 8192).
--
-- WHAT THE APP DOES (command-center/lib/server/brain/ref-sheets.ts saveSheets; app/api/brain/turn/route.ts): the sheets route
--   writes its sheets with ai_chat_save_sheets (the list and the base it started from) and shows what it answers; the turn route
--   writes the film link with it right after its ai_chat_save_brief. Before this file is applied the function does not exist
--   (PGRST202 / 42883): saveSheets falls back to #980's re-read, merge and ai_chat_save_brief, and the turn route's BRIEF still
--   carries the stored sheets and the link (carrySheets), exactly as #980. With this file applied that carry is overruled by the
--   trigger and harmless, so it stays for a database without it.
--
-- GUARD (md5 of the body, whitespace runs read as one space): ai_chat_save_brief 16f6ce5d2815675860bbce0a1a1810ac (0199, which 0226
--   did not change). This file was designed on that body (the author and editor rule mirrored above, and its write being the one
--   the trigger overrules); any other body is refused ("changed by hand? compare with 0199 before applying").
--
-- LOCKS. One row lock, the conversation's, taken first; then reads only (films, film_scenes). 0232's order (workspace advisory lock,
--   conversation row, leases, calls, person) is kept: nothing here takes an advisory lock or a lease.
--
-- NO BACKSLASH in this file or its rollback (an apply tool can rewrite escape sequences). The md5 fold is
--   regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g'); the patterns use bracket classes.
--
-- NOT CHANGED: every price, hold, credit, create, film and publish rule (CLAUDE.md rules 2 and 3: a sheet write spends nothing,
--   starts nothing and publishes nothing), and every 0199 body.
--
-- REPLAY. This file replays onto itself (create or replace, the trigger dropped and created again). Re-running 0199 replaces its
--   bodies with the same text and leaves the trigger on. 0199's rollback drops the table and the trigger with it; drop this file
--   first with its rollback to remove its functions too.
--
-- REQUIRES 0199 (ai_chat_sessions, ai_chat_save_brief), 0018 (is_org_member), 0036 (creative_refuse), 0166 (films, film_scenes).
--   Undo: docs/sql/rollback_0249_ai_chat_save_sheets.sql (owner-applied): the trigger and the three functions dropped, and 0199's
--   CHECK put back (it refuses, by name and with the remedy, while a conversation holds more than 262144 bytes with its sheets).
--   The sheets already stored stay in the BRIEF (they are the person's), and both routes go back to #980's behaviour at once.
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).

set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regclass('public.ai_chat_sessions') is null then
    raise exception '0249 needs 0199 (ai_chat_sessions): apply 0199_studio_ai_chat.sql first';
  end if;
  if to_regprocedure('public.is_org_member(uuid, text)') is null or to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0249 needs is_org_member (0018) and creative_refuse (0036)';
  end if;
  if to_regclass('public.films') is null or to_regclass('public.film_scenes') is null then
    raise exception '0249 needs 0166 (films, film_scenes): apply it first';
  end if;
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.ai_chat_save_brief(uuid, jsonb, text)');
  if h is null then
    raise exception '0249 found no public.ai_chat_save_brief(uuid, jsonb, text): apply 0199 first';
  end if;
  if h <> '16f6ce5d2815675860bbce0a1a1810ac' then
    raise exception '0249 found public.ai_chat_save_brief with an unknown body (md5 %): changed by hand? compare with 0199 before applying', h;
  end if;
  -- The BRIEF's CHECK this file replaces: 0199's, or this file's own on a replay. Anything else was changed by hand.
  select pg_get_constraintdef(c.oid) into h from pg_constraint c
   where c.conrelid = 'public.ai_chat_sessions'::regclass and c.conname = 'ai_chat_sessions_brief_check';
  if h is not null and h <> 'CHECK (((jsonb_typeof(brief) = ''object''::text) AND (octet_length((brief)::text) <= 262144)))' then
    raise exception '0249 found ai_chat_sessions_brief_check with an unknown definition (%): changed by hand? compare with 0199 before applying', h;
  end if;
  if h is null and not exists (select 1 from pg_constraint c where c.conrelid = 'public.ai_chat_sessions'::regclass
                                  and c.conname = 'ai_chat_sessions_brief_0249') then
    raise exception '0249 found no CHECK on ai_chat_sessions.brief (neither 0199''s nor its own): compare with 0199 before applying';
  end if;
  -- A conversation the new CHECK would refuse (sheets over their own budget, written through 0199 before this file): said with the
  -- count and the remedy, before the ALTER would fail on a raw 23514.
  select count(*)::text into h from public.ai_chat_sessions
   where octet_length(coalesce(brief -> 'ref_sheets', '[]'::jsonb)::text) > 196608
      or octet_length(coalesce(brief -> 'film_link', 'null'::jsonb)::text) > 8192;
  if h <> '0' then
    raise exception '0249: % conversation(s) hold more than 196608 bytes of ref_sheets or 8192 of film_link; trim those keys by hand, then apply this file', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- The sheets get their own budget (SIZE in the header)
-- ───────────────────────────────────────────────────────────────────────────

alter table public.ai_chat_sessions drop constraint if exists ai_chat_sessions_brief_0249;
alter table public.ai_chat_sessions drop constraint if exists ai_chat_sessions_brief_check;
alter table public.ai_chat_sessions add constraint ai_chat_sessions_brief_0249 check (
  jsonb_typeof(brief) = 'object'
  and octet_length((brief - 'ref_sheets' - 'film_link')::text) <= 262144
  and octet_length(coalesce(brief -> 'ref_sheets', '[]'::jsonb)::text) <= 196608
  and octet_length(coalesce(brief -> 'film_link', 'null'::jsonb)::text) <= 8192);

-- ───────────────────────────────────────────────────────────────────────────
-- The shape of one sheet (internal)
-- ───────────────────────────────────────────────────────────────────────────

-- Null when p is one well-formed sheet; otherwise the refusal's code and what was wrong ("code:what"). The rules of the app's
-- readSheets, strict: a write never stores what readSheets would have to repair.
create or replace function public.ai_chat_sheet_problem(p jsonb) returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v jsonb;
  seen text[] := '{}';
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  id_re constant text := '^[A-Za-z0-9_-]{1,40}$';
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return 'invalid_sheet:a sheet is an object';
  end if;
  if exists (select 1 from jsonb_object_keys(p) k where k not in ('character_id', 'stage', 'views')) then
    return 'invalid_sheet:a sheet has character_id, stage and views only';
  end if;
  if jsonb_typeof(p -> 'character_id') is distinct from 'string' or (p ->> 'character_id') !~ id_re then
    return 'invalid_sheet:character_id';
  end if;
  if not (p ? 'stage') or not (jsonb_typeof(p -> 'stage') = 'null'
                               or (jsonb_typeof(p -> 'stage') = 'string' and (p ->> 'stage') ~ id_re)) then
    return 'invalid_sheet:stage';
  end if;
  if jsonb_typeof(p -> 'views') is distinct from 'array' then
    return 'invalid_sheet:views';
  end if;
  if jsonb_array_length(p -> 'views') > 3 then
    return 'too_many_views:at most 3 views per sheet';
  end if;
  for v in select e from jsonb_array_elements(p -> 'views') e loop
    if jsonb_typeof(v) <> 'object' then
      return 'invalid_sheet:a view is an object';
    end if;
    if exists (select 1 from jsonb_object_keys(v) k
                where k not in ('view', 'prompt', 'asset_id', 'status', 'job_id', 'attempt', 'error', 'key')) then
      return 'invalid_sheet:a view has view, prompt, asset_id, status, job_id, attempt, error and key only';
    end if;
    if jsonb_typeof(v -> 'view') is distinct from 'string' or (v ->> 'view') not in ('front', 'side', 'back') then
      return 'invalid_sheet:view';
    end if;
    if (v ->> 'view') = any (seen) then
      return 'invalid_sheet:a view appears twice';
    end if;
    seen := seen || (v ->> 'view');
    if jsonb_typeof(v -> 'prompt') is distinct from 'string' then
      return 'invalid_sheet:prompt';
    end if;
    if char_length(v ->> 'prompt') > 4000 then
      return 'sheet_prompt_too_long:at most 4000 characters';
    end if;
    if jsonb_typeof(v -> 'status') is distinct from 'string'
       or (v ->> 'status') not in ('planned', 'making', 'ready', 'approved', 'failed') then
      return 'invalid_sheet:status';
    end if;
    if coalesce(jsonb_typeof(v -> 'asset_id'), 'null') <> 'null'
       and (jsonb_typeof(v -> 'asset_id') <> 'string' or (v ->> 'asset_id') !~ uuid_re) then
      return 'invalid_sheet:asset_id';
    end if;
    if coalesce(jsonb_typeof(v -> 'job_id'), 'null') <> 'null'
       and (jsonb_typeof(v -> 'job_id') <> 'string' or (v ->> 'job_id') !~ uuid_re) then
      return 'invalid_sheet:job_id';
    end if;
    if v ? 'attempt' then
      -- Two steps: the number is read only once it is known to be one (a string cast would raise instead of refusing by name).
      if jsonb_typeof(v -> 'attempt') <> 'number' then
        return 'invalid_sheet:attempt';
      end if;
      if (v ->> 'attempt')::numeric <> trunc((v ->> 'attempt')::numeric) or (v ->> 'attempt')::numeric not between 0 and 999 then
        return 'invalid_sheet:attempt';
      end if;
    end if;
    if coalesce(jsonb_typeof(v -> 'error'), 'null') <> 'null'
       and (jsonb_typeof(v -> 'error') <> 'string' or (v ->> 'error') !~ '^[a-z][a-z0-9_]{0,39}$') then
      return 'invalid_sheet:error';
    end if;
    if coalesce(jsonb_typeof(v -> 'key'), 'null') <> 'null'
       and (jsonb_typeof(v -> 'key') <> 'string' or (v ->> 'key') !~ '^sheet:[0-9a-f]{48}$') then
      return 'invalid_sheet:key';
    end if;
  end loop;
  return null;
end
$$;

-- One STORED sheet as the app's readSheets reads it (lib/brain/ref-sheets.ts): null when the sheet itself is unreadable (no valid
-- character_id, stage or views list); otherwise the sheet rebuilt with its readable views only (a valid view name and a string
-- prompt, the first of each name, at most 3), each field that is not in its shape read as its default. A list written through 0199
-- before this file keeps every view the app shows today: one bad view never takes its sheet's paid pictures with it.
create or replace function public.ai_chat_sheet_repair(p jsonb) returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v jsonb;
  out_views jsonb := '[]'::jsonb;
  seen text[] := '{}';
  n numeric;
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  id_re constant text := '^[A-Za-z0-9_-]{1,40}$';
begin
  if p is null or jsonb_typeof(p) <> 'object'
     or jsonb_typeof(p -> 'character_id') is distinct from 'string' or (p ->> 'character_id') !~ id_re
     or not (p ? 'stage') or not (jsonb_typeof(p -> 'stage') = 'null' or (jsonb_typeof(p -> 'stage') = 'string' and (p ->> 'stage') ~ id_re))
     or jsonb_typeof(p -> 'views') is distinct from 'array' then
    return null;
  end if;
  for v in select e from jsonb_array_elements(p -> 'views') e loop
    continue when jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 'view') is distinct from 'string'
                  or (v ->> 'view') not in ('front', 'side', 'back') or jsonb_typeof(v -> 'prompt') is distinct from 'string';
    continue when (v ->> 'view') = any (seen) or array_length(seen, 1) >= 3;
    seen := seen || (v ->> 'view');
    n := case when jsonb_typeof(v -> 'attempt') = 'number' then (v ->> 'attempt')::numeric end;
    out_views := out_views || jsonb_build_array(jsonb_build_object(
      'view', v ->> 'view',
      'prompt', v ->> 'prompt',
      'asset_id', case when jsonb_typeof(v -> 'asset_id') = 'string' and (v ->> 'asset_id') ~ uuid_re then v -> 'asset_id' else 'null'::jsonb end,
      'status', case when (v ->> 'status') in ('planned', 'making', 'ready', 'approved', 'failed') and jsonb_typeof(v -> 'status') = 'string'
                     then v ->> 'status' else 'planned' end,
      'job_id', case when jsonb_typeof(v -> 'job_id') = 'string' and (v ->> 'job_id') ~ uuid_re then v -> 'job_id' else 'null'::jsonb end,
      'attempt', case when n is not null and n = trunc(n) and n >= 0 and n < 1000 then n::integer else 0 end,
      'error', case when jsonb_typeof(v -> 'error') = 'string' and (v ->> 'error') ~ '^[a-z][a-z0-9_]{0,39}$' then v -> 'error' else 'null'::jsonb end,
      'key', case when jsonb_typeof(v -> 'key') = 'string' and (v ->> 'key') ~ '^sheet:[0-9a-f]{48}$' then v -> 'key' else 'null'::jsonb end));
  end loop;
  return jsonb_build_object('character_id', p -> 'character_id', 'stage', p -> 'stage', 'views', out_views);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- The one writer of brief -> ref_sheets and brief -> film_link
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.ai_chat_save_sheets(p_session uuid, p_sheets jsonb, p_base jsonb, p_film_link jsonb)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
  v_problem text;
  v_list jsonb;
  v_e jsonb;
  v_keys text[];
  v_k text;
  v_stored jsonb := '[]'::jsonb;
  v_base jsonb := '[]'::jsonb;
  v_out jsonb;
  v_idx integer;
  v_f jsonb;
  v_b0 jsonb;
  v_views jsonb;
  v_name text;
  a jsonb;
  b jsonb;
  w jsonb;
  ra integer[];
  rb integer[];
  v_brief jsonb;
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  -- 0199's rule, word for word: the author, still an editor of the workspace; anyone else reads it as missing.
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user for update;
  if not found or not public.is_org_member(s.org_id, 'editor') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
  end if;
  if s.step = 'created' then
    perform public.creative_refuse('session_closed', 'this plan was handed off; start a new conversation', 'NS409');
  end if;
  if s.step <> 'ready' then
    perform public.creative_refuse('plan_not_ready', s.step, 'NS409');
  end if;
  if s.brief ? 'film_plan' then
    perform public.creative_refuse('film_conversation', 'a project''s storyboard conversation has no character sheets', 'NS409');
  end if;
  if p_sheets is null and p_film_link is null then
    perform public.creative_refuse('invalid_params', 'sheets, a film link, or both');
  end if;

  -- The caps, on what the caller sent (the list, and the base it started from), before anything is read or written.
  foreach v_name in array array['p_sheets', 'p_base'] loop
    v_list := case when v_name = 'p_sheets' then p_sheets else p_base end;
    continue when v_list is null;
    if jsonb_typeof(v_list) <> 'array' then
      perform public.creative_refuse('invalid_sheet', v_name || ' is a list of sheets');
    end if;
    if jsonb_array_length(v_list) > 40 then
      perform public.creative_refuse('too_many_sheets', 'at most 40 sheets');
    end if;
    if octet_length(v_list::text) > 196608 then
      perform public.creative_refuse('sheets_too_large', 'at most 196608 bytes of sheets');
    end if;
    v_keys := '{}';
    for v_e in select e from jsonb_array_elements(v_list) e loop
      v_problem := public.ai_chat_sheet_problem(v_e);
      if v_problem is not null then
        perform public.creative_refuse(split_part(v_problem, ':', 1), v_name || ': ' || substr(v_problem, strpos(v_problem, ':') + 1));
      end if;
      v_k := (v_e ->> 'character_id') || ':' || coalesce(v_e ->> 'stage', '');
      if v_k = any (v_keys) then
        perform public.creative_refuse('invalid_sheet', v_name || ': two sheets of one character and stage');
      end if;
      v_keys := v_keys || v_k;
    end loop;
  end loop;

  if p_film_link is not null then
    if jsonb_typeof(p_film_link) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_film_link) k where k not in ('film_id', 'scenes'))
       or jsonb_typeof(p_film_link -> 'film_id') is distinct from 'string' or (p_film_link ->> 'film_id') !~ uuid_re
       or jsonb_typeof(p_film_link -> 'scenes') is distinct from 'array' or jsonb_array_length(p_film_link -> 'scenes') > 60 then
      perform public.creative_refuse('invalid_film_link', 'a film id and at most 60 scenes');
    end if;
    if exists (select 1 from jsonb_array_elements(p_film_link -> 'scenes') e
                where jsonb_typeof(e) <> 'object'
                   or exists (select 1 from jsonb_object_keys(e) k where k not in ('brief', 'film'))
                   or jsonb_typeof(e -> 'brief') is distinct from 'string' or (e ->> 'brief') !~ '^[A-Za-z][A-Za-z0-9_-]{0,15}$'
                   or jsonb_typeof(e -> 'film') is distinct from 'string' or (e ->> 'film') !~ uuid_re) then
      perform public.creative_refuse('invalid_film_link', 'each scene is {brief, film}');
    end if;
    -- The film is the conversation's own workspace's, and every linked scene is that film's: never another tenant's ids.
    -- uuids compared as uuids (the shape is checked above), so the primary keys answer under the row lock.
    if not exists (select 1 from public.films f where f.id = (p_film_link ->> 'film_id')::uuid and f.org_id = s.org_id)
       or exists (select 1 from jsonb_array_elements(p_film_link -> 'scenes') e
                   where not exists (select 1 from public.film_scenes fs
                                      where fs.id = (e ->> 'film')::uuid and fs.film_id = (p_film_link ->> 'film_id')::uuid
                                        and fs.org_id = s.org_id)) then
      perform public.creative_refuse('invalid_film_link', 'that film or scene is not in this workspace');
    end if;
  end if;

  v_brief := s.brief;
  if p_sheets is not null then
    -- What is stored now, read as the app's readSheets reads it (ai_chat_sheet_repair), one per key (the first).
    v_keys := '{}';
    if jsonb_typeof(s.brief -> 'ref_sheets') = 'array' then
      for v_e in select public.ai_chat_sheet_repair(e) from jsonb_array_elements(s.brief -> 'ref_sheets') e loop
        continue when v_e is null;
        v_k := (v_e ->> 'character_id') || ':' || coalesce(v_e ->> 'stage', '');
        continue when v_k = any (v_keys);
        v_keys := v_keys || v_k;
        v_stored := v_stored || jsonb_build_array(v_e);
      end loop;
    end if;
    v_base := coalesce(p_base, '[]'::jsonb);
    v_out := v_stored;
    for v_e in select e from jsonb_array_elements(p_sheets) e loop
      v_k := (v_e ->> 'character_id') || ':' || coalesce(v_e ->> 'stage', '');
      select (o.n - 1)::integer into v_idx from jsonb_array_elements(v_out) with ordinality o(x, n)
       where (o.x ->> 'character_id') || ':' || coalesce(o.x ->> 'stage', '') = v_k limit 1;
      if v_idx is null then
        v_out := v_out || jsonb_build_array(v_e);
        continue;
      end if;
      v_f := v_out -> v_idx;
      select x into v_b0 from jsonb_array_elements(v_base) x
       where (x ->> 'character_id') || ':' || coalesce(x ->> 'stage', '') = v_k limit 1;
      v_views := '[]'::jsonb;
      foreach v_name in array array['front', 'side', 'back'] loop
        a := (select x from jsonb_array_elements(v_f -> 'views') x where x ->> 'view' = v_name limit 1);
        b := (select x from jsonb_array_elements(v_e -> 'views') x where x ->> 'view' = v_name limit 1);
        if a is null and b is null then
          continue;
        elsif a is null or b is null then
          w := coalesce(b, a);
        elsif b is distinct from (select x from jsonb_array_elements(case when jsonb_typeof(v_b0 -> 'views') = 'array'
                                                                          then v_b0 -> 'views' else '[]'::jsonb end) x
                                    where x ->> 'view' = v_name limit 1) then
          -- The caller changed this view: theirs.
          w := b;
        else
          ra := array[coalesce((a ->> 'attempt')::numeric::integer, 0), array_position(array['planned', 'failed', 'making', 'ready', 'approved'], a ->> 'status')];
          rb := array[coalesce((b ->> 'attempt')::numeric::integer, 0), array_position(array['planned', 'failed', 'making', 'ready', 'approved'], b ->> 'status')];
          w := case when rb >= ra then b else a end;
        end if;
        v_views := v_views || jsonb_build_array(w);
      end loop;
      v_out := jsonb_set(v_out, array[v_idx::text], jsonb_set(v_e, '{views}', v_views));
      v_b0 := null;
    end loop;
    -- Refused, never cut: a sheet past the 40th may hold a paid job's id (both reviewers on 0249).
    if jsonb_array_length(v_out) > 40 then
      perform public.creative_refuse('too_many_sheets', 'the sheets stored and sent together are more than 40');
    end if;
    -- The sheets' own budget (ai_chat_sessions_brief_0249): checked here by name, never left to the CHECK's raw 23514.
    if octet_length(v_out::text) > 196608 then
      perform public.creative_refuse('sheets_too_large', 'the sheets stored and sent together are over 196608 bytes');
    end if;
    v_brief := jsonb_set(v_brief, '{ref_sheets}', v_out, true);
  end if;
  if p_film_link is not null then
    v_brief := jsonb_set(v_brief, '{film_link}', p_film_link, true);
  end if;

  -- Only this update may change the two keys (ai_chat_sessions_keep_sheets): the row is named, then the name cleared at once.
  perform set_config('nightshift.ai_chat_sheets', s.id::text, true);
  update public.ai_chat_sessions set brief = v_brief, updated_at = now() where id = s.id;
  perform set_config('nightshift.ai_chat_sheets', '', true);
  return jsonb_build_object('ref_sheets', coalesce(v_brief -> 'ref_sheets', '[]'::jsonb), 'film_link', v_brief -> 'film_link');
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- Every other writer keeps the stored sheets and link
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.ai_chat_sessions_keep_sheets() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  if coalesce(current_setting('nightshift.ai_chat_sheets', true), '') = new.id::text then
    return new;
  end if;
  -- Whatever the incoming BRIEF says about them (nothing, an older copy, anything else), the stored ones stay: 0199's
  -- ai_chat_save_brief and ai_chat_finish_turn write a whole BRIEF, and the copy a route carried may be older than the row.
  v := new.brief - 'ref_sheets' - 'film_link';
  -- The writer's own BRIEF is measured alone, against 0199's 262144 (the sheets have their own budget): what is refused here is
  -- the writer's own size, said by name with the remedy instead of the CHECK's raw 23514.
  if jsonb_typeof(v) = 'object' and octet_length(v::text) > 262144 then
    raise exception 'brief_too_large' using errcode = 'NS400',
      detail = 'the plan itself is over 262144 bytes (character sheets not counted): shorten the plan or start a new conversation';
  end if;
  if old.brief ? 'ref_sheets' then
    v := v || jsonb_build_object('ref_sheets', old.brief -> 'ref_sheets');
  end if;
  if old.brief ? 'film_link' then
    v := v || jsonb_build_object('film_link', old.brief -> 'film_link');
  end if;
  new.brief := v;
  return new;
end
$$;

drop trigger if exists ai_chat_sessions_keep_sheets on public.ai_chat_sessions;
create trigger ai_chat_sessions_keep_sheets
  before update of brief on public.ai_chat_sessions
  for each row when (old.brief is distinct from new.brief)
  execute function public.ai_chat_sessions_keep_sheets();

revoke all on function public.ai_chat_sheet_problem(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_sheet_repair(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_sessions_keep_sheets() from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb) to authenticated;

comment on function public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb) is
  'Migration 0249: the one writer of brief.ref_sheets and brief.film_link of a Nightshift AI conversation (its author, an editor, step ready), merged view by view under the row lock; every other key untouched.';

-- ───────────────────────────────────────────────────────────────────────────
-- End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  select f.prosecdef, f.proconfig into r from pg_proc f where f.oid = to_regprocedure('public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb)');
  if not found or not r.prosecdef or not ('search_path=public, pg_temp' = any (r.proconfig)) then
    raise exception '0249 end state: ai_chat_save_sheets is not security definer with a pinned search_path';
  end if;
  if not has_function_privilege('authenticated', 'public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb)', 'EXECUTE') then
    raise exception '0249 end state: ai_chat_save_sheets is callable by the wrong role';
  end if;
  if has_function_privilege('authenticated', 'public.ai_chat_sheet_problem(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ai_chat_sheet_problem(jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.ai_chat_sheet_problem(jsonb)', 'EXECUTE') then
    raise exception '0249 end state: ai_chat_sheet_problem is callable by an API role';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.ai_chat_sessions'::regclass
                    and t.tgname = 'ai_chat_sessions_keep_sheets' and t.tgenabled = 'O' and not t.tgisinternal
                    and t.tgfoid = 'public.ai_chat_sessions_keep_sheets()'::regprocedure) then
    raise exception '0249 end state: the keep-sheets trigger is not on ai_chat_sessions';
  end if;
  if has_function_privilege('authenticated', 'public.ai_chat_sheet_repair(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ai_chat_sheet_repair(jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.ai_chat_sheet_repair(jsonb)', 'EXECUTE') then
    raise exception '0249 end state: ai_chat_sheet_repair is callable by an API role';
  end if;
  -- Column grants too: a column-level UPDATE on brief would pass has_table_privilege and still write it.
  if has_any_column_privilege('authenticated', 'public.ai_chat_sessions', 'UPDATE')
     or has_any_column_privilege('anon', 'public.ai_chat_sessions', 'UPDATE') then
    raise exception '0249 end state: an API role can update a conversation directly';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.ai_chat_sessions'::regclass and conname = 'ai_chat_sessions_brief_check')
     or not exists (select 1 from pg_constraint where conrelid = 'public.ai_chat_sessions'::regclass
                       and conname = 'ai_chat_sessions_brief_0249' and convalidated) then
    raise exception '0249 end state: the BRIEF''s CHECK is not 0249''s (the sheets counted apart)';
  end if;
  if (select md5(regexp_replace(p2.prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc p2
       where p2.oid = to_regprocedure('public.ai_chat_save_brief(uuid, jsonb, text)')) <> '16f6ce5d2815675860bbce0a1a1810ac' then
    raise exception '0249 end state: ai_chat_save_brief is not 0199''s body';
  end if;
end $$;

notify pgrst, 'reload schema';

-- Verify (read-only): every column should read true.
-- select to_regprocedure('public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb)') is not null as writer,
--        exists (select 1 from pg_trigger where tgname = 'ai_chat_sessions_keep_sheets' and tgenabled = 'O') as trigger_on,
--        has_function_privilege('authenticated', 'public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb)', 'EXECUTE') as members_call,
--        not has_function_privilege('anon', 'public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb)', 'EXECUTE') as anon_closed,
--        not has_function_privilege('authenticated', 'public.ai_chat_sheet_problem(jsonb)', 'EXECUTE') as helper_closed,
--        exists (select 1 from pg_constraint where conname = 'ai_chat_sessions_brief_0249') as sheets_counted_apart;
