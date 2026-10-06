import type { CSSProperties } from "react";

/**
 * Light drawn over a still, in CSS alone: no file, no fetch, no canvas, nothing but a few elements that move by their
 * transform and opacity (so it costs the compositor and not the main thread), masked to the picture by its box
 * (overflow hidden), starting after the page has loaded, stopped by the page's pause switch and absent under reduced
 * motion (site-next.css, ".nx-fx"). Each kind is the light that belongs to its scene: sand in the wind over the caravan,
 * shafts and dust in the library, mist in the valley, shimmer on the moon's water, flicker in the lanterns. The picture
 * it sits on says "Example clip (animated still)" while it runs (the badge rule keys on `data-fxscene`).
 */
export type FxKind = "sand" | "shafts" | "mist" | "water" | "lanterns";

const rnd = (i: number, k: number) => {
  const v = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

const style = (o: Record<string, string | number>) => o as CSSProperties;

function Motes({ n, kind }: { n: number; kind: string }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className="nx-fx-mote" style={style({ "--x": `${Math.round(rnd(i, 1) * 100)}%`, "--y": `${Math.round(rnd(i, 2) * 100)}%`, "--s": `${(1.5 + rnd(i, 3) * 2.5).toFixed(1)}px`, "--d": `${(7 + rnd(i, 4) * 9).toFixed(1)}s`, "--t": `${(-rnd(i, 5) * 12).toFixed(1)}s`, "--dx": `${Math.round((rnd(i, 6) - 0.3) * (kind === "sand" ? 160 : 40))}px`, "--dy": `${Math.round(-20 - rnd(i, 7) * 50)}px` })} />
      ))}
    </>
  );
}

export function StillFx({ kind }: { kind: FxKind }) {
  return (
    <div className="nx-fx" data-fx={kind} aria-hidden>
      {kind === "sand" && (
        <>
          <b className="nx-fx-streak" style={style({ "--y": "58%", "--d": "11s", "--t": "-2s" })} />
          <b className="nx-fx-streak" style={style({ "--y": "72%", "--d": "14s", "--t": "-9s" })} />
          <Motes n={8} kind="sand" />
        </>
      )}
      {kind === "shafts" && (
        <>
          <b className="nx-fx-shaft" style={style({ "--x": "20%", "--w": "22%", "--r": "16deg", "--d": "9s", "--t": "-1s" })} />
          <b className="nx-fx-shaft" style={style({ "--x": "34%", "--w": "14%", "--r": "20deg", "--d": "12s", "--t": "-6s" })} />
          <b className="nx-fx-shaft" style={style({ "--x": "8%", "--w": "16%", "--r": "12deg", "--d": "10s", "--t": "-3s" })} />
          <Motes n={6} kind="shafts" />
        </>
      )}
      {kind === "mist" && (
        <>
          <b className="nx-fx-mist" style={style({ "--y": "46%", "--d": "26s", "--t": "-4s" })} />
          <b className="nx-fx-mist" style={style({ "--y": "62%", "--d": "34s", "--t": "-17s" })} />
          <b className="nx-fx-sun" />
        </>
      )}
      {kind === "water" && (
        <>
          <b className="nx-fx-shimmer" />
          <b className="nx-fx-moonglow" />
          {Array.from({ length: 7 }, (_, i) => (
            <i key={i} className="nx-fx-star" style={style({ "--x": `${Math.round(6 + rnd(i, 1) * 88)}%`, "--y": `${Math.round(4 + rnd(i, 2) * 38)}%`, "--d": `${(2.5 + rnd(i, 3) * 3).toFixed(1)}s`, "--t": `${(-rnd(i, 4) * 5).toFixed(1)}s` })} />
          ))}
        </>
      )}
      {kind === "lanterns" &&
        [
          [8, 9],
          [19, 15],
          [29, 11],
          [39, 17],
          [49, 10],
          [59, 16],
          [69, 12],
          [80, 18],
          [91, 11],
        ].map(([x, y], i) => <u key={i} className="nx-fx-lantern" style={style({ "--x": `${x}%`, "--y": `${y}%`, "--d": `${(1.6 + rnd(i, 1) * 2.2).toFixed(1)}s`, "--t": `${(-rnd(i, 2) * 4).toFixed(1)}s` })} />)}
    </div>
  );
}
