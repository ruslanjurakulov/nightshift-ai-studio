import { jsonLdScript } from "@/lib/landing";

/** One question and its answer, exactly as the page prints them. */
export type FaqEntry = { id: string; q: string; a: string };

/**
 * schema.org FAQPage for /studio. It is built from the very strings the page
 * prints (components/site/StudioPage.tsx renders the same items), so a visible
 * answer and the structured one cannot differ: tests/studio-page.test.tsx
 * compares them. Plain text only, no markup, no links in an answer.
 */
export function faqPageJsonLd(items: readonly FaqEntry[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({
      "@type": "Question",
      name: i.q,
      acceptedAnswer: { "@type": "Answer", text: i.a },
    })),
  };
}

export { jsonLdScript };
