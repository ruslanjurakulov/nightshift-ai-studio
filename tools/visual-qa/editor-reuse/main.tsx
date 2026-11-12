import "@/app/fonts.css";
import "@/app/globals.css";
import "@/components/motion/motion.css";
import "@/app/(app)/app-redesign.css";
import "@/app/(app)/app-pages-1.css";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/context";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import type { EditorAsset, TimelineDoc } from "@/lib/editor";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = q.get("theme") ?? "dark";
const locale = (q.get("lang") ?? "en") as "uz" | "en" | "ru";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const M = "44444444-4444-4444-8444-444444444444";
const O = "55555555-5555-4555-8555-555555555555";
// An abstract placeholder drawn here: the layout's shape, nothing more.
const swatch = (a: string, b: string) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs><rect width='100%' height='100%' fill='url(#g)'/></svg>`);
const assets: Record<string, EditorAsset> = {
  [A]: { id: A, kind: "video", name: "interview.mp4", durationS: 20, width: 1920, height: 1080, viewUrl: null, thumbUrl: swatch("#1f4e8c", "#f2a541") } as EditorAsset,
  [B]: { id: B, kind: "video", name: "b-roll.mp4", durationS: 12, width: 1920, height: 1080, viewUrl: null, thumbUrl: swatch("#3d5a80", "#ee6c4d") } as EditorAsset,
  [M]: { id: M, kind: "audio", name: "music.mp3", durationS: 60, viewUrl: null, thumbUrl: null } as unknown as EditorAsset,
  [O]: { id: O, kind: "image", name: "logo.png", durationS: null, width: 400, height: 400, viewUrl: swatch("#5f0f40", "#9a031e"), thumbUrl: swatch("#5f0f40", "#9a031e") } as unknown as EditorAsset,
};
const doc: TimelineDoc = {
  version: 1, width: 1920, height: 1080, fps: 30,
  tracks: [
    { id: "v1", kind: "V", clips: [
      { id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 5, speed: 1, audio: true, grade: { brightness: 0.05, contrast: 1.15, saturation: 1.25 }, filter: "warm", vignette: 0.3 },
      { id: "c2", asset_id: B, start_s: 5, in_s: 1, out_s: 5, speed: 1, audio: true },
      { id: "c3", asset_id: A, start_s: 9, in_s: 8, out_s: 14, speed: 1, audio: true },
    ] },
    { id: "a1", kind: "A", clips: [{ id: "m1", asset_id: M, start_s: 0, in_s: 0, out_s: 15, gain_db: -6, fade_in_s: 0, fade_out_s: 1 }] },
    { id: "t1", kind: "T", clips: [{ id: "x1", start_s: 0.5, end_s: 3, text: "Hook title", size: 64, x: 0.5, y: 0.85, anchor: "center" }] },
    { id: "t2", kind: "T", clips: [{ id: "x2", start_s: 9.5, end_s: 12, text: "Part two", size: 64, x: 0.5, y: 0.85, anchor: "center" }] },
  ],
  overlays: [{ id: "o1", asset_id: O, start_s: 10, end_s: 13, x: 0.8, y: 0.2, w: 0.2, opacity: 1 }],
};
const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }));
window.fetch = (() => json({ error: "offline harness" }, 503)) as typeof fetch;
createRoot(document.getElementById("root")!).render(
  <I18nProvider locale={locale}>
    <main className="pad-page min-w-0 flex-1">
      <TimelineEditor projectId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" title="Trip" rev={1} doc={doc} exports={[]} assets={assets} videos={[assets[A], assets[B]]} userId="harness" />
    </main>
  </I18nProvider>,
);
