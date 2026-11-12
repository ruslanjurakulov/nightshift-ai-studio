/**
 * The Content-Security-Policy for every page the Command Center renders
 * (BR-S-008). Built per request in middleware.ts, because the script rule
 * carries a fresh nonce: Next reads the nonce back out of the request's CSP
 * header and stamps it on every script tag it writes (its chunks and the
 * inline RSC payload), so nothing here has to be threaded through a page.
 *
 * Why a nonce works without changing how pages render: the root layout already
 * reads cookies and headers (getLocale), so every page is rendered per request
 * already; there is no prerendered HTML that would lack the nonce.
 *
 * Why it matters: @supabase/ssr keeps the session in a cookie the browser
 * client must be able to read (httpOnly is off by design), so one injected
 * script is a stolen session. `strict-dynamic` with a nonce means only the
 * scripts Next itself wrote, and the scripts those load (Paddle.js, then
 * Paddle's Retain snippet), may run; an injected <script> or inline handler
 * cannot.
 *
 * Shipped as Content-Security-Policy-Report-Only first: a violation is logged
 * in the browser console (and sent to CSP_REPORT_URI when one is set) instead
 * of breaking a page. The deploy-time switch CSP_MODE (a repository variable,
 * read per request) picks what is sent:
 *
 *   report-only (also `report`, empty, unset, or anything unrecognised): today's
 *     report-only header, byte for byte. The default.
 *   enforce: the same policy as the enforcing header, plus
 *     `upgrade-insecure-requests` on https, reporting to our own
 *     /api/csp-report unless CSP_REPORT_URI names a collector.
 *   both: `enforce`, and in addition a STRICTER report-only policy (cspStrict)
 *     that measures what narrowing img-src/media-src would break.
 *   off: neither header (an escape hatch, not a setting to leave on).
 *
 * See docs/security/CSP.md.
 */

export type CspMode = "report-only" | "enforce" | "both" | "off";

export const CSP_HEADER = "Content-Security-Policy";
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";

/** Our own violation collector (app/api/csp-report/route.ts). Same origin, so a relative report-uri. */
export const CSP_REPORT_PATH = "/api/csp-report";

/** Unset, empty or anything unrecognised is report-only: a typo must never
 *  silently turn the policy off, nor turn on enforcement nobody tested. */
export function cspMode(raw: string | undefined): CspMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "enforce" || v === "both" || v === "off") return v;
  return "report-only";
}

/** True when the mode sends an ENFORCING policy (which then carries frame-ancestors itself). */
export function cspEnforces(mode: CspMode): boolean {
  return mode === "enforce" || mode === "both";
}

/**
 * sha256 of NO_FLASH_SCRIPT (lib/theme.ts), the one inline script we write
 * ourselves. A hash rather than the nonce: the script is a constant, and a
 * nonce attribute on server-rendered markup is hidden by the browser after
 * parsing, which React then reports as a hydration mismatch.
 * tests/csp.test.ts recomputes it, so editing the script without updating
 * this fails the suite instead of silently blocking the theme in production.
 */
export const NO_FLASH_SCRIPT_HASH = "'sha256-0sat8E4VTcOjmj9b0kR7WSmpelpaTP7qCVYbsdetoNY='";

/**
 * Paddle.js v2 and what it loads, read from cdn.paddle.com/paddle/v2/paddle.js
 * and the Retain snippet it injects in production (public.profitwell.com).
 * The pricing page previews prices against api.paddle.com; the Buy credits
 * overlay is a frame on buy.paddle.com; paddle.css comes from the CDN.
 * Sandbox twins are listed so a sandbox deployment behaves the same.
 */
const PADDLE = {
  script: ["https://cdn.paddle.com", "https://public.profitwell.com"],
  style: ["https://cdn.paddle.com", "https://sandbox-cdn.paddle.com"],
  connect: [
    "https://api.paddle.com",
    "https://sandbox-api.paddle.com",
    "https://www2.profitwell.com",
    "https://retain-api.profitwell.com",
    "https://api.profitwell-events.com",
    "https://retain-widgets-api.paddle.com",
    "https://sandbox-retain-widgets-api.paddle.com",
  ],
  frame: [
    "https://buy.paddle.com",
    "https://sandbox-buy.paddle.com",
    "https://retain-widgets.paddle.com",
    "https://sandbox-retain-widgets.paddle.com",
  ],
} as const;

/**
 * The app-wide backdrop artwork (components/NeuralBackdrop.tsx): its poster image and its looping video, two fixed
 * CloudFront URLs on every signed-in screen. Named so the stricter policy of `both` reports only hosts nobody listed;
 * tests/csp.test.ts reads the component and fails if its URLs move to a host that is not here.
 */
export const BACKDROP_IMG_ORIGIN = "https://d2ol7oe51mr4n9.cloudfront.net";
export const BACKDROP_MEDIA_ORIGIN = "https://d8j0ntlcm91z4.cloudfront.net";

/** The Supabase project's REST/auth/storage origin and its realtime socket. */
export function supabaseOrigins(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return [];
  const ws = `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`;
  return [u.origin, ws];
}

/** A report collector must be an absolute https URL; anything else is ignored
 *  rather than written into a header. */
export function reportUri(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:") return null;
    // A header value cannot carry these, and a policy separator would let the
    // setting inject directives.
    if (/[\s;,'"]/.test(v)) return null;
    return u.href;
  } catch {
    return null;
  }
}

export interface CspOptions {
  nonce: string;
  supabaseUrl: string;
  /** `next dev` needs eval for React's dev tooling; production never does. */
  dev?: boolean;
  reportUri?: string | null;
  /** The Mobile view's shell page (lib/view-mode.ts): it frames the app, so `frame-src` also names the site itself. */
  frameSelf?: boolean;
  /** A response our own page asked to frame (lib/view-mode.ts framedBySelf): `frame-ancestors 'self'` instead of 'none'. */
  framedBySelf?: boolean;
  /**
   * A same-origin path for `report-uri` (CSP_REPORT_PATH), used only when no absolute `reportUri` is set. A path
   * gets `report-uri` alone: `report-to` needs a Reporting-Endpoints entry, and Chrome, which prefers report-to,
   * would drop reports it cannot resolve.
   */
  reportPath?: string | null;
  /** Append `upgrade-insecure-requests` (an enforcing policy served over https only; browsers ignore it in report-only). */
  upgradeInsecure?: boolean;
  /**
   * The stricter policy `both` sends as report-only: img-src and media-src narrowed from any https origin to our
   * own origin, Supabase, Paddle's CDN and the backdrop artwork. Reports from it name every other host the app really
   * loads (finished generations on provider CDNs, social avatars), the evidence for narrowing the enforced policy.
   */
  strict?: boolean;
}

/**
 * The policy, one directive per line of thought:
 *
 * - script-src: the nonce plus `strict-dynamic` (CSP3 browsers then ignore the
 *   host list and 'self'); the hosts are the fallback for a browser without
 *   strict-dynamic. No 'unsafe-inline' — with a nonce present CSP2+ browsers
 *   would ignore it anyway, and it would only weaken older ones.
 * - style-src keeps 'unsafe-inline': React writes `style="…"` attributes into
 *   server-rendered markup across the app, and a nonce cannot cover attributes.
 *   CSS injection cannot read the session cookie; script injection can.
 * - img-src / media-src allow any https origin: finished generations link to
 *   whichever provider host produced them, social avatars come from rotating
 *   CDN hosts, and review copies are signed Supabase Storage URLs. An image or
 *   a video cannot execute script.
 * - connect-src is the real exfiltration control: our own API, Supabase (REST
 *   and the realtime websocket) and Paddle only.
 * - frame-ancestors 'none' repeats the header next.config.ts already sends
 *   (BR-S-007), so the enforcing policy alone is also complete. The one
 *   exception is the Mobile view (lib/view-mode.ts): our own page framing
 *   itself, which the browser marks Sec-Fetch-Dest: iframe and Sec-Fetch-Site:
 *   same-origin, gets 'self'; the shell that does the framing also lists
 *   'self' in frame-src. Nobody else can frame the site.
 */
export function buildCsp(opts: CspOptions): string {
  const supabase = supabaseOrigins(opts.supabaseUrl);
  // The strict variant's hosts: our origin, Supabase Storage (no socket), Paddle's CDN images, the backdrop artwork.
  const narrow = ["'self'", "data:", "blob:", ...supabase.filter((o) => /^https?:/.test(o)), ...PADDLE.style];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      [
        "'self'",
        `'nonce-${opts.nonce}'`,
        "'strict-dynamic'",
        NO_FLASH_SCRIPT_HASH,
        ...PADDLE.script,
        ...(opts.dev ? ["'unsafe-eval'"] : []),
      ],
    ],
    ["style-src", ["'self'", "'unsafe-inline'", ...PADDLE.style]],
    ["img-src", opts.strict ? [...narrow, BACKDROP_IMG_ORIGIN] : ["'self'", "data:", "blob:", "https:"]],
    ["media-src", opts.strict ? [...narrow, BACKDROP_MEDIA_ORIGIN] : ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...supabase, ...PADDLE.connect]],
    ["frame-src", [...(opts.frameSelf ? ["'self'"] : []), ...PADDLE.frame]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", [opts.framedBySelf ? "'self'" : "'none'"]],
  ];
  if (opts.upgradeInsecure) directives.push(["upgrade-insecure-requests", []]);
  if (opts.reportUri) {
    directives.push(["report-uri", [opts.reportUri]]);
    directives.push(["report-to", ["csp"]]);
  } else if (opts.reportPath) {
    directives.push(["report-uri", [opts.reportPath]]);
  }
  return directives.map(([name, values]) => [name, ...values].join(" ")).join("; ");
}

/** 128 random bits, base64: what a nonce must be (unguessable, per response).
 *  Web Crypto, because middleware runs on the edge runtime. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Which header carries the policy Next reads the nonce from in this mode, or null for none. */
export function cspHeaderName(mode: CspMode): string | null {
  if (cspEnforces(mode)) return CSP_HEADER;
  if (mode === "report-only") return CSP_REPORT_ONLY_HEADER;
  return null;
}

export interface CspHeaderSet {
  /** Every policy header the response carries, in order. */
  response: { name: string; value: string }[];
  /** Reporting-Endpoints for an absolute collector (report-to), or null. */
  reportingEndpoints: string | null;
}

/**
 * The policy headers for one response in `mode`. Every header in the set carries the same nonce. The first one is
 * the header the middleware also puts on the request, where Next reads the nonce (it reads the enforcing header
 * first, then the report-only one).
 *
 * report-only is exactly what was sent before the switch existed (`buildCsp(opts)`), so leaving the variable unset
 * changes nothing. The enforcing modes always report somewhere: to CSP_REPORT_URI when it is set, else to our own
 * CSP_REPORT_PATH, so the first day of enforcement is visible in the web container's log.
 */
export function cspHeaders(mode: CspMode, opts: CspOptions & { https?: boolean }): CspHeaderSet {
  const { https, ...base } = opts;
  const reportingEndpoints = base.reportUri ? `csp="${base.reportUri}"` : null;
  if (mode === "off") return { response: [], reportingEndpoints: null };
  if (mode === "report-only") {
    return { response: [{ name: CSP_REPORT_ONLY_HEADER, value: buildCsp(base) }], reportingEndpoints };
  }
  const reporting = { reportUri: base.reportUri ?? null, reportPath: base.reportUri ? null : CSP_REPORT_PATH };
  const response = [
    { name: CSP_HEADER, value: buildCsp({ ...base, ...reporting, upgradeInsecure: https === true, strict: false }) },
  ];
  if (mode === "both") {
    response.push({ name: CSP_REPORT_ONLY_HEADER, value: buildCsp({ ...base, ...reporting, upgradeInsecure: false, strict: true }) });
  }
  return { response, reportingEndpoints };
}
