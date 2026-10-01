import { ImageResponse } from "next/og";
import { en } from "@/lib/i18n/en";

/**
 * The social card: the hero line on the control room's ink ground, and the
 * rundown with its one lit lamp — the video waiting for approval — words
 * only, no figures. English, because a shared link's card is cached once for everyone.
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

/* The identity's control-room tokens (docs/design/IDENTITY.md §Palette, dark). */
const GROUND = "#0B0F16";
const CONSOLE = "#11161F";
const RULE = "#252F40";
const RULE_STRONG = "#56637C";
const TEXT = "#ECE5D8";
const DIM = "#A39D91";
const AMBER = "#FFA940";
const GO = "#5FD49A";

export function GET() {
  const h = en.site.hero;
  const rows = en.site.rundown.rows;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          backgroundColor: GROUND,
          color: TEXT,
          padding: "64px 72px",
          gap: 56,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1.15 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: AMBER, boxShadow: `0 0 0 4px ${GROUND}, 0 0 0 6px ${RULE_STRONG}` }} />
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>{en.brand.name}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 60, fontWeight: 700, lineHeight: 1.04, letterSpacing: "-0.025em" }}>
            <span>{h.titleA}</span>
            <span style={{ color: DIM }}>{h.titleB}</span>
          </div>
          <div style={{ fontSize: 18, color: DIM, letterSpacing: "0.14em", textTransform: "uppercase" }}>{h.kicker}</div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 0.85,
            alignSelf: "center",
            backgroundColor: CONSOLE,
            border: `2px solid ${RULE_STRONG}`,
            borderRadius: 14,
          }}
        >
          {rows.map((row) => {
            const yours = row.id === "approval";
            const next = row.id === "youtube";
            return (
              <div
                key={row.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "16px 22px",
                  borderBottom: next ? "none" : `1px solid ${RULE}`,
                  backgroundColor: yours ? "rgba(255,169,64,0.14)" : "transparent",
                }}
              >
                <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: next ? DIM : TEXT }}>
                  {row.name}
                </div>
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    backgroundColor: yours ? AMBER : next ? "transparent" : GO,
                    border: next ? `2px solid ${RULE_STRONG}` : "none",
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    ),
    size,
  );
}
