import { ImageResponse } from "next/og";
import { en } from "@/lib/i18n/en";

/**
 * The social card for the homepage: the hero line on the brand's true-black
 * ground with the sky accent, and the pipeline's stage names — words only, no
 * figures. English, because a shared link's card is cached once for everyone.
 * Rendered with next/og's bundled font, so building it fetches nothing.
 *
 * Why a route at /og.png and not the app/opengraph-image.tsx convention: that
 * convention serves at /opengraph-image (no extension), which the auth gate in
 * middleware.ts sends to /login for a signed-out visitor — and every crawler
 * that unfurls a link is signed out. The middleware matcher already skips any
 * path ending in .png, so this card is reachable without widening the public
 * surface in lib/public-paths.ts. app/page.tsx points og:image here.
 */
export const dynamic = "force-static";

const size = { width: 1200, height: 630 };

const SKY = "#a1d0fc";
const MUTED = "#7f8a97";
const BORDER = "#1b1f25";

export function GET() {
  const stages = en.landing.run.stages.map((s) => s.name);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          backgroundColor: "#000000",
          backgroundImage: "radial-gradient(circle at 12% 0%, rgba(161,208,252,0.20), rgba(0,0,0,0) 55%)",
          color: "#ffffff",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 40, fontWeight: 700, color: SKY, letterSpacing: "-0.02em" }}>{en.brand.name}</div>
          <div style={{ fontSize: 20, color: MUTED, letterSpacing: "0.2em", textTransform: "uppercase" }}>
            {en.landing.hero.eyebrow}
          </div>
        </div>

        <div style={{ display: "flex", fontSize: 76, fontWeight: 700, lineHeight: 1.05, letterSpacing: "-0.03em", maxWidth: 1000 }}>
          {en.landing.hero.title}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {stages.map((name, i) => (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  display: "flex",
                  padding: "8px 14px",
                  borderRadius: 999,
                  border: `1.5px solid ${i === stages.length - 1 ? SKY : BORDER}`,
                  color: i === stages.length - 1 ? SKY : "#d6dde6",
                  fontSize: 20,
                }}
              >
                {name}
              </div>
              {i < stages.length - 1 && <div style={{ width: 12, height: 2, background: SKY, opacity: 0.5 }} />}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
