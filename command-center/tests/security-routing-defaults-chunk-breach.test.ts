import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routingOptions } from "@/lib/server/pipeline-options";

/**
 * Breach, PR #958: the PR moved the routing panel's vendor LISTS to props (routingOptions()), but the panel itself
 * (components/providers/PipelineRouting.tsx, "use client") still hard-codes the pipeline's DEFAULT vendors and the special
 * case for one of them: `CHRONOS_VIDEO_PROVIDER || "minimax"`, `CHRONOS_IMAGE_PROVIDER || "leonardo"`, and the
 * `id === "minimax"` branch that writes CHRONOS_ENABLE_MINIMAX_BROLL. That is the pipeline's routing (which video and image
 * vendor a run uses when nobody chose), and it ships in the Providers page's static chunk.
 *
 * Measured on a local build of bb8a6d1b9 (`next start`, fake Supabase): a CUSTOMER's `RSC: 1` request to /{channel}/providers
 * answers the 404 but its flight data still names `static/chunks/app/(app)/[channel]/providers/page-<hash>.js`; that URL then
 * downloads with NO cookie (200, 15 KB) and contains "minimax" x5, "leonardo" x1 and the CHRONOS_* routing variable names.
 * scripts/vendor-bundle-check.mjs prints "clean" on that build: no pattern covers a bare vendor id as a default.
 *
 * Pinned on the client module's source (a build is not available to vitest): no vendor id the routing panel offers may be a
 * literal in it. The fix is to derive the current selection and the id -> variables mapping on the server (the page already
 * reads the variables there) and pass the panel the result.
 */
const SRC = readFileSync(path.join(process.cwd(), "components", "providers", "PipelineRouting.tsx"), "utf8");
const { video, image } = routingOptions();

describe("breach #958: the routing panel's client chunk names no vendor", () => {
  it("control: the module is a client module and the lists are non-empty", () => {
    expect(SRC).toMatch(/^"use client";/m);
    expect(video.length).toBeGreaterThan(2);
    expect(image.length).toBeGreaterThan(2);
  });

  it.each([...video, ...image].map((o) => o.id))("no %s literal in PipelineRouting.tsx (it ships in a static chunk)", (id) => {
    // Only code, not comments: the module's doc comment may describe config.py.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(new RegExp(`["'\`]${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`));
  });
});
