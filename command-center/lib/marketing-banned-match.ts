import { LANGS, type Lang } from "@/lib/marketing-posts";

/**
 * The matching half of the banned-wording check (lib/marketing-banned.ts holds the lists, server-only). Client-safe: it holds no
 * list, so the New post form gets the lists as a prop and compiles them here.
 */
export interface BannedList {
  /** Rule id -> the patterns (Python `re` syntax, matched case-insensitively on the normalised text). */
  rules: readonly { id: string; patterns: readonly string[] }[];
  providerNames: readonly string[];
}

export interface CompiledBanned {
  rules: { id: string; res: RegExp[] }[];
  providers: { id: string; re: RegExp }[];
}

// Python's \b, \w and \s are Unicode-aware; JavaScript's \b and \w are ASCII-only, so a Cyrillic word would never match a `\b…\b`
// pattern. Build the same boundary and word class from Unicode properties (the same as the sender mirror in lib/marketing-posts.ts).
const W = "[\\p{L}\\p{N}_]";
const BOUNDARY = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

function compile(source: string): RegExp {
  return new RegExp(source.replace(/\\b/g, BOUNDARY).replace(/\\w/g, W), "iu");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function compileBanned(list: BannedList): CompiledBanned {
  return {
    rules: list.rules.map((r) => ({ id: r.id, res: r.patterns.map(compile) })),
    providers: list.providerNames.map((name) => ({
      id: `provider:${name}`,
      re: new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(name)}(?![\\p{L}\\p{N}_-])`, "iu"),
    })),
  };
}

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
export function bannedHitsIn(texts: Partial<Record<Lang, string>>, compiled: CompiledBanned): BannedHit[] {
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
    for (const rule of compiled.rules) {
      for (const re of rule.res) {
        const m = re.exec(t);
        if (m) add(rule.id, lang, m[0].trim().slice(0, 60));
      }
    }
    for (const p of compiled.providers) {
      const m = p.re.exec(t);
      if (m) add(p.id, lang, m[0]);
    }
  }
  return [...hits.values()];
}
