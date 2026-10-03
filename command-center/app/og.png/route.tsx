import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { en } from "@/lib/i18n/en";
import { BRAND_MARK_FOLDS, BRAND_MARK_OUTLINE, BRAND_MARK_RATIO } from "@/components/site/BrandMark";

/**
 * The social card: the folded-ribbon N beside the wordmark, the hero line on
 * the control room's ink ground, and the rundown with its one lit lamp — the
 * video waiting for approval — words only, no figures. English, because a
 * shared link's card is cached once for everyone.
 * Set in the product's typeface, Onest, and the wordmark's own condensed
 * capitals (brand/og-fonts, both OFL). They are read from the repository while
 * the static card is built, so building it fetches nothing over the network.
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
const GROUND = "#131210";
const CONSOLE = "#1B1A17";
const RULE = "#2D2B26";
const RULE_STRONG = "#6F695F";
const TEXT = "#F1EDE6";
const DIM = "#B4AEA1";
const AMBER = "#FFA940";
const GO = "#5FD49A";
/* The mark: white on the ground, as the owner supplied it (brand/logo). */
const MARK = "#FAFAFA";
const MARK_W = 60;

const FONT_DIR = join(process.cwd(), "brand", "og-fonts");

async function font(file: string): Promise<ArrayBuffer> {
  const buf = await readFile(join(FONT_DIR, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export async function GET() {
  const [wordmark, regular, semibold] = await Promise.all([
    font("SofiaSansExtraCondensed-Bold.ttf"),
    font("Onest-Regular.ttf"),
    font("Onest-SemiBold.ttf"),
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
          fontFamily: "Onest",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1.2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <svg width={MARK_W} height={Math.round(MARK_W * BRAND_MARK_RATIO)} viewBox="0 0 1000 938">
              <path fill={MARK} fillRule="evenodd" d={BRAND_MARK_OUTLINE} />
              <path fill={MARK} fillOpacity={0.5} d={BRAND_MARK_FOLDS} />
            </svg>
            <div style={{ fontFamily: "Sofia Sans Extra Condensed", fontSize: 38, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              {en.brand.name}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 76,
              fontWeight: 600,
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
            }}
          >
            <span>{h.titleA}</span>
            <span style={{ color: DIM }}>{h.titleB}</span>
          </div>
          <div style={{ fontSize: 28, lineHeight: 1.4, color: DIM }}>{h.kicker}</div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 0.8,
            alignSelf: "center",
            backgroundColor: CONSOLE,
            border: `2px solid ${RULE_STRONG}`,
            borderRadius: 20,
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
                    fontSize: 30,
                    fontWeight: 600,
                    color: next ? DIM : TEXT,
                  }}
                >
                  {row.name}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {yours && (
                    <div style={{ fontSize: 20, fontWeight: 600, color: AMBER }}>
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
        { name: "Sofia Sans Extra Condensed", data: wordmark, weight: 700, style: "normal" },
        { name: "Onest", data: regular, weight: 400, style: "normal" },
        { name: "Onest", data: semibold, weight: 600, style: "normal" },
      ],
    },
  );
}
