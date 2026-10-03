import type { Metadata, Viewport } from "next";
import { Martian_Mono, Sofia_Sans, Sofia_Sans_Extra_Condensed } from "next/font/google";
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
    { media: "(prefers-color-scheme: light)", color: "#e4e7ec" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f16" },
  ],
};

/* The identity's type (docs/design/IDENTITY.md §Type): one superfamily at two
   widths — Extra Condensed is the console's engraving (titles, labels, the
   Generate key), the normal width is the reading face — and Martian Mono,
   narrowed on its width axis, for every number that counts something.
   Cyrillic is loaded for Russian; Uzbek is Latin with ʻ (in latin). Served
   from our own origin by next/font, so no request leaves for Google at run time.
   `subsets` only picks what is PRELOADED: every subset's @font-face (Cyrillic,
   Latin Extended) stays in the CSS behind its unicode-range and loads when a
   page uses it. Preloading Latin alone keeps the first paint to three font
   files instead of nine. */
const display = Sofia_Sans_Extra_Condensed({
  subsets: ["latin"],
  variable: "--font-ns-display",
  display: "swap",
  fallback: ["Arial Narrow", "Roboto Condensed", "sans-serif"],
});
const body = Sofia_Sans({
  subsets: ["latin"],
  variable: "--font-ns-body",
  display: "swap",
  fallback: ["Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
});
const mono = Martian_Mono({
  subsets: ["latin"],
  variable: "--font-ns-mono",
  display: "swap",
  axes: ["wdth"],
  fallback: ["ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
});

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();

  return (
    <html lang={locale} suppressHydrationWarning className={`${display.variable} ${body.variable} ${mono.variable}`}>
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
