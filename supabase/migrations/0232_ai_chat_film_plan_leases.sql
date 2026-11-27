-- 0232_ai_chat_film_plan_leases.sql — one storyboard plan per FILM, and its turns reserved when it begins (the film editor's "Write
-- the storyboard with AI", /api/brain/film, and the chat's `choose` on a short outline, /api/brain/turn; docs/studio/NIGHTSHIFT_AI.md
-- "Writing a project's storyboard").
--
-- *** NOT APPLIED LIVE. *** Number 0232, assigned by the coordinator (0230 and 0231 are other branches').
--
-- EVIDENCE (Breach on #953, pinned in tests/security/test_sec_brain_film_breach.py and command-center/tests/security-brain-film-breach
-- .test.ts):
--   * BR-FILM-01/02: 0211's lease is per CONVERSATION. Two conversations planning the same film (one person's two first presses that
--     raced, two editors of one workspace, or the chat's draft and the film editor's button on that draft) each hold a running lease
--     at once: both plans take every turn, and only one save_film can win.
--   * BR-FILM-03: the route's "begun only when today's turns cover the worst case" is a READ of ai_chat_quota. It reserves nothing, so
--     two plans in flight (two projects, two tabs, two editors) both pass it at the cap, and the second stops halfway: turns spent, no
--     storyboard.
--
-- CHANGE (additive):
--   * ai_chat_film_plan_leases: one row per film. Which conversation and which 0211 attempt is planning it, how many turns it reserved,
--     how many it took, what was released when it ended, running | failed | done. RLS on, an author-only SELECT policy as a second wall,
--     no grant to any API role.
--   * ai_chat_film_plan_begin(p_session, p_film, p_at_most): NEW. Called right after 0211's ai_chat_plan_begin, by both routes, before
--     the plan's first turn. The caller must be the conversation's author and an editor with a seat (0215's is_org_spender); the film
--     one of the conversation's own workspace (any of its channels: save_film may move it), and one a plan could write: editable, not
--     archived, no scene yet (`film_not_plannable` otherwise, the rule lib/server/brain/film-plan.ts filmRefusal applies); 0211's lease
--     of that conversation running. While another plan holds the film: `plan_running` (detail: when it ends), never a second plan.
--     Then, under the SAME workspace lock ai_chat_reserve_turn takes ('ai_chat:' || org) and then the person's ('ai_chat_user:' ||
--     user), p_at_most turns are reserved against the workspace's daily cap (or the Free trial) and against the person's own daily
--     limit. The lease expires with 0211's (the same 320 s, the same expires_at).
--   * p_at_most is bounded by the FILM, not the caller (Breach BR-LEASE-03: a direct RPC asked the whole day's cap for a 60 s film and
--     held every colleague off without taking one turn): ai_chat_film_plan_max_turns(target_seconds) = least(15, 1 + 2 x ceil(t / 24)).
--     The routes ask their own worst case: the film route 1 + 2 x windows (the outline call included), the chat's choose 2 x windows
--     (its outline is the proposal already paid for). Sentinel ran both planners over every length and clip shape: worst 15 and 12, so
--     the bound covers both and is tight at 90 s (9); command-center/tests/brain-film-lease-bound.test.ts keeps the two in step. A
--     number over the bound is refused (`invalid_params`), never cut down.
--   * Refusals of the begin, in the order ai_chat_reserve_turn refuses a turn, all on CHARGED numbers: no cap row and no trial left, or
--     a cap of 0 -> chat_plan_required; charged >= cap -> chat_daily_cap (used=N limit=M); everything left held by other plans ->
--     chat_reserved (used=N reserved=R limit=M until=T); else short of p_at_most -> plan_over_cap (left=N needed=M
--     scope=workspace|trial|person). Nothing is written by a refusal.
--   * Three bodies replaced, each the earlier one plus marked 0232 lines (md5 guard below):
--       ai_chat_reserve_turn (0226)  a turn of a conversation whose film plan is running is taken out of its reservation first, then
--                                    the caps are read as before on the charged count; a turn that finds the rest held is refused
--                                    `chat_reserved` (used, reserved, limit, until); the person's limit also counts their holds;
--                                    the answer adds `reserved`;
--       ai_chat_plan_end (0226)      the film lease of the attempt it ends ends with it, and its unused turns come back;
--       ai_chat_quota (0199)         adds `reserved` and `reserved_until` next to `used`, which stays the charged count.
--     ai_chat_used and ai_chat_trial_left keep 0199's bodies: "used" means charged, everywhere (Sentinel on 0232: a hold reported as
--     used read as a day's turns gone, and its remedy as "wait 24 hours").
--
-- WHY A NEW FUNCTION AND NOT A NEW ARGUMENT ON ai_chat_plan_begin. A new argument is a new signature: PostgREST would see two
--   overloads of plan_begin (or the old one dropped under a running app), and 0226's guarded body would be replaced in full. The new
--   function rides on 0211's lease instead (same conversation, same attempt, same expiry), so 0211's own plan_end can close both with
--   one added statement, and plan_begin, plan_session and plan_state stay as 0226 and 0211 left them (guarded as dependencies).
--
-- HOW A RESERVATION IS COUNTED. outstanding = greatest(0, reserved - taken), for a lease that is running AND unexpired AND whose author
--   is still an editor or above of the workspace (or the workspace is the exempt one): a member removed or demoted mid-plan holds
--   nothing (Breach BR-LEASE-02: nobody could end their lease, and it blocked the workspace for its 320 s). ai_chat_reserved(org) adds
--   those up; ai_chat_reserved_by(user) adds up a person's own. A plan's turn first adds 1 to taken (outstanding - 1), then its call
--   is written (charged + 1): charged + held does not move, and a forgiven outcome (not_sent, refused, ...) leaves it 1 lower. Nothing
--   is counted twice, and nothing goes below zero (greatest(0, ...) per lease).
-- HOW IT IS RELEASED. At ai_chat_plan_end (done or failed): released = what was not taken. At expiry, at once: an expired lease is
--   simply no longer counted (a crashed server's plan gives its unused turns back the second its 320 s end, without anyone running
--   anything). The sweep, which mirrors 0211's, then tidies: the next ai_chat_film_plan_begin in the workspace marks every expired
--   running film lease failed / expired with what it released, and finishes that plan's own still-pending calls (made by its author in
--   its conversation inside its window) as vendor_error with unknown tokens, the way 0211's takeover does: the vendor may have been
--   paid, so they stay counted. The platform's global daily limit is not reserved: it is the owner's last brake and is never promised.
--
-- LOCKS. Everyone takes, in this order: the workspace's advisory lock, the conversation's row, 0211's lease, the film lease, calls, and
--   the person's advisory lock last of the locks a begin takes. ai_chat_film_plan_begin: workspace, conversation (ai_chat_plan_session),
--   0211's lease, film leases (another's SKIP LOCKED), calls (SKIP LOCKED), then the person. ai_chat_reserve_turn: workspace, then
--   (0232) the conversation's row, then its film lease, then the person and the platform as before. ai_chat_plan_end: conversation,
--   0211's lease, film lease. 0199's ai_chat_finish_turn takes a call and then the conversation, and no path here waits on a call while
--   holding a conversation (SKIP LOCKED), as in 0211.
--
-- KNOWN, NOT CLOSED HERE (Sentinel on 0232; docs/studio/NIGHTSHIFT_AI.md):
--   * F: a plan turn the cap forgives (vendor_refused, refused, not_sent) comes out of the plan's reservation and back to the
--     workspace's pool, not to the plan: the plan can then find one turn fewer than it reserved. Future fix: ai_chat_finish_turn gives a
--     forgiven turn back to the lease it was taken from (test to add: test_a_forgiven_plan_turn_goes_back_to_its_own_plan).
--   * G: the chat's choose saving a storyboard already stored in its conversation (no turn) takes no film lease. It spends nothing;
--     future: a non-reserving hold of the film so the film editor's button waits for it too.
--   * I: an expired lease that the sweep skipped (SKIP LOCKED: another transaction held it) and that a new begin of the same film then
--     writes over is not marked expired and its pending calls are not closed; they stay pending (counted) until 0211's own takeover of
--     that conversation. Future fix: close them in the overwrite as well, with a two-connection lab test.
--   * K: no change.
--   * A person's holds across several films are bounded only by their own daily limit (each film's at most 15). Future: a per-person,
--     per-workspace sum of at most 15.
--
-- WHAT THE APP DOES (command-center/lib/server/brain/film-plan.ts, app/api/brain/turn/route.ts): both call ai_chat_film_plan_begin
--   with the plan's at_most (the film route 1 + 2 x windows incl. the outline call, the chat's choose 2 x windows) after 0211's begin
--   and before the first turn, and answer each refusal above. Before this file is applied the function does not exist (PGRST202 /
--   42883): the routes keep #953's behaviour unchanged (the route-level yield per person, the read-only cap check) and claim no
--   reservation.
--
-- GUARD (md5 of the body, whitespace runs read as one space; this file refuses any other body):
--   ai_chat_reserve_turn   e105fa9373fac86e9a36cf4a945a21b4 (0226) -> 51ecb8f5cd0226a0f89a3aa7571c605f
--   ai_chat_plan_end       4df6a1c4054bcacedf971a0b79f997d6 (0226) -> 71c2feb9b1b12295bef680822ab80c91
--   ai_chat_quota          7c17f9749127303a53d039bbdc15e8c2 (0199) -> 09b69b04c1073ad8e79bbc8107e92f81
--   and, not replaced but relied on: ai_chat_plan_session 75c679292759d14dc51ba865f32d6f8e (0226), ai_chat_plan_begin
--   2002d73eb60ad129f7318416ba560da6 (0226), ai_chat_plan_state c2aede96712ab6d28dc6d29c060eb5f2 (0211; 0226 left it as it was).
--   A body known to be the one 0226 replaces (0211's plan_session 872b3f92, plan_begin bcb630a5, plan_end 5b94856b; 0199's
--   ai_chat_reserve_turn 7c89309b) is refused with "apply 0226 first"; any other body as unknown ("changed by hand? compare with 0226
--   before applying").
--
-- NO BACKSLASH in this file or its rollback (an apply tool can rewrite escape sequences). The md5 fold is
--   regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g'). ai_chat_reserve_turn's body holds two E'' character lists: it is written as an
--   EXECUTE whose backslashes are a token that replace() turns back into chr(92), as 0226 does, so its source is 0226's plus the hunks.
--
-- NOT CHANGED: every cap value, price, hold, credit, film and publish rule (CLAUDE.md rules 2 and 3: a lease spends nothing, starts
--   nothing and publishes nothing). 0211's per-conversation lease stays exactly as it is.
--
-- REPLAY. This file replays onto itself (its guard takes its own bodies). Re-running 0199 or 0211 applies silently and puts the older
--   bodies back (apply 0226 and then this file again after); re-running 0226 FAILS LOUDLY (its guard refuses this file's
--   ai_chat_reserve_turn and ai_chat_plan_end): take this file out first with its rollback, then 0226, then this file again.
--
-- REQUIRES 0199, 0211, 0215 (is_org_spender), 0226, 0166 (films, film_is_editable, film_scenes). Undo:
--   docs/sql/rollback_0232_ai_chat_film_plan_leases.sql (owner-applied): the three earlier bodies back verbatim, the new function,
--   helpers and table dropped.
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).

set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regprocedure('public.is_org_spender(uuid, text)') is null then
    raise exception '0232 asks 0215''s is_org_spender: apply 0215_film_archive_resume.sql, then 0226 first';
  end if;
  if to_regclass('public.ai_chat_plan_leases') is null or to_regclass('public.films') is null
     or to_regprocedure('public.film_is_editable(text)') is null then
    raise exception '0232 needs 0211 (ai_chat_plan_leases) and 0166 (films, film_is_editable): apply them, then 0226 first';
  end if;
  -- The bodies this file replaces (the earlier one, or this file's own on a replay) and the ones it relies on (exactly as 0226 left them).
  for r in select * from (values
      ('public.ai_chat_reserve_turn(uuid, text, boolean, text)', 'e105fa9373fac86e9a36cf4a945a21b4', '51ecb8f5cd0226a0f89a3aa7571c605f'),
      ('public.ai_chat_plan_end(uuid, integer, text, text)', '4df6a1c4054bcacedf971a0b79f997d6', '71c2feb9b1b12295bef680822ab80c91'),
      ('public.ai_chat_quota(uuid)', '7c17f9749127303a53d039bbdc15e8c2', '09b69b04c1073ad8e79bbc8107e92f81'),
      ('public.ai_chat_plan_session(uuid)', '75c679292759d14dc51ba865f32d6f8e', '75c679292759d14dc51ba865f32d6f8e'),
      ('public.ai_chat_plan_begin(uuid, bigint, integer)', '2002d73eb60ad129f7318416ba560da6', '2002d73eb60ad129f7318416ba560da6'),
      ('public.ai_chat_plan_state(uuid)', 'c2aede96712ab6d28dc6d29c060eb5f2', 'c2aede96712ab6d28dc6d29c060eb5f2')) v(sig, was, now_) loop
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null then
      raise exception '0232 found no % : apply 0199, 0211 and 0226 first', r.sig;
    end if;
    if h = any (array['872b3f926f9dcf658b8a8efc097397f5', 'bcb630a57a5be419f80e5a9e2b9ce588', '5b94856b084a3941a39eb825baa8ed5e',
                      '7c89309bd1e2c15109d3824cc1104df8']) then
      raise exception '0232 found % with the body 0226 replaces (md5 %): apply 0226 first (0226_org_spender_everywhere.sql), then this file', r.sig, h;
    end if;
    if h <> all (array[r.was, r.now_]) then
      raise exception '0232 found % with an unknown body (md5 %): changed by hand? compare with 0226 before applying', r.sig, h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- The film lease
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.ai_chat_film_plan_leases (
  -- One row per film, written over by each new plan of it (as 0211's row per conversation is).
  film_id      uuid primary key references public.films (id) on delete cascade,
  org_id       uuid not null references public.organizations (id) on delete cascade,
  session_id   uuid not null references public.ai_chat_sessions (id) on delete cascade,
  created_by   uuid not null,
  -- The 0211 attempt of session_id this plan runs as: ai_chat_plan_end ends the film lease of exactly that attempt.
  attempt      integer not null check (attempt >= 1),
  -- What the plan may take (at most ai_chat_film_plan_max_turns of the film, never more than 15), what it took, and what came back.
  reserved     integer not null check (reserved between 1 and 15),
  taken        integer not null default 0 check (taken >= 0),
  released     integer check (released is null or released >= 0),
  state        text not null check (state in ('running', 'failed', 'done')),
  -- A short machine word (plan_end's reason, "expired", "superseded"), never text a person or a model wrote.
  reason       text check (reason is null or reason ~ '^[a-z][a-z0-9_]{0,39}$'),
  started_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  finished_at  timestamptz
);
-- One running film plan per conversation (0211 already allows one running plan per conversation; this keeps the film side in step).
create unique index if not exists ai_chat_film_plan_leases_one_per_session
  on public.ai_chat_film_plan_leases (session_id) where state = 'running';
-- Full indexes on the two cascading foreign keys (a conversation's or a workspace's delete reaches the leases without a scan), and
-- what every cap reads: the running leases of a workspace (org_id), and of a person.
create index if not exists ai_chat_film_plan_leases_session on public.ai_chat_film_plan_leases (session_id);
create index if not exists ai_chat_film_plan_leases_org on public.ai_chat_film_plan_leases (org_id);
create index if not exists ai_chat_film_plan_leases_user_running
  on public.ai_chat_film_plan_leases (created_by) where state = 'running';

alter table public.ai_chat_film_plan_leases enable row level security;
revoke all on table public.ai_chat_film_plan_leases from public, anon, authenticated, service_role;
drop policy if exists ai_chat_film_plan_leases_author_read on public.ai_chat_film_plan_leases;
-- A second wall only: with no grant, no API role reads the table at all. Should a grant ever be added, it is the author's rows.
create policy ai_chat_film_plan_leases_author_read on public.ai_chat_film_plan_leases
  for select to authenticated using (created_by = (select auth.uid()));
comment on table public.ai_chat_film_plan_leases is
  'Migration 0232: one storyboard plan per film, with the turns it reserved at begin (reserved, taken, released). RLS on, an author-only SELECT policy, no grant: only ai_chat_film_plan_begin, ai_chat_reserve_turn and ai_chat_plan_end touch it.';

-- The most turns a plan of a film this long can need: the film route's worst case (1 outline call + 2 x windows, every window asked
-- again once) over chapters of at least 24 s, and never more than 15. Sentinel measured both planners against it for every length and
-- clip shape (worst 15 for the film route, 12 for the chat's choose; tight at 90 s); the vitest mirror filmLeaseMaxTurns must agree.
create or replace function public.ai_chat_film_plan_max_turns(p_seconds integer) returns integer
  language sql immutable security definer set search_path = public, pg_temp as $$
  select least(15, 1 + 2 * ceil(p_seconds / 24.0))::integer
$$;

-- Whether a lease still counts: running, unexpired, something left of it, and its author still an editor or above of the workspace
-- (0215's is_org_spender rule, asked of the lease's author: a seat, or the exempt workspace). A member removed or demoted mid-plan
-- cannot end their lease any more (session_not_found), so it must stop holding the workspace's turns at once (Breach BR-LEASE-02).
create or replace function public.ai_chat_reserved(p_org uuid) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(greatest(0, l.reserved - l.taken)), 0)::integer from public.ai_chat_film_plan_leases l
   where l.org_id = p_org and l.state = 'running' and l.expires_at > now()
     and (exists (select 1 from public.org_members m
                   where m.org_id = l.org_id and m.user_id = l.created_by
                     and public.app_role_rank(m.role) >= public.app_role_rank('editor'))
          or public.credits_exempt(l.org_id))
$$;

-- When the last of the workspace's counted holds ends (null: none): what a refusal for a held cap says to wait for.
create or replace function public.ai_chat_reserved_until(p_org uuid) returns timestamptz
  language sql stable security definer set search_path = public, pg_temp as $$
  select max(l.expires_at) from public.ai_chat_film_plan_leases l
   where l.org_id = p_org and l.state = 'running' and l.expires_at > now() and l.reserved > l.taken
     and (exists (select 1 from public.org_members m
                   where m.org_id = l.org_id and m.user_id = l.created_by
                     and public.app_role_rank(m.role) >= public.app_role_rank('editor'))
          or public.credits_exempt(l.org_id))
$$;

-- A person's own running holds, across workspaces, against their own daily limit. Not filtered by membership: it is their limit.
create or replace function public.ai_chat_reserved_by(p_user uuid) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(greatest(0, l.reserved - l.taken)), 0)::integer from public.ai_chat_film_plan_leases l
   where l.created_by = p_user and l.state = 'running' and l.expires_at > now()
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- ai_chat_quota (0199's body, one marked 0232 hunk)
-- ───────────────────────────────────────────────────────────────────────────

-- What the panel shows: the plan's cap, what is used, the longest message. A member's own workspace only. `limit` null = no Brain on
-- this plan (the panel shows the upgrade), never 0 read as "used up".
create or replace function public.ai_chat_quota(p_org uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or p_org is null or not public.is_org_member(p_org, 'viewer') then
    perform public.creative_refuse('forbidden', 'not a member of this workspace', 'NS403');
  end if;
  -- The model is the owner's and its id names the vendor: a member gets only a reference the server maps to its own list
  -- (lib/server/brain/session modelFromRef), never the id itself. This keeps the id out of every answer and screen; it is not a secret
  -- against a member who hashes the few public candidate ids: the web server reads as the member (anon key only, CLAUDE.md rule 3),
  -- so nothing it can read is hidden from them (Lens and Breach on 0199).
  return jsonb_build_object('used', public.ai_chat_used(p_org), 'limit', public.ai_chat_cap(p_org),
                            -- 0232: what running film plans hold besides the charged turns, and when the last of them ends (null:
                            -- none). Never folded into used: a hold is not a turn taken, and it comes back within minutes.
                            'reserved', public.ai_chat_reserved(p_org),
                            'reserved_until', to_char(public.ai_chat_reserved_until(p_org) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                            'trial_left', case when public.ai_chat_cap(p_org) is null then public.ai_chat_trial_left(p_org) end,
                            'max_input_chars', (select max_input_chars from public.ai_chat_settings where id),
                            'model_ref', (select md5('nightshift-chat-model:' || model) from public.ai_chat_settings where id));
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- ai_chat_reserve_turn (0226's body, marked 0232 hunks)
-- ───────────────────────────────────────────────────────────────────────────

-- This body holds a backslash. A backslash can be rewritten on its way through an apply tool, so this file holds none: the statement
-- is run through EXECUTE, each backslash spelled <0232:backslash> and turned back into chr(92). Its source is 0226's plus the hunks.
do $bs0232$
begin
  execute replace($fn0232$create or replace function public.ai_chat_reserve_turn(p_session uuid, p_text text, p_retry boolean default false,
                                                      p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
  v_max integer;
  v_cap integer;
  v_used integer;
  v_call uuid;
  -- 0232: what the workspace's running film plans still hold (ai_chat_reserved), read after this turn's own take below.
  v_res integer;
  -- Every whitespace a person can type, not only spaces (Breach: a message of tabs and newlines took a turn), and the invisible ones
  -- (zero-width, word joiner, BOM) removed first, so a message of NBSPs or zero-width spaces is empty (Lens on 0199).
  -- Breach on 0199 added the rest that render as nothing: soft hyphen, joiners, bidi marks, variation selectors, tags, fillers.
  v_text text := btrim(regexp_replace(coalesce(p_text, ''),
                         E'[<0232:backslash>u00AD<0232:backslash>u034F<0232:backslash>u180E<0232:backslash>u200B-<0232:backslash>u200F<0232:backslash>u202A-<0232:backslash>u202E<0232:backslash>u2060-<0232:backslash>u2064<0232:backslash>uFEFF<0232:backslash>uFE00-<0232:backslash>uFE0F<0232:backslash>U000E0000-<0232:backslash>U000E007F]', '', 'g'),
                       E' <0232:backslash>t<0232:backslash>r<0232:backslash>n<0232:backslash>f<0232:backslash>u0085<0232:backslash>u00A0<0232:backslash>u115F<0232:backslash>u1160<0232:backslash>u1680<0232:backslash>u2000<0232:backslash>u2001<0232:backslash>u2002<0232:backslash>u2003<0232:backslash>u2004<0232:backslash>u2005<0232:backslash>u2006<0232:backslash>u2007<0232:backslash>u2008<0232:backslash>u2009<0232:backslash>u200A<0232:backslash>u2028<0232:backslash>u2029<0232:backslash>u202F<0232:backslash>u205F<0232:backslash>u2800<0232:backslash>u3000<0232:backslash>u3164<0232:backslash>uFFA0' || chr(11));
  st public.ai_chat_settings;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user;
  if not found or not public.is_org_member(s.org_id, 'editor') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
  end if;
  -- 0226 (the owner's decision, 22 Nov; 0215's is_org_spender): spending an organization's credits takes a seat in it. 0043's
  -- accessible_org_ids makes a platform owner or admin an admin of every organization; that stays read-only support access. In the
  -- exempt organization the credits are the platform's own, so its platform owner or admin may, as before. Before the turn is checked, the organization's lock is taken, or the cap or the trial is counted.
  if not public.is_org_spender(s.org_id, 'editor') then
    perform public.creative_refuse('not_a_member', 'you are not an owner, admin or editor member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  if s.step = 'created' then
    perform public.creative_refuse('session_closed', 'this plan was handed off; start a new conversation', 'NS409');
  end if;
  if p_request_id is not null and p_request_id !~ '^[A-Za-z0-9_-]{8,64}$' then
    perform public.creative_refuse('invalid_params', 'a request id is 8 to 64 letters, digits, - or _');
  end if;
  select * into st from public.ai_chat_settings where id;
  v_max := st.max_input_chars;
  if coalesce(p_retry, false) then
    if (select m.role from public.ai_chat_messages m where m.session_id = s.id order by m.id desc limit 1) is distinct from 'user' then
      perform public.creative_refuse('nothing_to_retry', 'the last message was answered', 'NS409');
    end if;
  elsif v_text = '' then
    perform public.creative_refuse('invalid_params', 'say something first');
  end if;
  if char_length(v_text) > coalesce(v_max, 2000) then
    perform public.creative_refuse('message_too_long', format('at most %s characters', coalesce(v_max, 2000)));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_chat:' || s.org_id::text, 0));
  -- The same press again (a network retry): answered as a duplicate, with nothing written (under the lock: two copies racing find
  -- each other, and the unique index is the last word).
  -- The refusal names the conversation the first copy went to: a retried Start finds its own (Lens on 0199).
  if p_request_id is not null and exists (select 1 from public.ai_chat_calls c where c.user_id = v_user and c.request_id = p_request_id) then
    perform public.creative_refuse('duplicate_request',
      coalesce((select c.session_id::text from public.ai_chat_calls c where c.user_id = v_user and c.request_id = p_request_id), ''), 'NS409');
  end if;
  -- 0232 (a film plan reserves its turns at begin, ai_chat_film_plan_begin): a turn of a conversation whose film plan is running is
  -- taken out of that plan's reservation BEFORE the caps below are read, so the turn is counted once: one fewer reserved now, one
  -- more charged once its call is written below. Past its reservation (taken above reserved) it is counted on top, as any other.
  -- The conversation's row first: ai_chat_plan_end locks the conversation and then the film lease, so this takes them in the same
  -- order and the two cannot deadlock. A refusal below rolls the take back with everything else.
  perform 1 from public.ai_chat_sessions x where x.id = s.id for update;
  update public.ai_chat_film_plan_leases fl set taken = fl.taken + 1
   where fl.session_id = s.id and fl.created_by = v_user and fl.state = 'running' and fl.expires_at > now();
  v_cap := public.ai_chat_cap(s.org_id);
  v_used := public.ai_chat_used(s.org_id);
  if v_cap is null then
    -- The lifetime trial, counted under the same workspace lock as the cap (two tabs cannot both take the last one).
    if public.ai_chat_trial_left(s.org_id) = 0 then
      perform public.creative_refuse('chat_plan_required', 'Nightshift AI is on the Plus, Pro and Business plans', 'NS402');
    end if;
  elsif v_cap = 0 then
    perform public.creative_refuse('chat_plan_required', 'Nightshift AI is on the Plus, Pro and Business plans', 'NS402');
  elsif v_used >= v_cap then
    perform public.creative_refuse('chat_daily_cap', format('used=%s limit=%s', v_used, v_cap), 'NS429');
  end if;
  -- 0232: what is left after the charged turns may be held by running film plans (their reservations, ai_chat_reserved: this
  -- turn's own plan already took its turn out above). "used" stays the charged count; a turn that only finds the rest held is told
  -- so, with when the holds end, never "the daily cap is reached" (Sentinel on 0232: the remedy is to wait minutes, not a day).
  v_res := public.ai_chat_reserved(s.org_id);
  if v_res > 0 and ((v_cap is null and public.ai_chat_trial_left(s.org_id) - v_res <= 0)
                    or (v_cap > 0 and v_used + v_res >= v_cap)) then
    perform public.creative_refuse('chat_reserved', format('used=%s reserved=%s limit=%s until=%s', v_used, v_res, coalesce(v_cap::text, ''),
      coalesce(to_char(public.ai_chat_reserved_until(s.org_id) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')), 'NS429');
  end if;
  -- The person's own turns everywhere, and the platform's: under their own locks, after the workspace's, always in this order.
  perform pg_advisory_xact_lock(hashtextextended('ai_chat_user:' || v_user::text, 0));
  -- Every outcome counts here, not_sent too: a member can reserve and finish their own calls by hand, and each writes rows
  -- (Lens and Breach on 0199: not_sent passed every cap). The plan cap is the one that forgives what was not their doing.
  if (select count(*) from public.ai_chat_calls c where c.user_id = v_user and c.created_at > now() - interval '24 hours')
     >= st.per_user_daily then
    perform public.creative_refuse('chat_daily_cap', 'your own daily limit across workspaces is reached', 'NS429');
  end if;
  -- 0232: the person's running film plans hold their turns too (reserved at begin against this same limit), so their other turns
  -- see them as used. This turn's own take is already out of its reservation (above).
  if (select count(*) from public.ai_chat_calls c where c.user_id = v_user and c.created_at > now() - interval '24 hours')
     + public.ai_chat_reserved_by(v_user) >= st.per_user_daily then
    perform public.creative_refuse('chat_daily_cap', 'your own daily limit across workspaces is reached', 'NS429');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_chat_global', 0));
  if (select count(*) from public.ai_chat_calls c where c.created_at > now() - interval '24 hours') >= st.global_daily then
    perform public.creative_refuse('chat_unavailable', 'Nightshift AI has reached its daily limit; try again later', 'NS503');
  end if;
  if not coalesce(p_retry, false) then
    insert into public.ai_chat_messages (session_id, created_by, role, content) values (s.id, v_user, 'user', v_text);
  end if;
  insert into public.ai_chat_calls (org_id, user_id, session_id, model, request_id)
  values (s.org_id, v_user, s.id, (select model from public.ai_chat_settings where id), p_request_id) returning id into v_call;
  update public.ai_chat_sessions set updated_at = now() where id = s.id;
  return jsonb_build_object('call_id', v_call, 'used', v_used + 1, 'limit', v_cap,
                            -- 0232: what running film plans hold besides (the panel shows it as held, never as used).
                            'reserved', v_res,
                            'trial_left', case when v_cap is null then public.ai_chat_trial_left(s.org_id) end);
end
$$$fn0232$, '<0232:backslash>', chr(92));
end $bs0232$;

-- ───────────────────────────────────────────────────────────────────────────
-- ai_chat_plan_end (0226's body, one marked 0232 hunk)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.ai_chat_plan_end(p_session uuid, p_attempt integer, p_state text, p_reason text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.ai_chat_sessions;
  l public.ai_chat_plan_leases;
begin
  s := public.ai_chat_plan_session(p_session);
  -- 0226 (the owner's decision, 22 Nov; 0215's is_org_spender): spending an organization's credits takes a seat in it. 0043's
  -- accessible_org_ids makes a platform owner or admin an admin of every organization; that stays read-only support access. In the
  -- exempt organization the credits are the platform's own, so its platform owner or admin may, as before. ai_chat_plan_session above asks it already (its own hunk); asked again here, where the lease is written, so this
  -- function refuses on its own if that helper ever changes. Before the lease is read or written.
  if not public.is_org_spender(s.org_id, 'editor') then
    perform public.creative_refuse('not_a_member', 'you are not an owner, admin or editor member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  if p_state is null or p_state not in ('failed', 'done') then
    perform public.creative_refuse('invalid_params', 'a plan ends failed or done');
  end if;
  if p_reason is not null and p_reason !~ '^[a-z][a-z0-9_]{0,39}$' then
    perform public.creative_refuse('invalid_params', 'a reason is a short machine word');
  end if;
  select * into l from public.ai_chat_plan_leases where session_id = s.id for update;
  if not found or l.attempt is distinct from p_attempt or l.state <> 'running' then
    perform public.creative_refuse('plan_not_current', 'that plan is no longer the running one', 'NS409');
  end if;
  update public.ai_chat_plan_leases set state = p_state, reason = p_reason, finished_at = now() where session_id = s.id;
  -- 0232: the film plan this attempt holds, if any (ai_chat_film_plan_begin rides on this lease: same conversation, same attempt),
  -- ends with it, and what it reserved and did not take comes back to the workspace and the person now, not at its expiry.
  update public.ai_chat_film_plan_leases fl
     set state = p_state, reason = p_reason, finished_at = now(), released = greatest(0, fl.reserved - fl.taken)
   where fl.session_id = s.id and fl.attempt = l.attempt and fl.state = 'running';
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- ai_chat_film_plan_begin (new)
-- ───────────────────────────────────────────────────────────────────────────

-- Begin a plan of one film: the conversation's 0211 lease must be running (this rides on it), no other plan may hold the film, and the
-- plan's worst case must fit today's turns. Returns the turns reserved, what is left after them, which limit is the tighter one, and
-- when the lease ends. Asked again by the same attempt for the same film, it answers the reservation it already holds (a retried
-- request reserves nothing twice, whatever number it asks).
create or replace function public.ai_chat_film_plan_begin(p_session uuid, p_film uuid, p_at_most integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
  pl public.ai_chat_plan_leases;
  fl public.ai_chat_film_plan_leases;
  f public.films;
  st public.ai_chat_settings;
  v_cap integer;
  v_used integer;
  v_res integer;
  v_trial integer;
  v_left integer;
  v_scope text;
  v_mine integer;
  v_bound integer;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  -- Read without a lock first: the workspace's lock is taken before the conversation's row (ai_chat_reserve_turn's order).
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user;
  if not found or not public.is_org_member(s.org_id, 'editor') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
  end if;
  -- 0226's rule (0215's is_org_spender): the workspace's turns are spent by a seat in it; a seatless platform owner or admin reads only.
  -- Before anything is locked, counted or written.
  if not public.is_org_spender(s.org_id, 'editor') then
    perform public.creative_refuse('not_a_member', 'you are not an owner, admin or editor member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  if p_film is null or p_at_most is null or p_at_most < 1 then
    perform public.creative_refuse('invalid_params', 'a film and the most turns its plan can take');
  end if;
  -- The film is of the conversation's own workspace; another workspace's film reads as missing, as film_json answers. Not pinned to
  -- the conversation's channel: save_film may move a film to another channel of the same workspace after its conversation was opened
  -- (0166), and that project would then never be plannable again from its own conversation.
  select * into f from public.films x where x.id = p_film and x.org_id = s.org_id;
  if not found then
    perform public.creative_refuse('film_not_found', 'that film is not in this conversation''s workspace', 'NS404');
  end if;
  -- A film a plan could write into, the rule both routes apply before any turn (film-plan.ts filmRefusal, the chat's fresh draft):
  -- editable, not archived, no scene yet. Anything else would hold turns for a storyboard nothing will save (Breach BR-LEASE-01).
  if not (public.film_is_editable(f.status) and f.archived_at is null
          and not exists (select 1 from public.film_scenes x where x.film_id = p_film)) then
    perform public.creative_refuse('film_not_plannable', 'a storyboard is written only into an editable film with no scenes', 'NS409');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_chat:' || s.org_id::text, 0));
  -- The conversation's row (author, editor, seat, not handed off: 0226's helper), then its 0211 lease.
  s := public.ai_chat_plan_session(p_session);
  select * into pl from public.ai_chat_plan_leases where session_id = s.id for update;
  if not found or pl.state <> 'running' or pl.expires_at <= now() or pl.created_by <> v_user then
    perform public.creative_refuse('plan_not_current', 'begin this conversation''s plan first', 'NS409');
  end if;

  -- The sweep (0211's, mirrored): every film plan of this workspace whose time ran out is failed / expired with what it gave back,
  -- and its own calls still pending (its author's, in its conversation, inside its window) are failures with unknown tokens, never
  -- "ok" and never "not_sent": the vendor may have been paid. Its turns were already back (an expired lease is not counted); this
  -- records it. Another transaction's lease or call is left alone (SKIP LOCKED): this one never waits on them holding the workspace.
  with gone as (
    update public.ai_chat_film_plan_leases x
       set state = 'failed', reason = 'expired', finished_at = now(), released = greatest(0, x.reserved - x.taken)
     where x.film_id in (select y.film_id from public.ai_chat_film_plan_leases y
                          where y.org_id = s.org_id and y.state = 'running' and y.expires_at <= now()
                          for update skip locked)
    returning x.session_id, x.created_by, x.started_at, x.expires_at
  )
  update public.ai_chat_calls c
     set outcome = 'vendor_error', tokens_in = null, tokens_out = null, finished_at = now()
   where c.id in (select k.id from public.ai_chat_calls k join gone g on k.session_id = g.session_id and k.user_id = g.created_by
                   where k.outcome = 'pending' and k.created_at >= g.started_at and k.created_at <= g.expires_at
                   for update of k skip locked);

  -- A running film lease of this conversation from an earlier attempt cannot outlive that attempt (plan_end ends both; a takeover of
  -- an expired attempt is swept above). Closed if one is found anyway, so the one-per-conversation rule can never block a new plan.
  update public.ai_chat_film_plan_leases x
     set state = 'failed', reason = 'superseded', finished_at = now(), released = greatest(0, x.reserved - x.taken)
   where x.session_id = s.id and x.state = 'running' and x.attempt <> pl.attempt;
  -- This attempt already planning another film: one plan at a time per conversation, as 0211 says.
  select * into fl from public.ai_chat_film_plan_leases x
   where x.session_id = s.id and x.state = 'running' and x.film_id <> p_film and x.expires_at > now();
  if found then
    perform public.creative_refuse('plan_running', to_char(fl.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'NS409');
  end if;

  select * into fl from public.ai_chat_film_plan_leases where film_id = p_film for update;
  if found and fl.state = 'running' and fl.expires_at > now() then
    if fl.session_id = s.id and fl.attempt = pl.attempt then
      -- The same plan asking again (a retried request): the reservation it holds, nothing reserved twice.
      return jsonb_build_object('film_id', p_film, 'attempt', fl.attempt, 'reserved', fl.reserved, 'taken', fl.taken, 'left', null,
                                'scope', null, 'expires_at', to_char(fl.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    end if;
    -- Another plan of this film is running (another conversation of this person, another editor, or the chat's draft): the second
    -- press is told when it ends and takes nothing (Breach BR-FILM-01/02).
    perform public.creative_refuse('plan_running', to_char(fl.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'NS409');
  end if;

  -- No more than a plan of this film can need (Breach BR-LEASE-03): refused, never cut down, so a caller's mistake is said.
  v_bound := public.ai_chat_film_plan_max_turns(f.target_seconds);
  if p_at_most > v_bound then
    perform public.creative_refuse('invalid_params', format('at most %s turns for this film', v_bound));
  end if;

  -- The workspace, in ai_chat_reserve_turn's order and on its charged numbers, then what other plans hold.
  v_cap := public.ai_chat_cap(s.org_id);
  v_used := public.ai_chat_used(s.org_id);
  v_res := public.ai_chat_reserved(s.org_id);
  if v_cap is null then
    v_trial := public.ai_chat_trial_left(s.org_id);
    if v_trial = 0 then
      perform public.creative_refuse('chat_plan_required', 'Nightshift AI is on the Plus, Pro and Business plans', 'NS402');
    end if;
    v_left := v_trial - v_res;
    v_scope := 'trial';
  elsif v_cap = 0 then
    perform public.creative_refuse('chat_plan_required', 'Nightshift AI is on the Plus, Pro and Business plans', 'NS402');
  elsif v_used >= v_cap then
    perform public.creative_refuse('chat_daily_cap', format('used=%s limit=%s', v_used, v_cap), 'NS429');
  else
    v_left := v_cap - v_used - v_res;
    v_scope := 'workspace';
  end if;
  if v_left <= 0 then
    perform public.creative_refuse('chat_reserved', format('used=%s reserved=%s limit=%s until=%s', v_used, v_res, coalesce(v_cap::text, ''),
      coalesce(to_char(public.ai_chat_reserved_until(s.org_id) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')), 'NS429');
  end if;
  if v_left < p_at_most then
    perform public.creative_refuse('plan_over_cap', format('left=%s needed=%s scope=%s', v_left, p_at_most, v_scope), 'NS429');
  end if;
  -- The person's own daily limit across workspaces (0199's per_user_daily, every outcome counted), less what their running plans
  -- hold: under the person's lock, the last lock taken here, after the workspace's, as ai_chat_reserve_turn takes them.
  perform pg_advisory_xact_lock(hashtextextended('ai_chat_user:' || v_user::text, 0));
  select * into st from public.ai_chat_settings where id;
  v_mine := st.per_user_daily
            - (select count(*)::integer from public.ai_chat_calls c where c.user_id = v_user and c.created_at > now() - interval '24 hours')
            - public.ai_chat_reserved_by(v_user);
  if v_mine < p_at_most then
    perform public.creative_refuse('plan_over_cap', format('left=%s needed=%s scope=person', greatest(0, v_mine), p_at_most), 'NS429');
  end if;
  if v_mine < v_left then
    v_left := v_mine;
    v_scope := 'person';
  end if;

  -- Granted for exactly the 0211 lease's window, as its attempt.
  insert into public.ai_chat_film_plan_leases (film_id, org_id, session_id, created_by, attempt, reserved, taken, released, state,
                                               reason, started_at, expires_at, finished_at)
  values (p_film, s.org_id, s.id, v_user, pl.attempt, p_at_most, 0, null, 'running', null, now(), pl.expires_at, null)
  on conflict (film_id) do update
     set org_id = excluded.org_id, session_id = excluded.session_id, created_by = excluded.created_by, attempt = excluded.attempt,
         reserved = excluded.reserved, taken = 0, released = null, state = 'running', reason = null, started_at = excluded.started_at,
         expires_at = excluded.expires_at, finished_at = null;
  return jsonb_build_object('film_id', p_film, 'attempt', pl.attempt, 'reserved', p_at_most, 'taken', 0, 'left', v_left - p_at_most,
                            'scope', v_scope, 'expires_at', to_char(pl.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- Grants. The replaced bodies keep their earlier grants (create or replace keeps them); restated so a replay leaves the same state.
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.ai_chat_film_plan_max_turns(integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_reserved(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_reserved_until(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_reserved_by(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_quota(uuid) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_quota(uuid) to authenticated;
revoke all on function public.ai_chat_reserve_turn(uuid, text, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_reserve_turn(uuid, text, boolean, text) to authenticated;
revoke all on function public.ai_chat_plan_end(uuid, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_plan_end(uuid, integer, text, text) to authenticated;
revoke all on function public.ai_chat_film_plan_begin(uuid, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_film_plan_begin(uuid, uuid, integer) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
  h text;
  fn oid;
  ro text;
begin
  for r in select * from (values
      ('public.ai_chat_reserve_turn(uuid, text, boolean, text)', '51ecb8f5cd0226a0f89a3aa7571c605f'),
      ('public.ai_chat_plan_end(uuid, integer, text, text)', '71c2feb9b1b12295bef680822ab80c91'),
      ('public.ai_chat_quota(uuid)', '09b69b04c1073ad8e79bbc8107e92f81')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception '0232 end state: % does not hold this file''s body (md5 %)', r.sig, h;
    end if;
  end loop;
  -- The table's shape, as this file declares it (a table of the same name made by hand differently is not taken over in silence).
  if (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position)
        from information_schema.columns where table_schema = 'public' and table_name = 'ai_chat_film_plan_leases')
     is distinct from 'film_id:uuid:NO,org_id:uuid:NO,session_id:uuid:NO,created_by:uuid:NO,attempt:integer:NO,reserved:integer:NO,'
                      'taken:integer:NO,released:integer:YES,state:text:NO,reason:text:YES,started_at:timestamp with time zone:NO,'
                      'expires_at:timestamp with time zone:NO,finished_at:timestamp with time zone:YES' then
    raise exception '0232 end state: ai_chat_film_plan_leases does not have the columns this file declares';
  end if;
  if (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'ai_chat_film_plan_leases'
       and indexname in ('ai_chat_film_plan_leases_pkey', 'ai_chat_film_plan_leases_one_per_session', 'ai_chat_film_plan_leases_session',
                         'ai_chat_film_plan_leases_org', 'ai_chat_film_plan_leases_user_running')) <> 5 then
    raise exception '0232 end state: ai_chat_film_plan_leases is missing one of its indexes';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ai_chat_film_plan_leases'::regclass) then
    raise exception '0232 end state: ai_chat_film_plan_leases must have RLS on';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'ai_chat_film_plan_leases') <> 1
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_chat_film_plan_leases'
                     and policyname = 'ai_chat_film_plan_leases_author_read' and cmd = 'SELECT') then
    raise exception '0232 end state: ai_chat_film_plan_leases must have exactly its author-only SELECT policy';
  end if;
  foreach ro in array array['anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(ro, 'public.ai_chat_film_plan_leases', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception '0232 end state: ai_chat_film_plan_leases must not be reachable directly by %', ro;
    end if;
  end loop;
  for r in select * from (values
      ('public.ai_chat_film_plan_begin(uuid, uuid, integer)', true),
      ('public.ai_chat_reserve_turn(uuid, text, boolean, text)', true),
      ('public.ai_chat_plan_end(uuid, integer, text, text)', true),
      ('public.ai_chat_quota(uuid)', true),
      ('public.ai_chat_film_plan_max_turns(integer)', false),
      ('public.ai_chat_reserved(uuid)', false),
      ('public.ai_chat_reserved_until(uuid)', false),
      ('public.ai_chat_reserved_by(uuid)', false)) v(sig, member) loop
    fn := to_regprocedure(r.sig);
    if fn is null then
      raise exception '0232 end state: % does not exist', r.sig;
    end if;
    if has_function_privilege('authenticated', fn, 'EXECUTE') <> r.member
       or has_function_privilege('anon', fn, 'EXECUTE') or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0232 end state: % has the wrong grants', r.sig;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0232 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', r.sig;
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- Verify (read-only, run after applying; every row should read true)
-- select v.sig, md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) = v.want as is_0232s
--   from (values
--     ('public.ai_chat_reserve_turn(uuid, text, boolean, text)', '51ecb8f5cd0226a0f89a3aa7571c605f'),
--     ('public.ai_chat_plan_end(uuid, integer, text, text)', '71c2feb9b1b12295bef680822ab80c91'),
--     ('public.ai_chat_quota(uuid)', '09b69b04c1073ad8e79bbc8107e92f81')) v(sig, want)
--   join pg_proc p on p.oid = to_regprocedure(v.sig);
-- select to_regprocedure('public.ai_chat_film_plan_begin(uuid, uuid, integer)') is not null as begin_exists,
--        public.ai_chat_film_plan_max_turns(60) = 7 and public.ai_chat_film_plan_max_turns(90) = 9
--          and public.ai_chat_film_plan_max_turns(1200) = 15 as bound_pinned,
--        not has_table_privilege('authenticated', 'public.ai_chat_film_plan_leases', 'SELECT') as leases_closed,
--        (select relrowsecurity from pg_class where oid = 'public.ai_chat_film_plan_leases'::regclass) as rls_on;
