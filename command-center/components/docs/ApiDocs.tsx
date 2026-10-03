import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { API_TIERS, TOPUP_MIN_CENTS, formatUsd, type ApiPriceMap } from "@/lib/api/pricing";
import { MAX_ACTIVE_KEYS } from "@/lib/api/keys";
import { KEY_RPM_MAX, LEGACY_SCOPES } from "@/lib/api/scopes";
import { fmt } from "@/lib/i18n/core";
import type { DevDictionary } from "@/lib/i18n/dev";
import { CodeBlock } from "@/components/docs/CodeBlock";
import type { CopyLabels } from "@/components/docs/CopyButton";
import { DevNav, DocSection, H3, Table, type ScrollLabels } from "@/components/docs/doc-parts";

export type { ScrollLabels } from "@/components/docs/doc-parts";

/**
 * The API reference, on the public site's own system (site.css): a condensed
 * title over a contents rundown, then numbered sections ruled like a rundown
 * sheet — number and title on the left, the text on the right — with mono
 * tables and code on the console ground.
 *
 * It is written for the person who is about to make the first call, not for
 * the person debugging the server: a quick start, the calls that matter, how to
 * retry and cap a price. There is deliberately NO errors section and no error
 * or status-code name in the prose (owner's order): how the server is wired
 * inside — holds, queues, other organizations, a vendor's policy — is not a
 * customer's business. The machine-readable OpenAPI document keeps the error
 * schema; the two facts a developer needs (x-request-id, Idempotency-Key) are
 * folded into the endpoints and retry sections.
 *
 * Money: only the live api_prices list is printed. When it cannot be read the
 * page says no price is published — the seeded defaults are a fresh
 * database's starting point, not a price anyone set, so they never appear.
 * Samples carry placeholders (VIDEO_ID, MODEL_ID), never an amount that could
 * be read as a price.
 */

const SECTION_IDS = ["start", "auth", "endpoints", "generations", "safety", "pricing"] as const;
type SectionId = (typeof SECTION_IDS)[number];

/** Method and path by endpoint id; the words are per language (dev.api.endpoints.list). */
const ENDPOINTS: Record<string, [string, string]> = {
  me: ["GET", "/me"],
  balance: ["GET", "/balance"],
  channels: ["GET", "/channels"],
  accounts: ["GET", "/accounts"],
  "videos-create": ["POST", "/videos"],
  "videos-list": ["GET", "/videos"],
  "videos-get": ["GET", "/videos/{id}"],
  "videos-publish": ["POST", "/videos/{id}/publish"],
  "videos-download": ["POST", "/videos/{id}/downloads"],
  "downloads-get": ["GET", "/downloads/{id}"],
  "downloads-file": ["GET", "/downloads/{id}/file"],
  "jobs-get": ["GET", "/jobs/{id}"],
  quote: ["POST", "/creative/quote"],
  "generation-create": ["POST", "/creative/jobs"],
  "generation-get": ["GET", "/creative/jobs/{id}"],
};

/** A unit's live price, or null: a missing or non-positive row is unpublished, never free. */
function livePrice(prices: ApiPriceMap | null, unit: string): number | null {
  const v = prices?.[unit];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** "{a} and {b}" with nodes in the slots, so a price can sit in a counter-face span. */
function slots(template: string, values: Record<string, React.ReactNode>): React.ReactNode[] {
  return template.split(/(\{\w+\})/g).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1] in values ? <span key={i}>{values[m[1]]}</span> : part;
  });
}

export function ApiDocs({
  prices,
  origin,
  labels,
  dev,
  showCli = false,
}: {
  prices: ApiPriceMap | null;
  origin: string;
  labels: ScrollLabels;
  dev: DevDictionary;
  showCli?: boolean;
}) {
  const c = dev.api;
  const BASE = `${origin}/api/v1`;
  const perMinute = livePrice(prices, "video_minute");
  const minimum = livePrice(prices, "job_minimum");
  const perCredit = livePrice(prices, "download_cents_per_credit");
  const copy: CopyLabels = dev.ui;
  const no = (id: SectionId) => SECTION_IDS.indexOf(id) + 1;
  const code = (text: string, name: string) => <CodeBlock code={text} name={name} scrollLabel={labels.code} copy={copy} />;
  const AUTH = `-H "Authorization: Bearer $NIGHTSHIFT_API_KEY"`;
  const [accountBefore, accountAfter = ""] = c.start.account.split("{terms}");

  return (
    <div className="st-doc">
      <section aria-labelledby="api-title" className="st-wrap st-doc-hero">
        <div>
          <DevNav nav={dev.nav} current="api" showCli={showCli} />
          <h1 id="api-title" className="st-h1-page mt-6">
            {c.title}
          </h1>
          <p className="st-lead mt-7">{c.lead}</p>
          <div className="st-hero-actions">
            <Link href="/mcp" className="st-key" data-size="sm">
              {c.toAssistant}
              <ArrowRight aria-hidden />
            </Link>
            <a href="/docs/api/openapi.json" className="st-link">
              {dev.ui.openApi}
              <ArrowUpRight aria-hidden />
            </a>
          </div>
        </div>
        <nav aria-labelledby="toc-title" className="st-doc-toc">
          <h2 id="toc-title" className="st-kicker">
            {c.toc}
          </h2>
          <ol>
            {SECTION_IDS.map((id, i) => (
              <li key={id}>
                <a href={`#${id}`}>
                  <span className="st-num" aria-hidden>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {c.sections[id]}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </section>

      <DocSection id="start" no={no("start")} title={c.sections.start}>
        <ol className="st-doc-steps st-doc-steps-big">
          {c.start.steps.map((s) => (
            <li key={s.id}>
              <div>
                <h3 className="st-doc-step-title">{s.title}</h3>
                <p>{fmt(s.body, { min: formatUsd(TOPUP_MIN_CENTS) })}</p>
              </div>
            </li>
          ))}
        </ol>
        {code(
          `export NIGHTSHIFT_API_KEY="<your API key>"

curl ${BASE}/channels \\
  ${AUTH}`,
          c.start.steps[1].title,
        )}
        {code(
          `{
  "channels": [
    {
      "id": "my-channel",
      "name": "My channel",
      "niche": "history",
      "active": true,
      "youtube_connected": true,
      "target_duration_seconds": 180
    }
  ]
}`,
          c.start.steps[2].title,
        )}
        <p className="st-body">
          {accountBefore}
          <Link className="st-doc-a" href="/terms">
            {c.start.termsLink}
          </Link>
          {accountAfter}
        </p>
        <a href="#endpoints" className="st-link">
          {c.start.next}
          <ArrowRight aria-hidden />
        </a>
      </DocSection>

      <DocSection id="auth" no={no("auth")} title={c.sections.auth}>
        <p className="st-body">{c.auth.lead}</p>
        {code(`Authorization: Bearer nsk_live_…`, c.sections.auth)}
        <ul className="st-doc-list">
          {c.auth.rules.map((r) => (
            <li key={r}>{fmt(r, { max: MAX_ACTIVE_KEYS })}</li>
          ))}
        </ul>
        <p className="st-body">{c.auth.scopesLead}</p>
        <Table name={c.auth.scopesTable} labels={labels}>
          <tbody>
            {c.auth.scopes.map((s) => (
              <tr key={s.id}>
                <td className="st-doc-path">{s.id}</td>
                <td>{s.what}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="st-body">{fmt(c.auth.scopesNote, { legacy: LEGACY_SCOPES.join(", "), rpm: KEY_RPM_MAX })}</p>
      </DocSection>

      <DocSection id="endpoints" no={no("endpoints")} title={c.sections.endpoints}>
        <p className="st-body">{fmt(c.endpoints.lead, { base: BASE })}</p>
        <Table name={c.endpoints.table} labels={labels} stack>
          <tbody>
            {c.endpoints.list.map((e) => {
              const [method, path] = ENDPOINTS[e.id] ?? ["", e.id];
              return (
                <tr key={e.id}>
                  <td className="st-doc-method" data-method={method}>
                    {method}
                  </td>
                  <td className="st-doc-path">{path}</td>
                  <td>{e.what}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <H3>{c.endpoints.startTitle}</H3>
        {code(
          `curl -X POST ${BASE}/videos \\
  ${AUTH} \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"channel_id": "my-channel", "topic": "The lost city of Z", "duration": 180}'

# 201 {"job_id": 42, "channel_id": "my-channel", "status": "queued", "price_cents": <the amount held>}`,
          c.endpoints.startName,
        )}
        <p className="st-body">{c.endpoints.startBody}</p>
        <H3>{c.endpoints.followTitle}</H3>
        {code(
          `curl ${BASE}/jobs/42 ${AUTH}
curl "${BASE}/videos?channel_id=my-channel&limit=5" ${AUTH}`,
          c.endpoints.followName,
        )}
        <p className="st-body">{c.endpoints.followBody}</p>
        <H3>{c.endpoints.publishTitle}</H3>
        {code(
          `curl -X POST ${BASE}/videos/VIDEO_ID/publish \\
  ${AUTH} \\
  -H "Content-Type: application/json" \\
  -d '{"account_ids": ["<instagram or tiktok account id>"], "channel_ids": ["my-second-channel"]}'`,
          c.endpoints.publishName,
        )}
        <p className="st-body">{c.endpoints.publishBody}</p>
        <H3>{c.endpoints.downloadTitle}</H3>
        {code(
          `curl -X POST ${BASE}/videos/VIDEO_ID/downloads ${AUTH} \\
  -H "Content-Type: application/json" -d '{"quality": "1080p"}'
curl ${BASE}/downloads/7 ${AUTH}          # until status = ready
curl -o video.mp4 ${BASE}/downloads/7/file ${AUTH}`,
          c.endpoints.downloadName,
        )}
        <p className="st-body">{c.endpoints.downloadBody}</p>
      </DocSection>

      <DocSection id="generations" no={no("generations")} title={c.sections.generations}>
        <p className="st-body">{c.generations.lead}</p>
        {code(
          `curl -X POST ${BASE}/creative/quote \\
  ${AUTH} -H "Content-Type: application/json" \\
  -d '{"capability": "t2i", "model": "MODEL_ID", "params": {"prompt": "a lighthouse at dawn"}}'
# 200 {"quote": {"credits": <price in credits>, "model": "MODEL_ID", "capability": "t2i", …}}

curl -X POST ${BASE}/creative/jobs \\
  ${AUTH} -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"capability": "t2i", "model": "MODEL_ID", "params": {"prompt": "a lighthouse at dawn"}, "max_credits": QUOTED_CREDITS}'
# 201 {"id": "…", "status": "queued", "quoted_credits": <the quote>, "charged_credits": null, …}

curl ${BASE}/creative/jobs/JOB_ID ${AUTH}   # until status = completed`,
          c.generations.name,
        )}
        <ul className="st-doc-list">
          {c.generations.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </DocSection>

      <DocSection id="safety" no={no("safety")} title={c.sections.safety}>
        <H3>{c.safety.idemTitle}</H3>
        <p className="st-body">{c.safety.idemBody}</p>
        {code(
          `KEY=$(uuidgen)
BODY='{"channel_id": "my-channel", "topic": "The lost city of Z", "duration": 180}'

curl -X POST ${BASE}/videos ${AUTH} -H "Content-Type: application/json" -H "Idempotency-Key: $KEY" -d "$BODY"
# timed out? send the identical request again:
curl -X POST ${BASE}/videos ${AUTH} -H "Content-Type: application/json" -H "Idempotency-Key: $KEY" -d "$BODY"
# → the first answer again, with the header idempotent-replayed: true`,
          c.safety.name,
        )}
        <H3>{c.safety.maxTitle}</H3>
        <p className="st-body">{c.safety.maxBody}</p>
      </DocSection>

      <DocSection id="pricing" no={no("pricing")} title={c.sections.pricing}>
        <p className="st-body">{perMinute !== null ? c.pricing.live : c.pricing.none}</p>
        <Table name={c.pricing.table} labels={labels}>
          <tbody>
            <tr>
              <th scope="row">{c.pricing.video}</th>
              <td>
                {perMinute !== null ? (
                  slots(c.pricing.videoPrice, {
                    perMinute: <span className="st-num">{formatUsd(perMinute)}</span>,
                    minimum:
                      minimum !== null
                        ? slots(c.pricing.videoMinimum, { minimum: <span className="st-num">{formatUsd(minimum)}</span> })
                        : "",
                  })
                ) : (
                  <span className="st-doc-none">{c.pricing.notPublished}</span>
                )}
              </td>
            </tr>
            <tr>
              <th scope="row">{c.pricing.publish}</th>
              <td>{c.pricing.free}</td>
            </tr>
            <tr>
              <th scope="row">{c.pricing.download}</th>
              <td>
                {perCredit !== null ? (
                  slots(c.pricing.downloadPrice, { perCredit: <span className="st-num">{perCredit}¢</span> })
                ) : (
                  <span className="st-doc-none">{c.pricing.notPublished}</span>
                )}
              </td>
            </tr>
          </tbody>
        </Table>
        <p className="st-body">
          <b>{c.pricing.howTitle}.</b> {c.pricing.howBefore}{" "}
          {perMinute !== null && minimum !== null ? (
            <code>{`max(⌈seconds × ${perMinute}¢ / 60⌉, ${minimum}¢)`}</code>
          ) : (
            <code>{c.pricing.formulaGeneric}</code>
          )}{" "}
          {c.pricing.howAfter}
        </p>
        <H3>{c.pricing.tiersTable}</H3>
        <p className="st-body">{c.pricing.tiersLead}</p>
        <Table name={c.pricing.tiersTable} labels={labels}>
          <thead>
            <tr>
              <th scope="col">{c.pricing.tierCols.tier}</th>
              <th scope="col">{c.pricing.tierCols.paid}</th>
              <th scope="col">{c.pricing.tierCols.rpm}</th>
              <th scope="col">{c.pricing.tierCols.concurrency}</th>
              <th scope="col">{c.pricing.tierCols.cap}</th>
            </tr>
          </thead>
          <tbody>
            {API_TIERS.map((tier) => (
              <tr key={tier.tier}>
                <td className="st-num">{tier.tier}</td>
                <td className="st-num">{tier.tier === 0 ? c.pricing.activated : `≥ ${formatUsd(tier.minPaidCents)}`}</td>
                <td className="st-num">{tier.rpm}</td>
                <td className="st-num">{tier.concurrency}</td>
                <td className="st-num">{formatUsd(tier.monthlyCapCents)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="st-body">{c.pricing.limits}</p>
      </DocSection>

      <section aria-labelledby="close-title" className="st-doc-close">
        <div className="st-wrap st-doc-close-row">
          <div>
            <h2 id="close-title" className="st-doc-h2">
              {c.closing.title}
            </h2>
            <p className="st-body mt-3">{c.closing.body}</p>
          </div>
          <Link href="/mcp" className="st-key">
            {c.closing.cta}
            <ArrowRight aria-hidden />
          </Link>
        </div>
      </section>
    </div>
  );
}
