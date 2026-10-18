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
 */
import { LANGS, type Lang } from "@/lib/marketing-posts";

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
];

// Python's \b, \w and \s are Unicode-aware; JavaScript's \b and \w are ASCII-only, so a Cyrillic word would never match a `\b…\b`
// pattern. Build the same boundary and word class from Unicode properties (the same as the sender mirror in lib/marketing-posts.ts).
const W = "[\\p{L}\\p{N}_]";
const BOUNDARY = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

function compile(source: string): RegExp {
  return new RegExp(source.replace(/\\b/g, BOUNDARY).replace(/\\w/g, W), "iu");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const COMPILED_RULES = BANNED_RULES.map((r) => ({ id: r.id, res: r.patterns.map(compile) }));
const COMPILED_PROVIDERS = BANNED_PROVIDER_NAMES.map((name) => ({
  id: `provider:${name}`,
  re: new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(name)}(?![\\p{L}\\p{N}_-])`, "iu"),
}));

/**
 * The same normalisation as the Python checker (casefold, the Uzbek apostrophes to ', ё to е), plus NFKC first so a ligature such as
 * "ﬁ" reads as "fi" (Python's casefold does that too; JavaScript's toLowerCase does not).
 */
export function normaliseForBanned(text: string): string {
  // The apostrophes first: NFKC would turn the acute accent ´ into a space and a combining mark.
  return text.replace(/[ʻʼ‘’`´]/g, "'").normalize("NFKC").toLowerCase().replace(/ё/g, "е");
}

export interface BannedHit {
  /** A rule id (free, unlimited, ...) or `provider:<name>`. */
  id: string;
  /** Where it was found: the language and the words that matched, as the owner typed them (lower-cased). */
  found: { lang: Lang; text: string }[];
}

/**
 * The rules (and provider names) the texts trip, each with where. Checked per language; the worker checks the three joined, which
 * can only differ for a phrase that runs across two languages. An empty list means this page's list found nothing, not that the post
 * is safe to say.
 */
export function bannedHits(texts: Partial<Record<Lang, string>>): BannedHit[] {
  const hits = new Map<string, BannedHit>();
  const add = (id: string, lang: Lang, text: string) => {
    const hit = hits.get(id) ?? { id, found: [] };
    if (!hit.found.some((f) => f.lang === lang && f.text === text)) hit.found.push({ lang, text });
    hits.set(id, hit);
  };
  for (const lang of LANGS) {
    const raw = texts[lang];
    if (typeof raw !== "string" || raw === "") continue;
    const t = normaliseForBanned(raw);
    for (const rule of COMPILED_RULES) {
      for (const re of rule.res) {
        const m = re.exec(t);
        if (m) add(rule.id, lang, m[0].trim().slice(0, 60));
      }
    }
    for (const p of COMPILED_PROVIDERS) {
      const m = p.re.exec(t);
      if (m) add(p.id, lang, m[0]);
    }
  }
  return [...hits.values()];
}
