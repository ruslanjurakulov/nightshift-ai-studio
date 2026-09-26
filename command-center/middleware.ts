import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import {
  ALL_CHANNELS_SLUG,
  CHANNEL_COOKIE,
  CHANNEL_HEADER,
  PATH_HEADER,
  isSection,
} from "@/lib/channels";
import { gateDecision } from "@/lib/public-paths";

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
  url.pathname = path === "/" ? `/${slug}/command-center` : `/${slug}${path}`;
  return url;
}

/**
 * Refreshes the Supabase auth session on every request and gates the app: an
 * unauthenticated visitor is sent to /login, except on the public landing,
 * Privacy, Terms and Pricing pages and the sign-up flow. When Supabase isn't configured we let requests
 * through so the pages can render the NOT CONFIGURED state.
 */
export async function middleware(request: NextRequest) {
  if (!isSupabaseConfigured) return NextResponse.next();

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
  const withChannel = NextResponse.next({ request: { headers } });
  // Carry over any refreshed auth cookies the Supabase client just set.
  response.cookies.getAll().forEach((c) => withChannel.cookies.set(c));
  return withChannel;
}

export const config = {
  // Run on everything except Next internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
