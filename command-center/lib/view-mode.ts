/**
 * Mobile / Desktop view: the visitor's own choice of layout, whatever device
 * the site is opened on. Pure functions only (no DOM, no request objects), so
 * the same rules run in the root layout, the middleware and the browser, and
 * tests/view-mode.test.ts pins them.
 *
 * The choice is one cookie, `ns_view=mobile|desktop`. No cookie means
 * automatic: the layout the device would get anyway, which is the whole
 * behaviour of the site for everyone who never touches the switch.
 *
 *  - Desktop on a phone: the server writes `<meta viewport width=1280>`
 *    (viewportFor), the phone lays the page out at 1280 css px and every
 *    Tailwind breakpoint answers as on a laptop.
 *  - Mobile on a desktop: breakpoints are viewport media queries, so a div
 *    cannot be made "phone sized". The page is rendered inside a same-origin
 *    iframe about 430 px wide (frameSrcFor): the frame has its own viewport,
 *    so every media query answers exactly as on a phone.
 *
 * Docs: docs/VIEW_MODE.md.
 */

export const VIEW_COOKIE = "ns_view";
export const VIEW_CHOICES = ["mobile", "desktop"] as const;
export type ViewChoice = (typeof VIEW_CHOICES)[number];
/** What is on screen right now. */
export type ViewMode = ViewChoice;

/** Only the two literal values are accepted; anything else is "no choice". */
export function parseViewChoice(raw: unknown): ViewChoice | null {
  return raw === "mobile" || raw === "desktop" ? raw : null;
}

/** The layout width a phone is given when the visitor asks for Desktop. */
export const DESKTOP_VIEWPORT_WIDTH = 1280;
/** The phone frame's width on a desktop screen. */
export const FRAME_WIDTH_PX = 430;
/** The app's desktop layout starts here (Tailwind `lg`): the sidebar replaces the bottom bar. */
export const DESKTOP_MEDIA = "(min-width: 1024px)";

/** `<meta viewport>` width for a choice: a number forces that layout width, null leaves the device's own. */
export function viewportWidthFor(choice: ViewChoice | null): number | null {
  return choice === "desktop" ? DESKTOP_VIEWPORT_WIDTH : null;
}

/** The request header the middleware hands the root layout: "render the phone frame around this URL". */
export const FRAME_SRC_HEADER = "x-ns-frame-src";

/** Pages that are never framed: sign-in steps and the connection screen forbid it (next.config.ts), the API is not a page. */
const UNFRAMED_PREFIXES = ["/api", "/auth", "/oauth", "/_next"] as const;

export function framablePath(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) return false;
  // The router decodes and matches without regard to case, so the test does too: /%61uth and /AUTH are /auth.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname).toLowerCase();
  } catch {
    return false;
  }
  if (decoded.includes("\\") || decoded.startsWith("//") || /[\u0000-\u001f\u007f]/.test(decoded)) return false;
  if (decoded.split("/").some((seg) => seg === "." || seg === "..")) return false;
  return !UNFRAMED_PREFIXES.some((p) => decoded === p || decoded.startsWith(`${p}/`));
}

/**
 * The URL to show inside the phone frame, or null when this request is rendered
 * as itself. Only a top-level navigation of a framable page by a visitor who
 * chose Mobile gets the frame. `Sec-Fetch-Dest` is the browser's own word for
 * what is asking: `document` is a tab, `iframe` is our frame (which must NOT
 * wrap again), `empty` is a client-side navigation fetch. A browser that sends
 * none of it (before 2023) simply gets the unframed page.
 */
export function frameSrcFor(input: {
  choice: ViewChoice | null;
  fetchDest: string | null;
  pathname: string;
  search: string;
}): string | null {
  if (input.choice !== "mobile" || input.fetchDest !== "document") return null;
  if (!framablePath(input.pathname)) return null;
  return `${input.pathname}${input.search}`;
}

/**
 * May this response be framed? Only by our own page: the browser says it is a
 * frame navigation (`Sec-Fetch-Dest: iframe`) started by the same origin
 * (`Sec-Fetch-Site: same-origin`). A page on another site framing us sends
 * `cross-site`, so it still gets DENY. Everything else keeps DENY.
 */
export function framedBySelf(input: { fetchDest: string | null; fetchSite: string | null; pathname: string }): boolean {
  return input.fetchDest === "iframe" && input.fetchSite === "same-origin" && framablePath(input.pathname);
}

/** True for a frame request, whatever the site (the layout mounts the frame bridge for it). */
export function isFrameRequest(fetchDest: string | null): boolean {
  return fetchDest === "iframe";
}

/**
 * The cookie value that makes `target` the layout. Mobile on a phone-sized
 * screen is what the device does by itself, so it clears the choice instead of
 * wrapping a phone in a phone frame. Everything else is stored.
 */
export function choiceFor(target: ViewMode, phoneSizedScreen: boolean): ViewChoice | null {
  if (target === "mobile") return phoneSizedScreen ? null : "mobile";
  return "desktop";
}

/** What is on screen: the stored choice, else whatever the viewport gives. */
export function effectiveMode(choice: ViewChoice | null, desktopLayout: boolean): ViewMode {
  return choice ?? (desktopLayout ? "desktop" : "mobile");
}

export function otherMode(mode: ViewMode): ViewMode {
  return mode === "mobile" ? "desktop" : "mobile";
}

/** The `Set-Cookie`-style string document.cookie takes. No PII, a year, readable by the server on every request. */
export function viewCookieString(choice: ViewChoice | null, secure: boolean): string {
  const attrs = `path=/; samesite=lax${secure ? "; secure" : ""}`;
  return choice
    ? `${VIEW_COOKIE}=${choice}; ${attrs}; max-age=${60 * 60 * 24 * 365}`
    : `${VIEW_COOKIE}=; ${attrs}; max-age=0`;
}

/** The choice in a `document.cookie` string. */
export function readViewChoice(cookieHeader: string): ViewChoice | null {
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === VIEW_COOKIE) return parseViewChoice(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * Should a link inside the phone frame leave the frame? Another site's page
 * (it would refuse to load in a frame), and our own routes that end in a
 * redirect to one or forbid framing: the provider connections under /api, the
 * sign-in steps, the connection screen.
 */
export function leavesFrame(href: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(href, origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.origin !== origin) return true;
  return !framablePath(u.pathname);
}

/** The message the framed page sends its parent so the address bar and title follow it. */
export const FRAME_SYNC = "ns-frame-sync";
export interface FrameSync {
  type: typeof FRAME_SYNC;
  href: string;
  title: string;
}

/** A sync message from the frame, if it is one and its href is a path on this site. */
export function parseFrameSync(data: unknown): FrameSync | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== FRAME_SYNC || typeof d.href !== "string" || typeof d.title !== "string") return null;
  // Tab, newline and carriage return are stripped by the URL parser after the `//` test, so they are refused outright.
  if (!d.href.startsWith("/") || d.href.startsWith("//") || d.href.includes("\\") || /[\u0000-\u001f\u007f]/.test(d.href)) return null;
  return { type: FRAME_SYNC, href: d.href, title: d.title.slice(0, 300) };
}
