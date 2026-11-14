# Live public counters on the site ("Live from our pipeline")

A small strip on the landing page (under the facts row) and on `/solutions` that
says what the pipeline has actually done, counted from the database: videos
rendered (at least), videos uploaded to YouTube as private, videos a person
approved, Studio generations completed, and the hour in which the last queue run
finished. It is built and wired in, and it is **hidden**: nothing shows until the
owner turns it on, and even then not until at least 5 customer workspaces are
counted (the k rule below).

## The one command

Run it in the Supabase SQL editor of the live project:

```sql
select public.set_public_stats_visible(true);
```

To hide the strip again:

```sql
select public.set_public_stats_visible(false);
```

No redeploy and no environment variable. Turning it on also takes the first
measurement. The site keeps the answer for five minutes
(`command-center/lib/server/public-stats.ts`), so the strip appears, or
disappears, within about five minutes.

**The k rule: at least 5 counted customer workspaces.** With the switch on, the
strip still shows nothing until at least 5 customer workspaces (each with at least
one counted row of any kind) are in the numbers. A customer knows its own counts;
with only one or two others, the totals minus its own would be another tenant's
numbers. To see why the strip is still hidden, and what it would show:

```sql
select public.public_site_stats();
```

In the SQL editor (or signed in as a platform owner/admin) this always takes a
fresh measurement and adds two keys the public never gets: `counted_orgs` (how
many customer workspaces are counted) and `min_counted_orgs` (5). Its `visible`
says whether the site would show the strip right now.

Each switch change writes one row to `security_events` (kind `site.public_stats`,
with `from`, `to` and `via`: `sql_editor` or `admin`), which the owner's Security
page lists. Anyone else who calls the switch gets `42501` and nothing is written.
"The SQL editor" is an allow-list: a session with no API claims whose role is a
member of `postgres` and is not an API role.

## What each number counts

All from migration 0164 (`supabase/migrations/0164_public_site_stats.sql`).

| Key | What it counts |
| :-- | :-- |
| `videos_rendered` | Videos with a finished cut: a recorded master hash, or an upload. A held run stopped before the render is not counted. **A lower bound**, so the site says "at least": a held cut from before migration 0112 has no hash. |
| `videos_uploaded_private` | Uploaded videos that went to YouTube as private: recorded privacy `private`, or private on a read-back before a "publish when approved" request made them public. An upload that went public at once (auto publish on) is not counted. |
| `videos_approved` | Distinct videos a person approved (the immutable approve intents written by `approve_video_publish`, 0112). |
| `studio_generations` | Studio generations with status `completed`. |
| `last_run_at` | The hour (UTC) in which the newest queue run (`daily` or `repair`) finished successfully. Only the hour, so a customer cannot match it to their own run; the site says "between 04:00 and 05:00 UTC". |
| `as_of` | When the numbers were measured. |

**Left out:** the operator's own workspace (`default_org_id()`) and every
workspace one of whose members is a bound account on the platform staff roster
(`app_members`, matched by user id). Rows with no organization are not counted.
So the strip counts customers' work only, and today it may read low: that is
why it is hidden until real traffic grows.

**Never shown as a number when it is not one.** A count is a real count (a
measured zero shows as 0). A value that is missing or not a number reads "not
measured yet", never 0. No rate or percentage is shown, so a small sample cannot
make one look meaningful. The public read never returns an organization, user,
channel, video, title, the number of counted workspaces, or any per-tenant row.

## How fresh the numbers are

The database stores one measurement. Where pg_cron is installed, the job
`nightshift-public-site-stats` refreshes it every 10 minutes. Without pg_cron,
once it is older than 15 minutes, one public read measures again and stores it
(a read-only request answers with the fresh numbers and stores nothing). A public
read never measures when nothing is stored yet: it says hidden. With the site's
five-minute cache, a number on the page was measured at most about 15 minutes
earlier with pg_cron and about 20 without; its "as of" says exactly when.

## When it shows nothing

The strip renders nothing at all (no empty box, no zeros) when the switch is off,
when fewer than 5 customer workspaces are counted, when no measurement is stored
yet, when migration 0164 is not applied yet, when the read fails or takes longer
than 1.5 seconds, or when the answer has no measurement time.

## Undo

`docs/sql/rollback_0164_public_site_stats.sql` (owner-applied) unschedules the
pg_cron job and drops the switch table and the four functions. The site then
shows no strip, as before.
