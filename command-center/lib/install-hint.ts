/**
 * The "Add to Home Screen" tip's decisions, as pure functions (components/shell/InstallHint.tsx draws it).
 *
 * Two routes, because the platforms differ: Chromium on Android hands the page an install prompt of its own
 * (`beforeinstallprompt`), which is shown only when the browser fired it, so the tip never offers what the browser
 * would refuse. iOS Safari has no such event; the only way is Share > Add to Home Screen, so the tip says so.
 * Nothing else shows it: not a desktop, not an installed app, not a visitor who has seen it once on this device.
 */

/** localStorage key: this device has been shown the tip. A per-viewer convenience only; losing it just shows the tip again. */
export const INSTALL_HINT_KEY = "ns-install-hint";

/** Wait this long after load, so the tip never competes with the page's first paint or the first thing a person reads. */
export const INSTALL_HINT_DELAY_MS = 4000;

/**
 * iPhone or iPad Safari: the one iOS browser where the Share sheet's wording matches the tip. iPadOS 13+ says
 * "Macintosh" in its user agent, so a touch screen on a "Mac" is an iPad. Other iOS browsers carry their own token
 * (CriOS, FxiOS, EdgiOS, OPiOS) and in-app browsers (a link opened inside Instagram, Facebook, Gmail...) have no Add to
 * Home Screen at all; both are left alone.
 */
export function isIosSafari(userAgent: string, maxTouchPoints: number): boolean {
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  if (!ios) return false;
  if (!/Safari\//.test(userAgent)) return false;
  return !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|Twitter/.test(userAgent);
}

/** The installed app (any platform): the tip has nothing to say there. */
export function isStandalone(displayModeStandalone: boolean, iosStandalone: boolean | undefined): boolean {
  return displayModeStandalone || iosStandalone === true;
}
