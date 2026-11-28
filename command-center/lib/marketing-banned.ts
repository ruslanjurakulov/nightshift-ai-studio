import "server-only";
import { compileBanned, bannedHitsIn, type BannedList } from "@/lib/marketing-banned-match";

/**
 * The banned wording of a public post, checked on the New post form (docs/news/banned-claims.json).
 *
 * The database cannot read that file, so a post the owner types is not checked there (migration 0110). The page checks the three
 * texts against the same list and SHOWS the hits; the owner decides, nothing is blocked. The worker blocks a promo post for the same
 * list (modules/marketing_content.banned_hits).
 *
 * The Next app is built from this folder alone and cannot import the JSON, so the list is copied here. tests/marketing-banned.test.ts
 * reads the JSON and FAILS if this copy differs by one pattern, rule or provider name, and runs the cases of
 * tests/fixtures/marketing_banned_cases.json, which tests/test_marketing_banned_fixture.py runs through the real Python checker: the
 * two regular-expression dialects cannot drift apart unseen.
 *
 * Server-only: BANNED_PROVIDER_NAMES is a list of the vendors we use or considered, which is exactly what the site must not show,
 * and a client import put it in the marketing page's static chunk (downloadable by anyone, operator page or not). The page hands
 * the lists to the form as a prop (BANNED_LIST); the matching itself is lib/marketing-banned-match.ts. scripts/vendor-bundle-check.mjs
 * reads the names from here and fails the build if the list is in any chunk.
 */
/** Rule id -> the patterns (Python `re` syntax, matched case-insensitively on the normalised text). `why` is worded in lib/i18n/marketing. */
export const BANNED_RULES: readonly { id: string; patterns: readonly string[] }[] = [
  {
    id: "free",
    patterns: ["\\bfree\\b", "\\bfreebie", "бесплатн\\w*", "\\bдаром\\b", "\\bbepul\\w*", "\\btekin\\b"],
  },
  {
    id: "unlimited",
    patterns: ["\\bunlimited\\b", "\\bno limits?\\b", "безлимит\\w*", "неограничен\\w*", "без\\s+огранич\\w*", "\\bcheksiz\\w*", "\\bchegarasiz\\w*"],
  },
  {
    id: "guarantee",
    patterns: ["\\bguarant\\w*", "гарант\\w*", "\\bkafolat\\w*"],
  },
  {
    id: "superlative",
    patterns: [
      "\\bbest\\b",
      "\\bnumber one\\b",
      "\\bno\\.? ?1\\b",
      "#1",
      "\\bleading\\b",
      "\\btop-?rated\\b",
      "\\bfastest\\b",
      "\\bcheapest\\b",
      "\\bunbeatable\\b",
      "лучш\\w*",
      "номер\\s+один",
      "№\\s*1",
      "быстрейш\\w*",
      "дешевейш\\w*",
      "\\beng\\s+(yaxshi|zo'r|tez|arzon|kuchli)\\w*",
      "\\b1-raqam\\w*",
    ],
  },
  {
    id: "income",
    patterns: [
      "\\bearn\\w*",
      "\\bincome\\b",
      "\\bget rich\\b",
      "\\bmake money\\b",
      "\\bprofit\\w*",
      "доход\\w*",
      "заработ\\w*",
      "прибыл\\w*",
      "разбогат\\w*",
      "\\bdaromad\\w*",
      "\\bpul\\s+(ishla|top)\\w*",
      "\\bboyib\\w*",
      "\\bboy\\s+bo'l\\w*",
    ],
  },
  {
    id: "views",
    patterns: [
      "\\bviral\\b",
      "\\bmore views\\b",
      "\\bget views\\b",
      "\\bmillions? of views\\b",
      "\\bboost (your )?(views|reach|subscribers|followers)\\b",
      "\\bgrow your (audience|channel)\\b",
      "вирусн\\w*",
      "больше\\s+просмотр\\w*",
      "накрут\\w*",
      "миллион\\w*\\s+просмотр\\w*",
      "\\bko'proq\\s+ko'rish\\w*",
      "\\bmillion\\w*\\s+ko'rish\\w*",
    ],
  },
  {
    id: "certainty",
    patterns: ["\\bforever\\b", "\\blifetime\\b", "\\b100\\s?%", "\\brisk-free\\b", "\\bno risk\\b", "навсегда", "пожизненн\\w*", "без\\s+риска", "\\babadiy\\w*", "\\bumrbod\\w*", "\\briskiz\\b"],
  },
  {
    id: "endorsement",
    patterns: [
      "\\b(official|certified|approved|endorsed)\\b[^.]{0,40}\\b(youtube|google|telegram|instagram|tiktok)\\b",
      "\\b(youtube|google|telegram|instagram|tiktok)\\b[^.]{0,40}\\b(partner|approved|endorsed|certified)\\b",
      "официальн\\w*[^.]{0,40}(youtube|ютуб|google|гугл)",
      "партнер\\w*\\s+(youtube|ютуб|google|гугл)",
      "\\brasmiy\\w*[^.]{0,40}(youtube|google)",
    ],
  },
];

/** A model or provider may be named only after a real call through its adapter has succeeded (CLAUDE.md, Definition of Done). */
export const BANNED_PROVIDER_NAMES: readonly string[] = [
  "openai", "chatgpt", "gpt", "sora", "veo", "kling", "runway", "luma", "pika", "elevenlabs", "eleven labs", "midjourney", "flux",
  "seedance", "seedream", "hailuo", "minimax", "gemini", "imagen", "claude", "anthropic", "wan", "higgsfield", "krea",
  "stable diffusion", "stability ai", "dall-e", "dalle", "whisper", "suno", "udio", "heygen", "synthesia", "pexels", "pixabay",
  // Meta Model API ToS 7: no Meta name or mark may be used in connection with the service (registry entry grounded-image-1.0).
  "meta", "muse image",
];

/** Both lists, for the marketing page to hand the New post form as a prop (the operator's own RSC payload, no static chunk). */
export const BANNED_LIST: BannedList = { rules: BANNED_RULES, providerNames: BANNED_PROVIDER_NAMES };

const COMPILED = compileBanned(BANNED_LIST);

/**
 * The rules (and provider names) the texts trip, each with where, against the full list. Server code and tests; the form uses
 * bannedHitsIn() over the prop.
 */
export function bannedHits(texts: Parameters<typeof bannedHitsIn>[0]) {
  return bannedHitsIn(texts, COMPILED);
}

export { normaliseForBanned, type BannedHit } from "@/lib/marketing-banned-match";
