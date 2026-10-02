import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { API_TIERS, formatUsd, type ApiPriceMap } from "@/lib/api/pricing";
import { MAX_ACTIVE_KEYS } from "@/lib/api/keys";
import { KEY_RPM_MAX, LEGACY_SCOPES } from "@/lib/api/scopes";

/**
 * The API reference, on the public site's own system (site.css): a condensed
 * title over a contents rundown, then numbered sections ruled like a rundown
 * sheet — number and title on the left, the text on the right — with mono
 * tables and code on the console ground. A developer document, kept in
 * English like the API's own field names and error codes.
 *
 * Money: only the live api_prices list is printed. When it cannot be read the
 * page says no price is published — the seeded defaults are a fresh
 * database's starting point, not a price anyone set, so they never appear.
 */

/** What a screen reader calls a box that scrolls sideways. A scroll container
 *  must be reachable by keyboard, and a focusable box needs a name — a name of
 *  its own (axe landmark-unique), so each box is called by what it holds. */
export type ScrollLabels = { table: string; code: string };

function Code({ children, name, labels }: { children: string; name: string; labels: ScrollLabels }) {
  return (
    <pre tabIndex={0} role="region" aria-label={`${name} · ${labels.code}`} className="scroll-focus st-code">
      <code>{children}</code>
    </pre>
  );
}

/** A table that scrolls inside its own box on a phone instead of widening the page. */
function Table({
  children,
  name,
  labels,
  stack = false,
}: {
  children: React.ReactNode;
  name: string;
  labels: ScrollLabels;
  /** On a phone, each row becomes its key cells on one line over its description
   *  (a three-column table left the description a ~100px column). */
  stack?: boolean;
}) {
  return (
    <div tabIndex={0} role="region" aria-label={`${name} · ${labels.table}`} className="scroll-focus st-doc-table-wrap">
      <table className="st-doc-table" data-stack={stack || undefined}>
        <caption className="sr-only">{name}</caption>
        {children}
      </table>
    </div>
  );
}

const SECTIONS = [
  ["start", "Getting started"],
  ["pricing", "Pricing"],
  ["tiers", "Usage tiers and limits"],
  ["endpoints", "Endpoints"],
  ["scopes", "Key scopes and limits"],
  ["creative", "Generations"],
  ["mcp", "MCP server"],
  ["errors", "Errors"],
] as const;

type SectionId = (typeof SECTIONS)[number][0];

function Section({ id, children }: { id: SectionId; children: React.ReactNode }) {
  const i = SECTIONS.findIndex(([s]) => s === id);
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="st-doc-sec">
      <div className="st-wrap st-doc-grid">
        <header className="st-doc-head">
          <span className="st-num st-doc-no" aria-hidden>
            {String(i + 1).padStart(2, "0")}
          </span>
          <h2 id={`${id}-title`} className="st-doc-h2">
            {SECTIONS[i][1]}
          </h2>
        </header>
        <div className="st-doc-body">{children}</div>
      </div>
    </section>
  );
}

const H3 = ({ children }: { children: React.ReactNode }) => <h3 className="st-doc-h3">{children}</h3>;

const ENDPOINTS: [string, string, string][] = [
  ["GET", "/me", "The key's organization, usage tier and limits"],
  ["GET", "/balance", "Prepaid balance, hold and this month's spend (cents)"],
  ["GET", "/channels", "Your channels — what POST /videos takes"],
  ["GET", "/accounts", "Publish targets: YouTube channels, Instagram / TikTok accounts"],
  ["POST", "/videos", "Start a video (queued; charged when it succeeds)"],
  ["GET", "/videos", "List videos (?channel_id, ?limit ≤ 100, ?offset)"],
  ["GET", "/videos/{id}", "One video, with its publish requests"],
  ["POST", "/videos/{id}/publish", "Cross-post a finished video (free)"],
  ["POST", "/videos/{id}/downloads", "Order a 720p / 1080p download"],
  ["GET", "/downloads/{id}", "A download's status (file_url when ready)"],
  ["GET", "/downloads/{id}/file", "The MP4 of a ready download"],
  ["GET", "/jobs/{id}", "A video job's status and charge"],
  ["POST", "/creative/quote", "The price of one generation, in credits (nothing is held)"],
  ["POST", "/creative/jobs", "Start a generation (Idempotency-Key and max_credits required)"],
  ["GET", "/creative/jobs/{id}", "A generation this key started: status, charge, result"],
];

const SCOPE_ROWS: [string, string][] = [
  ["account:read", "GET /me needs none; /balance, /channels, /accounts"],
  ["videos:read", "GET /videos, /videos/{id}, /jobs/{id}, /downloads/{id}"],
  ["videos:write", "POST /videos, /videos/{id}/publish, /videos/{id}/downloads"],
  ["creative:quote", "POST /creative/quote"],
  ["creative:create", "POST /creative/jobs — spends credits"],
  ["creative:read", "GET /creative/jobs/{id}"],
];

const ERRORS: [number, string, string][] = [
  [400, "invalid_request_error", "invalid_body, unknown_parameter, invalid_params, duration_required, targets_required, max_credits_required, idempotency_key_required"],
  [401, "authentication_error", "invalid_api_key — missing, malformed, revoked or unknown"],
  [402, "billing_error", "insufficient_balance, monthly_limit_reached, key_limit_reached, insufficient_credits, key_credit_limit_reached"],
  [403, "permission_error", "api_not_activated, key_owner_not_admin, insufficient_scope, entitlement_required, forbidden"],
  [404, "not_found_error", "channel_not_found, video_not_found, job_not_found, download_not_found, no_master"],
  [409, "conflict_error", "channel_not_active, publish_refused, download_not_ready, price_changed"],
  [422, "idempotency_error", "idempotency_key_reused (409 idempotency_in_progress); also model_not_sellable, unpriced, source_unavailable, capability_not_supported"],
  [429, "rate_limit_error", "rate_limit_exceeded, concurrency_limit_exceeded, run_limit_reached — honour Retry-After"],
  [503, "api_error", "queue_backend_required, downloads_unavailable, pricing_unavailable, api_unavailable"],
];

/** A unit's live price, or null: a missing or non-positive row is unpublished, never free. */
function livePrice(prices: ApiPriceMap | null, unit: string): number | null {
  const v = prices?.[unit];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

const NOT_PUBLISHED = "No price published yet";

export function ApiDocs({ prices, origin, labels }: { prices: ApiPriceMap | null; origin: string; labels: ScrollLabels }) {
  const BASE = `${origin}/api/v1`;
  const perMinute = livePrice(prices, "video_minute");
  const minimum = livePrice(prices, "job_minimum");
  const perCredit = livePrice(prices, "download_cents_per_credit");
  return (
    <div className="st-doc">
      <section aria-labelledby="api-title" className="st-wrap st-doc-hero">
        <div>
          <nav aria-label="Breadcrumb" className="st-kicker flex flex-wrap items-center gap-2">
            <Link
              href="/solutions/developers"
              className="inline-flex min-h-11 items-center underline decoration-[var(--ns-rule-strong)] underline-offset-4 hover:text-[var(--ns-text)]"
            >
              Developers
            </Link>
            <span aria-hidden>/</span>
            <span aria-current="page">API reference</span>
          </nav>
          <h1 id="api-title" className="st-h1-page mt-6">
            The Nightshift API
          </h1>
          <p className="st-lead mt-7">
            Start videos for your channels, follow each one to YouTube, cross-post it and download it — from your own
            code or an AI assistant. Every call passes the same checks as the site: your organization&apos;s channels
            only, the publish check and its approvals, private YouTube uploads.
          </p>
          <div className="st-hero-actions">
            <a href="/docs/api/openapi.json" className="st-link">
              OpenAPI 3.1 spec
              <ArrowUpRight aria-hidden />
            </a>
            <Link href="/solutions/developers" className="st-link">
              What it is for
              <ArrowRight aria-hidden />
            </Link>
          </div>
        </div>
        <nav aria-labelledby="toc-title" className="st-doc-toc">
          <h2 id="toc-title" className="st-kicker">
            On this page
          </h2>
          <ol>
            {SECTIONS.map(([id, title], i) => (
              <li key={id}>
                <a href={`#${id}`}>
                  <span className="st-num" aria-hidden>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </section>

      <Section id="start">
        <ol className="st-doc-steps">
          <li>
            <span>The API opens to an organization that has bought a credit pack, or that has API access switched on for it.</span>
          </li>
          <li>
            <span>
              An organization admin opens <b>Developers</b> in the Command Center and presses <b>Activate API</b>,
              accepting the{" "}
              <Link className="st-doc-a" href="/terms">
                Terms
              </Link>
              .
            </span>
          </li>
          <li>
            <span>Top up the API balance (at least $5; it is separate from site credits).</span>
          </li>
          <li>
            <span>Create a key (up to {MAX_ACTIVE_KEYS} active keys). It is shown once — store it as a secret.</span>
          </li>
        </ol>
        <Code name="Your first call" labels={labels}>{`curl ${BASE}/me \\
  -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"`}</Code>
        <p className="st-body">
          A key acts as the admin who created it, inside that organization only. If that person leaves the organization
          or stops being an owner or admin, their keys stop working (<code>key_owner_not_admin</code>). Never put a key
          in a browser or an app you ship: anyone holding it can spend your balance.
        </p>
      </Section>

      <Section id="pricing">
        <p className="st-body">
          {perMinute !== null
            ? "From the live price list, prepaid, in US dollars:"
            : "The live price list is not published, or could not be read just now — so this page shows no price rather than a guess."}
        </p>
        <Table name="Prices" labels={labels}>
          <tbody>
            <tr>
              <th scope="row">Video</th>
              <td>
                {perMinute !== null ? (
                  <>
                    <span className="st-num">{formatUsd(perMinute)}</span> a minute of requested length
                    {minimum !== null && (
                      <>
                        , at least <span className="st-num">{formatUsd(minimum)}</span> a video
                      </>
                    )}
                  </>
                ) : (
                  <span className="st-doc-none">{NOT_PUBLISHED}</span>
                )}
              </td>
            </tr>
            <tr>
              <th scope="row">Publish to platforms</th>
              <td>Free</td>
            </tr>
            <tr>
              <th scope="row">HD download (720p / 1080p)</th>
              <td>
                {perCredit !== null ? (
                  <>
                    The site&apos;s download price in credits × <span className="st-num">{perCredit}¢</span>
                  </>
                ) : (
                  <span className="st-doc-none">{NOT_PUBLISHED}</span>
                )}
              </td>
            </tr>
          </tbody>
        </Table>
        <p className="st-body">
          How it is charged: starting a video <b>holds</b>{" "}
          {perMinute !== null ? (
            <code>
              max(⌈seconds × {perMinute}¢ / 60⌉, {minimum ?? 0}¢)
            </code>
          ) : (
            <code>max(⌈seconds × per-minute price / 60⌉, minimum)</code>
          )}{" "}
          from your available balance, and the answer carries it as <code>price_cents</code>. When the job succeeds the
          hold is charged; if it fails or is cancelled, all of it is released. The length is your <code>duration</code>,
          or the channel&apos;s target length. A download is held when ordered and charged when the file is ready; a
          failed download costs nothing, and the same quality of the same video is free again for 7 days.
        </p>
      </Section>

      <Section id="tiers">
        <p className="st-body">Your tier rises by itself with what you have paid in top-ups (net of refunds):</p>
        <Table name="Usage tiers" labels={labels}>
          <thead>
            <tr>
              <th scope="col">Tier</th>
              <th scope="col">Paid top-ups</th>
              <th scope="col">Requests / min</th>
              <th scope="col">Videos at once</th>
              <th scope="col">Monthly spend cap</th>
            </tr>
          </thead>
          <tbody>
            {API_TIERS.map((tier) => (
              <tr key={tier.tier}>
                <td className="st-num">{tier.tier}</td>
                <td className="st-num">{tier.tier === 0 ? "activated" : `≥ ${formatUsd(tier.minPaidCents)}`}</td>
                <td className="st-num">{tier.rpm}</td>
                <td className="st-num">{tier.concurrency}</td>
                <td className="st-num">{formatUsd(tier.monthlyCapCents)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="st-body">
          The organization can set a lower monthly limit, and each key its own. Spend this month counts charges plus
          holds still open. Rate limits are per key per minute; every response carries <code>x-ratelimit-limit</code>,{" "}
          <code>x-ratelimit-remaining</code> and <code>x-ratelimit-reset</code> (seconds), and a 429 carries{" "}
          <code>Retry-After</code>.
        </p>
      </Section>

      <Section id="endpoints">
        <p className="st-body">
          Base URL <code>{BASE}</code>. JSON in, JSON out. Money is in integer US cents.
        </p>
        <Table name="Endpoints" labels={labels} stack>
          <tbody>
            {ENDPOINTS.map(([m, path, what]) => (
              <tr key={m + path}>
                <td className="st-doc-method" data-method={m}>
                  {m}
                </td>
                <td className="st-doc-path">{path}</td>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <H3>Start a video</H3>
        <Code name="Start a video" labels={labels}>{`curl -X POST ${BASE}/videos \\
  -H "Authorization: Bearer $NIGHTSHIFT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"channel_id": "my-channel", "topic": "The lost city of Z", "duration": 180}'

# 201 {"job_id": 42, "channel_id": "my-channel", "status": "queued", "price_cents": …}`}</Code>
        <p className="st-body">
          Optional fields: <code>topic</code>, <code>niche</code>, <code>duration</code> (30–3600 s),{" "}
          <code>language</code>, <code>visual_style</code>, <code>video_provider</code>, <code>image_provider</code>.
          Unknown fields are refused. The video is rendered private and follows the channel&apos;s own publish rules.
        </p>
        <H3>Follow the job, then find the video</H3>
        <Code name="Follow a job" labels={labels}>{`curl ${BASE}/jobs/42 -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"
curl "${BASE}/videos?channel_id=my-channel&limit=5" -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"`}</Code>
        <H3>Publish to platforms</H3>
        <Code name="Publish a video" labels={labels}>{`curl -X POST ${BASE}/videos/VIDEO_ID/publish \\
  -H "Authorization: Bearer $NIGHTSHIFT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"account_ids": ["<instagram or tiktok account id>"], "channel_ids": ["my-second-channel"]}'`}</Code>
        <p className="st-body">
          One request per target, each with its own answer. A video that has not passed the publish check and its
          approvals is recorded <code>refused</code> with a reason, exactly as on the site. Targets come from{" "}
          <code>GET /accounts</code>.
        </p>
        <H3>Download in HD</H3>
        <Code name="Download a video" labels={labels}>{`curl -X POST ${BASE}/videos/VIDEO_ID/downloads -H "Authorization: Bearer $NIGHTSHIFT_API_KEY" \\
  -H "Content-Type: application/json" -d '{"quality": "1080p"}'
curl ${BASE}/downloads/7 -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"          # until status = ready
curl -o video.mp4 ${BASE}/downloads/7/file -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"`}</Code>
      </Section>

      <Section id="scopes">
        <p className="st-body">
          Every key has scopes, chosen when it is created in the Developer console; a call outside them is refused with{" "}
          <code>403 insufficient_scope</code> (the body names <code>required_scope</code>), before anything is created
          or charged. Keys made before generations existed hold only {LEGACY_SCOPES.join(", ")} and can never start a
          generation. <code>GET /me</code> works with any valid key and lists the key&apos;s scopes.
        </p>
        <Table name="Key scopes" labels={labels}>
          <tbody>
            {SCOPE_ROWS.map(([scope, what]) => (
              <tr key={scope}>
                <td className="st-doc-path">{scope}</td>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="st-body">
          A key can also carry its own requests-per-minute limit (1–{KEY_RPM_MAX}; it can only lower the usage
          tier&apos;s, never raise it) and a monthly credit ceiling for generations. Give a key only what its program
          needs — a key that only reads status cannot spend anything.
        </p>
      </Section>

      <Section id="creative">
        <p className="st-body">
          Pictures, clips and voice-overs with the same models, prices and checks as the Studio. Unlike videos, a
          generation is paid in the organization&apos;s <b>credits</b>, not the USD API balance, and it is{" "}
          <b>the Studio&apos;s own job</b>: the quote is held when you start it, the charge is taken when the
          generation succeeds, and the hold is released if it fails, expires or is stopped. Quote first, then start
          with the price you accept:
        </p>
        <Code name="Quote and start a generation" labels={labels}>{`curl -X POST ${BASE}/creative/quote \\
  -H "Authorization: Bearer $NIGHTSHIFT_API_KEY" -H "Content-Type: application/json" \\
  -d '{"capability": "t2i", "model": "MODEL_ID", "params": {"prompt": "a lighthouse at dawn"}}'
# 200 {"quote": {"credits": 6, "model": "MODEL_ID", "capability": "t2i", ...}}

curl -X POST ${BASE}/creative/jobs \\
  -H "Authorization: Bearer $NIGHTSHIFT_API_KEY" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"capability": "t2i", "model": "MODEL_ID", "params": {"prompt": "a lighthouse at dawn"}, "max_credits": 6}'
# 201 {"id": "…", "status": "queued", "quoted_credits": 6, "charged_credits": null, ...}

curl ${BASE}/creative/jobs/JOB_ID -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"   # until status = completed`}</Code>
        <ul className="st-doc-list">
          <li>
            <b>max_credits</b> and an <b>Idempotency-Key</b> are required. A price above <code>max_credits</code> is{" "}
            <code>409 price_changed</code> and nothing is held; a retry with the same key and body returns the first
            answer and never pays twice. Idempotency keys belong to the API key that sent them.
          </li>
          <li>
            Not enough credits is <code>402 insufficient_credits</code>; the limit on generations running at once is{" "}
            <code>429 run_limit_reached</code>; a key&apos;s own monthly credit ceiling is{" "}
            <code>402 key_credit_limit_reached</code>. Nothing is held in any of these cases.
          </li>
          <li>
            Only models the API may sell are accepted: a model whose vendor does not allow third-party API use, or one
            that is unverified or unpriced, is <code>422 model_not_sellable</code>.
          </li>
          <li>
            Input pictures (<code>source_asset_id</code>) must be in your organization&apos;s media library; another
            organization&apos;s id answers exactly like one that does not exist (<code>422 source_unavailable</code>).
          </li>
          <li>
            A key reads only the generations it started. Outputs are saved to your media library (
            <code>result_asset_ids</code>); a status of <code>completed</code> with <code>charged_credits</code> is the
            final charge, <code>failed</code> means everything was released.
          </li>
        </ul>
      </Section>

      <Section id="mcp">
        <p className="st-body">
          <code>{origin}/api/mcp</code> is a remote MCP server (Streamable HTTP) for AI assistants, with the same key,
          limits and prices. Tools: list_channels, create_video, get_job_status, list_videos, get_video,
          list_connected_accounts, publish_video, request_download, get_download, get_balance.
        </p>
        <H3>Claude Code</H3>
        <Code name="Claude Code setup" labels={labels}>{`claude mcp add --transport http nightshift ${origin}/api/mcp \\
  --header "Authorization: Bearer nsk_live_…"`}</Code>
        <H3>Cursor (~/.cursor/mcp.json)</H3>
        <Code name="Cursor setup" labels={labels}>{`{"mcpServers": {"nightshift": {"url": "${origin}/api/mcp",
  "headers": {"Authorization": "Bearer nsk_live_…"}}}}`}</Code>
        <p className="st-body">
          Claude Desktop and claude.ai custom connectors, and ChatGPT connectors, authenticate remote servers with OAuth
          and cannot send an API-key header, so they cannot connect directly. In Claude Desktop, add the server through
          the local <code>mcp-remote</code> bridge instead (see the MCP guide in the repository, docs/MCP.md); ChatGPT is
          not supported until OAuth is offered.
        </p>
        <Code name="Claude Desktop bridge setup" labels={labels}>{`{"mcpServers": {"nightshift": {"command": "npx",
  "args": ["-y", "mcp-remote", "${origin}/api/mcp", "--header", "Authorization:\${NIGHTSHIFT_AUTH}"],
  "env": {"NIGHTSHIFT_AUTH": "Bearer nsk_live_…"}}}}`}</Code>
      </Section>

      <Section id="errors">
        <Code name="An error answer" labels={labels}>{`{"error": {"type": "billing_error", "code": "insufficient_balance",
           "message": "Your API balance does not cover this video. Top up in the Developer console.",
           "request_id": "req_…", "price_cents": 360, "available_cents": 120}}`}</Code>
        <Table name="Error codes" labels={labels} stack>
          <tbody>
            {ERRORS.map(([status, type, codes]) => (
              <tr key={status}>
                <td className="st-doc-path">{status}</td>
                <td className="st-doc-path">{type}</td>
                <td>{codes}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="st-body">
          Every response has an <code>x-request-id</code>; quote it when you contact support. POST endpoints accept an{" "}
          <code>Idempotency-Key</code> header: the same key with the same body within 24 hours returns the first
          success again (header <code>idempotent-replayed: true</code>) instead of making a second video; the same key
          with a different body is a 422.
        </p>
      </Section>
    </div>
  );
}
