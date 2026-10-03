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

export const metadata: Metadata = {
  title: "Nightshift Command Center",
  description: "Nightshift makes finished YouTube videos for your channel, shows the price before every run, and waits for your approval before anything goes public.",
  // The tab icon is the tile with the N set larger (icon.svg, favicon.ico). Without this the head also
  // links the 512 px icon.png, whose N is 6 px wide at tab size, and a high-density tab can pick that one.
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/favicon.ico", sizes: "32x32" }] },
};

/** The browser chrome takes the page's ground: the light table, or the control room at night. */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f3f1" },
    { media: "(prefers-color-scheme: dark)", color: "#131210" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  preloadFonts(locale);

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
          {children}
        </PublicI18nProvider>
      </body>
    </html>
  );
}
