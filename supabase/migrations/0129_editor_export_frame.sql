-- 0129_editor_export_frame.sql — one edit, several frame sizes: an export request may name ONE frame from a closed list, and the
-- export is rendered in that frame instead of the project's own (the video editor, finishing 0054 / the export formats of #609).
-- Until now an export always rendered the saved revision in the project's frame, one export per project at a time, so the same edit in
-- 16:9, 9:16, 1:1 and 4:5 meant four copies of the project (docs/editor-render-fields.md, "Export formats").
--
-- WHAT IT ADDS (no new table, no new policy, no grant on a table, nothing replaced)
--   editor_exports.frame_preset / frame_width / frame_height
--                                   the frame an export was asked in, or all three null = the project's own frame (every row before
--                                   this file, and every export asked for through the two-argument function). One CHECK: all null,
--                                   or an id-shaped word with an even frame of 16-4096 px a side and at most 2560x1440 pixels (the
--                                   timeline's own limits, modules/timeline.py MIN_SIDE / MAX_SIDE / LARGE_FRAME_PX). Written only by
--                                   the new overload below: no API role has INSERT or UPDATE on the table (0054), and nothing here adds one.
--   editor_export_frame(text)       INTERNAL (no API role may call it). The CLOSED LIST: the five ids of schemas/export_presets.json with
--                                   their width and height, value for value (tests/test_editor_export_frame_migration.py compares the two).
--                                   An id outside the list returns no row. Exact match: no trimming, no case folding, no numbers from a client.
--   request_editor_export(project, rev, frame)
--                                   NEW overload, three arguments, none defaulted (a default would make a two-name call ambiguous for
--                                   PostgREST). 0054's function with the frame added: the body is 0054's BYTE FOR BYTE except for the
--                                   lines marked 0129 (the pin test takes them out and compares what is left with 0054's body). The
--                                   two-argument function is NOT touched: an export without a frame is exactly what it was.
--
-- WHAT THE NEW OVERLOAD CHECKS, in order
--   sign-in (forbidden) → the project exists, is live and the caller is a member of its organization (not_found: another organization's
--   project reads as missing, as in 0054) → the frame is one of the closed list (invalid_frame, NS400; null, a made-up word, a padded or
--   upper-case id, "1080x1920", SQL text: all the same refusal, and only AFTER membership, so a stranger learns nothing) → the revision is
--   the current one → every file is still this organization's and live → the length (empty, too_long: at most 30 minutes) → under the
--   per-organization lock: the in-flight and daily limits below → the row.
--
-- THE LIMITS: 0054's, EACH FRAME IS ONE EXPORT
--   An export in a frame is one export like any other: it takes one of the organization's three waiting-or-rendering places and one of
--   its twenty a day, under the same advisory lock, and it is free (nothing here holds, charges or refunds a credit; no provider is called).
--   ONE RULE HAS A NEW SHAPE, in the new overload only: "one export at a time per project" becomes "one export at a time per project PER
--   FRAME SIZE" (the same size of the same project twice is export_in_progress; a different size is a different file and may wait beside
--   it). The size of an export in flight is its row's frame, or, for a row without one, the frame of the document it copied: so a format
--   that is the project's own size (youtube_1080p on a 1920x1080 project) is refused while the plain export of that project is in flight,
--   and the other way round the two-argument function refuses anyway.
--   The organization's cap of three in flight is what bounds the worker, and it is unchanged, so one project can never hold more than the
--   three places its organization has. The two-argument function still refuses while ANY export of the project is in flight.
--
-- WHAT THIS CANNOT DO
--   * put a free-form size into a render: the function reads width and height from its own list, never from the caller, and the worker
--     re-reads the id against schemas/export_presets.json and refuses a row whose three values are not exactly one entry (invalid_frame);
--   * reach another organization: every gate before the frame is 0054's, in 0054's order, and the frame is looked at after membership;
--   * publish, or carry an approval: an export in another frame is a NEW library file (media_assets, source 'render') with its own id and
--     sha256. Nothing here touches the publish gate, publish_requests, approve_video_publish or any video row;
--   * be written by a client directly: editor_exports has SELECT only for API roles (0054).
--
-- ORDER AND ROLL-OUT. Safe in either order with the Command Center and the worker. Before this runs the Command Center's three-argument
-- call gets PGRST202 and answers "not available" for that frame (it never renders the project's frame in its place); an export without a
-- frame goes through the two-argument function as always. A worker older than this file ignores the new columns and would render the
-- project's frame: the switch NIGHTSHIFT_MULTI_RATIO_EXPORT (web and worker, default off) is turned on only after both run this change.
-- Needs 0054. Replaces NO function: refuses (changes nothing) if the live two-argument request_editor_export() is not 0054's body (the
-- new overload is a copy of it, and a copy of a body nobody reviewed would silently drop a live fix), or if a three-argument overload or
-- an editor_export_frame() that is not this file's is already there.
-- Additive and idempotent (guarded columns and constraint, create-or-replace, revoke-then-grant). Nothing is dropped.
-- Undo: docs/sql/rollback_0129_editor_export_frame.sql (owner-applied).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the first must read 6d37b4d75092708981c28a56879c89b4, the others must be empty / 0):
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.request_editor_export(uuid, integer)'::regprocedure;
--   select pg_get_function_identity_arguments(oid) from pg_proc where proname in ('request_editor_export', 'editor_export_frame')
--     and pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(oid) <> 'p_project uuid, p_rev integer';
--   select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'editor_exports' and column_name like 'frame_%';

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regclass('public.editor_exports') is null or to_regclass('public.editor_projects') is null
     or to_regprocedure('public.request_editor_export(uuid, integer)') is null
     or to_regprocedure('public.editor_doc_problem(uuid, jsonb)') is null
     or to_regprocedure('public.editor_doc_duration(jsonb)') is null then
    raise exception '0129 needs the video editor: apply 0054_editor_projects.sql first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = 'public.request_editor_export(uuid, integer)'::regprocedure;
  if h <> '6d37b4d75092708981c28a56879c89b4' then
    raise exception '0129 found a two-argument request_editor_export() that is not 0054''s body (md5 %): the new overload is a copy of 0054''s, read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.request_editor_export(uuid, integer, text)');
  if h is not null and h <> '83456b3c70d9433ce0e21da1339198ad' then
    raise exception '0129 found a three-argument request_editor_export() that is not this file''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.editor_export_frame(text)');
  if h is not null and h <> '1bcfdbfab6526ce7d0ba07e167f5740c' then
    raise exception '0129 found an editor_export_frame() that is not this file''s (md5 %): read the live body first', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. editor_exports: the frame an export was asked in
-- ───────────────────────────────────────────────────────────────────────────

alter table public.editor_exports add column if not exists frame_preset text;
alter table public.editor_exports add column if not exists frame_width integer;
alter table public.editor_exports add column if not exists frame_height integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'editor_exports_frame_shape'
                   and conrelid = 'public.editor_exports'::regclass) then
    -- Every existing row has all three null, so this validates without rewriting anything.
    alter table public.editor_exports
      add constraint editor_exports_frame_shape check (
        (frame_preset is null and frame_width is null and frame_height is null)
        or (frame_preset is not null and frame_width is not null and frame_height is not null
            and frame_preset ~ '^[a-z0-9_]{1,32}$'
            and frame_width between 16 and 4096 and frame_height between 16 and 4096
            and frame_width % 2 = 0 and frame_height % 2 = 0
            and frame_width * frame_height <= 3686400));
  end if;
end $$;

comment on column public.editor_exports.frame_preset is
  'The frame this export was asked in (migration 0129): an id of the closed list editor_export_frame() holds (schemas/export_presets.json), or null = the project''s own frame. Written only by request_editor_export(project, rev, frame).';
comment on column public.editor_exports.frame_width is
  'Width in pixels of frame_preset as the database''s list had it when the export was asked for (migration 0129); null with frame_preset. The worker renders this frame only if it is exactly its own list''s entry.';
comment on column public.editor_exports.frame_height is
  'Height in pixels of frame_preset (migration 0129); null with frame_preset.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The closed list (internal)
-- ───────────────────────────────────────────────────────────────────────────

-- The frames an export may be asked in: schemas/export_presets.json, id for id and pixel for pixel (a test compares the two; a new
-- format is a new migration, on purpose). No row for anything else, null included. The frame RATE is not here: an export in another
-- frame keeps the project's own rate.
create or replace function public.editor_export_frame(p_frame text)
  returns table (id text, width integer, height integer)
  language sql immutable set search_path = public, pg_temp as $$
  select v.id, v.width, v.height
    from (values ('youtube_1080p', 1920, 1080),
                 ('youtube_720p', 1280, 720),
                 ('vertical_1080p', 1080, 1920),
                 ('square_1080', 1080, 1080),
                 ('feed_4x5_1080', 1080, 1350)) as v (id, width, height)
   where v.id = p_frame
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. request_editor_export — three arguments: 0054's function plus the frame
-- ───────────────────────────────────────────────────────────────────────────

-- Queue a render of revision p_rev in the frame p_frame. Everything not marked 0129 is 0054's two-argument function, line for line.
create or replace function public.request_editor_export(p_project uuid, p_rev integer, p_frame text) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p       public.editor_projects;
  problem text;
  total   numeric;
  e       public.editor_exports;
  frame_id text;   -- 0129
  frame_w  integer;   -- 0129
  frame_h  integer;   -- 0129
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.editor_projects where id = p_project for update;
  if not found or p.deleted_at is not null or not public.is_org_member(p.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- 0129 the frame, from the database's own closed list and only AFTER membership: null, a made-up word, a padded or upper-case id
  -- 0129 and a size typed as text are one refusal. Width and height are read from the list, never from the caller.
  select f.id, f.width, f.height into frame_id, frame_w, frame_h from public.editor_export_frame(p_frame) f;   -- 0129
  if frame_id is null then   -- 0129
    raise exception 'invalid_frame' using errcode = 'NS400';   -- 0129
  end if;   -- 0129
  if p_rev is null or p_rev <> p.rev then
    raise exception 'stale_revision' using errcode = 'NS409', detail = format('current=%s', p.rev);
  end if;
  -- Again now: a file used by the project may have been deleted since it was saved.
  problem := public.editor_doc_problem(p.org_id, p.doc);
  if problem is not null then
    raise exception '%', problem using errcode = 'NS400';
  end if;
  total := public.editor_doc_duration(p.doc);
  if total is null then
    raise exception 'invalid_doc' using errcode = 'NS400';
  end if;
  if total <= 0 then
    raise exception 'empty' using errcode = 'NS400';
  end if;
  if total > 1800 then
    raise exception 'too_long' using errcode = 'NS400', detail = 'max_s=1800';
  end if;

  -- One request per organization at a time: the limits hold under parallel clicks.
  perform pg_advisory_xact_lock(hashtextextended('editor_exports:' || p.org_id::text, 0));
  -- 0129 one at a time per project PER FRAME SIZE: the same picture twice is refused, another size is another file. An export in
  -- 0129 flight without a frame is the size of the document it copied (jsonb compares numbers by value, and never raises on a doc
  -- 0129 whose width is not a number). The organization's three in flight and twenty a day below are 0054's lines, unchanged, and
  -- 0129 each frame counts as one.
  if exists (select 1 from public.editor_exports
              where project_id = p.id and status in ('queued', 'rendering') and coalesce(to_jsonb(frame_width), doc -> 'width') = to_jsonb(frame_w) and coalesce(to_jsonb(frame_height), doc -> 'height') = to_jsonb(frame_h)) then   -- 0129 replaces: where project_id = p.id and status in ('queued', 'rendering')) then
    raise exception 'export_in_progress' using errcode = 'NS409';
  end if;
  if (select count(*) from public.editor_exports
       where org_id = p.org_id and status in ('queued', 'rendering')) >= 3 then
    raise exception 'export_in_progress' using errcode = 'NS409', detail = 'max_active=3';
  end if;
  if (select count(*) from public.editor_exports
       where org_id = p.org_id and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'daily_limit' using errcode = 'NS429', detail = 'max=20';
  end if;

  insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, requested_by)
  values (p.org_id, p.id, p.rev, p.doc, round(total, 3), auth.uid())
  returning * into e;
  -- 0129 the frame is stamped on the row this call just made, in the same transaction: nobody ever sees it without one.
  update public.editor_exports   -- 0129
     set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h   -- 0129
   where id = e.id;   -- 0129
  return e.id;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges: the overload like the two-argument function (0054), the list for nobody
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.editor_export_frame(text) from public, anon, authenticated, service_role;
revoke all on function public.request_editor_export(uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.request_editor_export(uuid, integer, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. End state (raises, and so rolls the whole file back, if anything is not as written above)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  req2 regprocedure := 'public.request_editor_export(uuid, integer)'::regprocedure;
  req3 regprocedure := 'public.request_editor_export(uuid, integer, text)'::regprocedure;
  lst  regprocedure := 'public.editor_export_frame(text)'::regprocedure;
  role_name text;
  priv text;
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = req2) <> '6d37b4d75092708981c28a56879c89b4'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = req3) <> '83456b3c70d9433ce0e21da1339198ad'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = lst) <> '1bcfdbfab6526ce7d0ba07e167f5740c' then
    raise exception '0129 end state: a function does not hold the body this file expects';
  end if;
  if (select count(*) from pg_proc where proname = 'request_editor_export' and pronamespace = 'public'::regnamespace) <> 2 then
    raise exception '0129 end state: request_editor_export() does not have exactly two overloads';
  end if;
  if not (has_function_privilege('authenticated', req3, 'EXECUTE')
          and not has_function_privilege('anon', req3, 'EXECUTE')
          and not has_function_privilege('service_role', req3, 'EXECUTE')
          and has_function_privilege('authenticated', req2, 'EXECUTE')
          and not has_function_privilege('anon', req2, 'EXECUTE')
          and not has_function_privilege('service_role', req2, 'EXECUTE')
          and not has_function_privilege('authenticated', lst, 'EXECUTE')
          and not has_function_privilege('anon', lst, 'EXECUTE')
          and not has_function_privilege('service_role', lst, 'EXECUTE')) then
    raise exception '0129 end state: a function has the wrong grants';
  end if;
  if exists (select 1 from pg_proc p where p.oid in (req3, lst)
              and (p.proacl is null
                   or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')
                   or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))) then
    raise exception '0129 end state: a function is public or has no fixed search_path';
  end if;
  if not (select prosecdef from pg_proc where oid = req3) or (select prosecdef from pg_proc where oid = lst) then
    raise exception '0129 end state: the overload must be SECURITY DEFINER and the list must not be';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'editor_exports'
         and column_name in ('frame_preset', 'frame_width', 'frame_height') and is_nullable = 'YES' and column_default is null) <> 3 then
    raise exception '0129 end state: the three frame columns are not all there, nullable and without a default';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'editor_exports_frame_shape'
                   and conrelid = 'public.editor_exports'::regclass and contype = 'c' and convalidated) then
    raise exception '0129 end state: the frame check is missing or not validated';
  end if;
  -- The closed list answers for its five ids and for nothing else.
  if (select count(*) from unnest(array['youtube_1080p', 'youtube_720p', 'vertical_1080p', 'square_1080', 'feed_4x5_1080']) i,
                            public.editor_export_frame(i) f) <> 5
     or exists (select 1 from unnest(array[null, '', ' vertical_1080p', 'VERTICAL_1080P', '1080x1920', 'project']) i,
                              public.editor_export_frame(i) f) then
    raise exception '0129 end state: the closed list of frames is not the five formats';
  end if;
  -- No API role can write the columns: the table stays SELECT-only for them (0054).
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    foreach priv in array array['insert', 'update', 'delete', 'truncate'] loop
      if has_table_privilege(role_name, 'public.editor_exports', priv)
         or has_column_privilege(role_name, 'public.editor_exports', 'frame_preset', 'insert')
         or has_column_privilege(role_name, 'public.editor_exports', 'frame_preset', 'update') then
        raise exception '0129 end state: % can write editor_exports', role_name;
      end if;
    end loop;
  end loop;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) = 3 from information_schema.columns
--     where table_schema = 'public' and table_name = 'editor_exports' and column_name in ('frame_preset', 'frame_width', 'frame_height')) as frame_columns,
--   exists (select 1 from pg_constraint where conname = 'editor_exports_frame_shape' and convalidated) as frame_check,
--   has_function_privilege('authenticated', 'public.request_editor_export(uuid,integer,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.request_editor_export(uuid,integer,text)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.request_editor_export(uuid,integer,text)', 'EXECUTE') as overload_scoped,
--   not has_function_privilege('authenticated', 'public.editor_export_frame(text)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.editor_export_frame(text)', 'EXECUTE') as list_internal,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) = '6d37b4d75092708981c28a56879c89b4'
--      from pg_proc where oid = 'public.request_editor_export(uuid, integer)'::regprocedure) as two_argument_untouched,
--   not has_table_privilege('authenticated', 'public.editor_exports', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.editor_exports', 'UPDATE') as exports_read_only;
--
-- How many exports were asked in another frame so far (after the switch is on):
--   select frame_preset, status, count(*) from public.editor_exports where frame_preset is not null group by 1, 2 order by 1, 2;
