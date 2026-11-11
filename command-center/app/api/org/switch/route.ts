import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { ORG_COOKIE, coerceOrgs } from "@/lib/orgs";
import { ORG_COOKIE_OPTIONS } from "@/lib/orgs-server";
import { ALL_CHANNELS_SLUG, CHANNEL_COOKIE } from "@/lib/channels";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { readBytesCapped } from "@/lib/server/json-body";
import { publicOrigin } from "@/lib/server/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The most a form post may carry here (one uuid field). */
const MAX_BODY_BYTES = 1024;

/**
 * Switch organization as a NAVIGATION: a same-origin `<form method="post">` (lib/context-switch.ts
 * `submitOrganizationSwitch`) sends `orgId`; the server checks the caller and their membership exactly as
 * /api/org/select does (`my_organizations()`), sets the organization cookie, forgets the remembered channel and
 * answers 303 to `/all-channels`, which the next request resolves under the NEW organization.
 *
 * Why a navigation: leaving the editor's project page runs its unsaved-changes prompt (`beforeunload`). A form
 * submission is a navigation, so the prompt runs BEFORE anything is sent, and Cancel sends nothing; switching
 * first by fetch and then navigating left a person who cancelled on the old page under the new session.
 *
 * Refused: another origin (403, requireSameOrigin), no session (303 to /login), a body that is not one small
 * form field, or an organization the caller is not a member of (303 back to the page the form was on, or /).
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const origin = publicOrigin(request);
  const back = (): NextResponse => {
    let path = "/";
    try {
      const ref = new URL(request.headers.get("referer") ?? "", origin);
      if (ref.origin === new URL(origin).origin) path = ref.pathname + ref.search;
    } catch {
      path = "/";
    }
    return NextResponse.redirect(new URL(path, origin), 303);
  };
  const user = await getUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin), 303);

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return back();
  const bytes = await readBytesCapped(request, MAX_BODY_BYTES);
  if (!bytes) return back();
  const orgId = new URLSearchParams(new TextDecoder().decode(bytes)).get("orgId") ?? "";
  if (!orgId) return back();

  const supabase = await createClient();
  if (!supabase) return back();
  const { data, error } = await supabase.rpc("my_organizations");
  if (error || !coerceOrgs(data).some((o) => o.id === orgId)) return back();

  const response = NextResponse.redirect(new URL(`/${ALL_CHANNELS_SLUG}`, origin), 303);
  response.cookies.set(ORG_COOKIE, orgId, ORG_COOKIE_OPTIONS);
  // The remembered channel belongs to the organization being left (lib/context-switch.ts switchOrganization).
  response.cookies.set(CHANNEL_COOKIE, ALL_CHANNELS_SLUG, { path: "/", maxAge: 31536000, sameSite: "lax" });
  return response;
});
