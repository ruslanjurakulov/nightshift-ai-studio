#!/usr/bin/env node
/**
 * After `next build`: no browser JavaScript carries our vendor routing, the vendor display map, or our vendor metering units.
 *
 * Three things the site must never show, each of which a build once put in a static chunk:
 *
 *   - each effect's model preference order (lib/effects/effects.json "models":["runway-gen4.5","minimax-h3",…]) and its full
 *     prompt: the catalog was a client module, in the chunk on /, /solutions/[slug] and the Studio. It is server-only now
 *     (lib/effects/catalog.ts) and the browser gets the slices in lib/effects/shared.ts;
 *   - the provider display map (openai:"OpenAI", bfl:"Black Forest Labs", …): it sat in lib/models-discovery.ts, which the plan
 *     finder imports, so it was in the chunk on /, /pricing and /login. It is lib/server/provider-names.ts now;
 *   - the cost ledger's units: the list (["gemini_input_tokens",…,"pexels_requests",…]) sat in lib/credits.ts, and the
 *     vendor-named ones were keys of the shared dictionary and of lib/creditUnits.ts. They are lib/server/ledger-units.ts and
 *     lib/server/ledger-unit-labels.ts now; a vendor-named unit is flagged in ANY form, a dictionary key included.
 *
 * And what the signed-in screens imported, which put the same kind of data in their chunks (a static chunk is downloadable
 * by anyone, operator-only pages included; the screens now get it as props from the server):
 *
 *   - a secret NAME (GEMINI_API_KEY, …) or a `secretName:` key: lib/providers.ts, lib/imageProviders.ts, lib/model-keys.ts;
 *   - a vendor console or key page (consoleUrl / keyUrl) from lib/providers.ts and lib/model-keys.ts;
 *   - an image generator's default vendor model (`defaultModel:`, or a value of it that is not a Studio model id) from
 *     lib/imageProviders.ts;
 *   - the Agent Builder registry's licensing and pricing state (lib/agent-providers.ts);
 *   - the Create form's operator option lists: its video models (lib/server/pipeline-options.ts), the narration vendor's
 *     model -> languages table (lib/ttsLanguages.ts) and the model each Studio example was written for
 *     (lib/server/creative-examples.ts);
 *   - the marketing board's banned provider names (lib/marketing-banned.ts BANNED_PROVIDER_NAMES): the list IS the vendors' names.
 *     Flagged as BANNED_LIST_MIN of them side by side as array elements or in one literal; the New post form gets the list as a prop;
 *   - our configuration's naming: the per-unit cost variables' prefix CHRONOS_PRICE_ and the sponsor CPM variable
 *     (lib/server/price-env.ts), which the shared dictionary carried in four sentences, and the token secret's prefix
 *     CHRONOS_YT_TOKEN_ (lib/server/github-secrets.ts), which the Channels screens built names with. Flagged in any form.
 *   - our deployment's configuration names (lib/server/config-env.ts: GITHUB_SECRETS_TOKEN, GOOGLE_OAUTH_CLIENT_SECRET,
 *     MEDIA_URL_SECRET, NIGHTSHIFT_MODEL_SWITCH, DODO_PRODUCT_*, …), which the shared dictionary carried in setup sentences on
 *     a dozen screens. Flagged as whole names (and the prefixes as the start of one); lib/server/config-hints.ts names them to
 *     the operator.
 *
 * In what shapes (PR 3 of the sweep added all but the first; tests/security-vendor-bundle-check-breach.test.ts and
 * tests/security-vendor-sweep3-breach.test.ts hold a failing case and a legitimate look-alike for each):
 *
 *   - as written: adjacent quoted array elements, key:"value" pairs, a value inside longer copy;
 *   - the provider map as [slug, name] entries (new Map([...]), Object.entries serialized), as objects holding the slug and
 *     the name as two values under any keys ({slug,name}, {name,id}), reversed ({"Black Forest Labs":"bfl"}) and as a switch
 *     (case"bfl":return"Black Forest Labs");
 *   - an effect's model order as ONE string a split() turns back into the list ("a,b", "a b", "a|b"), or in copy with an
 *     arrow between two choices ("a → b", "a -> b", "a > b");
 *   - the banned names inside one string or regex literal, separated by | or , (a precompiled matcher, a split string);
 *   - split, interned or concatenated strings, through reassemble(): a `+` chain of pieces, an array of pieces joined, a
 *     template literal whose every ${…} is a piece, and an array literal of pieces, where a piece is a string literal or an
 *     identifier declared exactly once in its file, by assigning it one (var v0="runway-gen4.5",v1="minimax-h3";x=[v0,v1]);
 *     and the compiler's own form of a template literal, a .concat() chain, and the literal prefix of a .concat() or a
 *     .join() whose later pieces are known only at run time.
 *
 * What is NOT caught, and cannot be by reading text (a pass is not a proof for these):
 *
 *   - a value that exists only at run time: fetched, decoded (atob, a char-code array, a reversed or shifted string), indexed
 *     out of a larger table (s.slice(3,9)), or computed by any function call other than join();
 *   - an identifier declared more than once in its file (a minifier reuses e, t, n across scopes, as variables and as
 *     parameters): which value a use holds is a scope question, so it is not resolved, and an interned id held in such a
 *     name reads as nothing;
 *   - a template literal or `+` chain with any piece that is not a literal or a once-bound identifier (a parameter, a property
 *     read): only its literal runs are joined, and a prompt whose every literal run is shorter than PROMPT_WINDOW is missed;
 *   - an effect's order in shapes with no two choices side by side: a fallback map ({"a":"b","b":"c"}), Map entries with a rank
 *     ([["a",0],["b",1]]), objects ([{id:"a"},{id:"b"}]). Each is a pattern over arbitrary keys and values that ordinary
 *     picker code also writes, so a pattern for it would fail legitimate builds;
 *   - one or two provider pairs that are just a name written properly (openai:"OpenAI"; MAP_PAIRS_MIN), fewer than
 *     BANNED_LIST_MIN banned names together, one model id alone (a Studio model id is shown by design);
 *   - pages rendered per request (see below): their RSC payloads are not files in the build.
 *
 * Every value is read from those files, so a new effect, vendor or unit is checked without editing this script. What is
 * scanned: EVERY .js file under .next/static (a static chunk is downloadable by anyone who knows its name, signed in or not),
 * and every text file next build wrote under .next/server/app (prerendered .html/.rsc pages, route handler .body files, their
 * .meta) and the .html under .next/server/pages, except the server's own code (.js, .map, .nft.json), which legitimately
 * holds the data. Pages that render per request (all of today's app pages) are not files in the build and are NOT covered
 * here: their props are held by tests (tests/pricing-finder-props.test.tsx, tests/effects-gallery-props.test.tsx). The
 * summary line says how many app pages were prerendered, 0 included.
 *
 * Text is read the way the browser would read it: escaped quotes are undone until nothing changes (a JSON string in an RSC
 * row in a flight script is escaped two or three times) and the HTML quote entities are decoded.
 *
 * Exit 1 on a leak, 2 when the check could not run (no build, a partial build, or a source no longer in the shape read here —
 * a pass then would mean nothing). Run from command-center/ after `next build`: `node scripts/vendor-bundle-check.mjs
 * [path/to/.next]`. Prints file paths and the pattern that matched; never the surrounding text.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
// An optional first argument names another build's .next (to show the check failing on a copy of an older build).
const NEXT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, ".next");
const STATIC = path.join(NEXT, "static");
const PRERENDERED = path.join(NEXT, "server");
const EFFECTS_JSON = path.join(ROOT, "lib", "effects", "effects.json");
const EFFECTS_MODULE = path.join(ROOT, "lib", "effects", "catalog.ts");
const PROVIDERS = path.join(ROOT, "lib", "server", "provider-names.ts");
const LEDGER = path.join(ROOT, "lib", "server", "ledger-units.ts");
/** The signed-in screens' sources (relative to command-center/), each server-only now. Exported for the tests' fake builds. */
export const SIGNED_IN_SOURCES = [
  "lib/providers.ts",
  "lib/imageProviders.ts",
  "lib/model-keys.ts",
  "lib/agent-providers.ts",
  "lib/ttsLanguages.ts",
  "lib/ttsModels.ts",
  "lib/server/pipeline-options.ts",
  "lib/server/creative-examples.ts",
  "lib/creative/model-names.ts",
  "lib/server/github-secrets.ts",
  "lib/server/github-variables.ts",
  // The marketing board's banned provider names: the list is the vendor identities themselves (PR 3 of the sweep).
  "lib/marketing-banned.ts",
  // Our pricing configuration's names (CHRONOS_PRICE_, CHRONOS_SPONSORSHIP_CPM_USD).
  "lib/server/price-env.ts",
  // Our deployment's configuration names (GITHUB_SECRETS_TOKEN, MEDIA_URL_SECRET, NIGHTSHIFT_MODEL_SWITCH, …): PR 4 of the sweep.
  "lib/server/config-env.ts",
];
/** How many banned provider names side by side as array elements make it the list: three could be a model picker's makers. */
export const BANNED_LIST_MIN = 4;
/** How many of the Create form's video options (id and label side by side) in one file make it the list. */
export const OPTION_PAIRS_MIN = 3;

/** How many pairs of the provider map in one file make it the map: two vendor names in some copy are not a lookup table. */
export const MAP_PAIRS_MIN = 3;
/** A prompt is matched by windows of this many characters from each part between its slots: long enough that no other text
 *  in the product holds one, short enough that a part as short as a template's head still has one. */
export const PROMPT_WINDOW = 30;

const fail2 = (msg) => {
  console.error(`vendor-bundle-check: ${msg}`);
  process.exit(2);
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const Q = `["'\`]`;

function serverOnly(file, label) {
  if (!existsSync(file)) fail2(`${label} not found — run from command-center/.`);
  const src = readFileSync(file, "utf8");
  if (!/^import "server-only";$/m.test(src)) fail2(`${label} no longer has \`import "server-only"\` — the guard this check backs up is gone.`);
  return src;
}

/** The effects, the provider map and the ledger units, read from their (server-only) sources. */
function readSource() {
  serverOnly(EFFECTS_MODULE, "lib/effects/catalog.ts");
  if (!existsSync(EFFECTS_JSON)) fail2("lib/effects/effects.json not found — run from command-center/.");
  let raw;
  try {
    raw = JSON.parse(readFileSync(EFFECTS_JSON, "utf8"));
  } catch {
    fail2("lib/effects/effects.json is not JSON.");
  }
  const effects = (Array.isArray(raw?.effects) ? raw.effects : [])
    .filter((e) => typeof e?.id === "string" && Array.isArray(e.models) && typeof e.prompt === "string")
    .map((e) => ({ id: e.id, models: e.models.filter((m) => typeof m === "string"), prompt: e.prompt }));
  // Floors from the file as it is today (8 effects, 2 to 4 models each): far below them the file is no longer read.
  if (effects.length < 5 || effects.some((e) => e.models.length < 1 || e.prompt.length < 40)) {
    fail2(`read ${effects.length} effects with models and prompts from lib/effects/effects.json — its shape changed.`);
  }

  const providerSrc = serverOnly(PROVIDERS, "lib/server/provider-names.ts");
  const block = providerSrc.match(/const PROVIDER_NAMES[^=]*=\s*\{([\s\S]*?)\};/);
  if (!block) fail2("PROVIDER_NAMES is no longer an object literal in lib/server/provider-names.ts — update readSource().");
  const providers = [...block[1].matchAll(/^\s*["']?([a-z0-9_-]+)["']?:\s*"([^"]+)",?\s*$/gm)].map((m) => ({ slug: m[1], name: m[2] }));
  if (providers.length < 8) fail2(`read only ${providers.length} PROVIDER_NAMES entries — its shape changed.`);

  const ledgerSrc = serverOnly(LEDGER, "lib/server/ledger-units.ts");
  const list = ledgerSrc.match(/export const LEDGER_UNITS\s*=\s*\[([\s\S]*?)\]/);
  if (!list) fail2("LEDGER_UNITS is no longer an array literal in lib/server/ledger-units.ts — update readSource().");
  const units = [...list[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
  if (units.length < 5) fail2(`read only ${units.length} LEDGER_UNITS — its shape changed.`);
  const vlist = ledgerSrc.match(/export const VENDOR_NAMED_LEDGER_UNITS\s*=\s*\[([\s\S]*?)\]/);
  if (!vlist) fail2("VENDOR_NAMED_LEDGER_UNITS is no longer an array literal in lib/server/ledger-units.ts — update readSource().");
  const vendorUnits = [...vlist[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
  if (vendorUnits.length < 1 || vendorUnits.some((u) => !units.includes(u))) fail2("VENDOR_NAMED_LEDGER_UNITS is empty or names a unit LEDGER_UNITS does not — its shape changed.");
  return { effects, providers, units, vendorUnits, ...readSignedIn() };
}

const src = (rel) => serverOnly(path.join(ROOT, rel), rel);

/** What the signed-in screens imported, read from the (now server-only) sources. */
function readSignedIn() {
  const providersSrc = src("lib/providers.ts");
  const imageSrc = src("lib/imageProviders.ts");
  const keysSrc = src("lib/model-keys.ts");
  const agentSrc = src("lib/agent-providers.ts");
  const ttsSrc = src("lib/ttsLanguages.ts");
  src("lib/ttsModels.ts");
  const pipelineSrc = src("lib/server/pipeline-options.ts");
  const ghSecretsSrc = src("lib/server/github-secrets.ts");
  const ghVariablesSrc = src("lib/server/github-variables.ts");
  const examplesSrc = src("lib/server/creative-examples.ts");

  const secretNames = new Set();
  for (const text of [providersSrc, imageSrc]) for (const m of text.matchAll(/secretName:\s*"([A-Z][A-Z0-9_]+)"/g)) secretNames.add(m[1]);
  const fromProviders = secretNames.size;
  const envBlocks = [...keysSrc.matchAll(/envSets:\s*\[((?:[^\[\]]|\[[^\[\]]*\])*)\]/g)];
  for (const b of envBlocks) for (const m of b[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)) secretNames.add(m[1]);
  // Floors from the files as they are today (16 providers, 6 generators, 20-odd vendors): far below them, the regexes no longer
  // read the files.
  // The YouTube secrets the new-channel wizard saves (YOUTUBE_SECRET_NAMES): a secret name like any other.
  const yt = ghSecretsSrc.match(/export const YOUTUBE_SECRET_NAMES\s*=\s*\{([\s\S]*?)\}/);
  const ytNames = yt ? [...yt[1].matchAll(/"(YOUTUBE_[A-Z0-9_]+)"/g)].map((m) => m[1]) : [];
  if (ytNames.length < 3) fail2(`read only ${ytNames.length} YOUTUBE_SECRET_NAMES from lib/server/github-secrets.ts — its shape changed.`);
  for (const n of ytNames) secretNames.add(n);
  if (fromProviders < 12 || envBlocks.length < 12) fail2(`read ${fromProviders} secret names from lib/providers.ts and lib/imageProviders.ts and ${envBlocks.length} envSets from lib/model-keys.ts — their shape changed.`);

  const keyPages = new Set();
  for (const m of providersSrc.matchAll(/consoleUrl:\s*"(https:\/\/[^"]+)"/g)) keyPages.add(m[1]);
  const fromConsole = keyPages.size;
  for (const m of keysSrc.matchAll(/keyUrl:\s*"(https:\/\/[^"]+)"/g)) keyPages.add(m[1]);
  if (fromConsole < 10 || keyPages.size <= fromConsole) fail2(`read ${fromConsole} consoleUrl and ${keyPages.size - fromConsole} more keyUrl values — their shape changed.`);

  const defaultModels = [...imageSrc.matchAll(/defaultModel:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (defaultModels.length < 4) fail2(`read only ${defaultModels.length} defaultModel values from lib/imageProviders.ts — its shape changed.`);
  // A Studio model id is shown to customers by design (the picker), so a default model that is also one is not, alone, a leak;
  // the `defaultModel:` key is.
  const studioIds = new Set([...readFileSync(path.join(ROOT, "lib", "creative", "model-names.ts"), "utf8").matchAll(/^\s*"([^"]+)":\s*"/gm)].map((m) => m[1]));
  if (studioIds.size < 20) fail2(`read only ${studioIds.size} Studio model ids from lib/creative/model-names.ts — its shape changed.`);

  const registry = agentSrc.match(/export const PROVIDERS\s*=\s*\{([\s\S]*?)\n\}\s*as const;/);
  if (!registry) fail2("PROVIDERS is no longer an object literal in lib/agent-providers.ts — update readSignedIn().");
  const agentKeys = ["licensingState", "pricingMode", "apiState"];
  const agentStates = new Set();
  for (const k of agentKeys) for (const m of registry[1].matchAll(new RegExp(`${k}:\\s*"([a-z_]+)"`, "g"))) agentStates.add(m[1]);
  const developers = [...registry[1].matchAll(/developer:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (agentStates.size < 2 || developers.length < 2) fail2("read no licensingState / pricingMode / developer from lib/agent-providers.ts — its shape changed.");

  const videoBlock = pipelineSrc.match(/const CREATE_VIDEO_MODELS[^=]*=\s*\[([\s\S]*?)\];/);
  if (!videoBlock) fail2("CREATE_VIDEO_MODELS is no longer an array literal in lib/server/pipeline-options.ts — update readSignedIn().");
  const createOptions = [...videoBlock[1].matchAll(/\{\s*id:\s*"([a-z0-9-]+)",\s*name:\s*"([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2] }));
  if (createOptions.length < 5) fail2(`read only ${createOptions.length} Create video options — its shape changed.`);

  const imageOptions = [...imageSrc.matchAll(/\{\s*id:\s*"([a-z0-9-]+)",\s*name:\s*"([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2] }));
  if (imageOptions.length < 4) fail2(`read only ${imageOptions.length} image generators from lib/imageProviders.ts — its shape changed.`);
  const ttsSrcModels = src("lib/ttsModels.ts");
  // The routing variables the Providers panel writes (WRITABLE_VARIABLES' CHRONOS_* names): one names the b-roll vendor, all
  // are our pipeline's configuration. The panel gets them as props.
  const wv = ghVariablesSrc.match(/export const WRITABLE_VARIABLES\s*=\s*\[([\s\S]*?)\]/);
  const routingVariables = wv ? [...wv[1].matchAll(/"(CHRONOS_[A-Z0-9_]+)"/g)].map((m) => m[1]) : [];
  if (routingVariables.length < 5) fail2(`read only ${routingVariables.length} CHRONOS_* names from WRITABLE_VARIABLES in lib/server/github-variables.ts — its shape changed.`);

  const ttsBlock = ttsSrc.match(/TTS_MODEL_LANGUAGES[^=]*=\s*\{([\s\S]*?)\n\};/);
  const ttsModels = ttsBlock ? [...ttsBlock[1].matchAll(/^\s*([a-z0-9_]+):\s*\[/gm)].map((m) => m[1]) : [];
  if (ttsModels.length < 5) fail2(`read only ${ttsModels.length} models of TTS_MODEL_LANGUAGES from lib/ttsLanguages.ts — its shape changed.`);
  // The model ids the queue accepts and the picker lists (lib/ttsModels.ts), when the table does not key one of them.
  for (const m of ttsSrcModels.matchAll(/"(eleven_[a-z0-9_]+)"/g)) if (!ttsModels.includes(m[1])) ttsModels.push(m[1]);

  const bannedSrc = src("lib/marketing-banned.ts");
  const bannedBlock = bannedSrc.match(/export const BANNED_PROVIDER_NAMES[^=]*=\s*\[([\s\S]*?)\];/);
  const bannedNames = bannedBlock ? [...bannedBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  if (bannedNames.length < 20) fail2(`read only ${bannedNames.length} BANNED_PROVIDER_NAMES from lib/marketing-banned.ts — its shape changed.`);

  // Our configuration's naming, which the browser never needs: the per-unit cost variables' prefix (lib/server/price-env.ts) and
  // the per-channel token secret's (lib/server/github-secrets.ts). Each was a literal in a chunk every signed-in page loads.
  // Every CHRONOS_* constant of lib/server/price-env.ts (the per-unit cost prefix, the sponsor CPM variable, and whatever is
  // added there), and the token secret's prefix.
  const priceSrc = src("lib/server/price-env.ts");
  const priceNames = [...priceSrc.matchAll(/export const [A-Z0-9_]+\s*=\s*"(CHRONOS_[A-Z0-9_]+)"/g)].map((m) => m[1]);
  const tokenPrefix = ghSecretsSrc.match(/export const CHANNEL_TOKEN_SECRET_PREFIX\s*=\s*"(CHRONOS_[A-Z0-9_]+_)"/)?.[1];
  if (priceNames.length < 2 || !priceNames.includes("CHRONOS_PRICE_") || !tokenPrefix) {
    fail2("lib/server/price-env.ts no longer exports CHRONOS_PRICE_ and the sponsor variable, or CHANNEL_TOKEN_SECRET_PREFIX (lib/server/github-secrets.ts) is no longer a CHRONOS_*_ literal — their shape changed.");
  }

  // Our deployment's configuration names (lib/server/config-env.ts): every exported string, the way price-env.ts is read. A name
  // ending in "_" is a prefix (DODO_PRODUCT_<PACK>), flagged as the start of any longer name; the rest are whole names. The
  // shared dictionary carried twenty of them in setup sentences; lib/server/config-hints.ts now names them to the operator.
  const configSrc = src("lib/server/config-env.ts");
  const configEnv = [...configSrc.matchAll(/export const [A-Z0-9_]+\s*=\s*"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]);
  // Floor from the file as it is today (21 names): far below it, the regex no longer reads the file.
  if (configEnv.length < 18 || !configEnv.includes("GITHUB_SECRETS_TOKEN")) {
    fail2(`read only ${configEnv.length} configuration names from lib/server/config-env.ts — its shape changed.`);
  }
  const configNames = configEnv.filter((n) => !n.endsWith("_"));
  const configEnvPrefixes = configEnv.filter((n) => n.endsWith("_"));

  const exBlock = examplesSrc.match(/EXAMPLE_MODELS[^=]*=\s*\{([\s\S]*?)\};/);
  const exampleModels = exBlock ? [...exBlock[1].matchAll(/^\s*([a-z0-9_]+):\s*"([^"]+)",?\s*$/gm)].map((m) => ({ id: m[1], model: m[2] })) : [];
  if (exampleModels.length < 4) fail2(`read only ${exampleModels.length} EXAMPLE_MODELS from lib/server/creative-examples.ts — its shape changed.`);

  return {
    secretNames: [...secretNames],
    keyPages: [...keyPages],
    defaultModels,
    studioIds: [...studioIds],
    agentKeys,
    agentStates: [...agentStates],
    developers,
    createOptions,
    imageOptions,
    routingVariables,
    ttsModels,
    exampleModels,
    bannedNames,
    configPrefixes: [...priceNames, tokenPrefix, ...configEnvPrefixes],
    configNames,
  };
}

/** A URL as written, with or without its trailing slash, and not as the start of a longer one. */
const urlPattern = (u) => `${escape(u.replace(/\/+$/, ""))}\\/?(?![\\w./%-])`;

/** The windows a prompt is matched by: from each part between its {slots}, its start, middle and end (PROMPT_WINDOW long). */
export function promptWindows(prompt) {
  const out = new Set();
  for (const part of prompt.split(/\{[^}]*\}/).map((p) => p.trim())) {
    if (part.length < PROMPT_WINDOW) continue;
    const mid = Math.floor((part.length - PROMPT_WINDOW) / 2);
    for (const at of [0, mid, part.length - PROMPT_WINDOW]) out.add(part.slice(at, at + PROMPT_WINDOW));
  }
  return [...out];
}

/** Every pattern the browser must not see: [label, RegExp] for single hits, and the provider pairs counted per file. */
export function patterns(source) {
  const { effects, providers, units, vendorUnits } = source;
  const single = [];
  for (const e of effects) {
    // Any two consecutive choices of the effect's order, as adjacent array elements in any quotes: a prefix of the list is
    // already the routing. A one-model effect is matched on its key and value together.
    if (e.models.length === 1) {
      single.push([`effect ${e.id} model order`, new RegExp(`${Q}?models${Q}?\\s*:\\s*\\[\\s*${Q}${escape(e.models[0])}${Q}\\s*\\]`)]);
    }
    for (let i = 0; i + 1 < e.models.length; i++) {
      const [a, b] = [e.models[i], e.models[i + 1]];
      // As array elements, or inside ONE string a split(",") / split(" ") turns back into the list ("a,b", "a b"), or in copy
      // with an arrow between them ("a → b", "a -> b", "a > b").
      const bare = (m) => `(?<![\\w.-])${escape(m)}(?![\\w.-])`;
      single.push([
        `effect ${e.id} model order (${a} then ${b})`,
        new RegExp(`${Q}${escape(a)}${Q}\\s*,\\s*${Q}${escape(b)}${Q}|${bare(a)}(?:\\s*(?:[,|;>]|->|→)\\s*|\\s+)${bare(b)}`),
      ]);
    }
    // The prompt, filled or not: a window from any part between its slots. A filled prompt keeps every part.
    const windows = promptWindows(e.prompt);
    if (windows.length === 0) fail2(`effect ${e.id}: no part of its prompt is ${PROMPT_WINDOW} characters long — update promptWindows().`);
    single.push([`effect ${e.id} prompt`, new RegExp(windows.map(escape).join("|"))]);
  }
  // Two ledger units next to each other as array elements is the unit list (a dictionary writes unit:"label", never this).
  const unit = `${Q}(?:${units.map(escape).join("|")})${Q}`;
  single.push(["ledger unit list", new RegExp(`${unit}\\s*,\\s*${unit}`)]);
  // A vendor-named unit anywhere, in any form: quoted, a key, inside a longer string.
  for (const u of vendorUnits) single.push([`vendor-named ledger unit ${u}`, new RegExp(`(?<![a-z0-9_])${escape(u)}(?![a-z0-9_])`)]);
  single.push(...signedInPatterns(source));
  const pairs = providers.map((p) => {
    const slug = `${Q}${escape(p.slug)}${Q}`;
    const name = `${Q}${escape(p.name)}${Q}`;
    // The slug and the name as two VALUES of one object with no nested object between them, in either order, under any keys:
    // {slug:"bfl",name:"Black Forest Labs"}, {"name":"OpenAI","id":"openai"}.
    const inObject = (x, y) => `\\{[^{}]{0,400}?:\\s*${x}[^{}]{0,400}?:\\s*${y}[^{}]{0,400}?\\}`;
    return {
      label: `${p.slug}:"${p.name}"`,
      re: new RegExp(
        [
          // bfl:"Black Forest Labs", "bfl":"Black Forest Labs", bfl: 'Black Forest Labs' — any quote, quoted key or not.
          `(?<![\\w$])${Q}?${escape(p.slug)}${Q}?\\s*:\\s*${name}`,
          // ["bfl","Black Forest Labs"]: new Map([...]) or Object.entries(PROVIDER_NAMES), serialized.
          `\\[\\s*${slug}\\s*,\\s*${name}\\s*\\]`,
          inObject(slug, name),
          inObject(name, slug),
          // Reversed, a name -> slug lookup: {"Black Forest Labs":"bfl"}.
          `${name}\\s*:\\s*${slug}`,
          // A switch instead of a lookup object: case"bfl":return"Black Forest Labs".
          `case\\s*${slug}\\s*:\\s*return\\s*${name}`,
        ].join("|"),
      ),
      // A pair whose name is not just its slug written properly (bfl -> Black Forest Labs) is the map's own: one is enough.
      alone: p.name.toLowerCase().replace(/[^a-z0-9]/g, "") !== p.slug.replace(/[^a-z0-9]/g, ""),
    };
  });
  const options = [...(source.createOptions ?? []), ...(source.imageOptions ?? [])].map((o) => ({
    label: `${o.id}:"${o.name}"`,
    // value:"kling",children:"Kling" (the compiled <option>) or {id:"kling",name:"Kling"} (the list itself).
    re: new RegExp(`${Q}?(?:value|id)${Q}?\\s*:\\s*${Q}${escape(o.id)}${Q}[^{}]{0,200}?${Q}?(?:children|name|label)${Q}?\\s*:\\s*${Q}${escape(o.name)}${Q}`),
  }));
  return { single, pairs, options };
}

/** The signed-in screens' patterns: [label, RegExp]. Empty when the source has none of the fields (a caller of the old shape). */
function signedInPatterns({ configPrefixes = [], configNames = [], bannedNames = [], createOptions = [], routingVariables = [], secretNames = [], keyPages = [], defaultModels = [], studioIds = [], agentKeys = [], agentStates = [], developers = [], ttsModels = [], exampleModels = [] }) {
  const out = [];
  const key = (k) => new RegExp(`(?<![\\w$])${Q}?${escape(k)}${Q}?\\s*:`);
  if (secretNames.length > 0) {
    out.push(["secretName: key", key("secretName")]);
    // The key with a literal value that is not a Studio model id: a picker's own default is a Studio id, shown by design.
    const studioAlt = studioIds.length > 0 ? `(?!${Q}(?:${studioIds.map(escape).join("|")})${Q})` : "";
    out.push(["defaultModel: key", new RegExp(`(?<![\\w$])${Q}?defaultModel${Q}?\\s*:\\s*${studioAlt}${Q}`)]);
  }
  for (const n of secretNames) out.push([`secret name ${n}`, new RegExp(`(?<![A-Za-z0-9_])${escape(n)}(?![A-Za-z0-9_])`)]);
  // A prefix in any form: "CHRONOS_PRICE_<UNIT>" in copy, "CHRONOS_YT_TOKEN_"+ref in code.
  for (const p of configPrefixes) out.push([`configuration name ${p}*`, new RegExp(`(?<![A-Za-z0-9_])${escape(p)}`)]);
  // A whole name, not a longer one that contains it (NEXT_PUBLIC_PADDLE_API_KEY is not PADDLE_API_KEY; HTTP_STATUS is nothing).
  for (const n of configNames) out.push([`configuration name ${n}`, new RegExp(`(?<![A-Za-z0-9_])${escape(n)}(?![A-Za-z0-9_])`)]);
  for (const v of routingVariables) out.push([`routing variable ${v}`, new RegExp(`(?<![A-Za-z0-9_])${escape(v)}(?![A-Za-z0-9_])`)]);
  for (const u of keyPages) out.push([`vendor key page ${u}`, new RegExp(urlPattern(u))]);
  const studio = new Set(studioIds);
  for (const m of defaultModels) if (!studio.has(m)) out.push([`image generator default model ${m}`, new RegExp(`${Q}${escape(m)}${Q}`)]);
  for (const k of agentKeys) out.push([`agent provider ${k}: key`, key(k)]);
  for (const v of agentStates) out.push([`agent provider state ${v}`, new RegExp(`${Q}${escape(v)}${Q}`)]);
  for (const d of developers) if (/[\s/]/.test(d)) out.push([`agent provider developer ${d}`, new RegExp(escape(d))]);
  // A narration model as the key of a language list: the table, minified or not (eleven_v4:["uz","ru","en"]).
  if (ttsModels.length > 0) {
    out.push(["narration model language table", new RegExp(`(?<![\\w$])${Q}?(?:${ttsModels.map(escape).join("|")})${Q}?\\s*:\\s*\\[\\s*${Q}(?:uz|ru|en)${Q}`)]);
  }
  // A narration vendor model id in ANY form (a label map key, an id list, an option's id): the ids are the vendor's own.
  for (const m of ttsModels) out.push([`narration vendor model ${m}`, new RegExp(`(?<![A-Za-z0-9_])${escape(m)}(?![A-Za-z0-9_])`)]);
  // An example id mapped straight to its model (the exampleModels prop, EXAMPLE_MODELS minified).
  for (const e of exampleModels) out.push([`example ${e.id} model map`, new RegExp(`(?<![\\w$])${Q}?${escape(e.id)}${Q}?\\s*:\\s*${Q}${escape(e.model)}${Q}`)]);
  // An example's id and the model it was written for, in one object (in either order).
  for (const e of exampleModels) {
    const id = `${Q}?id${Q}?\\s*:\\s*${Q}${escape(e.id)}${Q}`;
    const model = `${Q}?modelId${Q}?\\s*:\\s*${Q}${escape(e.model)}${Q}`;
    out.push([`example ${e.id} model`, new RegExp(`${id}[^{}]{0,600}?${model}|${model}[^{}]{0,600}?${id}`)]);
  }
  // The marketing board's banned provider names as a list: BANNED_LIST_MIN of them side by side as array elements, in any order
  // and any case. One or two in some copy (or a picker's makers) are not the list.
  if (bannedNames.length >= BANNED_LIST_MIN) {
    const n = `${Q}(?:${bannedNames.map(escape).join("|")})${Q}`;
    out.push(["marketing banned provider name list", new RegExp(`${n}(?:\\s*,\\s*${n}){${BANNED_LIST_MIN - 1}}`, "i")]);
    // The same list inside ONE string or regex literal, the names separated by | or , (a precompiled matcher, a split string).
    const b = `(?:${bannedNames.map(escape).join("|")})`;
    out.push(["marketing banned provider name list", new RegExp(`(?<![\\w-])${b}(?:\\s*[|,]\\s*${b}){${BANNED_LIST_MIN - 1}}(?![\\w-])`, "i")]);
  }
  // Three of the Create form's video ids as adjacent array elements, in any order: the option list without its names.
  if (createOptions.length >= 3) {
    const vid = `${Q}(?:${createOptions.map((o) => escape(o.id)).join("|")})${Q}`;
    out.push(["Create form video id list", new RegExp(`${vid}\\s*,\\s*${vid}\\s*,\\s*${vid}`)]);
  }
  return out;
}

/** Text as the browser reads it: `\"` undone until nothing changes (each serializer layer adds one), HTML quote entities decoded. */
export function normalize(raw) {
  let text = raw.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&#x27;/gi, "'");
  for (let i = 0; i < 8; i++) {
    const next = text.replace(/\\+"/g, '"');
    if (next === text) break;
    text = next;
  }
  return text;
}

// A string literal in any quotes (a template literal without substitutions included), and an identifier that is not a member.
const STR = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`(?:[^`\\\\$]|\\\\.|\\$(?!\\{))*`";
const IDENT = String.raw`(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$])(?!\s*[.(\[])`;
const PIECE = `(?:${STR}|${IDENT})`;
const PIECE_RE = new RegExp(PIECE, "g");

/**
 * Identifiers declared exactly once in the text, by an assignment of a string literal (`v0="runway-gen4.5"` in
 * `var v0=…,v1=…`): what a minifier writes when it interns a repeated string. Every other way a name is declared counts too
 * (a function or arrow parameter, catch(x), for(let x of …), a destructuring target, a `var x;` with no value), so a name
 * declared twice is unknown: a minifier reuses `n`, `r` across scopes, and a parameter that shadows a module-level `n` must
 * not be read as its literal (let n="…";x.map(function(n,r){return[n,r]})). Which value a use holds is a scope question this
 * script does not answer.
 */
export function stringBindings(text) {
  const count = new Map();
  const bump = (name) => count.set(name, (count.get(name) ?? 0) + 1);
  const namesIn = (list) => {
    for (const m of list.replace(new RegExp(STR, "g"), "").matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) bump(m[0]);
  };
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) bump(m[1]);
  // Parameter lists (a function, an arrow, catch; an if(...){ is counted too, which only makes a name unknown sooner).
  for (const m of text.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) namesIn(m[1]);
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) bump(m[1]);
  // Destructuring targets, declared or assigned: [e,t]=…, {a:b,c}=….
  for (const m of text.matchAll(/([[{][^[\]{}]*[\]}])\s*=(?![=>])/g)) namesIn(m[1]);
  // Declarations with no value at all (var a,b;) and a for-of / for-in variable.
  for (const m of text.matchAll(/\b(?:var|let|const)\s+((?:[A-Za-z_$][\w$]*\s*,\s*)*[A-Za-z_$][\w$]*)(?=\s*(?:[;)\n]|$)|\s+(?:of|in)\b)/g)) namesIn(m[1]);
  const out = new Map();
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*(${STR})(?=\\s*(?:[,;)}\\]]|$))`, "gm"))) {
    if (count.get(m[1]) === 1) out.set(m[1], m[2].slice(1, -1));
  }
  return out;
}

/** A piece's string value: a literal's text, a once-bound identifier's literal, else null (unknown at build time). */
function pieceValue(piece, bindings) {
  if (/^["'`]/.test(piece)) return piece.slice(1, -1);
  return bindings.has(piece) ? bindings.get(piece) : null;
}

/** `value` as a literal the patterns read: in a quote it does not contain, or null when it holds all three. */
function quoted(value) {
  const q = ['"', "'", "`"].find((c) => !value.includes(c));
  return q === undefined ? null : `${q}${value}${q}`;
}

/**
 * The text with the string expressions a build can evaluate written back as the one literal they make, so every pattern sees
 * a split id, pair or prompt as if it had been written whole. Repeated until nothing changes (a join inside an array):
 *
 *   - a template literal whose every ${…} is a literal or a once-bound identifier: `runway-${"gen4.5"}` -> "runway-gen4.5";
 *   - an array of such pieces joined: ["runway-","gen4.5"].join("") -> "runway-gen4.5";
 *   - a `+` chain, each run of such pieces in it: "runway-"+"gen4.5"+x -> "runway-gen4.5"+x;
 *   - in an array literal (not a destructuring target), each once-bound identifier: [v0,v1] -> ["runway-gen4.5","minimax-h3"];
 *   - a .concat() chain, which is how SWC writes a template literal for this build's browsers:
 *     "".concat("runway","-gen4.5") -> "runway-gen4.5", "CHRONOS_".concat("PRICE","_").concat(n.toUpperCase()) ->
 *     "CHRONOS_PRICE_".concat(n.toUpperCase()): the literal prefix up to the first argument that is not a piece;
 *   - a join with run-time elements, its literal prefix: ["CHRONOS","PRICE",e].join("_") -> "CHRONOS_PRICE_"+[e].join("_");
 *   - a grouping paren around one literal: [("runway-"+"gen4.5"),"minimax-h3"] -> ["runway-gen4.5","minimax-h3"].
 *
 * Anything that needs a value only known at run time (a parameter, a fetch, a computed index) is left as it is.
 */
/** Top-level comma-separated parts of an argument or element list (strings and nested brackets kept whole). */
function splitTop(list) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (quote) {
      cur += c;
      if (c === "\\") cur += list[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts;
}

/** The value of a part that is exactly one piece (a literal or a once-bound identifier), else null. */
function partValue(part, bindings) {
  return new RegExp(`^(?:${STR})$`).test(part) || /^[A-Za-z_$][\w$]*$/.test(part) ? pieceValue(part, bindings) : null;
}

// Nested brackets, two levels deep: enough for n.toUpperCase() or f(a(b)) as one argument.
const NEST = String.raw`(?:[^()]|\((?:[^()]|\([^()]*\))*\))*`;
export function reassemble(text, bindings = stringBindings(text)) {
  const templateWithSubs = /`(?:[^`\\$]|\\.|\$(?!\{))*(?:\$\{[^{}`]*\}(?:[^`\\$]|\\.|\$(?!\{))*)+`/g;
  const joinRe = new RegExp(`\\[((?:[^[\\]()]|\\(${NEST}\\))*)\\]\\.join\\(\\s*(${STR})?\\s*\\)`, "g");
  const concatRe = new RegExp(`(${PIECE})((?:\\.concat\\(${NEST}\\))+)`, "g");
  const groupRe = new RegExp(`(?<![\\w$)\\]])\\(\\s*(${STR})\\s*\\)`, "g");
  const chainRe = new RegExp(`${PIECE}(?:\\s*\\+\\s*${PIECE})+`, "g");
  // One element too: a one-model effect's `models:[v0]`.
  const arrayRe = new RegExp(`\\[\\s*${PIECE}(?:\\s*,\\s*${PIECE})*\\s*\\](?!\\s*=(?!=))`, "g");
  const pieces = (s) => [...s.matchAll(PIECE_RE)].map((m) => m[0]);
  let out = text;
  for (let pass = 0; pass < 4; pass++) {
    const before = out;
    out = out.replace(templateWithSubs, (whole) => {
      let ok = true;
      const value = whole.slice(1, -1).replace(/\$\{([^{}`]*)\}/g, (_, expr) => {
        const e = expr.trim();
        const v = new RegExp(`^(?:${STR})$`).test(e) || /^[A-Za-z_$][\w$]*$/.test(e) ? pieceValue(e, bindings) : /^-?\d+(?:\.\d+)?$/.test(e) ? e : null;
        if (v === null) ok = false;
        return v ?? "";
      });
      return ok ? (quoted(value) ?? whole) : whole;
    });
    out = out.replace(joinRe, (whole, list, sep) => {
      const parts = splitTop(list);
      const glue = sep === undefined ? "," : sep.slice(1, -1);
      const values = parts.map((p) => partValue(p, bindings));
      const lead = values.findIndex((v) => v === null);
      if (lead === -1) return quoted(values.join(glue)) ?? whole;
      if (lead === 0) return whole;
      // Literals, then a run-time element: the prefix is known (["CHRONOS","PRICE",e].join("_") -> "CHRONOS_PRICE_"+…).
      const prefix = quoted(values.slice(0, lead).join(glue) + glue);
      return prefix === null ? whole : `${prefix}+[${parts.slice(lead).join(",")}].join(${sep ?? ""})`;
    });
    out = out.replace(concatRe, (whole, head, tail) => {
      const first = pieceValue(head, bindings);
      if (first === null) return whole;
      const args = [];
      for (const m of tail.matchAll(new RegExp(`\\.concat\\((${NEST})\\)`, "g"))) args.push(...splitTop(m[1]));
      let value = first;
      let i = 0;
      for (; i < args.length; i++) {
        const v = partValue(args[i], bindings);
        if (v === null) break;
        value += v;
      }
      if (i === 0) return whole;
      const lit = quoted(value);
      if (lit === null) return whole;
      return i === args.length ? lit : `${lit}.concat(${args.slice(i).join(",")})`;
    });
    out = out.replace(groupRe, "$1");
    out = out.replace(chainRe, (whole) => {
      const parts = pieces(whole);
      const runs = [];
      for (const p of parts) {
        const v = pieceValue(p, bindings);
        const last = runs.at(-1);
        if (v !== null && last && last.values) last.values.push(v);
        else runs.push(v !== null ? { values: [v] } : { raw: p });
      }
      if (!runs.some((r) => r.values && r.values.length > 1)) return whole;
      return runs.map((r) => (r.values ? (quoted(r.values.join("")) ?? r.values.map((v) => JSON.stringify(v)).join("+")) : r.raw)).join("+");
    });
    out = out.replace(arrayRe, (whole) => {
      let changed = false;
      const next = whole.replace(PIECE_RE, (p) => {
        if (/^["'`]/.test(p) || !bindings.has(p)) return p;
        changed = true;
        return quoted(bindings.get(p)) ?? p;
      });
      return changed ? next : whole;
    });
    if (out === before) break;
  }
  return out;
}

function scanOnce(text, { single, pairs, options = [] }) {
  const hits = single.filter(([, re]) => re.test(text)).map(([label]) => label);
  const optionHits = options.filter((o) => o.re.test(text));
  if (optionHits.length >= OPTION_PAIRS_MIN) hits.push(`Create form operator video options (${optionHits.map((o) => o.label).join(", ")})`);
  const mapHits = pairs.filter((p) => p.re.test(text));
  if (mapHits.length >= MAP_PAIRS_MIN || mapHits.some((p) => p.alone)) {
    hits.push(`provider display map (${mapHits.map((p) => p.label).join(", ")})`);
  }
  return hits;
}

/**
 * The labels of everything in `raw` the browser must not see, read through normalize(): a payload inlined as
 * JSON.parse("{\"models\":[\"a\"]}"), an RSC row inside a flight script, or an HTML attribute carries the same data. Then
 * read again through reassemble(): what only a split, interned or concatenated form carries is labelled "(reassembled)".
 */
export function findLeaks(raw, list) {
  const text = normalize(raw);
  const hits = scanOnce(text, list);
  const whole = reassemble(text);
  if (whole !== text) {
    const seen = new Set(hits);
    for (const h of scanOnce(whole, list)) if (!seen.has(h)) hits.push(`${h} (reassembled)`);
  }
  return hits;
}

function filesUnder(dir, keep) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, keep));
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

/** A file is text when it has no NUL byte in its first 8 KB (a .body may be an icon). */
function isText(file) {
  const buf = readFileSync(file);
  return !buf.subarray(0, 8192).includes(0);
}

/** Every file next build wrote for a browser under server/: not the server's own code, which legitimately holds the data. */
const SERVER_CODE = /\.(?:js|mjs|cjs|map)$|\.nft\.json$/;

/** Positive control 1, signed-in half: each pattern catches the minified form its source module shipped as. */
function selfTestSignedIn(source, scan, has) {
  const must = (text, label, what) => {
    if (!has(scan(text), label)) fail2(`self-test: ${what} is not caught.`);
  };
  must('{id:"x",secretName:"X_API_KEY"}', "secretName: key", "a `secretName:` key");
  must('{id:"x",defaultModel:"m"}', "defaultModel: key", "a `defaultModel:` key");
  for (const n of source.secretNames) {
    must(`t="${n}"`, `secret name ${n}`, `the secret name ${n}`);
    must(`"Set ${n} in the worker"`, `secret name ${n}`, `the secret name ${n} inside copy`);
  }
  for (const u of source.keyPages) must(`(0,r.jsx)("a",{href:"${u}",target:"_blank"})`, `vendor key page ${u}`, `the key page ${u}`);
  for (const m of source.defaultModels) {
    if (!source.studioIds.includes(m)) must(`{m:"${m}"}`, `image generator default model ${m}`, `the default model ${m}`);
  }
  for (const k of source.agentKeys) must(`{${k}:"x"}`, `agent provider ${k}: key`, `the agent registry's ${k}`);
  for (const v of source.agentStates) must(`s="${v}"`, `agent provider state ${v}`, `the agent registry state ${v}`);
  must(`{${source.ttsModels[0]}:["uz","ru","en"]}`, "narration model language table", "the narration model language table");
  must(`{"${source.ttsModels.at(-1)}":["ru","en"]}`, "narration model language table", "the narration model language table, quoted");
  for (const e of source.exampleModels) must(`{id:"${e.id}",mode:"video",modelId:"${e.model}",aspect:"16:9"}`, `example ${e.id} model`, `example ${e.id}'s model`);
  const compiled = source.createOptions.map((o) => `(0,r.jsx)("option",{value:"${o.id}",children:"${o.name}"})`).join(",");
  const listed = JSON.stringify(source.createOptions);
  // An option with another prop between its value and its label is the same option.
  const spaced = source.createOptions.map((o) => `(0,r.jsx)("option",{value:"${o.id}",className:"o",children:"${o.name}"})`).join(",");
  for (const text of [compiled, listed, spaced]) must(text, "Create form operator video options", "the Create form's video option list");
  must(JSON.stringify(source.imageOptions), "Create form operator video options", "the image generator option list");
  must(`z.enum(${JSON.stringify(source.createOptions.slice(0, 3).map((o) => o.id))})`, "Create form video id list", "three video ids side by side");
  for (const m of source.ttsModels) must(`L={${m}:"x"}`, `narration vendor model ${m}`, `the narration model id ${m} as a key`);
  for (const e of source.exampleModels) must(JSON.stringify({ [e.id]: e.model }), `example ${e.id} model map`, `example ${e.id} -> model as a map`);
  for (const p of source.configPrefixes) {
    must(`x:"Set ${p}<UNIT> for each unit"`, `configuration name ${p}`, `the configuration prefix ${p} inside copy`);
    must(`n=${JSON.stringify(p)}+k.toUpperCase()`, `configuration name ${p}`, `the configuration prefix ${p} building a name`);
  }
  for (const v of source.routingVariables) must(`{[${JSON.stringify(v)}]:"1"}`, `routing variable ${v}`, `the routing variable ${v}`);
  for (const n of source.configNames) {
    must(`x:"Set ${n} on the server."`, `configuration name ${n}`, `the configuration name ${n} inside copy`);
    must(`e.env[${JSON.stringify(n)}]`, `configuration name ${n}`, `the configuration name ${n} as a key`);
  }
  // Negative control: an ordinary ALL_CAPS constant, and a longer public name that ends in one of ours, are not our configuration.
  for (const text of ['r="HTTP_STATUS"', 'x:"NEXT_PUBLIC_PADDLE_API_KEY_HINT"', "PAYMENTS_PROVIDERS_LIST"]) {
    if (scan(text).some((h) => h.startsWith("configuration name "))) fail2(`self-test: ${text} is flagged as a configuration name.`);
  }
}

function main() {
  const source = readSource();
  const list = patterns(source);
  const scan = (text) => findLeaks(text, list);
  const has = (hits, prefix) => hits.some((h) => h.startsWith(prefix));

  // Positive control 1: the patterns catch the forms the product writes, minified, escaped, in an HTML attribute and with
  // the prompt filled. If a regex is broken, this fails before a clean scan can be mistaken for a clean build.
  const e0 = source.effects.find((e) => e.models.length > 1) ?? source.effects[0];
  const filled = source.effects.find((e) => /\{[^}]*\}/.test(e.prompt));
  const p = source.providers;
  const u = source.units;
  const shipped = [
    `{id:"${e0.id}",models:${JSON.stringify(e0.models)},prompt:${JSON.stringify(e0.prompt)}}`,
    `F={${p.map((x) => `${x.slug}:"${x.name}"`).join(",")}}`,
    `o=${JSON.stringify(u)}`,
  ].join(";");
  const twice = JSON.stringify(JSON.stringify(JSON.stringify({ models: e0.models, units: u, map: Object.fromEntries(p.map((x) => [x.slug, x.name])) })));
  const attribute = `<div data-x="${JSON.stringify({ models: e0.models, map: Object.fromEntries(p.map((x) => [x.slug, x.name])), u }).replace(/"/g, "&quot;")}">`;
  for (const text of [shipped, `JSON.parse(${twice})`, attribute]) {
    const caught = scan(text);
    for (const must of [`effect ${e0.id} model order`, "ledger unit list", "provider display map"]) {
      if (!has(caught, must)) fail2(`self-test: the pattern "${must}" does not match the text it exists to catch.`);
    }
  }
  if (!has(scan(shipped), `effect ${e0.id} prompt`)) fail2("self-test: the prompt pattern does not match the prompt.");
  if (filled && !has(scan(JSON.stringify(filled.prompt.replace(/\{[^}]*\}/g, "a red fox"))), `effect ${filled.id} prompt`)) {
    fail2("self-test: the prompt pattern does not match a filled prompt.");
  }
  for (const e of source.effects) {
    if (!has(scan(`m=${JSON.stringify(e.models.slice(0, 2))}`), `effect ${e.id} model order`)) fail2(`self-test: the pattern for ${e.id}'s models does not match them.`);
  }
  for (const v of source.vendorUnits) {
    if (!has(scan(`{${v}:"x"}`), `vendor-named ledger unit ${v}`)) fail2(`self-test: ${v} as a key is not caught.`);
  }
  // The forms Breach found on #956 that only reassemble() and the entry / object pair forms read. Built from the real data.
  const [m0, m1] = e0.models;
  const cut = (id) => [id.slice(0, Math.ceil(id.length / 2)), id.slice(Math.ceil(id.length / 2))];
  const prompt = e0.prompt.split(/\{[^}]*\}/).sort((a, b) => b.length - a.length)[0];
  const forms = [
    [`var v0=${JSON.stringify(m0)},v1=${JSON.stringify(m1)};x=[v0,v1]`, `effect ${e0.id} model order`, "interned model ids"],
    [`x=[${cut(m0).map((p) => JSON.stringify(p)).join("+")},${JSON.stringify(cut(m1))}.join("")]`, `effect ${e0.id} model order`, "model ids cut into + and join pieces"],
    [`x=[\`${cut(m0)[0]}\${${JSON.stringify(cut(m0)[1])}}\`,"${m1}"]`, `effect ${e0.id} model order`, "a model id as a template over literals"],
    [`o=${JSON.stringify(e0.models.join(","))}.split(",")`, `effect ${e0.id} model order`, "the model order as one split string"],
    [`p=${[...prompt.matchAll(/[\s\S]{1,12}/g)].map((m) => JSON.stringify(m[0])).join("+")}`, `effect ${e0.id} prompt`, "a prompt cut into 12-character + pieces"],
    [`M=new Map(${JSON.stringify(p.map((x) => [x.slug, x.name]))})`, "provider display map", "the provider map as [slug, name] entries"],
    [`L=${JSON.stringify(p.map((x) => ({ slug: x.slug, name: x.name })))}`, "provider display map", "the provider map as { slug, name } objects"],
    [`L=${JSON.stringify(p.map((x) => ({ name: x.name, id: x.slug })))}`, "provider display map", "the provider map as { name, id } objects"],
    [`B=${JSON.stringify(source.bannedNames)}`, "marketing banned provider name list", "the marketing board's banned provider names"],
    [`R=/\\b(?:${source.bannedNames.join("|")})\\b/i`, "marketing banned provider name list", "the banned names as one regex"],
    // What next's SWC emits for a template literal at this build's target (tests/security-vendor-bundle-check-breach.test.ts
    // compiles real sources to the same shape): .concat() chains.
    [`export var ORDER=["".concat(${cut(m0).map((x) => JSON.stringify(x)).join(",")}),${JSON.stringify(m1)}];`, `effect ${e0.id} model order`, "a model id from a compiled template"],
    ['export var f=function(n){return"CHRONOS_".concat("PRICE","_").concat(n.toUpperCase())};', "configuration name CHRONOS_PRICE_", "the cost prefix from a compiled template"],
    ['f=function(e){return["CHRONOS","PRICE",e.toUpperCase()].join("_")}', "configuration name CHRONOS_PRICE_", "the cost prefix joined with a run-time piece"],
    [`t=${JSON.stringify(`Tries ${e0.models.join(" → ")}`)}`, `effect ${e0.id} model order`, "the model order in arrow copy"],
    [`R=${JSON.stringify(Object.fromEntries(p.map((x) => [x.name, x.slug])))}`, "provider display map", "the provider map reversed"],
    [`function n(e){switch(e){${p.map((x) => `case${JSON.stringify(x.slug)}:return ${JSON.stringify(x.name)};`).join("")}}}`, "provider display map", "the provider map as a switch"],
  ];
  for (const [text, label, what] of forms) if (!has(scan(text), label)) fail2(`self-test: ${what} is not caught.`);
  // And the false positive SW3-6 found: a Studio picker's own default (a Studio model id) is not an image generator's.
  if (has(scan(`P={defaultModel:${JSON.stringify(source.studioIds[0])}}`), "defaultModel: key")) fail2("self-test: a Studio model id under defaultModel: is flagged.");
  selfTestSignedIn(source, scan, has);

  if (!existsSync(STATIC)) fail2(".next/static not found — run `next build` first.");
  const files = filesUnder(STATIC, (n) => n.endsWith(".js"));
  const appDir = path.join(PRERENDERED, "app");
  const appFiles = filesUnder(appDir, (n) => !SERVER_CODE.test(n)).filter(isText);
  const errorPages = filesUnder(path.join(PRERENDERED, "pages"), (n) => n.endsWith(".html"));
  // What a "prerendered app page" is: an .html or .rsc next build wrote for an app route. Usually none (every app page is
  // dynamic today); then the summary says so, and nothing is claimed about the pages' payloads.
  const appPages = appFiles.filter((f) => /\.(?:html|rsc)$/.test(f));
  // Positive control 2: a real, whole build, with the public page the map and the unit list reached.
  const publicPage = files.filter((f) => /[\\/]app[\\/]pricing[\\/]page-[^\\/]+\.js$/.test(f));
  if (files.length < 50 || publicPage.length === 0) {
    fail2(`found ${files.length} .js files (${publicPage.length} /pricing page chunks) under static/ — not a whole build.`);
  }
  // Positive control 3: the screens that used to carry the data are still in the build — the Studio's Effects desk, the
  // canvas's effect list, the operator's price editor. If one stopped rendering, a pass would only say the screen is gone.
  const texts = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  for (const [marker, screen] of [
    ['"fx-grid"', "the Studio's Effects desk"],
    ['"cv-effects"', "the Studio canvas's effect list"],
    ['"credit-prices"', "the operator's price editor"],
    // The signed-in screens that carried the vendor lists: they must still be built, now fed by props.
    ['"g2-key-field"', "the operator's Providers board"],
    // Property reads only these two components make (the dictionary chunk holds the keys as `routingAutopilot:`, not `.x`).
    [".routingAutopilot", "the Providers page's routing panel"],
    [".voiceModelDropped", "the Create form"],
    ["Direct model provider review", "the Agent Builder"],
  ]) {
    if (![...texts.values()].some((t) => t.includes(marker))) fail2(`no chunk contains ${marker} (${screen}) — that screen is not in the build, so a pass would mean nothing.`);
  }

  const leaks = [];
  for (const file of [...files, ...appFiles, ...errorPages]) {
    const hits = scan(texts.get(file) ?? readFileSync(file, "utf8"));
    if (hits.length > 0) leaks.push(`${path.relative(ROOT, file)}: ${hits.join("; ")}`);
  }
  const scanned = `${files.length} static chunks, ${appFiles.length} files under server/app (${appPages.length} app pages prerendered) and ${errorPages.length} error pages`;
  if (leaks.length > 0) {
    console.error(`vendor-bundle-check: ${leaks.length} files of ${scanned} carry vendor routing, the vendor map or vendor metering units:`);
    for (const line of leaks) console.error(`  ${line}`);
    console.error(
      `Resolve on the server and pass the result as props: lib/effects/catalog.ts, lib/server/provider-names.ts, lib/server/ledger-units.ts, lib/server/ledger-unit-labels.ts and ${SIGNED_IN_SOURCES.filter((f) => !f.endsWith("model-names.ts")).join(", ")} are server-only.`,
    );
    process.exit(1);
  }
  console.log(
    `vendor-bundle-check: ${scanned}; ${list.single.length} patterns + the provider map + the Create video options (${source.effects.length} effects, ${source.providers.length} providers, ${source.units.length} ledger units, ${source.vendorUnits.length} vendor-named; ${source.secretNames.length} secret names, ${source.keyPages.length} key pages, ${source.agentStates.length} agent registry states, ${source.ttsModels.length} narration models, ${source.exampleModels.length} example models, ${source.bannedNames.length} banned provider names, ${source.configPrefixes.length} configuration prefixes, ${source.configNames.length} configuration names): clean.`,
  );
}

// Run only as a script: a test (or another script) importing promptWindows / normalize / findLeaks must not run a scan.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
