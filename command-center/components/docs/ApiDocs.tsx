import Link from "next/link";
import { API_TIERS, DEFAULT_API_PRICES, formatUsd, type ApiPriceMap } from "@/lib/api/pricing";
import { MAX_ACTIVE_KEYS } from "@/lib/api/keys";

/**
 * The API reference. A developer document, kept in English like the API's own
 * field names and error codes (the Developer console around it is translated).
 */


function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[12px] leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="panel flex flex-col gap-3 p-5">
      <h2 className="t-section">{title}</h2>
      {children}
    </section>
  );
}

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[14px] leading-relaxed text-[var(--color-muted)]">{children}</p>
);

const ENDPOINTS: [string, string, string][] = [
  ["GET", "/me", "The key's organization, usage tier and limits"],
  ["GET", "/balance", "Prepaid balance, hold and this month's spend (cents)"],
  ["GET", "/channels", "Your channels — what POST /videos takes"],
  ["GET", "/accounts", "Publish targets: YouTube channels, Instagram / TikTok accounts"],
  ["POST", "/videos", "Make a video (queued; charged when it succeeds)"],
  ["GET", "/videos", "List videos (?channel_id, ?limit ≤ 100, ?offset)"],
  ["GET", "/videos/{id}", "One video, with its publish requests"],
  ["POST", "/videos/{id}/publish", "Cross-post a finished video (free)"],
  ["POST", "/videos/{id}/downloads", "Order a 720p / 1080p download"],
  ["GET", "/downloads/{id}", "A download's status (file_url when ready)"],
  ["GET", "/downloads/{id}/file", "The MP4 of a ready download"],
  ["GET", "/jobs/{id}", "A video job's status and charge"],
];

const ERRORS: [number, string, string][] = [
  [400, "invalid_request_error", "invalid_body, unknown_parameter, invalid_params, duration_required, targets_required"],
  [401, "authentication_error", "invalid_api_key — missing, malformed, revoked or unknown"],
  [402, "billing_error", "insufficient_balance, monthly_limit_reached, key_limit_reached"],
  [403, "permission_error", "api_not_activated, key_owner_not_admin"],
  [404, "not_found_error", "channel_not_found, video_not_found, job_not_found, download_not_found, no_master"],
  [409, "conflict_error", "channel_not_active, publish_refused, download_not_ready"],
  [422, "idempotency_error", "idempotency_key_reused (409 idempotency_in_progress)"],
  [429, "rate_limit_error", "rate_limit_exceeded, concurrency_limit_exceeded — honour Retry-After"],
  [503, "api_error", "queue_backend_required, downloads_unavailable, pricing_unavailable, api_unavailable"],
];

export function ApiDocs({ prices, origin }: { prices: ApiPriceMap | null; origin: string }) {
  const BASE = `${origin}/api/v1`;
  const live = prices && prices.video_minute !== undefined;
  const p = live ? prices : { ...DEFAULT_API_PRICES };
  const perMinute = p.video_minute ?? DEFAULT_API_PRICES.video_minute;
  const minimum = p.job_minimum ?? DEFAULT_API_PRICES.job_minimum;
  const perCredit = p.download_cents_per_credit ?? DEFAULT_API_PRICES.download_cents_per_credit;
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">Nightshift API</h1>
        <P>
          Make faceless videos, follow them through the pipeline, cross-post them and download them — from your own
          code. The same checks as the site apply to every call: your organization&apos;s channels only, the publish
          gate and approvals, private YouTube uploads. Machine-readable:{" "}
          <a className="underline" href="/docs/api/openapi.json">
            OpenAPI 3.1
          </a>
          .
        </P>
      </header>

      <Section id="start" title="Getting started">
        <ol className="list-decimal space-y-1 pl-5 text-[14px] text-[var(--color-muted)]">
          <li>Buy any credit pack on the site (the API opens to organizations that have made a purchase).</li>
          <li>
            An owner or admin opens <b>Developers</b> in the Command Center and clicks <b>Activate API</b>, accepting
            the <Link className="underline" href="/terms">Terms</Link>.
          </li>
          <li>Top up the API balance (at least $5; it is separate from site credits).</li>
          <li>Create a key (up to {MAX_ACTIVE_KEYS} active keys). It is shown once — store it as a secret.</li>
        </ol>
        <Code>{`curl ${BASE}/me \\
  -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"`}</Code>
        <P>
          A key acts as the admin who created it, inside that organization only. If that person leaves the organization
          or stops being an owner/admin, their keys stop working (<code>key_owner_not_admin</code>). Never put a key in
          a browser or an app you ship: anyone holding it can spend your balance.
        </P>
      </Section>

      <Section id="pricing" title="Pricing">
        <P>
          {live ? "Current prices" : "Default prices (the live price list could not be read just now)"} — prepaid, in
          US dollars:
        </P>
        <table className="w-full text-left text-[13px]">
          <tbody className="divide-y divide-[var(--color-border)]">
            <tr>
              <td className="py-2">Video</td>
              <td className="py-2">
                {formatUsd(perMinute)} per minute of requested length, at least {formatUsd(minimum)} per video
              </td>
            </tr>
            <tr>
              <td className="py-2">Publish to platforms</td>
              <td className="py-2">free</td>
            </tr>
            <tr>
              <td className="py-2">HD download (720p / 1080p)</td>
              <td className="py-2">the site&apos;s download price in credits × {perCredit}¢</td>
            </tr>
          </tbody>
        </table>
        <P>
          How it is charged: creating a video <b>holds</b> max(⌈seconds × {perMinute}¢ / 60⌉, {minimum}¢) from your
          available balance. When the job succeeds the hold is charged; if it fails or is cancelled, all of it is
          released. The length is your <code>duration</code>, or the channel&apos;s target length. A download is held
          when ordered and charged when the file is ready; a failed download costs nothing, and the same quality of the
          same video is free again for 7 days. Why these numbers: the site sells a video minute for about 60 credits
          (~$0.60); the API is twice site retail.
        </P>
      </Section>

      <Section id="tiers" title="Usage tiers and limits">
        <P>Your tier rises automatically with what you have paid in top-ups (net of refunds):</P>
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="text-[var(--color-muted)]">
              <th className="py-1">Tier</th>
              <th className="py-1">Paid top-ups</th>
              <th className="py-1">Requests / min</th>
              <th className="py-1">Videos at once</th>
              <th className="py-1">Monthly spend cap</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {API_TIERS.map((tier) => (
              <tr key={tier.tier}>
                <td className="py-2">{tier.tier}</td>
                <td className="py-2">{tier.tier === 0 ? "activated" : `≥ ${formatUsd(tier.minPaidCents)}`}</td>
                <td className="py-2">{tier.rpm}</td>
                <td className="py-2">{tier.concurrency}</td>
                <td className="py-2">{formatUsd(tier.monthlyCapCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <P>
          The organization can set a lower monthly limit, and each key its own. Spend this month counts charges plus
          holds still open. Rate limits are per key per minute; every response carries <code>x-ratelimit-limit</code>,{" "}
          <code>x-ratelimit-remaining</code> and <code>x-ratelimit-reset</code> (seconds), and a 429 carries{" "}
          <code>Retry-After</code>.
        </P>
      </Section>

      <Section id="endpoints" title="Endpoints">
        <P>
          Base URL <code>{BASE}</code>. JSON in, JSON out. Money is in integer US cents.
        </P>
        <table className="w-full text-left text-[13px]">
          <tbody className="divide-y divide-[var(--color-border)]">
            {ENDPOINTS.map(([m, path, what]) => (
              <tr key={m + path}>
                <td className="mono py-2 pr-2">{m}</td>
                <td className="mono py-2 pr-2">{path}</td>
                <td className="py-2 text-[var(--color-muted)]">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="text-[14px] font-semibold">Make a video</h3>
        <Code>{`curl -X POST ${BASE}/videos \\
  -H "Authorization: Bearer $NIGHTSHIFT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"channel_id": "my-channel", "topic": "The lost city of Z", "duration": 180}'

# 201 {"job_id": 42, "channel_id": "my-channel", "status": "queued", "price_cents": 360}`}</Code>
        <P>
          Optional fields: <code>topic</code>, <code>niche</code>, <code>duration</code> (30–3600 s),{" "}
          <code>language</code>, <code>visual_style</code>, <code>video_provider</code>, <code>image_provider</code>.
          Unknown fields are refused. The video is rendered private and follows the channel&apos;s own publish rules.
        </P>
        <h3 className="text-[14px] font-semibold">Follow the job, then find the video</h3>
        <Code>{`curl ${BASE}/jobs/42 -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"
curl "${BASE}/videos?channel_id=my-channel&limit=5" -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"`}</Code>
        <h3 className="text-[14px] font-semibold">Publish to platforms</h3>
        <Code>{`curl -X POST ${BASE}/videos/VIDEO_ID/publish \\
  -H "Authorization: Bearer $NIGHTSHIFT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"account_ids": ["<instagram or tiktok account id>"], "channel_ids": ["my-second-channel"]}'`}</Code>
        <P>
          One request per target, each with its own answer. A video that has not passed the publish gate and its
          approvals is recorded <code>refused</code> with a reason, exactly as on the site. Targets come from{" "}
          <code>GET /accounts</code>.
        </P>
        <h3 className="text-[14px] font-semibold">Download in HD</h3>
        <Code>{`curl -X POST ${BASE}/videos/VIDEO_ID/downloads -H "Authorization: Bearer $NIGHTSHIFT_API_KEY" \\
  -H "Content-Type: application/json" -d '{"quality": "1080p"}'
curl ${BASE}/downloads/7 -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"          # until status = ready
curl -o video.mp4 ${BASE}/downloads/7/file -H "Authorization: Bearer $NIGHTSHIFT_API_KEY"`}</Code>
      </Section>

      <Section id="errors" title="Errors">
        <Code>{`{"error": {"type": "billing_error", "code": "insufficient_balance",
           "message": "Your API balance does not cover this video. Top up in the Developer console.",
           "request_id": "req_…", "price_cents": 360, "available_cents": 120}}`}</Code>
        <table className="w-full text-left text-[13px]">
          <tbody className="divide-y divide-[var(--color-border)]">
            {ERRORS.map(([status, type, codes]) => (
              <tr key={status}>
                <td className="mono py-2 pr-2">{status}</td>
                <td className="mono py-2 pr-2">{type}</td>
                <td className="py-2 text-[var(--color-muted)]">{codes}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <P>
          Every response has an <code>x-request-id</code>; quote it when you contact support. POST endpoints accept an{" "}
          <code>Idempotency-Key</code> header: the same key with the same body within 24 hours returns the first
          success again (header <code>idempotent-replayed: true</code>) instead of making a second video; the same key
          with a different body is a 422.
        </P>
      </Section>
    </main>
  );
}
