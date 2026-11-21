-- Rollback of 0200_film_assembly_orphans.sql (owner-applied, SQL editor): the assembly's orphan discard is taken out. 0200 added one
-- service-role function and nothing else (no table, column, row or grant on anything older), so this drops only that function. Files
-- it already soft-deleted stay deleted (0038's purge removes them as any deleted file); the film_events rows it wrote stay, as history.
-- 0171's rollback refuses while this function reads film_segments, so this goes first.
begin;
drop function if exists public.film_discard_unrecorded_assembly(uuid, uuid);
commit;
