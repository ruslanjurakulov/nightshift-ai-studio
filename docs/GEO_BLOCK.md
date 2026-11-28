# Blocking a model by country

Some vendors forbid their model in some countries. A registry entry can say so with `blocked_countries`, and the
Command Center then neither offers nor quotes nor starts that model, through its own routes, for a request that comes
from one of them. The database does not know where a request comes from, so the check lives in the web process, in the
routes and pickers listed below. **The web check alone is not in front of every call that prices, holds or queues
anything:** a signed-in user can call the database functions directly and skip it. Migration 0208 adds the database's own
check (below: a job on a model with a list needs a country our web server signed). 0142 kept every model with a list off
sale; since 0238 a row with a list may go on sale only when it also carries its vendor's allow-list (`available_countries`),
and only once 0230's gate is live. A deny-list-only row stays off sale. Opening one is still the owner's act.

## Google's models: an allow-list (2026-11-21)

Google's terms allow its API only inside the regions it lists ("You may only access the Services (or make API Clients
available to users) within an available region", Gemini API Additional Terms, effective March 23, 2026; the list:
<https://aistudio.google.com/docs/available-regions>, read 2026-11-21, no "last updated" date on the page). So every
`provider: google` row carries `blocked_countries` = every ISO 3166-1 alpha-2 code not on that list (19 codes: AF BV BY CN CU GP
HK IR KP MF MM MO MQ PF RU SJ SX TF YT), computed in one place (`command-center/lib/geo/blocked.ts`: `ISO_3166_ALPHA2`,
`GOOGLE_AVAILABLE_REGIONS`, `GOOGLE_BLOCKED`; the twin test compares each registry row). Kosovo is listed by Google and has no
ISO code; DB-IP writes it XK, which is allowed. For these models an **unknown country is refused whatever the reason**
(`REFUSE_UNKNOWN_COUNTRY`; 451 `country_unverified`, whose sentence says to turn off a VPN or proxy and reload), and they are
hidden from the pickers for such a request. The three Veo rows had no terms gate (they are past their shutdown date); they
got `terms_review_required`, because a country list needs one (0142). No Google model is opened by this.

## The database's own check (0208)

Since 0208 the database checks the country for every creative job on a model with a country list.

A member holds the anon key and their session, so the web routes alone cannot stop a direct `create_creative_job`. 0208 puts
a trigger on `creative_jobs` (every path writes there: the Studio, a workflow step, the API and MCP, a Film Studio take, the
worker's failover): a job on a model with a non-empty `blocked_countries` needs the header `x-nightshift-geo` =
`v1.<country>.<user id>.<expiry>.<HMAC-SHA256>`, signed by the web server (`command-center/lib/server/geo-claim.ts`) with the key
it shares with Supabase Vault only, made for this user, at most 300 seconds ahead. No valid claim: `country_unverified`; a
listed country: `country_blocked`. The header goes from our server to Supabase, never to the browser, and is sent only on a
call that may create a job on a gated model (the Studio's create, the region editor's run, Run now and the advance of a
workflow with such a step). The country is read in the transaction and stored nowhere.

Not vouched for, so refused for a gated model: the worker moving a job onto one (failover: `reroute_creative_job` skips that
candidate and tries the next, it does not abort the failover), a Film Studio take (the worker
makes it; there is no visitor), the API and MCP (a server's address says nothing about the person; these models are
`web_only` anyway), and a workflow step carried on from another member's page (the claim is bound to the person whose session
makes the call, and the step is made as the run's starter). Setup: the same 32+ character value in the web's
`NIGHTSHIFT_GEO_CLAIM_KEY` and in Vault as `nightshift_geo_claim_key`; without it every job on a gated model is refused and
the web logs the remedy.

**Opening steps, in this order** (before any model with a list is opened; 0208 says so with a NOTICE when a step is missing):

1. **Registry sync.** `python tools/probe_models.py --sync` copies `schemas/model_registry.json` into `model_registry`. The
   trigger reads `spec.blocked_countries` from the database row, so until the sync has run a Google row has no list there and
   the database does not gate it at all (0208 raises a NOTICE naming how many `provider = 'google'` rows have none).
2. **Vault key.** `select vault.create_secret('<value>', 'nightshift_geo_claim_key');` once, in the SQL editor (32+ characters;
   the value is never written in a file). 0208 raises a NOTICE while it is missing.
3. **Web key.** The same value as `NIGHTSHIFT_GEO_CLAIM_KEY` in the web's environment, then a redeploy. Without it the web signs
   nothing and every gated job is refused `country_unverified`.

**An unknown country fails closed in the database.** The web signs a claim only for a country it read; for a visitor whose
address DB-IP has no country for (`not_in_table`, below) it sends none, so the database refuses a job on any model with a list
with `country_unverified`, including a model the web allows such a visitor to see and quote (`grounded-image-1.0`, which is not
an allow-list model). For Google's models web and database agree (both refuse an unknown country).

**An allow-list vendor is gated by its allow-list (0230, BR-S6-04, BR-S6-05).** Google's `blocked_countries` is only the
complement of its list in ISO 3166-1, so under 0208 a signed code on neither list (EU or AP from the country table, ZZ, any two
capital letters) passed the database. Since 0230 every Google row also carries `available_countries` (Google's own list, synced like
`blocked_countries`), and the trigger refuses a code not on it as `country_unverified`; a listed blocked country is still
`country_blocked`. A row with `available_countries` is asked even when it has no `blocked_countries`. A Google row synced before
0230 has no allow-list and is refused every job until the sync runs (step 1 above; it may run before 0230 is applied, which avoids
that window; 0230 raises a NOTICE). A non-Google deny-list-only model (`grounded-image-1.0`) keeps 0208's rule.

**A model with both lists may be put on sale (0238).** 0142's CHECK `model_registry_countries_before_sale` (same name) now
refuses `beta`/`ga` for a row with a non-empty `blocked_countries` only when its spec has no non-empty `available_countries`
array. 0238 refuses to apply unless `creative_jobs_geo_gate` is 0230's body and its trigger is attached and enabled; the CHECK
reads the row, not the gate, so the order of undoing is fixed: take such a model off sale, roll back 0238, then 0230 or 0208
(both rollbacks refuse while a country-listed row is on sale). No row changes availability in 0238. The registry validator
holds the same line: `blocked_countries` with no `terms_gate` needs `available_countries`. The two Google image models the owner
cleared on 2026-11-28 (`gemini-3-pro-image`, `gemini-nano-banana-2.1`) stay `hidden` and unpriced; they are marked operator
previews (0139), which creative_price still quotes `unpriced` (priced by size, no per-size row). A Film Studio take carries no
visitor, so the gate refuses it (`country_unverified`) for these rows.

## How a request's country is known

1. **Visitor -> Caddy.** Nothing is in front of the server: the domain's nameservers are Porkbun's, its one `A` record points
   straight at the box, and there is no `AAAA` (read 2026-11-12). So the peer of every connection Caddy accepts is the visitor
   (or their VPN). `deploy/Caddyfile` writes that address into ONE header on every request it proxies, replacing whatever the
   client sent:

   ```
   request_header X-Nightshift-Client-IP {remote_host}
   ```

   No header is believed to name another address. `CF-Connecting-IP`, `X-Real-IP` and `X-Forwarded-For` from a client change
   nothing: with no proxy in front, anything that honoured `CF-Connecting-IP` from "Cloudflare's ranges" could be driven by a
   visitor whose own connection comes from one (WARP, a Worker). `X-Forwarded-For` is still Caddy's own, as before.
   **If a proxy or CDN is ever put in front**, this line must change in the same change (the peer would then be the proxy), and
   only that proxy's addresses may be trusted to name the visitor.
2. **Caddy -> web.** The `web` container publishes no port (`deploy/docker-compose.yml`), so Caddy is the only way in.
   `command-center/lib/geo/client-ip.ts` reads `X-Nightshift-Client-IP` and nothing else. On a Vercel deploy (the platform sets
   `VERCEL=1`) there is no Caddy and a visitor could send that header, so there the platform's own `x-vercel-forwarded-for` is read
   instead. The three per-address rate limits that used to believe a header a client can send (the sign-up handle check and the
   MCP client registration, `cf-connecting-ip`; the friend-invite link's visit limit, `x-vercel-forwarded-for` then
   `x-forwarded-for`; ledger BR-L-192) read the same address now.
3. **Address -> country.** `command-center/data/geoip/country.bin.gz` is DB-IP's free "IP to Country Lite" database in a
   compact form (below). A private, local, shared, documentation or reserved address has no country.

## Where it is enforced

| Path | What happens for a country on the model's list |
| :-- | :-- |
| Studio picker, Home's assistant, Workflows, region editor (`loadStudioModels`), the operator's preview list | the model is not listed |
| `POST /api/creative/quote`, `POST /api/creative/jobs` (a named model) | 451 `country_blocked`, before any database call |
| the same routes, automatic choice (`auto`, `cheap`, `fast`, `quality`) | see below |
| `POST /api/region-edit/quote`, `/run` | the model is not among the ones it may pick (`loadStudioModels`); `/run` also answers 451 by name before `create_creative_job`, and sends 0208's signed country |
| `POST /api/workflows/runs/[id]/advance` | not refused (an advance also settles the finished step); sends 0208's signed country only for a run with a gated step, and the database refuses the gated step's job without a valid one |
| `POST /api/workflows/[id]/quote`, `/run` | 451 `country_blocked` if ANY step names such a model, before the database prices or holds anything. `/run` checks the steps of the version the body names: if the workflow reads as another version it answers 409 `workflow_changed` (an edit after the check raises the version, and the database then refuses the run, 0073); one it cannot read is refused, never passed on unchecked |
| API and MCP | never offered: a model with a list must be `web_only` |

**Automatic choice and failover.** The database picks a model (`route_model`, 0075) and keeps a failover list (0088) without
knowing where the request comes from, and every sellable model is a candidate: nothing in the registry file can take a model out of
routing (availability and price live in the database), so a validator rule cannot do it. Without a migration, the web does it
(`command-center/lib/creative/route-around.ts`), and only for a visitor whose country is known and forbids a model that could make
the thing asked for:

- **Quote.** If the database's pick is forbidden here, the same choice is made among the models that remain: each is priced by
  the database's own exact quote, and they are ranked by `route_model`'s own rules (a test pins the port against the SQL text).
  The automatic choice is therefore never a dead end; `country_blocked` is answered only when no remaining model can make it.
- **Create.** The job is started in `exact` mode with the model the quote named. An exact job never fails over, so no later step
  can move it onto a forbidden model, and the database does not refuse a pick that is not its own. The cost: such a job is not
  retried on another model when its vendor is down.

Everyone else (an unknown country included) takes the database's path untouched.

**Not checked.** A workflow run that was started elsewhere and is carried on (`/advance`) from a blocked country: the run and its
price were confirmed at the start. Series and channel runs name no registry model in any request (they run the channel's configured
pipeline), so there is nothing to check by country there. Character Studio has its own two models and its own table.

## Unknown: allowed for a visitor, refused for a broken setup

The country can be unknown for four reasons, and they are not alike (`lib/server/geo.ts`, `unknownRefuses`):

| Reason | What it means | Production (self-hosted) | Development, tests, Vercel |
| :-- | :-- | :-- | :-- |
| `not_in_table` | a public address DB-IP has no country for | allowed, logged (the web); the job is refused `country_unverified` by the database (0208 fails closed) | the same |
| `no_address` | no `X-Nightshift-Client-IP`: the request did not come through Caddy, or Caddy did not write it | **refused and hidden** | allowed, logged |
| `not_public` | a private or local peer: the same | **refused and hidden** | allowed, logged |
| `no_table` | `data/geoip/country.bin.gz` cannot be read | **refused and hidden** | allowed, logged |

"Refused and hidden" applies only to a model with a country list: it is left out of every picker, a named quote or create
answers 451 `country_blocked`, a workflow with such a step is refused, and the automatic choice treats it as forbidden and
chooses among the rest. Every other model is untouched. Production means `NODE_ENV=production` without `VERCEL=1`
(`GEO_STRICT`). The server logs `geo: the country is unknown (<reason>)` either way, as an error when it refuses; the
address itself is never logged.

**At start.** `command-center/instrumentation.ts` runs `checkGeoTableAtStartup()` once when the server starts: when a model
has a country list and the table cannot be read, it logs `GEO TABLE MISSING ...` as an error, so a broken image shows in the
deploy's logs before the first visitor. The container's health check (`/login`) is not changed by it: the rest of the site
works, and the listed models fail closed.

## What it cannot do

- **(Before 0208.) The database did not check the country.** 0208 closes this for jobs (above); the paragraph is kept for the
  history of 0142. `create_creative_job` (0075), `start_workflow_run` (0073) and
  `advance_workflow_run` (0074) are granted to `authenticated`, and the browser holds the anon key, the project URL and the
  session (the cookie is readable by the page). A signed-in user can therefore call `supabase.rpc('create_creative_job', ...)`
  directly and skip every check on this page. What stops that from mattering today: a model with a country list cannot be on
  sale. The registry validator refuses `blocked_countries` without a `terms_gate` (which 0035 keeps off sale), and migration
  0142 refuses `beta`/`ga` for such a row in the database (a CHECK, so the platform admin, the service role and a sync are all
  refused). The fix that lets such a model be sold comes in a follow-up: either pass a server-attested country into these
  functions, or revoke them from `authenticated` behind a server-only wrapper that the web calls after its check.

- **A VPN, a proxy, Tor, a corporate network, or a roaming SIM** reads as the country it exits in. A person in a blocked
  country with a VPN abroad is let through; a person abroad on an exit in a blocked country is refused. Blocking by
  address is a reasonable effort, not proof of where a person is. If a vendor requires more (a billing address, a phone
  country, a declaration), that is a separate check.
- **The table is DB-IP's Lite edition** (accuracy index 81 per DB-IP, against 93 for their paid edition), updated
  monthly. An address block that moved countries since the month shipped reads as the old one.
- **Regions inside a country** (for example Crimea, Donetsk and Luhansk) cannot be told apart from the rest of the
  country at country level: the lookup answers the country DB-IP assigns, so such a region is blocked only when its whole
  country is on the list.
- **The API and MCP** sell to a server, whose address says nothing about the person behind it. A model with
  `blocked_countries` must therefore be `api_exposure: web_only` (the registry validator refuses anything else), so it is
  never offered there.

## The registry field

`blocked_countries`: ISO 3166-1 alpha-2 codes, upper case, unique, at least one. Optional; absent means "no country
list". `command-center/lib/geo/blocked.ts` carries the same lists as `BLOCKED_COUNTRIES` (the web image is built from
`command-center/` only and cannot read the registry); `command-center/tests/geo-block.test.ts` fails when the two differ.

### The row that carries a list today

One registry row has a list: the hidden, terms-gated image model added by pull request #691. Its vendor's Geographic Use
Policy (<https://dev.meta.ai/legal/geographic-use-policy>, last updated 2026-11-09, read 2026-11-12) makes the vendor's
whole service unavailable in its Restricted Territories (section 3). Its model-specific list (section 2.2) now names only two
other models, in South Korea; India, barred for this model by the 2026-10-12 version, is no longer listed. The row and
`BLOCKED_COUNTRIES` carry the same 22 codes:

```json
"blocked_countries": ["AF", "BY", "CN", "CU", "EH", "ER", "ET", "HK", "HT", "IQ", "IR", "KH", "KP", "LY", "MM",
                      "MO", "NI", "PK", "RU", "SO", "SY", "VE"]
```

The model stays hidden and terms-gated: the list does not open it. Whether blocking by address is enough for that vendor's
terms is the owner's decision (the row's terms note says what it cannot do).

| Code | Territory | Why |
| :-- | :-- | :-- |
| AF BY KH CU ER ET HT IR IQ LY MM NI KP PK RU SO SY VE EH | Afghanistan, Belarus, Cambodia, Cuba, Eritrea, Ethiopia, Haiti, Iran, Iraq, Libya, Myanmar, Nicaragua, North Korea, Pakistan, Russia, Somalia, Syria, Venezuela, Western Sahara | §3 Restricted Territories |
| CN HK MO | China, Hong Kong, Macau | §3 ("China/HK/Macau") |
| (none) | Crimea, Donetsk, Luhansk | §3, but a country-level table cannot tell them from the rest of Ukraine (see the limits) |

Uzbekistan is on no list.

## The table

- **Source:** DB-IP "IP to Country Lite", <https://db-ip.com/db/download/ip-to-country-lite>, month in
  `command-center/data/geoip/manifest.json` (2026-11: 732,796 ranges; DB-IP's published MD5 of the CSV
  `93c945395f0bc2ceefea7dd55750417a`, checked by the tool before it writes anything).
- **Licence:** Creative Commons Attribution 4.0. DB-IP asks a web application to link back to DB-IP.com on pages that
  display or use results from the database. Every page whose model picker is filtered by country carries
  "IP Geolocation by DB-IP" (uz "IP geolokatsiyasi: DB-IP", ru "IP-геолокация: DB-IP") linked to db-ip.com: the Studio's
  media desks, Home, Workflows and the region editor (`components/legal/GeoAttribution.tsx`, shown once any model has a
  country list). The Privacy Policy carries the same linked credit. The manifest records that the conversion changed the
  format only.
- **Privacy Policy.** Section 2 says, in uz, ru and en, what is looked up (the country of the request's IP address, for
  some models only), why, that it is done on our own server and sent to no one, that this check stores neither the address
  nor the country, and that a VPN reads as its exit. **Release day:** set the repository variable
  `NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE` to the new date and redeploy web (the date is not in the code; `/privacy` reads it
  from that variable), as for every change of the legal texts.
- **Why committed, and why not the CSV.** DB-IP's download server keeps only the current and the previous month, so a
  Docker build that fetched a pinned URL would start failing about two months later. The compact table is 2.2 MB
  gzipped (the CSV is 4.6 MB), costs nothing to parse (the web process gunzips it once, when a model with a list is first
  asked about, and binary-searches typed arrays), and adds about 2 MB to the image.
- **Refreshing it (monthly is enough):**

  ```bash
  curl -fsSLO https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.csv.gz
  python3 tools/geoip_build.py dbip-country-lite-YYYY-MM.csv.gz command-center/data/geoip/country.bin.gz \
      --month YYYY-MM --source-md5 <the MD5SUM printed on the download page>
  ```

  It rewrites `country.bin.gz` and `manifest.json`; commit both. The same month always rebuilds to the same bytes.
- **Where it is read:** `data/geoip/country.bin.gz` under the web process's working directory (the image's `/app`, or
  `command-center/` for `next dev`). `command-center/Dockerfile` copies `data/geoip` into the image.
