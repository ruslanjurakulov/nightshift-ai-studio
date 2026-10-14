import type { Metadata, Viewport } from "next";
import "./fonts.css";
import "./globals.css";
// The motion kit's CSS half (reduced-motion and no-script guards, plate,
// .ns-press) is global and tiny; the JavaScript half (MotionProvider) is
// mounted only by layouts whose pages animate — see docs/design/MOTION.md §7.
import "@/components/motion/motion.css";
import { getLocale } from "@/lib/i18n/server";
import { getDictionaryFor } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { NO_FLASH_SCRIPT } from "@/lib/theme";
import { preloadFonts } from "@/components/site/fonts";
import { cookies, headers } from "next/headers";
import { FRAME_SRC_HEADER, VIEW_COOKIE, isFrameRequest, parseViewChoice, viewportWidthFor } from "@/lib/view-mode";
import { ViewFrame } from "@/components/view-mode/ViewFrame";
import { EmbedBridge } from "@/components/view-mode/EmbedBridge";

export const metadata: Metadata = {
  title: "Nightshift Command Center",
  description: "Nightshift makes finished YouTube videos for your channel, shows the price before every run, and waits for your approval before anything goes public.",
  // Explicit, though app/manifest.ts alone would be linked: the root layout is where the head is read, and the link
  // is then one line a test can hold.
  manifest: "/manifest.webmanifest",
  // iOS ignores the manifest's name and display for a home-screen app; these are what it reads.
  appleWebApp: { capable: true, title: "Nightshift", statusBarStyle: "default" },
  // The tab icon is the tile with the N set larger (icon.svg, favicon.ico). Without this the head also
  // links the 512 px icon.png, whose N is 6 px wide at tab size, and a high-density tab can pick that one.
  // An explicit `icons` object also replaces Next's auto-generated links, so app/apple-icon.png is not linked on its
  // own: `apple` must be listed, or iOS "Add to Home Screen" finds no apple-touch-icon and draws a letter tile.
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/favicon.ico", sizes: "32x32" }],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

/**
 * The browser chrome takes the page's ground: the light table, or the control room at night.
 *
 * And the Mobile / Desktop view (lib/view-mode.ts): a visitor who chose Desktop gets `width=1280`, so a phone lays
 * the page out as a laptop would and every breakpoint follows. No choice leaves the device's own `device-width`
 * (Next's default), i.e. the site exactly as it was. Reading the cookie costs nothing: this layout already reads
 * the language cookie (getLocale), and the middleware mints a CSP nonce per request, so no page is static.
 */
export async function generateViewport(): Promise<Viewport> {
  const width = viewportWidthFor(parseViewChoice((await cookies()).get(VIEW_COOKIE)?.value));
  return {
    // No initial-scale for Desktop: Next adds `initial-scale=1` by default, which on a phone would show the top-left
    // 390 px of a 1280 px page; without it the browser fits the whole width and the visitor zooms in.
    ...(width ? { width, initialScale: undefined } : {}),
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: "#f3f3f1" },
      { media: "(prefers-color-scheme: dark)", color: "#131210" },
    ],
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  preloadFonts(locale);
  const requestHeaders = await headers();
  // Set by the middleware, never by the client: the visitor chose Mobile on a wide screen, so this document is only
  // the phone frame around the real page (components/view-mode/ViewFrame.tsx).
  const frameSrc = requestHeaders.get(FRAME_SRC_HEADER);
  // This document IS inside that frame: it tells the shell where it is (address bar, title) and lets links that
  // cannot live in a frame leave it.
  const inFrame = isFrameRequest(requestHeaders.get("sec-fetch-dest"));

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint — prevents a flash of the
            wrong theme. Must run synchronously, ahead of the body. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        {/* Only the public slice of the dictionary reaches the browser here.
            The app's layouts mount the full I18nProvider and the toasts
            (app/(app)/layout.tsx, app/welcome/layout.tsx). */}
        <PublicI18nProvider locale={locale} t={publicDictionary(getDictionaryFor(locale))}>
          {frameSrc ? <ViewFrame src={frameSrc} /> : children}
          {inFrame && <EmbedBridge />}
        </PublicI18nProvider>
      </body>
    </html>
  );
}
