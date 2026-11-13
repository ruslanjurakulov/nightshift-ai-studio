/**
 * The owner's ledger on each provider row of the Billing page (lib/billing.ts providerLedger): what was bought, what was used
 * (pipeline, Studio, probes) and what is left. English is the source of truth; ru.ts and uz.ts are typed against it. `{name}`
 * fillers are filled with fmt().
 *
 * Words to keep: "reported" is what the provider's own API said; "estimate" is our arithmetic (bought minus used, or a list
 * price times a quantity); "unknown" is neither, and never a 0. Counts are written as "label: number", so no language needs a
 * plural form.
 */
export const billingLedgerEn = {
  bought: "Bought",
  boughtNone: "no top-up recorded",
  boughtCount: "top-ups: {n}, first {date}",
  credits: "{n} credits",
  usedSince: "Used since {date} (UTC)",
  usedLast30: "Used, last 30 days",
  left: "Left",
  leftReported: "reported by the provider {when}",
  leftEstimate: "estimate: bought minus used",
  leftUnknown: {
    unread: "unknown: the billing data could not be read",
    no_topup: "unknown: no top-up recorded and no balance from the provider",
    used_unknown: "unknown: part of what was used has no price",
    negative: "unknown: more was used than the top-ups recorded",
  },
  sources: { pipeline: "Pipeline", studio: "Studio", probes: "Probes" },
  state: {
    unread: "could not read",
    untracked: "not recorded",
    notUsed: "not used",
    none: "none",
    partial: "history read only in part",
  },
  atLeast: "at least {usd}",
  estimate: "estimate",
  usdUnknown: "{qty} {unit}, USD unknown",
  rowsUsdUnknown: "{unit}: {n} rows, USD unknown",
  billingUnknown: "failed probes that may have been billed: {n}",
  units: {
    second: "s",
    image: "images",
    character: "characters",
    request: "requests",
    credits: "credits",
    tokens: "tokens",
    probe: "probes",
    tts_characters: "characters",
    gemini_input_tokens: "tokens",
    gemini_output_tokens: "tokens",
    video_gen_clips: "clips",
    image_generations: "images",
  } as Record<string, string>,
  pipelineLastDay: "Pipeline, last {n} day",
  pipelineLastDays: "Pipeline, last {n} days",
  pipeline30: "Pipeline, 30 days",
  headlinePipelineOnly: "pipeline only: Studio and probes are in each provider's row",
  noBillingLink: "no billing page verified",
};

export type BillingLedgerDictionary = typeof billingLedgerEn;
