-- 0058_storyboard_edit.sql — change the plan before paying for it, and get a
-- storyboard back when its render failed.
--
-- Follows 0057 (storyboard review). Two things a person could not do there:
--
-- 1. EDIT a waiting storyboard: change a scene's narration and its visual
--    description, delete a scene, move scenes up or down, add a scene. The
--    edit rewrites BOTH the scene cards (what the screen shows) and the script
--    the render resumes from (storyboards.script, which main.py --resume
--    writes to output/<slug>/script.json through modules/storyboard_review.py)
--    in one statement, so what was approved is what renders. The length the
--    render is priced for (duration_s) is recomputed here from the edited
--    scenes; the Command Center prices the approval from that column exactly
--    as before (0057), and the approval names the revision the person saw.
--
-- 2. RE-OPEN an approved storyboard whose render failed: before this, a
--    render that failed every attempt left the storyboard 'approved' forever
--    (one ready/approved row per run, so the run could never be approved
--    again). reopen_storyboard() puts it back to 'ready' — only when no render
--    of that approval can still start or be running, and only once the
--    approval's credit hold has been released by the failure path that
--    already exists (queue_worker / credits_settle release a failed run's
--    hold; expire_credit_reservations releases one whose worker died on its
--    last attempt). A hold that is released can never be started again
--    (start_credit_reservation only starts an OPEN hold), so a re-opened
--    storyboard cannot render on the old approval's money, and approving it
--    again places a new hold under a new reference (approvals + 1).
--
-- WHAT IT ADDS
--   storyboards.revision        0 when the pipeline writes the row; +1 on every
--                               saved edit. A save names the revision it was
--                               made on and a stale one is refused, never
--                               merged or overwritten.
--   storyboards.opening_edited  true once an edit changed the first scene (its
--                               text, or which scene comes first). The render
--                               then records no hook A/B arm: the opening is
--                               the person's, not the experiment's
--                               (modules/hook_ab.py ignores an empty variant).
--   storyboards.edited_at / edited_by / reopened_at   who changed it, when.
--   save_storyboard_edits(id, revision, scenes)
--   approve_storyboard_at(id, revision, amount, backend)
--                               approve_storyboard (0057) for the revision the
--                               person saw — refused if it changed since.
--   reopen_storyboard(id)       approved -> ready after a failed render.
--   storyboard_reopen_check(id) read-only: may it be re-opened, and if not why.
--
-- THE EDIT (save_storyboard_edits)
--   p_scenes is the whole new list, in order, 1..60 entries. Each entry is
--   {"src": <the scene's number in the revision being edited> | null for a new
--   scene, "narration": text, "visual": text} and nothing else — no ids of any
--   kind, so no asset, file or row of anyone else's can be referenced. Each
--   existing scene appears at most once; one left out is deleted.
--   * narration: 1..4000 characters after whitespace is collapsed; no control
--     or text-direction characters; no cue markup ([SFX:…], [MUSIC:…],
--     [PAUSE:…], [VOICE:…]) — a person's words are spoken, never parsed into
--     sound effects or a voice switch.
--   * visual: 0..1000 characters, the same character rules; stored as the
--     scene's footage search terms (comma-separated, at most 8, each <= 120).
--   * at most 120,000 characters of text in all, and a payload of at most
--     256 KiB.
--   * an unchanged scene keeps its script section exactly (cue markup and
--     all); a scene whose narration changed gets the new text and a length the
--     DATABASE computes from it (150 words a minute, 1..600 s) — the browser
--     never says how long a scene is, so it cannot make a long render cheap.
--   * the total is 30..3600 s like every run: below 30 is priced as 30, above
--     3600 is refused (never priced shorter than it is).
--   * the result must pass 0057's storyboard_scenes_valid() and the table's
--     CHECKs, as for any writer.
--   Only while status = 'ready' (0057's guard also freezes content otherwise),
--   only by someone who may start runs on the channel (the approve rule), and
--   only on the current revision. A save that changes nothing changes nothing.
--
-- RE-OPENING (reopen_storyboard) — refused while any of these holds:
--   * the approval's hold is open (the render may still start or be running),
--     or captured (it rendered and was charged);
--   * queue: the render job is queued or running, was cancelled less than ten
--     minutes ago (the worker may still be stopping it), or succeeded without
--     a released hold (a render nobody paid for may have produced a video);
--   * Actions with no hold (the operator's own organization): nothing in the
--     database says how the run ended, so only after 24 hours (0020's bound
--     for a run that never settled).
--   Anyone who may start runs on the channel may re-open; it spends nothing.
--
-- ERRORS (SQLSTATE; message = the code command-center/lib/storyboardReview.ts maps)
--   42501 forbidden                 NS409 storyboard_not_ready
--   NS412 stale_revision (detail revision=<current>)
--   22023 scenes_invalid (detail: which scene and why) | storyboard_too_long |
--         storyboard_not_editable (cards and script out of step)
--   NS423 render_in_progress | render_finished | hold_not_released |
--         render_unverifiable
--
-- REQUIRES 0057. Additive and idempotent: guarded column adds, create-or-
-- replace functions, drop-then-create triggers. Nothing of 0057 is replaced:
-- approve_storyboard, discard_storyboard and storyboard_dispatch_failed are
-- unchanged and keep their grants (a Command Center that predates this
-- migration keeps working).

do $$
begin
  if to_regprocedure('public.approve_storyboard(uuid,numeric,text)') is null
     or to_regprocedure('public.storyboard_lock_for_runner(uuid)') is null then
    raise exception '0058 needs storyboards: apply 0057_storyboard_review.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Columns
-- ───────────────────────────────────────────────────────────────────────────

alter table public.storyboards add column if not exists revision integer not null default 0;
alter table public.storyboards add column if not exists opening_edited boolean not null default false;
alter table public.storyboards add column if not exists edited_at timestamptz;
alter table public.storyboards add column if not exists edited_by uuid;
alter table public.storyboards add column if not exists reopened_at timestamptz;

alter table public.storyboards drop constraint if exists storyboards_revision_check;
alter table public.storyboards add constraint storyboards_revision_check
  check (revision between 0 and 100000);

comment on column public.storyboards.revision is
  'Edit counter (0058): 0 as the pipeline wrote it, +1 per saved edit. Saves and approvals name the revision they were made on; a stale one is refused.';
comment on column public.storyboards.opening_edited is
  'True once an edit changed the first scene (0058). The render then records no hook A/B arm.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Guards, for every writer
-- ───────────────────────────────────────────────────────────────────────────
-- 0057's guard already freezes content once a storyboard is no longer
-- 'ready' and limits status moves. These add: content only changes together
-- with a revision bump of exactly one; the revision never goes back; a
-- changed opening stays recorded; a new row starts unedited.

create or replace function public.storyboards_edit_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.revision < old.revision then
    raise exception 'a storyboard''s revision only grows' using errcode = '42501';
  end if;
  if (new.scenes is distinct from old.scenes
      or new.script is distinct from old.script
      or new.duration_s is distinct from old.duration_s)
     and new.revision <> old.revision + 1 then
    raise exception 'a storyboard''s content changes only with a new revision' using errcode = '42501';
  end if;
  if old.opening_edited and not new.opening_edited then
    raise exception 'an edited opening stays recorded' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists storyboards_edit_guard on public.storyboards;
create trigger storyboards_edit_guard
  before update on public.storyboards
  for each row execute function public.storyboards_edit_guard();

create or replace function public.storyboards_edit_insert_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.revision <> 0 or new.opening_edited or new.edited_at is not null
     or new.edited_by is not null or new.reopened_at is not null then
    raise exception 'a storyboard starts unedited' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists storyboards_edit_insert_guard on public.storyboards;
create trigger storyboards_edit_insert_guard
  before insert on public.storyboards
  for each row execute function public.storyboards_edit_insert_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Text rules
-- ───────────────────────────────────────────────────────────────────────────

-- Collapse every run of whitespace to one space, as the pipeline does when it
-- writes a card (modules/storyboard_review._clip), so "unchanged" compares
-- like with like.
create or replace function public.storyboard_squash(p text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))
$$;

-- Null when the text is acceptable, else why not. Control characters and
-- text-direction overrides (which make a line read differently than it is
-- stored) are refused; so is the script's cue markup, which ScriptEngine
-- would otherwise parse into sound effects, music, pauses or a voice switch.
create or replace function public.storyboard_text_problem(p text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case
    when p ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then 'control_character'
    when p ~ '[‪-‮⁦-⁩]' then 'direction_override'
    when p ~* '\[\s*(sfx|music|pause|voice)\s*:' then 'cue_markup'
    else null
  end
$$;

-- How long a narration takes to say: 150 words a minute, 1..600 s (0057's
-- per-scene bounds). Computed here so the length — and so the price — of an
-- edited scene is never the browser's to choose.
create or replace function public.storyboard_spoken_seconds(p text) returns integer
  language sql immutable set search_path = public, pg_temp as $$
  select greatest(1, least(600, ceil(
    coalesce(array_length(regexp_split_to_array(nullif(public.storyboard_squash(p), ''), ' '), 1), 0)
    * 60.0 / 150)::integer))
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Saving an edit
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.save_storyboard_edits(p_storyboard uuid, p_revision integer, p_scenes jsonb)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  sb          public.storyboards;
  v_old_cards jsonb;
  v_old_secs  jsonb;
  v_count     integer;
  v_cards     jsonb := '[]'::jsonb;
  v_secs      jsonb := '[]'::jsonb;
  v_used      integer[] := '{}';
  v_chars     integer := 0;
  v_total     integer := 0;
  v_opening   boolean := false;
  v_script    jsonb;
  el          jsonb;
  i           integer;
  k           text;
  v_src       integer;
  v_nar       text;
  v_vis       text;
  v_kw        text[];
  v_why       text;
  card        jsonb;
  sec         jsonb;
  secs        integer;
begin
  sb := public.storyboard_lock_for_runner(p_storyboard);
  -- After the lock: two saves, or a save and an approval, take turns here.
  if sb.status <> 'ready' then
    raise exception 'storyboard_not_ready' using errcode = 'NS409', detail = sb.status;
  end if;
  if p_revision is null or p_revision <> sb.revision then
    raise exception 'stale_revision' using errcode = 'NS412', detail = format('revision=%s', sb.revision);
  end if;

  if p_scenes is null or jsonb_typeof(p_scenes) <> 'array'
     or jsonb_array_length(p_scenes) not between 1 and 60 then
    raise exception 'scenes_invalid' using errcode = '22023', detail = 'count';
  end if;
  if octet_length(p_scenes::text) > 262144 then
    raise exception 'scenes_invalid' using errcode = '22023', detail = 'size';
  end if;

  v_old_cards := sb.scenes;
  v_old_secs := sb.script -> 'sections';
  v_count := jsonb_array_length(v_old_cards);
  -- The cards were written from the script's sections, one for one (0057,
  -- modules/storyboard_review.scene_cards). If that no longer holds there is
  -- no honest way to say which section a card edits.
  if v_old_secs is null or jsonb_typeof(v_old_secs) <> 'array'
     or jsonb_array_length(v_old_secs) <> v_count then
    raise exception 'storyboard_not_editable' using errcode = '22023';
  end if;

  i := 0;
  for el in select value from jsonb_array_elements(p_scenes) loop
    i := i + 1;
    if jsonb_typeof(el) <> 'object' then
      raise exception 'scenes_invalid' using errcode = '22023', detail = format('scene=%s shape', i);
    end if;
    for k in select jsonb_object_keys(el) loop
      if not (k = any (array['src', 'narration', 'visual'])) then
        raise exception 'scenes_invalid' using errcode = '22023', detail = format('scene=%s field', i);
      end if;
    end loop;

    -- Which scene of THIS revision it is, or a new one.
    v_src := null;
    if el ? 'src' and jsonb_typeof(el -> 'src') <> 'null' then
      if jsonb_typeof(el -> 'src') <> 'number'
         or (el ->> 'src')::numeric <> trunc((el ->> 'src')::numeric)
         or (el ->> 'src')::numeric not between 1 and v_count then
        raise exception 'scenes_invalid' using errcode = '22023', detail = format('scene=%s src', i);
      end if;
      v_src := (el ->> 'src')::integer;
      if v_src = any (v_used) then
        raise exception 'scenes_invalid' using errcode = '22023', detail = format('scene=%s duplicate', i);
      end if;
      v_used := v_used || v_src;
    end if;

    if jsonb_typeof(el -> 'narration') is distinct from 'string'
       or (el ? 'visual' and jsonb_typeof(el -> 'visual') not in ('string', 'null')) then
      raise exception 'scenes_invalid' using errcode = '22023', detail = format('scene=%s type', i);
    end if;
    v_why := coalesce(public.storyboard_text_problem(el ->> 'narration'),
                      public.storyboard_text_problem(el ->> 'visual'));
    if v_why is not null then
      raise exception 'scenes_invalid' using errcode = '22023', detail = format('scene=%s %s', i, v_why);
    end if;
    v_nar := public.storyboard_squash(el ->> 'narration');
    v_vis := public.storyboard_squash(el ->> 'visual');
    if length(v_nar) not between 1 and 4000 then
      raise exception 'scenes_invalid' using errcode = '22023', detail = format('scene=%s narration_length', i);
    end if;
    if length(v_vis) > 1000 then
      raise exception 'scenes_invalid' using errcode = '22023', detail = format('scene=%s visual_length', i);
    end if;
    v_chars := v_chars + length(v_nar) + length(v_vis);
    if v_chars > 120000 then
      raise exception 'scenes_invalid' using errcode = '22023', detail = 'total_length';
    end if;
    -- Footage search terms, as ScriptEngine keeps them.
    select coalesce(array_agg(t order by o), '{}') into v_kw
      from (select btrim(t) as t, o from unnest(string_to_array(v_vis, ',')) with ordinality as u(t, o)) x
     where t <> '';
    if cardinality(v_kw) > 8 or exists (select 1 from unnest(v_kw) t where length(t) > 120) then
      raise exception 'scenes_invalid' using errcode = '22023', detail = format('scene=%s visual_terms', i);
    end if;

    if v_src is null then
      secs := public.storyboard_spoken_seconds(v_nar);
      card := jsonb_build_object('n', i, 'name', 'Added scene', 'type', 'story', 'narration', v_nar,
                                 'visual', array_to_string(v_kw, ', '), 'duration_s', secs);
      sec := jsonb_build_object('name', 'Added scene', 'type', 'story', 'voice', 'main',
                                'narration', v_nar, 'duration_hint', secs, 'cut_interval', 5.0,
                                'keywords', to_jsonb(v_kw));
      if i = 1 then
        v_opening := true;
      end if;
    else
      card := (v_old_cards -> (v_src - 1)) || jsonb_build_object('n', i);
      sec := v_old_secs -> (v_src - 1);
      if jsonb_typeof(sec) <> 'object' then
        raise exception 'storyboard_not_editable' using errcode = '22023';
      end if;
      -- Unchanged text keeps the section exactly as written (cues included).
      if v_nar is distinct from coalesce(card ->> 'narration', '') then
        secs := public.storyboard_spoken_seconds(v_nar);
        card := card || jsonb_build_object('narration', v_nar, 'duration_s', secs);
        sec := sec || jsonb_build_object('narration', v_nar, 'duration_hint', secs);
        if i = 1 then
          v_opening := true;
        end if;
      end if;
      if v_vis is distinct from coalesce(card ->> 'visual', '') then
        card := card || jsonb_build_object('visual', array_to_string(v_kw, ', '));
        sec := sec || jsonb_build_object('keywords', to_jsonb(v_kw));
      end if;
      if i = 1 and v_src <> 1 then
        v_opening := true;
      end if;
    end if;
    v_total := v_total + (card ->> 'duration_s')::integer;
    v_cards := v_cards || jsonb_build_array(card);
    v_secs := v_secs || jsonb_build_array(sec);
  end loop;

  -- Priced from the scenes, like the pipeline (storyboard_review.priced_duration),
  -- except that an edit never makes a render longer than a run may be.
  if v_total > 3600 then
    raise exception 'storyboard_too_long' using errcode = '22023', detail = format('seconds=%s', v_total);
  end if;
  if not public.storyboard_scenes_valid(v_cards) then
    raise exception 'scenes_invalid' using errcode = '22023', detail = 'cards';
  end if;
  v_script := jsonb_set(sb.script, '{sections}', v_secs);
  if pg_column_size(v_script) > 262144 then
    raise exception 'scenes_invalid' using errcode = '22023', detail = 'total_length';
  end if;

  if v_cards = sb.scenes and v_script = sb.script then
    return jsonb_build_object('id', sb.id, 'status', sb.status, 'revision', sb.revision,
                              'duration_s', sb.duration_s, 'scenes', sb.scenes, 'changed', false);
  end if;

  update public.storyboards
     set scenes = v_cards, script = v_script, duration_s = greatest(30, v_total),
         revision = revision + 1, edited_at = now(), edited_by = auth.uid(),
         opening_edited = opening_edited or v_opening
   where id = sb.id
  returning * into sb;
  return jsonb_build_object('id', sb.id, 'status', sb.status, 'revision', sb.revision,
                            'duration_s', sb.duration_s, 'scenes', sb.scenes, 'changed', true);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Approving the revision the person saw
-- ───────────────────────────────────────────────────────────────────────────
-- The row lock, then the revision, then 0057's approval (which locks the same
-- row again in this transaction and does everything else: the 'ready' check,
-- the floor for the stored length, the hold, the job). An edit that landed
-- after the price was shown is a refusal, never a render of something else.

create or replace function public.approve_storyboard_at(
  p_storyboard uuid, p_revision integer, p_amount numeric, p_backend text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  sb public.storyboards;
begin
  sb := public.storyboard_lock_for_runner(p_storyboard);
  if sb.status <> 'ready' then
    raise exception 'storyboard_not_ready' using errcode = 'NS409', detail = sb.status;
  end if;
  if p_revision is null or p_revision <> sb.revision then
    raise exception 'stale_revision' using errcode = 'NS412', detail = format('revision=%s', sb.revision);
  end if;
  return public.approve_storyboard(p_storyboard, p_amount, p_backend) || jsonb_build_object('revision', sb.revision);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Re-opening after a failed render
-- ───────────────────────────────────────────────────────────────────────────

-- Null when no render of this approval can start or still be running and its
-- hold (if any) has gone back to the balance; else why not. Reads the hold
-- and the job as they are now; both states it accepts are final ('released'
-- never reopens, 'failed' is never re-queued), so nothing can change them
-- back between this check and the update.
create or replace function public.storyboard_reopen_blocker(p_storyboard uuid) returns text
  language plpgsql stable set search_path = public, pg_temp as $$
declare
  sb     public.storyboards;
  v_hold text;
  j      record;
begin
  select * into sb from public.storyboards where id = p_storyboard;
  if sb.id is null or sb.status <> 'approved' then
    return 'not_approved';
  end if;
  if sb.credit_ref is not null then
    select status into v_hold from public.credit_reservations where job_id = sb.credit_ref;
    if v_hold is null then
      return 'render_unverifiable';
    elsif v_hold = 'open' then
      -- Open and unstarted: a runner may still claim it. Open and started:
      -- running, or a failure the platform has not settled yet.
      return 'hold_not_released';
    elsif v_hold = 'captured' then
      return 'render_finished';
    end if;
  end if;
  if sb.backend = 'queue' then
    if sb.render_job_id is null then
      return 'render_unverifiable';
    end if;
    select status, heartbeat_at into j from public.render_jobs where id = sb.render_job_id;
    if j.status is null then
      return 'render_unverifiable';
    elsif j.status in ('queued', 'running') then
      return 'render_in_progress';
    elsif j.status = 'cancelled' and j.heartbeat_at > now() - interval '10 minutes' then
      return 'render_in_progress';
    elsif j.status = 'succeeded' and sb.credit_ref is null then
      -- A finished job with no hold to say what it did (the operator's own
      -- organization): it may have rendered.
      return 'render_finished';
    end if;
  elsif sb.backend = 'actions' then
    if sb.credit_ref is null and sb.decided_at > now() - interval '24 hours' then
      return 'render_unverifiable';
    end if;
  else
    return 'render_unverifiable';
  end if;
  return null;
end
$$;

create or replace function public.reopen_storyboard(p_storyboard uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  sb     public.storyboards;
  v_why  text;
begin
  sb := public.storyboard_lock_for_runner(p_storyboard);
  if sb.status <> 'approved' then
    raise exception 'storyboard_not_ready' using errcode = 'NS409', detail = sb.status;
  end if;
  v_why := public.storyboard_reopen_blocker(sb.id);
  if v_why is not null then
    raise exception '%', v_why using errcode = 'NS423';
  end if;
  update public.storyboards
     set status = 'ready', decided_by = null, decided_at = null, backend = null,
         credit_ref = null, credits_held = null, render_job_id = null, reopened_at = now()
   where id = sb.id
  returning * into sb;
  return jsonb_build_object('id', sb.id, 'status', sb.status, 'revision', sb.revision);
end
$$;

-- For the screen: whether to offer "Re-open", and what to say if not. Same
-- right as re-opening; another organization's storyboard and a missing one
-- read the same. Takes no lock.
create or replace function public.storyboard_reopen_check(p_storyboard uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_channel text;
  v_why     text;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select channel_id into v_channel from public.storyboards where id = p_storyboard;
  if v_channel is null or not (v_channel in (select public.accessible_channel_ids('admin'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_why := public.storyboard_reopen_blocker(p_storyboard);
  return jsonb_build_object('reopenable', v_why is null, 'reason', v_why);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Privileges
-- ───────────────────────────────────────────────────────────────────────────
-- The table's grants are 0057's: authenticated reads (RLS: members of the
-- channel's organization) and writes nothing; service_role may update only
-- status and rendered_at, so the new columns are written by these functions
-- alone.

revoke all on function public.storyboards_edit_guard() from public, anon, authenticated, service_role;
revoke all on function public.storyboards_edit_insert_guard() from public, anon, authenticated, service_role;
revoke all on function public.storyboard_squash(text) from public, anon, authenticated, service_role;
revoke all on function public.storyboard_text_problem(text) from public, anon, authenticated, service_role;
revoke all on function public.storyboard_spoken_seconds(text) from public, anon, authenticated, service_role;
revoke all on function public.storyboard_reopen_blocker(uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_storyboard_edits(uuid, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.approve_storyboard_at(uuid, integer, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.reopen_storyboard(uuid) from public, anon, authenticated, service_role;
revoke all on function public.storyboard_reopen_check(uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_storyboard_edits(uuid, integer, jsonb) to authenticated;
grant execute on function public.approve_storyboard_at(uuid, integer, numeric, text) to authenticated;
grant execute on function public.reopen_storyboard(uuid) to authenticated;
grant execute on function public.storyboard_reopen_check(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) = 5 from information_schema.columns
--     where table_schema = 'public' and table_name = 'storyboards'
--       and column_name in ('revision', 'opening_edited', 'edited_at', 'edited_by', 'reopened_at'))
--     as columns_added,
--   not has_table_privilege('authenticated', 'public.storyboards', 'UPDATE')
--     and not has_column_privilege('authenticated', 'public.storyboards', 'revision', 'UPDATE')
--     and not has_column_privilege('service_role', 'public.storyboards', 'revision', 'UPDATE')
--     and not has_column_privilege('service_role', 'public.storyboards', 'scenes', 'UPDATE')
--     as browser_and_pipeline_cannot_write_edits,
--   has_function_privilege('authenticated', 'public.save_storyboard_edits(uuid,integer,jsonb)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.approve_storyboard_at(uuid,integer,numeric,text)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.reopen_storyboard(uuid)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.storyboard_reopen_check(uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.save_storyboard_edits(uuid,integer,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.reopen_storyboard(uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.storyboard_reopen_blocker(uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.storyboard_spoken_seconds(text)', 'EXECUTE')
--     as functions_scoped,
--   (select bool_and(p.prosecdef = (p.proname in ('save_storyboard_edits', 'approve_storyboard_at',
--                                                 'reopen_storyboard', 'storyboard_reopen_check'))
--                    and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--      from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('save_storyboard_edits', 'approve_storyboard_at', 'reopen_storyboard',
--                         'storyboard_reopen_check', 'storyboard_reopen_blocker', 'storyboard_squash',
--                         'storyboard_text_problem', 'storyboard_spoken_seconds',
--                         'storyboards_edit_guard', 'storyboards_edit_insert_guard'))
--     as definer_and_search_path,
--   exists (select 1 from pg_trigger where tgname = 'storyboards_edit_guard' and not tgisinternal)
--     and exists (select 1 from pg_trigger where tgname = 'storyboards_edit_insert_guard' and not tgisinternal)
--     and exists (select 1 from pg_trigger where tgname = 'storyboards_guard' and not tgisinternal)
--     as guards_on,
--   (select count(*) from public.storyboards where revision < 0) = 0 as revisions_sane;
