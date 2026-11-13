#!/usr/bin/env node
/**
 * Writes lib/site/model-facts.json: the public half of schemas/model_registry.json, for the models that made at least one of the
 * site's samples (lib/site/showcase.json). The public model pages (app/models) read it.
 *
 *     node command-center/scripts/export-model-facts.mjs        (from the repository root, or `node scripts/…` in command-center)
 *
 * Why a copy and not the registry itself: the web image is built from command-center/ alone (Dockerfile, deploy/docker-compose.yml
 * `context: ../command-center`), so schemas/ is not there at build time. tests/model-pages.test.tsx re-projects the registry and
 * fails, naming this command, the moment the copy and the registry disagree.
 *
 * Only what a visitor may read: what the Studio can ask the model for (tools, shapes, lengths, resolutions, inputs) and the two
 * flags that decide what the page says about availability. Never the vendor's price, the credit unit, terms notes or limits: a
 * provider cost is not our price, and a page that printed it would be quoting a number nobody sells at. Not the maker's credit
 * line either: by the owner's rule of 2026-11-13 no public surface shows a "Powered by" line or links to the maker; that credit
 * stays in the signed-in Studio, where the feature is offered. Nor the provider slug: no page uses it, and a public file that
 * named whose model each one is would say more about our suppliers than the pages do.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CC = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REGISTRY_FILE = join(CC, "..", "schemas", "model_registry.json");
export const SHOWCASE_FILE = join(CC, "lib", "site", "showcase.json");
export const FACTS_FILE = join(CC, "lib", "site", "model-facts.json");

const list = (v) => (Array.isArray(v) ? v : []);

/** One registry model's public facts. Keys are always present, so an absent registry field reads as "none", never as a default. */
export function projectModel(m) {
  return {
    id: m.id,
    name: m.display_name,
    output: m.output,
    capabilities: list(m.capabilities),
    aspectRatios: list(m.aspect_ratios),
    aspectRatiosByCapability: m.aspect_ratios_by_capability && typeof m.aspect_ratios_by_capability === "object" ? m.aspect_ratios_by_capability : {},
    resolutions: list(m.resolutions),
    durationsS: list(m.durations_s),
    imageRefsMax: typeof m.inputs?.image_refs_max === "number" ? m.inputs.image_refs_max : 0,
    endFrame: m.end_frame === true,
    audioOut: m.audio_out === true,
    // 0139: only the JSON value true is an operator preview.
    operatorPreview: m.operator_preview === true,
    shutdownOn: typeof m.shutdown?.on === "string" ? m.shutdown.on : null,
  };
}

/** The facts file for these two documents: every model a sample names, in registry order. */
export function projectModelFacts(registry, showcase) {
  const sampled = new Set(list(showcase?.entries).map((e) => e?.modelId));
  return { models: list(registry?.models).filter((m) => sampled.has(m.id)).map(projectModel) };
}

export function renderModelFacts(facts) {
  return JSON.stringify(facts, null, 2) + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  const showcase = JSON.parse(readFileSync(SHOWCASE_FILE, "utf8"));
  const facts = projectModelFacts(registry, showcase);
  writeFileSync(FACTS_FILE, renderModelFacts(facts));
  console.log(`wrote ${facts.models.length} models to lib/site/model-facts.json`);
}
