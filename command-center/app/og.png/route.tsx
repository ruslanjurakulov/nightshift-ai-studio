import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { en } from "@/lib/i18n/en";

/**
 * The social card: the product's wordmark (the bare folded-ribbon N, then the
 * owner's lettering, exactly as components/site/Wordmark.tsx sets them), the
 * hero line on the control room's ink ground, and the rundown with its one lit
 * lamp — the video waiting for approval — words only, no figures. English,
 * because a shared link's card is cached once for everyone.
 * Set in the product's typeface, Onest (brand/og-fonts, OFL). The wordmark is
 * drawn from the vector masters in brand/logo, never from a font, so the card
 * cannot drift from the header. Everything is read from the repository while
 * the static card is built, so building it fetches nothing over the network.
 * The card is a pure function of those files and lib/i18n/en.ts: rebuilding it
 * gives the same image, which is the whole "script" there is to commit.
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
/* The wordmark lockup, in Wordmark.tsx's own proportions: the N is 2.05 times the lettering's cap
   height, the gap between them 0.62 of it, both on one centre line. The N's drawing is 1000 x 938
   (brand/logo/nightshift-mark.svg), the lettering's 1028 x 110.4 (nightshift-wordmark.svg). */
const N_H = 72;
const CAP = N_H / 2.05;
const N_W = Math.round((N_H * 1000) / 938);
const LETTERS_W = Math.round((CAP * 1028) / 110.4);
const LETTERS_H = Math.round(CAP);
const WORDMARK_GAP = Math.round(0.62 * CAP);

const BRAND_DIR = join(process.cwd(), "brand");
const FONT_DIR = join(BRAND_DIR, "og-fonts");

/** An SVG master as an <img> source; the lettering draws in currentColor, which an image has no parent for. */
async function svgData(file: string, ink?: string): Promise<string> {
  let svg = await readFile(join(BRAND_DIR, "logo", file), "utf8");
  if (ink) svg = svg.replaceAll("currentColor", ink);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function font(file: string): Promise<ArrayBuffer> {
  const buf = await readFile(join(FONT_DIR, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export async function GET() {
  const [mark, letters, regular, semibold] = await Promise.all([
    svgData("nightshift-mark.svg"),
    svgData("nightshift-wordmark.svg", TEXT),
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
          <div style={{ display: "flex", alignItems: "center", gap: WORDMARK_GAP }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- next/og renders <img> */}
            <img src={mark} width={N_W} height={N_H} alt="" />
            {/* eslint-disable-next-line @next/next/no-img-element -- next/og renders <img> */}
            <img src={letters} width={LETTERS_W} height={LETTERS_H} alt="" />
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
        { name: "Onest", data: regular, weight: 400, style: "normal" },
        { name: "Onest", data: semibold, weight: 600, style: "normal" },
      ],
    },
  );
}
