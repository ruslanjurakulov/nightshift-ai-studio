import { describe, expect, it } from "vitest";
import { LEGAL_TEXTS, type LegalBlock, type LegalDocument } from "@/lib/legal-docs";
import { tokenizeInline } from "@/lib/legal-docs/inline";

function strings(block: LegalBlock): string[] {
  if (typeof block === "string") return [block];
  if ("list" in block) return block.list;
  if ("note" in block) return [block.note];
  if ("creditExpiry" in block) return [block.creditExpiry.never, block.creditExpiry.after];
  return [...block.table.head, ...block.table.rows.flat()];
}

function allText(doc: LegalDocument): string[] {
  return [doc.title, doc.summary, ...doc.sections.flatMap((s) => [s.heading, ...s.body.flatMap(strings)])];
}

function hrefs(doc: LegalDocument): string[] {
  return allText(doc)
    .flatMap(tokenizeInline)
    .flatMap((tok) => (tok.kind === "link" ? [tok.href] : []))
    .sort();
}

function codes(doc: LegalDocument): string[] {
  return allText(doc)
    .flatMap(tokenizeInline)
    .flatMap((tok) => (tok.kind === "code" ? [tok.text] : []))
    .sort();
}

describe("inline markup", () => {
  it("splits links, operator placeholders and code out of the text", () => {
    expect(tokenizeInline("Email {contactEmail} or read [the policy](/privacy) on `youtube.upload`.")).toEqual([
      { kind: "text", text: "Email " },
      { kind: "var", name: "contactEmail" },
      { kind: "text", text: " or read " },
      { kind: "link", label: "the policy", href: "/privacy" },
      { kind: "text", text: " on " },
      { kind: "code", text: "youtube.upload" },
      { kind: "text", text: "." },
    ]);
  });

  // A typo'd placeholder must stay visible on the page, not vanish silently.
  it("leaves an unknown {placeholder} as text", () => {
    expect(tokenizeInline("by {legalNmae}")).toEqual([{ kind: "text", text: "by {legalNmae}" }]);
  });

  it("does not turn a non-https link into an anchor", () => {
    expect(tokenizeInline("[x](javascript:alert(1))").every((t) => t.kind === "text")).toBe(true);
  });
});

describe("legal texts", () => {
  const { en } = LEGAL_TEXTS;

  // Google's reviewers check for these; losing one in an edit fails verification.
  it("the Privacy Policy carries the links YouTube API Services require", () => {
    const links = hrefs(en.privacy);
    expect(links).toContain("https://www.youtube.com/t/terms");
    expect(links).toContain("https://policies.google.com/privacy");
    expect(links).toContain("https://myaccount.google.com/permissions");
    expect(links).toContain("https://developers.google.com/terms/api-services-user-data-policy");
    expect(allText(en.privacy).join(" ")).toContain("Limited Use requirements");
  });

  it("the Privacy Policy names every scope the connect flow requests", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../lib/server/google-oauth.ts", import.meta.url), "utf8"),
    );
    const requested = [...src.matchAll(/"https:\/\/www\.googleapis\.com\/auth\/([\w.-]+)"/g)].map((m) => m[1]);
    expect(requested.length).toBeGreaterThan(0);
    const named = codes(en.privacy).map((c) => c.replace(/\s*\(.*\)$/, ""));
    for (const scope of requested) expect(named).toContain(scope);
  });

  // Paddle's seller verification reads the Terms for what is sold, who sells
  // it and how refunds work, and the Privacy Policy for who processes payments.
  const PADDLE_BUYER_TERMS = "https://www.paddle.com/legal/checkout-buyer-terms";
  const PADDLE_PRIVACY = "https://www.paddle.com/legal/privacy";

  for (const [locale, texts] of Object.entries(LEGAL_TEXTS)) {
    describe(`${locale}: prepaid credits and Paddle`, () => {
      const credits = texts.terms.sections.find((s) => s.id === "credits");
      const creditsText = credits ? credits.body.flatMap(strings).join(" ") : "";

      it("the credits section is in effect: a lawyer-review note on top, no template marker, no [blanks]", () => {
        expect(credits?.body[0]).toHaveProperty("note");
        expect(creditsText).not.toMatch(/TEMPLATE|NOT IN EFFECT|ШАБЛОН|НЕ ДЕЙСТВУЕТ|SHABLON|KUCHDA EMAS/);
        // A bracketed gap like "[N months]" would be an unfinished promise;
        // markdown links are the only brackets allowed.
        expect(creditsText.replace(/\[[^\]]+\]\([^)]+\)/g, "")).not.toMatch(/\[|\]/);
      });

      it("names Paddle as Merchant of Record and links its buyer terms, privacy notice and our pricing page", () => {
        expect(creditsText).toContain("Paddle");
        expect(creditsText).toContain("Merchant of Record");
        const links = hrefs(texts.terms);
        expect(links).toContain(PADDLE_BUYER_TERMS);
        expect(links).toContain(PADDLE_PRIVACY);
        expect(links).toContain("/pricing");
      });

      // Unset expiry means "credits do not expire" — what the system does —
      // so both wordings must exist, and only the configured one fills {months}.
      it("says what happens with and without an expiry term", () => {
        const expiry = credits?.body.find((b) => typeof b === "object" && "creditExpiry" in b);
        expect(expiry).toBeDefined();
        const { never, after } = (expiry as { creditExpiry: { never: string; after: string } }).creditExpiry;
        expect(never).not.toContain("{months}");
        expect(after).toContain("{months}");
      });

      it("lists Paddle among the Privacy Policy's processors, with its privacy notice", () => {
        const processors = texts.privacy.sections.find((s) => s.id === "processors");
        const table = processors?.body.find((b) => typeof b === "object" && "table" in b) as
          | { table: { rows: string[][] } }
          | undefined;
        expect(table?.table.rows.some((r) => r[0].startsWith("Paddle"))).toBe(true);
        expect(processors?.body.flatMap(strings).join(" ")).toContain("Merchant of Record");
        expect(hrefs(texts.privacy)).toContain(PADDLE_PRIVACY);
      });
    });
  }

  for (const [locale, texts] of Object.entries(LEGAL_TEXTS)) {
    if (locale === "en") continue;
    describe(locale, () => {
      for (const kind of ["privacy", "terms"] as const) {
        it(`${kind}: has the same sections, links and scopes as English`, () => {
          expect(texts[kind].sections.map((s) => s.id)).toEqual(en[kind].sections.map((s) => s.id));
          expect(hrefs(texts[kind])).toEqual(hrefs(en[kind]));
          expect(codes(texts[kind])).toEqual(codes(en[kind]));
        });
      }
    });
  }
});
