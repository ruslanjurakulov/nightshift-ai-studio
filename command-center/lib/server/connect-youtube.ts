import "server-only";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { requireRole } from "@/lib/auth/roles";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { publicOrigin } from "@/lib/server/public-origin";
import {
  YOUTUBE_OAUTH_SCOPES,
  buildAuthUrl,
  buildTokenJson,
  encodeState,
  exchangeCode,
  isGoogleOAuthConfigured,
  tokenSecretName,
  type GoogleState,
} from "@/lib/server/google-oauth";
import { fetchTokenStatuses, storeVaultToken } from "@/lib/server/channel-tokens";
import { fetchPublicKey, isGithubConfigured, putSecret } from "@/lib/server/github-secrets";
import {
  PENDING_COOKIE,
  claimPending,
  createPending,
  dropUserPending,
  finishPending,
  pendingCookieOptions,
  releasePending,
  type YoutubeGrant,
} from "@/lib/server/connect-pending";
import { missingScopes } from "@/lib/channel-tokens";
import { readChannelPrefill } from "@/lib/welcome";
import {
  CONNECT_PICK_PATH,
  coerceYoutubeChannels,
  connectBackPath,
  pickedChannelSlug,
  type ConnectWord,
  type ConfirmResult,
  type YoutubeCandidate,
} from "@/lib/connect-picker";

/**
 * Connect YouTube, then pick the channel (the Add channel screen's one button).
 *
 * Start: refuse before the consent screen unless the caller may create AND
 * connect a channel where the token will live, then send the browser to
 * Google's chooser. Callback: check the CSRF nonce, exchange the code, read the
 * channels the authorisation can act for (channels.list, mine=true — the
 * youtube.readonly scope the flow already requests; nothing is widened) and
 * hold the result server-side (connect-pending.ts) for the pick screen.
 * Confirm: re-check the caller, re-validate the chosen id against THAT list,
 * create the channel paused and linked, and store the token through the same
 * mechanism the per-channel connect uses.
 *
 * Google issues a token for the identity picked on its own consent screen: a
 * Brand Account's channels are chosen THERE, so one authorisation usually
 * lists one channel (several only where the identity owns several). The pick
 * screen says so and offers "use another account", which runs the consent
 * again. Only one list entry is ever attached to one token: a token uploads as
 * the channel it was granted for, so attaching it to several would aim videos
 * at the wrong one.
 */

const NONCE_COOKIE = "yt_oauth_nonce";

export type PickAccess =
  | { ok: true; store: "vault" | "github"; orgId: string }
  | { ok: false; word: ConnectWord };

/**
 * Who may connect a new YouTube channel here, and where its token goes.
 *
 * - the operator's own organization: platform owner/admin, the token is a
 *   GitHub Actions secret (as /api/oauth/youtube/callback does);
 * - any other organization: an owner/admin of THAT organization, the token is
 *   sealed in Vault (requireOrgRole + store_channel_token's own check).
 * Anything else is refused, and refused BEFORE the consent screen.
 */
export async function youtubePickAccess(): Promise<PickAccess> {
  const org = await getOrgContext();
  if (!org.supported || !org.current) return { ok: false, word: org.unavailable ? "unavailable" : "not_available" };
  const orgId = org.current.id;
  if (org.current.is_default) {
    if (!(await requireRole("admin"))) return { ok: false, word: "forbidden" };
    return { ok: true, store: "github", orgId };
  }
  const access = await requireOrgRole({ orgId }, "admin");
  if (!access.ok) {
    return {
      ok: false,
      word: access.error === "org_unavailable" ? "unavailable" : access.error === "not_found" ? "not_found" : "forbidden",
    };
  }
  return { ok: true, store: "vault", orgId };
}

/** Everything that can stop a connect before it starts, in one place. */
async function startRefusal(access: Extract<PickAccess, { ok: true }>): Promise<ConnectWord | null> {
  if (!isGoogleOAuthConfigured) return "not_configured";
  if (access.store === "github") return isGithubConfigured ? null : "token_store";
  return (await fetchTokenStatuses()).available ? null : "token_store";
}

function redirectBack(origin: string, word: ConnectWord, clearNonce = true): NextResponse {
  const res = NextResponse.redirect(`${origin}${connectBackPath("youtube", word)}`);
  if (clearNonce) res.cookies.set(NONCE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export async function startYoutubePick(request: Request, userId: string): Promise<NextResponse> {
  const url = new URL(request.url);
  const origin = publicOrigin(request);
  const access = await youtubePickAccess();
  if (!access.ok) return redirectBack(origin, access.word, false);
  const refusal = await startRefusal(access);
  if (refusal) return redirectBack(origin, refusal, false);

  // A fresh start drops whatever this person had waiting: its token goes with it.
  dropUserPending(userId);

  const nonce = randomUUID();
  const prefill = readChannelPrefill(Object.fromEntries(url.searchParams));
  const state: GoogleState = { ref: "", nonce, pick: true };
  if (prefill.niche) state.niche = prefill.niche;
  if (prefill.language) state.language = prefill.language;

  const res = NextResponse.redirect(buildAuthUrl({ origin, state: encodeState(state), chooser: true }));
  res.cookies.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes to complete the consent
  });
  return res;
}

/** The channels the just-granted token can act for (channels.list, mine=true). */
export async function fetchOwnChannels(accessToken: string): Promise<YoutubeCandidate[] | null> {
  try {
    const res = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true&maxResults=50",
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
    );
    if (!res.ok) return null;
    return coerceYoutubeChannels(await res.json());
  } catch {
    return null;
  }
}

function readNonce(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${NONCE_COOKIE}=`))
    ?.slice(NONCE_COOKIE.length + 1);
}

async function failed(origin: string, word: ConnectWord, detail: Record<string, unknown> = {}): Promise<NextResponse> {
  await logAudit({ action: "channel.youtube.connect_failed", detail: { flow: "pick", result: word, ...detail } });
  return redirectBack(origin, word);
}

export async function finishYoutubePick(
  request: Request,
  url: URL,
  origin: string,
  state: GoogleState,
  userId: string,
): Promise<NextResponse> {
  // Checked again, as at the start: the state is only a claim.
  const access = await youtubePickAccess();
  if (!access.ok) return redirectBack(origin, access.word);
  if (!isGoogleOAuthConfigured) return redirectBack(origin, "not_configured");

  // Google reports a declined consent as ?error=access_denied.
  if (url.searchParams.get("error")) return redirectBack(origin, "denied");

  const code = url.searchParams.get("code") ?? "";
  const cookieNonce = readNonce(request);
  if (!code || code.length > 2048 || !cookieNonce || cookieNonce !== state.nonce) return redirectBack(origin, "bad_state");

  let tokens;
  let candidates: YoutubeCandidate[] | null;
  try {
    tokens = await exchangeCode({ code, origin });
    // No refresh token = the pipeline cannot renew access: refuse now.
    if (!tokens.refresh_token) return failed(origin, "no_refresh");
    const granted = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
    // Google's consent screen lets a scope be unticked; the pipeline would then
    // fail at the step that needed it, after spending.
    if (missingScopes(granted, YOUTUBE_OAUTH_SCOPES).length > 0) return failed(origin, "missing_scopes");
    candidates = await fetchOwnChannels(tokens.access_token);
  } catch (e) {
    return failed(origin, e instanceof Error && e.message === "oauth_exchange_rejected" ? "exchange_rejected" : "failed");
  }
  if (candidates === null) return failed(origin, "failed");
  if (candidates.length === 0) return failed(origin, "no_channel");

  const grant: YoutubeGrant = {
    platform: "youtube",
    store: access.store,
    tokens,
    scopes: (tokens.scope ?? "").split(/\s+/).filter((s) => YOUTUBE_OAUTH_SCOPES.includes(s)),
    candidates,
    niche: state.niche ?? null,
    language: state.language ?? null,
  };
  const handle = createPending({ userId, orgId: access.orgId, grant });
  const res = NextResponse.redirect(`${origin}${CONNECT_PICK_PATH}`);
  res.cookies.set(NONCE_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(PENDING_COOKIE, handle, pendingCookieOptions);
  return res;
}

/** The Nightshift channels of this organization already linked to a YouTube
 *  channel, by YouTube id. Null when the lookup failed (the caller then says
 *  nothing is "already connected" rather than guessing). */
export async function linkedYoutubeChannels(
  orgId: string,
): Promise<Map<string, { channelId: string; name: string }> | null> {
  const supabase = await createClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("channels")
      .select("channel_id, name, credential_ref")
      .eq("org_id", orgId)
      .limit(1000);
    if (error || !Array.isArray(data)) return null;
    const out = new Map<string, { channelId: string; name: string }>();
    for (const row of data as { channel_id?: unknown; name?: unknown; credential_ref?: { youtube_channel_id?: unknown } | null }[]) {
      const yt = row.credential_ref?.youtube_channel_id;
      if (typeof row.channel_id === "string" && typeof yt === "string" && yt) {
        out.set(yt, { channelId: row.channel_id, name: typeof row.name === "string" ? row.name : row.channel_id });
      }
    }
    return out;
  } catch {
    return null;
  }
}

type CreateOutcome = "created" | "taken" | "forbidden" | "failed";

async function createPickedChannel(opts: {
  slug: string;
  orgId: string;
  candidate: YoutubeCandidate;
  grant: YoutubeGrant;
  stamp: boolean;
}): Promise<CreateOutcome> {
  const supabase = await createClient();
  if (!supabase) return "failed";
  const c = opts.candidate;
  try {
    const { error } = await supabase.rpc("create_channel", {
      p_channel_id: opts.slug,
      p_org: opts.orgId,
      p_name: c.title,
      p_niche: opts.grant.niche ?? "",
      p_agent_config: {
        ...(opts.grant.language ? { language: opts.grant.language } : {}),
        // An explicit [] means "watch nobody", as in the wizard.
        competitor_channel_ids: [],
      },
      p_schedule_config: { publish_hour_utc: 15, enabled: true },
      // Public facts channels.list returned; the confirmation stamp is the
      // database's, from the operator's own admin or from the stored token.
      p_credential: {
        provider: "youtube",
        ref: opts.slug,
        youtube_channel_id: c.id,
        youtube_title: c.title,
        youtube_thumbnail: c.thumbnail ?? "",
        youtube_custom_url: c.handle ?? "",
        subscriber_count: c.subscribers ?? "",
        video_count: c.videos ?? "",
      },
      p_verified: opts.stamp,
    });
    if (!error) return "created";
    if (error.code === "23505") return "taken";
    return error.code === "42501" ? "forbidden" : "failed";
  } catch {
    return "failed";
  }
}

async function storeGithubToken(slug: string, grant: YoutubeGrant): Promise<boolean> {
  try {
    const key = await fetchPublicKey();
    await putSecret(tokenSecretName(slug), buildTokenJson(grant.tokens), key);
    return true;
  } catch {
    return false;
  }
}

export interface ConfirmOutcome {
  result: ConfirmResult;
  channelId?: string;
}

/**
 * The pick: create the chosen channel and attach the held token to it.
 *
 * The chosen id must be one of the channels Google returned for THIS
 * authorisation (the held list), never anything the browser names. The record
 * is consumed only by a success; a failure the person may retry leaves it.
 */
export async function confirmYoutubePick(opts: {
  userId: string;
  handle: string | undefined;
  youtubeChannelId: string;
}): Promise<ConfirmOutcome> {
  const access = await youtubePickAccess();
  if (!access.ok) return { result: access.word === "unavailable" ? "unavailable" : "forbidden" };

  const claim = claimPending(opts.handle, { userId: opts.userId, orgId: access.orgId });
  if (!claim) return { result: "expired" };
  const handle = opts.handle as string;
  const grant = claim.grant;
  // A record started in the other store (the caller's role changed) is refused.
  if (grant.platform !== "youtube" || grant.store !== access.store) {
    finishPending(handle);
    return { result: "expired" };
  }

  try {
    const candidate = grant.candidates.find((c) => c.id === opts.youtubeChannelId);
    if (!candidate) {
      releasePending(handle);
      return { result: "not_in_list" };
    }

    const linked = await linkedYoutubeChannels(access.orgId);
    if (linked?.has(candidate.id)) {
      releasePending(handle);
      return { result: "already_connected", channelId: linked.get(candidate.id)?.channelId };
    }
    if (access.store === "github" && !isGithubConfigured) {
      releasePending(handle);
      return { result: "not_configured" };
    }

    let slug: string | null = null;
    let outcome: CreateOutcome = "failed";
    for (let attempt = 1; attempt <= 6; attempt++) {
      const candidateSlug = pickedChannelSlug(candidate, attempt);
      if (!candidateSlug) break;
      outcome = await createPickedChannel({
        slug: candidateSlug,
        orgId: access.orgId,
        candidate,
        grant,
        stamp: access.store === "github",
      });
      if (outcome !== "taken") {
        slug = candidateSlug;
        break;
      }
    }
    if (!slug || outcome !== "created") {
      const result: ConfirmResult = outcome === "taken" ? "id_taken" : outcome === "forbidden" ? "forbidden" : "failed";
      await logAudit({
        action: "channel.youtube.connect_failed",
        detail: { flow: "pick", store: access.store, result, youtube_channel_id: candidate.id },
      });
      if (result === "forbidden") finishPending(handle);
      else releasePending(handle);
      return { result };
    }

    // The channel exists (paused). Now the token, where the existing connect puts it.
    let stored: boolean;
    if (access.store === "vault") {
      const refresh = grant.tokens.refresh_token ?? "";
      stored = (await storeVaultToken({
        channelId: slug,
        refreshToken: refresh,
        grantedScopes: grant.scopes,
        youtube: { id: candidate.id, title: candidate.title },
      })) === "connected";
    } else {
      stored = await storeGithubToken(slug, grant);
    }
    // Single use either way: a channel now exists, and a second press must not
    // create another. A failed store is retried from the channel's own Connect.
    finishPending(handle);

    await logAudit({
      action: stored ? "channel.youtube.connect" : "channel.youtube.connect_failed",
      channelId: slug,
      detail: {
        flow: "pick",
        store: access.store,
        result: stored ? "connected" : "created_not_connected",
        youtube_channel_id: candidate.id,
      },
    });
    return { result: stored ? "connected" : "created_not_connected", channelId: slug };
  } catch {
    // Never leave the record locked by a throw: the person may try again.
    releasePending(handle);
    return { result: "failed" };
  }
}
