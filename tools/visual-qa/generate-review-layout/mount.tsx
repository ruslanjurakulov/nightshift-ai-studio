import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { I18nProvider } from "@/lib/i18n/context";
import { STUDIO_VOICES, type StudioModel } from "@/lib/creative/studio";
import type { Locale } from "@/lib/i18n";
import "@/app/globals.css";
import "@/app/glass.css";
import "@/components/studio/desk.css";
import "@/components/studio/studio-home.css";

declare global {
  interface Window {
    mountReview: (locale: Locale, layout: "panel" | "composer") => void;
    syntheticCalls: string[];
    unmountReview: () => void;
  }
}

const ORG = "11111111-1111-4111-8111-111111111111";
const LOOK = "22222222-2222-4222-8222-222222222222";
const models: StudioModel[] = [
  { id: "synthetic-video", displayName: "SyntheticVideoModelWithAnIntentionallyLongUnbrokenDisplayNameForWrapping", capabilities: ["t2v"], durations: [5], beta: false },
  { id: "synthetic-voice", displayName: "Synthetic narrator model", capabilities: ["tts"], beta: false },
];
window.syntheticCalls = [];
window.fetch = async (input, init) => {
  const url = String(input);
  window.syntheticCalls.push(`${init?.method ?? "GET"} ${url}`);
  if (url === "/api/creative/jobs" && init?.method === "POST") throw new Error("Generation must never run in layout QA");
  if (url === "/api/creative/quote") return new Response(JSON.stringify({ quote: { credits: 12345.75 } }));
  if (url.startsWith("/api/creative/jobs")) return new Response(JSON.stringify({ jobs: [] }));
  return new Response(JSON.stringify({ error: "synthetic_unavailable" }), { status: 503 });
};

let root: Root | null = null;
window.unmountReview = () => { root?.unmount(); root = null; };
window.mountReview = (locale, layout) => {
  root?.unmount();
  window.syntheticCalls = [];
  root = createRoot(document.getElementById("mount")!);
  root.render(
    <I18nProvider locale={locale}>
      <GeneratePanel orgId={ORG} models={models} layout={layout} defaultStyleKitId={LOOK}
        initial={{ capability: layout === "panel" ? "t2v" : "tts", model: layout === "panel" ? "synthetic-video" : "synthetic-voice",
          prompt: "Synthetic layout fixture only", aspect: "16:9", duration: 5, voiceId: STUDIO_VOICES[0].id }} />
    </I18nProvider>,
  );
};
