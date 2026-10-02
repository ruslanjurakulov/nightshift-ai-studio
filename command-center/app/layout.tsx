import type { Metadata } from "next";
import { Martian_Mono, Sofia_Sans, Sofia_Sans_Extra_Condensed } from "next/font/google";
import "./globals.css";
import "@/components/motion/motion.css";
import { getLocale } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/context";
import { ToastProvider } from "@/components/feedback/ToastProvider";
import { NO_FLASH_SCRIPT } from "@/lib/theme";
import { MotionProvider } from "@/components/motion/MotionProvider";

export const metadata: Metadata = {
  title: "Nightshift Command Center",
  description: "Real-time monitoring & control plane for the Nightshift content-automation bot.",
};

/* The identity's type (docs/design/IDENTITY.md §Type): one superfamily at two
   widths — Extra Condensed is the console's engraving (titles, labels, the
   Generate key), the normal width is the reading face — and Martian Mono,
   narrowed on its width axis, for every number that counts something.
   Cyrillic is loaded for Russian; Uzbek is Latin with ʻ (in latin). Served
   from our own origin by next/font, so no request leaves for Google at run time. */
const display = Sofia_Sans_Extra_Condensed({
  subsets: ["latin", "latin-ext", "cyrillic"],
  variable: "--font-ns-display",
  display: "swap",
  fallback: ["Arial Narrow", "Roboto Condensed", "sans-serif"],
});
const body = Sofia_Sans({
  subsets: ["latin", "latin-ext", "cyrillic"],
  variable: "--font-ns-body",
  display: "swap",
  fallback: ["Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
});
const mono = Martian_Mono({
  subsets: ["latin", "latin-ext", "cyrillic"],
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
        <I18nProvider locale={locale}>
          <MotionProvider>
            <ToastProvider>{children}</ToastProvider>
          </MotionProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
