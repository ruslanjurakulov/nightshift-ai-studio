# S7 — Language URLs & SEO: diagnosis and plan

Stream S7 of the build program (`docs/studio/PROGRAM.md`, draft PR #891). Owner's decision of 22 Nov 2026: the public site
gets one URL per language, like kling.ai (`/ru`, `/ru/blog`), remembers the choice and sends later visits to it. Today a
crawler sees each public page in exactly one language, so we cannot rank for Russian or Uzbek searches.

This file is the measurement (CLAUDE.md rule 8). Evidence first, then the diagnosis, then the change.

## 1. Evidence: how the locale is resolved today

| Where | What it does |
| :-- | :-- |
| `lib/i18n/core.ts` | `Locale = "en" \| "ru" \| "uz"`, `DEFAULT_LOCALE = "en"`, cookie **`chronos_locale`** (not `NEXT_LOCALE`). |
| `lib/i18n/server.ts` `getLocale()` | cookie → first supported tag of `Accept-Language` (q-values ignored, list order) → `en`. |
| `app/layout.tsx` | `<html lang={await getLocale()}>`, mounts `PublicI18nProvider` with the public dictionary slice. |
| `lib/i18n/public-context.tsx` | `setLocale()` writes the cookie (1 year, `path=/`, `samesite=lax`) and calls `router.refresh()`. The URL never changes. |
| `components/LanguageSelector.tsx` | The EN/RU/UZ menu in the public header and the app; calls `setLocale`. |
| Every public `page.tsx` | `getDictionary()` → `getLocale()`; `generateMetadata` passes `locale` and `path` to `shareMetadata`. |
| `lib/landing.ts` `shareMetadata` | `alternates.canonical = path` (one URL for all three languages), `og:locale`. **No `hreflang`.** |
| `app/sitemap.ts` | One `<url>` per path from `listedPagePaths()`; no alternates. |
| `middleware.ts` | Knows nothing about locale. Strips its own request headers (`lib/security/internal-headers.ts`, #907) first. |

So the same URL answers in three languages depending on a cookie or a header a crawler does not send. Googlebot crawls
without `Accept-Language` and without cookies: it only ever sees English, the canonical claims that English URL for all
three, and there is no `hreflang` pointing anywhere else. That is the whole SEO problem.

`getLocale()` is the single seam: every public page, the root layout's `lang` and the metadata read the locale through
it. Nothing else decides the language.

## 2. Every public route (signed out, `lib/public-paths.ts`)

Indexable pages — the sitemap list (`lib/site-pages.ts listedPagePaths`): `/`, `/studio`, `/pricing`, `/solutions`,
`/solutions/youtube-channels`, `/solutions/creative-studio`, `/solutions/developers`, `/docs/api`, `/mcp`, `/privacy`,
`/terms`, and the uncounted ones `/roadmap`, `/refund`, `/trust`, `/referral`, `/data-deletion`. Behind `DEV_CLI_PAGE=1`:
`/docs/cli`, `/docs/skills`.

Public but not pages to translate per URL (stay exactly as they are):

- sign-in flow: `/login`, `/login/verify` (MFA), `/signup`, `/forgot-password`, `/reset-password`, `/welcome`
- auth: `/auth/callback`, `/auth/confirm`, `/oauth/*` and `/.well-known/*` (OAuth/MCP), every `/api/*`
  (`/api/v1`, `/api/pv`, `/api/mcp`, `/api/handle-available`, `/api/email/unsubscribe`, signed media `/api/media/file/*`)
- token links: `/i/<token>`, `/invite`, `/r/<token>[/video]`, `/unsubscribe`
- machine files: `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/docs/api/openapi.json`, fonts, icons, the manifest
- `/atelier` (concept flag), the 404

Two public pages have a signed-in meaning: `/` (signed in → the app, `channelRedirect`) and `/studio` (signed in → the old
section link). `gateDecision()` encodes both.

## 3. Every place that builds a public link

Server-built: `components/legal/PublicShell.tsx` (header nav, logo `/`, `/login`, `/signup`; passes items to
`PublicMenu.tsx`, which matches the active item with `usePathname()`), `PublicFooter.tsx`, `LegalFooter.tsx`
(`/pricing`, `/privacy`, `/terms`), `app/not-found.tsx`, `app/solutions/page.tsx`, `lib/solutions.ts solutionHref`.

Body components: `components/site/StudioPage.tsx`, `SolutionView.tsx`, `AutopilotPillar.tsx`, `AutopilotDemo.tsx`;
`components/landing/*` and `components/landing/home/HomePage.tsx` (**owned by PR #889 — not edited here**).

Machine-built: `app/sitemap.ts`, `app/llms.txt/route.ts`, `shareMetadata` (canonical, `og:url`), JSON-LD in `app/page.tsx`.

Also path-sensitive: `components/site/PageViewBeacon.tsx` posts `usePathname()` to `/api/pv`, whose closed SQL list
(migration 0104) holds unprefixed paths only — a `/ru/pricing` view would be refused.

## 4. Decisions

**English unprefixed, `ru` and `uz` prefixed** (`/pricing`, `/ru/pricing`, `/uz/pricing`). Not "every locale prefixed":

- Every URL in the world today (Google's index, the OAuth consent screen's homepage/privacy/terms links that Google
  verified for `youtube.upload`, Paddle's seller verification, e-mails, backlinks) is unprefixed. Prefixing English would
  turn each of them into a redirect hop, and a verified OAuth homepage that redirects is a risk we do not need.
- Google accepts either layout; what it needs is a distinct URL per language plus reciprocal `hreflang`. The unprefixed
  English URL doubles as `x-default`.
- `/en/...` is not a page: it answers **308** to the unprefixed path (deterministic, cacheable, no duplicate URL).

**Serving a prefixed URL is a rewrite, not a new route tree.** The middleware strips `/ru` and rewrites to the existing
page, setting a middleware-owned request header `x-nightshift-locale: ru` (added to `MIDDLEWARE_OWNED_REQUEST_HEADERS`,
so a client cannot send it). `getLocale()` reads that header first. No page moves into `app/[locale]/`, no homepage
component changes (#889 untouched), and `<html lang>`, the dictionary and the metadata all follow the URL through the
one seam. An unprefixed localizable page gets `x-nightshift-locale: en`: the URL, not the cookie, decides its language.
Only the paths in §2's indexable list are localizable (`LOCALIZED_PATHS`, exact match like every other public list);
`/ru/<anything else>` is the public 404. `en`, `ru`, `uz` join `RESERVED_ROOT_SEGMENTS`, so no channel can take them.

**First visit: cookie, then `Accept-Language`, redirect with 307.** A top-level GET/HEAD navigation (Sec-Fetch-Mode
`navigate`, or `Accept: text/html` on old browsers) to an unprefixed localizable page, by someone for whom that page is
public, goes to the prefixed URL when the cookie says `ru`/`uz`, or, with no cookie, when the highest-q supported language
in `Accept-Language` is `ru`/`uz`. **307, not 308**: the target depends on the visitor. A permanent redirect is cached by
the browser, so a person who later picks English would be sent back to `/ru` forever (a loop the server can no longer
break), and it would tell Google the English page moved. The 307 carries `Cache-Control: private, no-store` and
`Vary: Cookie, Accept-Language`; served pages get `Vary` too, so no cache hands one language's answer to another. Not
redirected: crawlers' cookie-less, header-less requests (they get English, as they should for `x-default`), RSC/prefetch
fetches, non-GET, signed-in `/` and `/studio` (the app), the query string is kept.

**Remembering the choice.** The switcher writes the cookie and navigates to the same page in the other language
(`localeHref`). Opening a `/ru` or `/uz` URL as a navigation also sets the cookie when it differs (kling's behaviour: the
language you arrived in is remembered), so the sign-in flow, which stays unprefixed and cookie-driven, keeps that language.
Unprefixed English never sets it (it is the redirect source, not a choice); to go back to English the switcher sets `en`.

**Signed in.** The app (`/{channel}/{section}`, cookie locale) does not change. `/ru` or `/ru/studio` signed in resolves
like `/` or `/studio`: a redirect to the unprefixed path, which the existing gate sends to the app. Public pages that a
signed-in person may read (`/ru/pricing`) are served in Russian as for anyone.

**Metadata.** `shareMetadata` gets the locale it is already passed: canonical = the URL of this language,
`alternates.languages` = `en`, `ru`, `uz`, `x-default` (→ English) for localizable paths; non-localizable pages (`/login`,
`/signup`) keep today's single canonical. `og:url` follows the canonical; `og:locale:alternate` lists the other two.

**Sitemap.** Every localizable path × 3 languages, each `<url>` with `xhtml:link rel="alternate"` for en/ru/uz/x-default
(Next's `alternates.languages` on a sitemap entry). `llms.txt` keeps the English list (it is for machines reading English).

**Page views.** The beacon sends the unprefixed path (the SQL list stays as it is, no migration) and already sends `lang`.

### Helper (agreed with S5 for the mega-menu)

`lib/i18n/locale-path.ts`, client-safe, no dictionary: `localeHref(locale, href)`, `splitLocalePath(pathname)`,
`LOCALIZED_PATHS`, `isLocalizedPath()`. `localeHref("ru", "/pricing") = "/ru/pricing"`, `localeHref("en", x) = x`,
anything not localizable (`/login`, `/api/…`, external, `#hash`) is returned unchanged, so every href can be wrapped.

## 5. What must not change (each pinned by a test)

Signed-in redirects (`/` → channel, `/studio`, zombie sections), MFA (`/login/verify`, enrol-only), `/login` `/signup`
`to-home`, `/auth/callback` `/auth/confirm` `/oauth/authorize` (incl. its `next`), every `/api/*` (401/503 JSON for calls),
signed media, review links, invite links, unsubscribe, fonts and static files (matcher untouched), dev pages and
`/atelier` flags, the internal-header strip, CSP nonce on rewritten pages, the frame (view-mode) headers.

## 6. Plan (draft PRs, `claude/nsai-s7-*`)

1. **`claude/nsai-s7-locale-urls`** — this doc; `locale-path.ts`; middleware rewrite/redirect/cookie; `getLocale()`
   header; reserved segments; `shareMetadata` hreflang + canonical; sitemap alternates; switcher navigates; beacon path;
   localized links in `PublicShell`/`PublicFooter`/`LegalFooter`/`not-found` (unless S5 owns them at that point).
   Tests: unit (helper, Accept-Language, redirect table, every pinned behaviour of §5), Playwright on a production build
   (every localizable page × 3 → 200, `lang`, `hreflang`, canonical; switcher keeps the page; no redirect loop; app untouched).
2. **`claude/nsai-s7-body-links`** — `localeHref` in the body components (`StudioPage`, `SolutionView`, `Autopilot*`),
   and the homepage components after #889 merges. Until then a Russian page's body links are unprefixed; a visitor with
   the cookie set (every visitor who opened a `/ru` URL) is sent straight back to `/ru` by the 307, so nobody lands in
   the wrong language, and crawlers find the `/ru` URLs through `hreflang` and the sitemap.

Open item for Atlas: confirm no live channel has the id `en`, `ru` or `uz`
(`select id from channels where id in ('en','ru','uz')`); such a channel's screens would become unreachable.
