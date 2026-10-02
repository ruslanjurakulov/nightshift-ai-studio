import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { en } from "@/lib/i18n/en";

/**
 * The social card: the hero line on the control room's ink ground, and the
 * rundown with its one lit lamp — the video waiting for approval — words
 * only, no figures. English, because a shared link's card is cached once for everyone.
 * Set in the identity's own faces (brand/og-fonts, OFL): Sofia Sans Extra
 * Condensed for the engraving, Sofia Sans for the line under it. They are read
 * from the repository while the static card is built, so building it fetches
 * nothing over the network.
 *
 * Why a route at /og.png and not the app/opengraph-image.tsx convention: that
 * convention serves at /opengraph-image (no extension), which the auth gate in
 * middleware.ts sends to /login for a signed-out visitor — and every crawler
 * that unfurls a link is signed out. The middleware matcher skips exactly
 * `/og.png` (anchored, BR-H-001), so this card is reachable without widening
 * the public surface in lib/public-paths.ts. app/page.tsx points og:image here.
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

const FONT_DIR = join(process.cwd(), "brand", "og-fonts");

async function font(file: string): Promise<ArrayBuffer> {
  const buf = await readFile(join(FONT_DIR, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export async function GET() {
  const [display, body, mono] = await Promise.all([
    font("SofiaSansExtraCondensed-Bold.ttf"),
    font("SofiaSans-Regular.ttf"),
    font("MartianMono-Medium.ttf"),
  ]);
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
          padding: "60px 72px",
          gap: 56,
          fontFamily: "Sofia Sans",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1.2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: AMBER, boxShadow: `0 0 0 4px ${GROUND}, 0 0 0 6px ${RULE_STRONG}` }} />
            <div style={{ fontFamily: "Sofia Sans Extra Condensed", fontSize: 38, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              {en.brand.name}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontFamily: "Sofia Sans Extra Condensed",
              fontSize: 104,
              fontWeight: 700,
              lineHeight: 0.88,
              textTransform: "uppercase",
            }}
          >
            <span>{h.titleA}</span>
            <span style={{ color: DIM }}>{h.titleB}</span>
          </div>
          <div style={{ fontSize: 26, color: DIM }}>{h.kicker}</div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 0.8,
            alignSelf: "center",
            backgroundColor: CONSOLE,
            border: `2px solid ${RULE_STRONG}`,
            borderRadius: 10,
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
                  padding: "15px 22px",
                  borderBottom: next ? "none" : `1px solid ${RULE}`,
                  backgroundColor: yours ? "rgba(255,169,64,0.14)" : "transparent",
                }}
              >
                <div
                  style={{
                    fontFamily: "Sofia Sans Extra Condensed",
                    fontSize: 32,
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    color: next ? DIM : TEXT,
                  }}
                >
                  {row.name}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {yours && (
                    <div style={{ fontFamily: "Martian Mono", fontSize: 15, color: AMBER, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                      {en.site.rundown.yours}
                    </div>
                  )}
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
              </div>
            );
          })}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Sofia Sans Extra Condensed", data: display, weight: 700, style: "normal" },
        { name: "Sofia Sans", data: body, weight: 400, style: "normal" },
        { name: "Martian Mono", data: mono, weight: 500, style: "normal" },
      ],
    },
  );
}
