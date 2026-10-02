import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import {
  ALL_CHANNELS_SLUG,
  CHANNEL_COOKIE,
  CHANNEL_HEADER,
  PATH_HEADER,
  SEARCH_HEADER,
  isSection,
  isUnknownRootPath,
} from "@/lib/channels";
import {
  SIGNED_MEDIA_PREFIX,
  gateDecision,
  isPublicApiPath,
  isPublicFontPath,
  isSignedMediaPath,
  isUnknownSolutionPath,
} from "@/lib/public-paths";
import { conceptDecision, conceptsEnabled } from "@/lib/concepts";
import { buildCsp, cspHeaderName, cspMode, makeNonce, reportUri } from "@/lib/security/csp";

/** Next's own route for app/not-found.tsx (it is what an unmatched URL renders). */
const NOT_FOUND_PATH = "/_not-found";

/**
 * Which channel a URL is about, and where a URL that does not say lands.
 *
 * Every screen lives at `/{channel}/{section}` — `/chronos/videos`,
 * `/all-channels/analytics` — so a URL carries the whole view. Paste one and it
 * opens on the same channel and the same screen, in any tab, on any machine.
 *
 * That only works if the channel is read from the path rather than from a
 * cookie, and Server Components cannot see route params from a shared helper.
 * So the segment is resolved here, once, and passed inward as a request header.
 *
 * A URL with no channel — "/" or an old `/videos` link — is redirected rather
 * than guessed at, using the cookie as a memory of the channel last viewed.
 * The redirect is what makes the address bar honest: you always end up looking
 * at a URL that says what you are looking at.
 */
function channelRedirect(request: NextRequest): URL | null {
  const path = request.nextUrl.pathname;
  const first = path.split("/")[1] ?? "";
  if (path !== "/" && !isSection(first)) return null;

  const remembered = request.cookies.get(CHANNEL_COOKIE)?.value;
  // A remembered channel that is now a section name is not a channel, and an
  // unset cookie is not an error — both mean "every channel".
  const slug = remembered && !isSection(remembered) ? remembered : ALL_CHANNELS_SLUG;

  const url = request.nextUrl.clone();
  // With no channel remembered, "/" goes to the bare every-channel segment:
  // its index page lands on the first channel (app/(app)/[channel]/page.tsx),
  // so nobody starts on a roll-up they did not ask for.
  // "/" goes to the channel's index, which picks the viewer's landing
  // (operator: Command Center; customer: Studio) — middleware cannot tell them apart.
  url.pathname = path === "/" ? `/${slug}` : `/${slug}${path}`;
  return url;
}

/**
 * Every response gets the Content-Security-Policy (lib/security/csp.ts), with
 * a nonce minted for this request. The policy goes on the REQUEST too: that is
 * where Next looks for the nonce to stamp on the scripts it renders, and every
 * NextResponse.next({ request }) below forwards it. The signed media file
 * route is left alone: it answers with its own, stricter policy
 * (`default-src 'none'; sandbox`), and a second policy is not needed there.
 */
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith(SIGNED_MEDIA_PREFIX)) return gate(request);
  const header = cspHeaderName(cspMode(process.env.CSP_MODE));
  if (!header) return gate(request);
  const report = reportUri(process.env.CSP_REPORT_URI);
  const policy = buildCsp({
    nonce: makeNonce(),
    supabaseUrl: SUPABASE_URL,
    dev: process.env.NODE_ENV === "development",
    reportUri: report,
  });
  request.headers.set(header, policy);
  const response = await gate(request);
  response.headers.set(header, policy);
  if (report) response.headers.set("Reporting-Endpoints", `csp="${report}"`);
  return response;
}

/**
 * Refreshes the Supabase auth session on every request and gates the app: an
 * unauthenticated visitor is sent to /login, except on the public landing,
 * Privacy, Terms and Pricing pages and the sign-up flow. When Supabase isn't configured we let requests
 * through so the pages can render the NOT CONFIGURED state.
 */
/** The public 404, rendered in place with its status. `request` carries the CSP nonce on. */
function notFoundResponse(request: NextRequest): NextResponse {
  return NextResponse.rewrite(new URL(NOT_FOUND_PATH, request.url), { request, status: 404 });
}

async function gate(request: NextRequest): Promise<NextResponse> {
  // The Atelier concept prototypes (lib/concepts.ts): a separate namespace,
  // decided before the gate and only for it. Off, every path under /atelier is
  // the public 404; on, exactly three URLs are served, noindex. Nothing here
  // touches the matcher, gateDecision() or the public-path lists.
  const concept = conceptDecision(request.nextUrl.pathname, conceptsEnabled());
  if (concept === "hide") return notFoundResponse(request);
  if (concept === "serve") {
    const served = NextResponse.next({ request });
    served.headers.set("X-Robots-Tag", "noindex, nofollow");
    return served;
  }
  // The public pages' two self-hosted font files, by exact name: static, public,
  // and on the critical path of a Russian page's first paint.
  if (isPublicFontPath(request.nextUrl.pathname)) return NextResponse.next({ request });
  if (!isSupabaseConfigured) {
    // No backend, so no account and no app to show. A built site answers every
    // app URL with the public 404 — never the app's frame or its setup notice
    // (env-var names, vendor names). API routes answer for themselves, and
    // `next dev` keeps the setup notice for whoever is wiring the site up.
    const path = request.nextUrl.pathname;
    if (
      process.env.NODE_ENV === "production" &&
      !path.startsWith("/api/") &&
      gateDecision(path, false) === "to-login"
    ) {
      return notFoundResponse(request);
    }
    // `{ request }` so the page still receives the CSP nonce set above.
    return NextResponse.next({ request });
  }
  // The public API authenticates its own bearer key (lib/public-paths.ts);
  // there is no session to refresh and nothing to redirect.
  if (isPublicApiPath(request.nextUrl.pathname)) return NextResponse.next();
  // A signed media link carries its own authorization (lib/server/media.ts).
  if (isSignedMediaPath(request.nextUrl.pathname)) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Only /login, /signup, the auth callback and the public pages (landing,
  // Privacy, Terms, Pricing) are reachable signed out; see lib/public-paths.ts
  // for why the match is exact.
  const decision = gateDecision(request.nextUrl.pathname, Boolean(user));
  // A signed-out visitor who mistyped a URL (/blog, /about) gets the 404, not a
  // sign-in form for a page that was never there. The rewrite serves only the
  // root not-found page: no layout of the app runs, nothing is read.
  if (
    decision === "to-login" &&
    (isUnknownRootPath(request.nextUrl.pathname) || isUnknownSolutionPath(request.nextUrl.pathname))
  ) {
    return notFoundResponse(request);
  }
  if (decision === "to-login" || decision === "to-home") {
    const url = request.nextUrl.clone();
    url.pathname = decision === "to-login" ? "/login" : "/";
    return NextResponse.redirect(url);
  }
  // Served as-is, with any refreshed auth cookies. The public pages sit outside
  // the channel layout, so they get no channel header.
  if (decision === "pass") return response;

  // A channelless URL is sent to one that names its channel.
  const redirectTo = channelRedirect(request);
  if (redirectTo) return NextResponse.redirect(redirectTo);

  // Otherwise the first segment IS the channel: hand it inward as a header, so
  // any Server Component can read the selection without threading params
  // through every page. Copied rather than mutated — a request's own headers
  // are not writable in place.
  const headers = new Headers(request.headers);
  headers.set(CHANNEL_HEADER, request.nextUrl.pathname.split("/")[1] ?? "");
  // The layout needs the whole path to correct a URL naming a channel that does
  // not exist, and a layout cannot read the pathname any other way.
  headers.set(PATH_HEADER, request.nextUrl.pathname);
  // …and the query string, so that redirect keeps it.
  headers.set(SEARCH_HEADER, request.nextUrl.search);
  const withChannel = NextResponse.next({ request: { headers } });
  // Carry over any refreshed auth cookies the Supabase client just set.
  response.cookies.getAll().forEach((c) => withChannel.cookies.set(c));
  return withChannel;
}

export const config = {
  // Run on everything except Next internals, a few exact static files and the
  // body of a media upload (PUT /api/media/uploads/<ticket>). Next buffers a
  // request body in memory for middleware and silently truncates it at 10 MB
  // (experimental.middlewareClientMaxBodySize), so an upload that passed
  // through here would sit whole in RAM and arrive cut short. That route
  // checks the session itself.
  //
  // Every exclusion is ANCHORED (BR-H-001). A request this matcher skips gets
  // no auth gate at all, and the router still resolves it as an app page when
  // it can: an unanchored `favicon.ico` skipped `/favicon.icox/providers`, and
  // `.*\.png$` skipped `/chronos/videos/x.png` — both rendered the console
  // signed out. So Next's own prefixes end in a slash or at the end of the
  // path, each static file is named exactly (dots escaped), and an upload is
  // one segment. A new file under public/ must be named here
  // (tests/middleware-matcher.test.ts fails until it is); until then it is
  // gated, never the other way round. The public site's icon.svg and its two
  // self-hosted font files (FONT_FILES in next.config.ts) are named the same way.
  matcher: [
    "/((?!_next/static/|_next/image$|favicon\\.ico$|icon\\.png$|icon\\.svg$|apple-icon\\.png$|og\\.png$|fonts/sofia-sans-cyrillic-v20\\.woff2$|fonts/sofia-sans-extra-condensed-cyrillic-v6\\.woff2$|api/media/uploads/[^/]+$).*)",
  ],
};
