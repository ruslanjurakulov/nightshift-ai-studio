# Film Studio: switching the film path on for the demo

This is a runbook. It changes nothing by being merged. Every step below is something a person runs on purpose, and every step
can be undone with the rollback at the end.

A film can be started and worked only while **all** of these are on:

| # | Switch | Where | Default |
|---|---|---|---|
| 1 | `film_studio_settings.film_studio_enabled`: the platform switch (0171) | database | off |
| 2 | `org_film_settings.film_studio_enabled`: one switch per organization (0198) | database | off |
| 3 | `NIGHTSHIFT_FILM_STUDIO`: the Studio → Projects pages and `/api/films/*` | GitHub repository variable (web) | unset = dark |
| 4 | `NIGHTSHIFT_WORKER`, `NIGHTSHIFT_FILM_WORKER`: deploy the film-worker container | GitHub repository variables (worker) | unset = not deployed |
| 5 | `NIGHTSHIFT_FILM_ASSEMBLY`: lets the film worker claim segments | GitHub repository variable (worker) | unset = claims nothing |

Rule 2 of CLAUDE.md is untouched: none of these publishes anything. A finished film is a file in the media library.

## Before you start

The assembly is a separate PR (#845, `modules/film_assembly.py` and its migration, placeholder 0200). Until it is merged and its
migration applied, no film can be finished: the worker claims nothing even with every switch below on.


0198 must be live. The deploy applies new migrations after a merge. Check it in the Supabase SQL editor; both columns must be `true`:

```sql
select to_regprocedure('public.film_take_job(uuid,text)') is not null              as has_0198,
       to_regprocedure('public.set_org_film_studio_enabled(uuid,boolean)') is not null as has_org_setter;
```

## 1. The platform switch (0171)

Run this in the Supabase SQL editor. The editor runs as the `postgres` role with no JWT, and both setters accept that caller
without owner_guard's second factor. Each change still writes one `security_events` row (`via: sql_editor`). The call is
idempotent: running it again answers `changed: false` and writes nothing.

```sql
select public.set_film_studio_enabled(true);
```

Verify:

```sql
select film_studio_enabled, updated_at from public.film_studio_settings;   -- expect: true
```

## 2. The organization switch (0198), for exactly these three organizations

```sql
select public.set_org_film_studio_enabled(o, true)
  from unnest(array['00000000-0000-0000-0000-000000000001',
                    '0c5ced44-0802-4466-a2d7-0b515a0dc469',
                    '45e83784-26cb-42cc-80df-d1602c28dacc']::uuid[]) o;
```

An id that is not an organization raises `not_found` (P0002), and nothing in that statement is applied. Fix the id and run it
again. The setter is idempotent, like step 1.

Verify (expect three rows, each `org_on = true` and `effective = true`):

```sql
select o.id, o.name,
       coalesce(s.film_studio_enabled, false) as org_on,
       public.film_studio_on_for(o.id)         as effective   -- platform AND org
  from public.organizations o
  left join public.org_film_settings s on s.org_id = o.id
 where o.id = any (array['00000000-0000-0000-0000-000000000001',
                         '0c5ced44-0802-4466-a2d7-0b515a0dc469',
                         '45e83784-26cb-42cc-80df-d1602c28dacc']::uuid[])
 order by o.name;
```

The audit trail for steps 1 and 2:

```sql
select at, kind, target, detail
  from public.security_events
 where kind in ('film_studio.enabled', 'film_studio.org_enabled')
 order by at desc limit 10;
```

## 3. Deploy variables

Set these under GitHub → Settings → Secrets and variables → Actions → **Variables**. Then run the web deploy workflow
(`deploy_web.yml`), which writes the worker env file and starts or removes the containers.

| Variable | Value | What it does |
|---|---|---|
| `NIGHTSHIFT_FILM_STUDIO` | `admins` for a platform-admins-only demo, or `on` | Shows Studio → Projects and opens `/api/films/*` |
| `NIGHTSHIFT_WORKER` | `on` (it already is if the pipeline worker runs) | Builds the worker env file; nothing below runs without it |
| `NIGHTSHIFT_FILM_WORKER` | `on` | Starts the `film-worker` container (mem_limit 3g) |
| `NIGHTSHIFT_FILM_ASSEMBLY` | `on` | Lets the worker claim segments. While it is off, the worker only runs the zero-cost expiry sweep |

`NIGHTSHIFT_FILM_ASSEMBLY=on` claims anything only when `modules/film_assembly.py` is on `main` (the assembly session's PR). Until
then the worker logs one line naming what is missing and claims nothing.

The film worker uses the same env the creative worker already has: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
`NIGHTSHIFT_CREATIVE_ADAPTERS` and `NIGHTSHIFT_MEDIA_DIR`. If one is missing, the worker refuses to start and its log names it.

Verify on the server:

```bash
dc ps film-worker                 # Up
dc logs --tail 50 film-worker     # "film worker … started", and no "no film segment is claimed until …" line
```

## 4. Check that a demo film can start

These are not switches, but each one blocks a start or a finished film:

- The `film_assembly_minute` row exists in `credit_prices`. The assembly is priced from it.
- The media volume has room for the master: about 9 MB per second of 1080p film, so about 0.5 GB for a 60 s demo and about 5.4 GB
  for a 10-minute film. With less, the assembly fails as `disk_low` and says so.
- The worker image was built from `Dockerfile.worker`, which caches the Whisper model that the captions use.

- Every model the film's scenes use must be sellable and available, exactly as for a Studio job.
- The organization needs the quoted credits. One hold, `fm-<segment id>`, is taken at start.
- Narration stays off: no TTS model is on sale.

The quote names every blocker. `quote_film` runs as the signed-in member, so ask for it in the Command Center: the film's
Assemble panel calls `/api/films/{id}/quote`. `startable: true` and an empty `blocked_by` mean the film can start.

## Rollback (switch everything off)

Run in the Supabase SQL editor. It is idempotent, and audited the same way.

```sql
select public.set_org_film_studio_enabled(o, false)
  from unnest(array['00000000-0000-0000-0000-000000000001',
                    '0c5ced44-0802-4466-a2d7-0b515a0dc469',
                    '45e83784-26cb-42cc-80df-d1602c28dacc']::uuid[]) o;
select public.set_film_studio_enabled(false);
```

Then set `NIGHTSHIFT_FILM_ASSEMBLY` and `NIGHTSHIFT_FILM_WORKER` to empty or `off`, and redeploy. A worker that is not `on` is
removed. `NIGHTSHIFT_FILM_STUDIO` can stay `admins` or be cleared.

What "off" does to a film already running, by design (0198):

- No new film starts.
- No new take begins on a running segment.
- A take whose task is already at the vendor is still polled to the end, because it is already paid.
- A queued segment that nobody claims is settled at 0 by the expiry sweep, and its hold is released.

Verify off: the platform query in step 1 shows `false`, and the `effective` column in step 2 shows `false` for all three rows.

Do not write to `film_studio_settings` or `org_film_settings` directly. The setters are the only audited path, and a direct
write leaves no `security_events` row.
