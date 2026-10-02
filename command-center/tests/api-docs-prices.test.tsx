// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ApiDocs } from "@/components/docs/ApiDocs";
import { openApiSpec } from "@/lib/api/openapi";
import type { ApiPriceMap } from "@/lib/api/pricing";

const labels = { table: "Table", code: "Code" };
const text = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

describe("/docs/api prints only the live price list (PIXEL-3 #3)", () => {
  it("with no readable list, says no price is published — never 0031's seeded $1.20 / $0.60", () => {
    const page = text(renderToStaticMarkup(<ApiDocs prices={null} origin="https://example.test" labels={labels} />));
    expect(page).toContain("No price published yet");
    expect(page).not.toMatch(/\$1\.20|\$0\.60|1\.5¢|Default prices/);
  });

  it("a list without a video price (or a zero one) is unpublished, not free", () => {
    for (const prices of [{}, { video_minute: 0, job_minimum: 60 }] as ApiPriceMap[]) {
      const page = text(renderToStaticMarkup(<ApiDocs prices={prices} origin="https://example.test" labels={labels} />));
      expect(page).toContain("VideoNo price published yet");
      expect(page).not.toMatch(/\$0\.00 a minute|at least \$0\.60/);
    }
  });

  it("with a live list, shows exactly its numbers", () => {
    const page = text(
      renderToStaticMarkup(
        <ApiDocs prices={{ video_minute: 150, job_minimum: 75, download_cents_per_credit: 2 }} origin="https://example.test" labels={labels} />,
      ),
    );
    expect(page).toContain("$1.50 a minute of requested length, at least $0.75 a video");
    expect(page).toContain("× 2¢");
    expect(page).toContain("max(⌈seconds × 150¢ / 60⌉, 75¢)");
  });

  it("carries no derived claim about the site's retail price", () => {
    const page = text(renderToStaticMarkup(<ApiDocs prices={{ video_minute: 120 }} origin="https://example.test" labels={labels} />));
    expect(page).not.toMatch(/twice site retail|about 60 credits|Buy any credit pack/);
  });

  it("the OpenAPI document names no price: it is static, and the only price is the live list", () => {
    const doc = JSON.stringify(openApiSpec("https://example.test"));
    expect(doc).not.toMatch(/\$1\.20|\$0\.60|default prices/i);
    expect(doc).toContain("/docs/api#pricing");
  });
});
