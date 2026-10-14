/**
 * Navigation that must act on the whole window, not on the Mobile view's phone
 * frame the page may be sitting in (lib/view-mode.ts). Outside a frame `top` is
 * `window`, so these are plain navigations there. Same-origin parents only: a
 * cross-origin parent would throw, and then the page navigates itself.
 */

/** Opens `url` in the top-level window. For redirects to another site (a payment portal, a provider's consent screen), which refuse to load inside a frame. */
export function assignTop(url: string): void {
  try {
    (window.top ?? window).location.assign(url);
  } catch {
    window.location.assign(url);
  }
}

/** Reloads the top-level window, so the server renders the layout the cookie now names. */
export function reloadTop(): void {
  try {
    (window.top ?? window).location.reload();
  } catch {
    window.location.reload();
  }
}
