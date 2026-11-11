/**
 * The owner's "Prices & budget" view (/{channel}/models?view=budget, lib/owner/budget.ts): every registry model with what
 * its vendor charges us, and a calculator from dollars to videos, images or minutes. English is the source of truth;
 * ru.ts and uz.ts are typed against it. `{name}` fillers are filled with fmt().
 *
 * Words to keep: the figure is the VENDOR's list price as the registry states it, rounded DOWN, and "estimate" wherever the
 * registry marks it unconfirmed. A model without a price says so and shows no number. Counts are written as "label: number"
 * so no language needs a plural form.
 */
export const modelBudgetEn = {
  viewBudget: "Prices & budget",
  title: "Model prices and budget",
  subtitle:
    "Every model in the registry with what its vendor charges us, and a calculator: type an amount in dollars and see roughly what it buys. Only you, the platform owner, see this page. Nothing on it spends or changes anything.",
  notEnabled: "The model registry is not in the database yet (migration 0035), so there is nothing to show.",
  failed: "The registry could not be read, so nothing is shown rather than a guess. Try again.",
  empty: "No models in the registry yet. Sync them from schemas/model_registry.json with tools/probe_models.py --sync.",
  pricesUnread: "The price list could not be read: customer prices are unknown here, not missing.",
  rules: {
    title: "How the calculator counts",
    items: [
      "The price is the vendor's list price from the registry file, per unit (one image, one second, one character). It is what we pay, not what a customer pays.",
      "“Estimate” means the registry has not confirmed the price against a bill.",
      "A video is counted at the shortest length the model makes and at its default resolution (or the registry's base price); pick another option or length to recount.",
      "Where the registry states a billing floor (a minimum number of seconds per job), each job is counted at least that long.",
      "Every figure is rounded down. Input pictures, tokens, sound options and failed jobs can change the real bill: the vendor's invoice is the truth.",
    ],
  },
  kinds: { video: "Video", image: "Images", audio: "Audio and music", other: "Other (text and transcription)" },
  count: "Models: {n}",
  status: {
    hidden: "Hidden",
    beta: "Beta",
    ga: "On sale (GA)",
    disabled: "Disabled",
    unknown: "Status unknown",
    terms: "Gated by vendor terms",
    pastShutdown: "Past vendor shutdown ({date})",
    shutdown: "Vendor shutdown {date}",
  },
  vendorCost: "Our cost",
  estimate: "estimate",
  asOf: "read {date}",
  noPrice: "no price in the registry",
  perUnit: { image: "per image", second: "per second", character: "per character", request: "per request" },
  customer: "Customer price",
  customerNone: "none set",
  customerUnread: "unknown",
  credits: "{n} credits {unit}",
  option: "Option",
  optionBase: "Base price",
  optionBaseSame: "Base price (same as {keys})",
  variantWords: { silent: "silent", audio: "with sound", low: "low", medium: "medium", high: "high" },
  length: "Length",
  seconds: "{n} s",
  budget: "Budget ($)",
  budgetPlaceholder: "e.g. 10",
  startsOn: {
    default_resolution: "Counted at the default resolution.",
    base: "Counted at the registry's base price.",
    cheapest_variant: "Counted at the cheapest priced option.",
  },
  shortest: "Counted at the shortest length the model makes.",
  result: {
    videos: "Videos of {d} s: ≈ {n} (≈ {m} min in all)",
    billed: "each billed as {b} s",
    minutes: "≈ {m} min",
    clips: "Clips of {d} s: ≈ {n}",
    floor: "the vendor bills at least {f} s per job",
    images: "Images: ≈ {n}",
    characters: "Characters of speech: ≈ {n}",
    requests: "Requests: ≈ {n}",
  },
  unpriced: "No price in the registry for: {keys}",
};

export type ModelBudgetDictionary = typeof modelBudgetEn;
