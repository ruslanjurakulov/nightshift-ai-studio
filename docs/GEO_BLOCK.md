# Blocking a model by country

Some vendors forbid their model in some countries. A registry entry can say so with `blocked_countries`, and the
Command Center then neither offers nor quotes nor starts that model for a request that comes from one of them. No
migration: the database does not know where a request comes from, so the check lives in the web process, in front of
every call that prices, holds or queues anything.

## How a request's country is known

1. **Cloudflare -> Caddy.** The site's DNS record is proxied by Cloudflare, so Caddy's peer is a Cloudflare edge, and
   the visitor's address is in Cloudflare's `CF-Connecting-IP`. `deploy/Caddyfile` writes ONE header on every request it
   proxies, `X-Nightshift-Client-IP`, replacing whatever the client sent:
   - from `CF-Connecting-IP` when the connection came from one of Cloudflare's published ranges
     (<https://www.cloudflare.com/ips-v4>, <https://www.cloudflare.com/ips-v6>, read 2026-11-12; matcher `@viaCloudflare`);
   - from the peer's own address (`{remote_host}`) otherwise (matcher `@notViaCloudflare`): someone who reaches the origin
     directly, bypassing Cloudflare, cannot choose their country by sending a `CF-Connecting-IP` of their own.
   Nothing else Caddy forwards changes: `X-Forwarded-For` is still Caddy's own, so the rate limits that read it see what
   they saw before.
2. **Caddy -> web.** The `web` container publishes no port (`deploy/docker-compose.yml`), so Caddy is the only way in.
   `command-center/lib/geo/client-ip.ts` reads `X-Nightshift-Client-IP` and nothing else. `X-Forwarded-For`,
   `X-Real-IP`, `CF-Connecting-IP` and `True-Client-IP` are never believed for this, whoever sends them.
3. **Address -> country.** `command-center/data/geoip/country.bin.gz` is DB-IP's free "IP to Country Lite" database in a
   compact form (below). A private, local, shared or reserved address has no country.

## Unknown is allowed, and logged

No trusted address (local development, a request that did not come through Caddy), a private address, an address the
table has no country for, or a table that cannot be read: the country is **unknown**, the model is offered and sold as
usual, and the server logs `geo: the country is unknown (<reason>)`. The address itself is never logged. Refusing on
unknown would refuse every visitor the day the table failed to load; that is a decision for the owner, not a default.

## What it cannot do

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
- **Workflows** (operator-only) are not checked by country; their steps are priced by the database.

## The registry field

`blocked_countries`: ISO 3166-1 alpha-2 codes, upper case, unique, at least one. Optional; absent means "no country
list". `command-center/lib/geo/blocked.ts` carries the same lists as `BLOCKED_COUNTRIES` (the web image is built from
`command-center/` only and cannot read the registry); `command-center/tests/geo-block.test.ts` fails when the two differ.

### The row this was built for (not in the registry yet)

The model added by pull request #691 is unavailable in India for that model, and its vendor's whole service is
unavailable in its listed Restricted Territories (the vendor's Geographic Use Policy, sections 2.2 and 3, updated
2026-10-12). When that row is merged, add to it, and to `BLOCKED_COUNTRIES`:

```json
"blocked_countries": ["AF", "BY", "CN", "CU", "ER", "ET", "HK", "HT", "IN", "IQ", "IR", "KH", "KP", "LY", "MM",
                      "MO", "NI", "PK", "RU", "SO", "SY", "VE", "EH"]
```

| Code | Territory | Why |
| :-- | :-- | :-- |
| IN | India | §2.2: the model is unavailable there |
| AF BY KH CU ER ET HT IR IQ LY MM NI KP PK RU SO SY VE EH | Afghanistan, Belarus, Cambodia, Cuba, Eritrea, Ethiopia, Haiti, Iran, Iraq, Libya, Myanmar, Nicaragua, North Korea, Pakistan, Russia, Somalia, Syria, Venezuela, Western Sahara | §3 Restricted Territories |
| CN HK MO | China, Hong Kong, Macau | §3 ("China/HK/Macau") |
| (none) | Crimea, Donetsk, Luhansk | §3, but a country-level table cannot tell them from the rest of Ukraine (see the limits) |

Uzbekistan is on no list.

## The table

- **Source:** DB-IP "IP to Country Lite", <https://db-ip.com/db/download/ip-to-country-lite>, month in
  `command-center/data/geoip/manifest.json` (2026-11: 732,796 ranges; DB-IP's published MD5 of the CSV
  `93c945395f0bc2ceefea7dd55750417a`, checked by the tool before it writes anything).
- **Licence:** Creative Commons Attribution 4.0. DB-IP asks a web application to link back to DB-IP.com on pages that
  display or use results from the database: the Studio's media desks (where a model is hidden or refused by country) carry
  "IP Geolocation by DB-IP" (uz "IP geolokatsiyasi: DB-IP", ru "IP-геолокация: DB-IP") linked to db-ip.com, shown once
  any model has a country list (`t.create.geoAttribution`). The manifest records that the conversion changed the format
  only. The Privacy Policy does not yet say that a request's address is looked up for its country; that text is the
  owner's to add (it is legal copy in three languages).
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
