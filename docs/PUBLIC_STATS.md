# Live public counters on the site ("Live from our pipeline")

A small strip on the landing page (under the facts row) and on `/solutions` that
says what the pipeline has actually done, counted from the database: videos
rendered, videos uploaded to YouTube as private, videos a person approved, Studio
generations completed, and when the last queue run finished. It is built and
wired in, and it is **hidden**: nothing shows until the owner turns it on.

## The one command

Run it in the Supabase SQL editor of the live project:

```sql
select public.set_public_stats_visible(true);
```

To hide the strip again:

```sql
select public.set_public_stats_visible(false);
```

No redeploy and no environment variable. The site keeps the answer for five
minutes (`command-center/lib/server/public-stats.ts`), so the strip appears, or
disappears, within about five minutes.

To see what the strip would show before turning it on (the SQL editor and a
platform owner/admin get the numbers while it is hidden, with `"visible": false`):

```sql
select public.public_site_stats();
```

Each change writes one row to `security_events` (kind `site.public_stats`, with
`from`, `to` and `via`: `sql_editor` or `admin`), which the owner's Security page
lists. Anyone else who calls the switch gets `42501` and nothing is written.

## What each number counts

All from migration 0164 (`supabase/migrations/0164_public_site_stats.sql`).

| Key | What it counts |
| :-- | :-- |
| `videos_rendered` | Videos with a finished cut: a recorded master hash, or an upload. A held run stopped before the render is not counted. A lower bound: a held cut from before migration 0112 has no hash. |
| `videos_uploaded_private` | Uploaded videos that went to YouTube as private: recorded privacy `private`, or private on a read-back before a "publish when approved" request made them public. An upload that went public at once (auto publish on) is not counted. |
| `videos_approved` | Distinct videos a person approved (the immutable approve intents written by `approve_video_publish`, 0112). |
| `studio_generations` | Studio generations with status `completed`. |
| `last_run_at` | When the newest queue run (`daily` or `repair`) finished successfully. |
| `as_of` | When the numbers were measured (a snapshot of at most five minutes). |

**Left out:** the operator's own workspace (`default_org_id()`) and every
workspace one of whose members is a bound account on the platform staff roster
(`app_members`, matched by user id). Rows with no organization are not counted.
So the strip counts customers' work only, and today it may read low: that is
why it is hidden until real traffic grows.

**Never shown as a number when it is not one.** A count is a real count (a
measured zero shows as 0). A value that is missing or not a number reads "not
measured yet", never 0. No rate or percentage is shown, so a small sample cannot
make one look meaningful. The public read never returns an organization, user,
channel, video, title or any per-tenant row.

## When it shows nothing

The strip renders nothing at all (no empty box, no zeros) when the switch is off,
when migration 0164 is not applied yet, when the read fails or takes longer than
1.5 seconds, or when the answer has no measurement time.

## Undo

`docs/sql/rollback_0164_public_site_stats.sql` (owner-applied) drops the switch
table and the three functions. The site then shows no strip, as before.
