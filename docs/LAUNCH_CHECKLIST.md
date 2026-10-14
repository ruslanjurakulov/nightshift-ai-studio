# Launch checklist — the standard for nightshift-ai.studio

Twenty things a public site must have before it is called live. The owner adopted
the list as **our standing standard**: it is not a one-off audit. Everything a
machine can check is pinned by tests so it cannot silently regress; what a
machine cannot judge is listed under "owner items" and is the owner's to sign off.

- Tests: `command-center/tests/launch-checklist.test.tsx` (items 1–4, 7, 11–20),
  `tests/page-views.test.ts` (10), `tests/public-forms-errors.test.tsx` (6),
  `tests/crawler.test.ts`, `tests/public-404.test.ts`, `tests/app-icons.test.ts`,
  `tests/middleware-matcher.test.ts` (the gate and the files), `tests/legal*.test.*`.
- Database side of item 10: `supabase/migrations/0104_site_page_views.sql`, pinned
  by `tests/test_site_page_views_migration.py` and the security lab
  (`tests/security/test_sec_page_views.py`).
- Run it all: `cd command-center && npx vitest run`.

**When you add a public page**, add it to `SITEMAP_PATHS` (`lib/public-paths.ts`),
to `PUBLIC_PAGE_PATHS` (`next.config.ts`), to the closed list in migration `0104`'s
`site_page_path_ok` (a *new* migration, never an edit), to `PAGES` in the launch
test, and give it a `describe()` entry in `lib/llms.ts`. The tests name whichever
step is missing. **When you add a language**, add it to `LOCALES`
(`lib/i18n/core.ts`) and nothing else here changes: the metadata, llms.txt and
page-count code all read that one list (migration `0104` accepts any two- or
three-letter lowercase code on purpose).

## The twenty points

Status: **ok** = already true, now pinned; **done** = built in this change;
**owner** = needs the owner's decision or action.

| # | Point | What we require | How it is checked | Status |
|--:|---|---|---|---|
| 1 | Privacy policy | `/privacy`, public, in every language, linked from every public footer, names every processor and every cookie | `legal-docs.test.ts` (sections, links, scopes), launch test (footer link, cookie names) | ok. **Owner:** a lawyer reads the wording (see below) |
| 2 | Terms of use | `/terms`, same | same | ok. **Owner:** lawyer review |
| 3 | Cookie consent | We store only what a feature you asked for needs, say so, and list it. No consent banner is required while that stays true | launch test: the policy names every cookie constant in the code and the theme key; no third-party tracker anywhere in `app/`, `components/`, `lib/` or `package.json`; the only third-party script origins are the payment provider's | **done** (section 9 of the policy in en/ru/uz + footer link `/privacy#cookies`). **Owner:** see "Cookies" |
| 4 | One clear CTA | Every public page's header carries one primary button, "Start free", to `/signup` | launch test, per page and language | ok |
| 5 | Mobile view | Works at 320 px: no horizontal scroll, nothing cut off | measured (below); `auth-shell-narrow-css`, `public-header-fit` tests | ok |
| 6 | Forms work | Sign-in, sign-up and forgot-password show an error in the visitor's language for every failure, never the backend's text, never navigate, and leave the button usable | `public-forms-errors.test.tsx`, `forgot-password-ui.test.tsx`, `signup-handle-ui.test.tsx` (fake backend, no real account, no mail) | ok |
| 7 | Broken links | No internal link or fragment on a public page leads nowhere; external links answer | launch test crawls every public page's rendered HTML in every language (no network); live crawl (below) | ok |
| 8 | Site speed | Measured per public page: TTFB, JS weight, LCP, CLS, image dimensions | measured (below); not a pass/fail test (real-hardware numbers do not belong in CI) | measured. **Owner:** decide whether the figures are good enough |
| 9 | Accessibility | axe finds no serious or critical issue on any public page at 320 and 1280 px in every language | measured (below), 0 violations of any impact | ok |
| 10 | Analytics | First-party, cookieless, privacy-preserving page counts; no third party | `page-views.test.ts`, migration 0104 tests, security lab | **done** (see "Analytics"). **Owner:** read-out is a SQL query |
| 11 | Meta title and description | Per page, per language: unique title (70 characters or fewer), description of 40 to 160 characters | launch test, every public page x every language | ok |
| 12 | sitemap.xml | Lists every public indexable page exactly once, on the site's own origin; nothing private | launch test (also reads the `app/` tree: a new public page that is not listed fails) | ok. `lastmod` is omitted (no build date reaches the server; we do not invent one) |
| 13 | robots.txt | Allow `/`, disallow `/api/`, name the sitemap | launch test (exact), `crawler.test.ts` | ok |
| 14 | Canonical URLs | Every public page's canonical is itself. **hreflang is deliberately off** | launch test | ok (see "hreflang") |
| 15 | Image alt text | No `<img>` without `alt` in a public page | launch test, on the rendered HTML of every page and language, and on the source | ok (live: 0 of 13 home images without alt) |
| 16 | FAQ | The home page answers questions and says so to search engines (FAQPage JSON-LD, same text) | launch test | ok |
| 17 | Custom 404 | The site's own page in the public frame, `noindex`, a way home | launch test, `public-404.test.ts` | ok |
| 18 | Social share | Open Graph and Twitter tags on every public page, `/og.png` 1200x630 | launch test | ok |
| 19 | Favicon | `favicon.ico`, `icon.svg`, `icon.png`, `apple-icon.png`, linked in the head | launch test, `app-icons.test.ts` | ok |
| 20 | llms.txt | `/llms.txt`, text/plain, Markdown per llmstxt.org, every link a real public route, generated from the sitemap's page list | launch test | **done**. `llms-full.txt` is not offered (see below) |

## Cookies and local storage (item 3)

What a scan of the code found (every cookie constant, every `localStorage` and
`sessionStorage` key, every third-party script), and what the policy now says:

- **First-party cookies, all strictly necessary:** the sign-in session
  (Supabase's own cookies), `chronos_locale` (language), `ns_view`
  (Mobile/Desktop), `chronos_channel`, `nightshift_org`, `ns_sidebar` (signed
  in: last channel, organization, menu width), `ns_auth_pending`, `ns_recovery`,
  `ns_invite` (10 min / 15 min / 24 h, one purpose each), and the connect-flow
  nonces `yt_oauth_nonce`, `ig_oauth_nonce`, `tt_oauth_nonce`, `tt_oauth_pkce`
  (10 min).
- **Local storage:** `chronos_theme`, the editor's on-device drafts
  (`ns.editor.draft.v1…`, cleared at sign-out), screen preferences. **Session
  storage (per tab):** navigation stack, unfinished create form, one-time notice,
  paused-animation choice.
- **No advertising, tracking or analytics cookie, and no third-party analytics,
  is set or loaded by our code.** `tests/launch-checklist.test.tsx` fails if a
  new cookie is added without being named in the policy, or if a known tracker
  host or package appears.
- Because everything stored is strictly necessary and the page counts are
  cookieless, **no consent banner is required** and none was built. The owner can
  still ask for one.
- **One third party, on `/pricing` only:** Paddle's price-preview script. On the
  live site it runs against Paddle's *sandbox* (`sandbox-cdn.paddle.com`,
  `sandbox-api.paddle.com`), and Paddle's content network set one security
  cookie, `__cf_bm` (bot protection), in a headless-browser run. The policy
  says plainly that the script and any cookie it sets are Paddle's. **Before
  switching Paddle to production, check whether Paddle Retain (ProfitWell,
  `public.profitwell.com`, allowed by our CSP) loads on `/pricing` for a signed-out
  visitor.** Retain is customer analytics; if it loads, that is a non-essential
  third party and this section and the "no banner" conclusion must be revisited
  (load Paddle.js only after a click, or disable Retain in the Paddle dashboard).
- **The wording is not legal advice.** A lawyer should read section 9 (and the
  page-statistics paragraph in it) in all three languages.

## Analytics (item 10)

The owner decided: first-party, cookieless, nothing leaves our stack. There was
no existing page-view mechanism in the repository (the `analytics` and
`measurement` code is YouTube channel analytics, a different thing).

**What is counted:** one added to a daily total for *(day, public page,
referring site's host, phone-sized or larger screen, language)*. Only the
eleven public marketing pages (`SITEMAP_PATHS`); never `/api`, never an app page.

**What is never stored or sent:** no cookie, no `localStorage`/`sessionStorage`
key, no IP address, no user agent, no fingerprint, no visitor or session id, no
time finer than a day, no referring path or query. The page sends four short
strings with `credentials: "omit"`; the route reads no cookie and no address.

**Respected:** Do-Not-Track and Global Privacy Control (the page does not send;
the route counts nothing if it is sent); a closed bot list matched in memory
(the user agent is never stored); same-origin only.

**Cannot be abused to fill the database:** the route answers `204` whatever it
did; one in-process ceiling (300 a minute); in the database a platform-wide
ceiling of 600 counted views a minute and a cap of 3000 rows a day (a new
combination past the cap is folded into referrer `other`, language `xx`); the
table's CHECKs refuse any path outside the closed list, any malformed host, any
bad device or language shape.

**Database surface (migration 0104, additive, RLS on, no policy):** one table
`site_page_views`, one `SECURITY DEFINER` function `record_page_view` (the only
thing `anon` may call), one pure helper `site_page_path_ok`. No read function.

> **Merging the migration applies it.** A migration file merged to `main` is
> applied to the live database automatically. 0104 needs 0042/0087
> (`web_rate_counters`); it fails loudly, without changing anything, if they are
> missing. Have it reviewed before merging.

**Read it** (owner, Supabase SQL editor; there is no admin page, none existed):

```sql
select path, sum(views) as views from public.site_page_views
 where day >= current_date - 30 group by path order by views desc;
select ref_host, sum(views) as views from public.site_page_views
 where day >= current_date - 30 and ref_host <> '' group by ref_host order by views desc limit 20;
select day, sum(views) as views from public.site_page_views
 where day >= current_date - 30 group by day order by day;
select device, lang, sum(views) as views from public.site_page_views
 where day >= current_date - 30 group by device, lang order by views desc;
```

Known limits, by design: a caller with the public key can inflate the count of a
public page (capped at 600 a minute, never data); reloads count as views; there
is no "unique visitors" figure, because that would need an identifier.

More known limits (from the security review; documented, not engineered away):
past the 600 a minute ceiling every direct call to the function still bumps the
one counter row, so a flood costs the database one tiny write per call; the
per-process 300 a minute limit in the route can, under a flood, starve real
counts; and someone with the public key can fill a day's 3000 rows within a few
minutes, after which that day's later real referring sites are counted under
`other` (page, device and language totals stay right). None of these exposes
data. Only the route's closed list leaves the server: a 404 on any other URL
sends nothing to the database. `/docs/cli` and `/docs/skills` (flag-gated pages)
are deliberately **not** counted, because the SQL and TypeScript lists must stay
identical (`tests/page-views.test.ts` compares them) and those two are not
always public.

## hreflang (item 14)

**Off, and correctly so.** The language is the visitor's `chronos_locale` cookie,
else the browser's `Accept-Language`, on the *same URL* (`lib/i18n/server.ts`
`getLocale`); no URL carries a language. hreflang would be three links to one
address. A launch test fails if a page declares `alternates.languages`. The day
the site serves a language per URL (`/ru/…`), the change is: give `shareMetadata`
(`lib/landing.ts`) the per-language URLs from the `LOCALES` list, emit
`alternates.languages` plus `x-default` from it, make the sitemap list the
variants from the same list, and flip the launch test. Search engines that read
`Accept-Language` will only ever index the version they were served.

## llms.txt (item 20)

`/llms.txt` is generated by `lib/llms.ts` from the same page list as the sitemap
(`lib/site-pages.ts`) plus the OpenAPI spec. Each title and description is the
page's own English copy, so it cannot drift; the MCP line is a neutral sentence
(the page's own description names third-party assistants). No prices, no provider
or model names, no role words (tested). Served `text/plain; charset=utf-8`,
`Cache-Control: public, max-age=3600`, public to everyone (`CRAWLER_PATHS`, so the
gate lets it through and `/llms.txt.rsc` redirects to it). With no configured
origin the links are root-relative, never localhost.

**`llms-full.txt` is not offered.** The only honest way to produce it is to
concatenate the pages' copy, which is the same text three times over the sitemap
descriptions and would have to be regenerated from rendered pages; there is no
single content source to generate it from without copying. If wanted, it should
be built from the dictionaries in a separate change.

## Measured on the live site, 14 October 2026

Method: headless Chromium (Playwright 1.56, the browser in `/opt/pw-browsers`),
public pages only, read-only, 14 pages x en/ru/uz x 320 and 1280 px (84 loads);
pages fetched Node-side because the sandbox's TLS interception is not trusted by
the browser. Timings include that detour and a sandbox-to-server route, so treat
them as indicative, not as lab Lighthouse numbers.

- **Broken links:** 15 URLs (14 pages and one probe) x 3 languages crawled. 89
  distinct internal URLs and every `#fragment`: **0 broken**. 30 external URLs:
  Google, YouTube, Paddle (privacy, buyer terms) all 200; the 22 Pexels credit
  links answer 403 to a script and are valid pages (Pexels blocks non-browser
  clients). The unknown-URL probe answers 404 in every language.
- **TTFB** (median of 5, with the proxy's round trip of about 180 ms included):
  208 to 257 ms for pages, 173 to 181 ms for `robots.txt`/`sitemap.xml`. The
  server's own share is therefore roughly 30 to 80 ms.
- **JavaScript** (uncompressed, executed): 392 to 490 KB over 11 to 16 files on
  the marketing pages; **login 644 KB (25 files), sign-up 619 KB (22),
  forgot-password 604 KB (19)** — about 50 % heavier than a marketing page
  (the sign-in client). Left as is: the fix would change how the auth pages load
  their client, and the brief keeps auth flows untouched. HTML is 170 to 250 KB
  decoded (gzip on the wire); `/mcp` is 435 KB decoded, the largest page.
- **LCP** (median over languages, indicative): 1.3 to 3.4 s; slowest `/mcp`
  (3.1 to 3.4 s) and the home page at 320 px (3.1 s, one run 5.3 s). **CLS:**
  0 on every marketing page, at most 0.008 on the three form pages.
- **Images:** 0 images without width/height attributes; **0 pages scroll
  horizontally at 320 px**; exactly one `<h1>` on every page.
- **Accessibility (axe-core 4.13, all rules):** **0 violations of any impact**
  on all 14 pages at 320 and 1280 px in en, ru and uz (84 runs; the harness was
  checked by injecting a known violation, which axe reports).
- **Forms:** sign-in and sign-up error states are covered in jsdom against a
  fake backend in all three languages (21 tests). No account was created on
  production and no mail was sent.

## Owner items (what a machine cannot decide)

1. **Legal review** of the privacy policy's cookie, storage and page-statistics
   wording, and the Terms, in en/ru/uz.
2. **Merging migration 0104** (applies it to the live database): review first.
3. **Paddle:** the live site's pricing page uses Paddle's *sandbox*; before going
   to production, check Retain (see Cookies) and revisit item 3 if it loads.
4. **Speed:** decide whether LCP of about 3 s on the home page and `/mcp`, and
   the 600+ KB auth pages, are acceptable; a real-device Lighthouse run from the
   target regions is the check we cannot do here.
5. **Search Console / Bing Webmaster:** verify the domain and submit
   `/sitemap.xml` (needs the owner's account).
6. **A consent banner** is not needed under the current design; ask if you want
   one anyway.
7. **`llms-full.txt`:** say if you want it built from the dictionaries.
8. **Sitemap `lastmod`:** needs a build date plumbed to the server (Dockerfile or
   deploy change); omitted until then.
