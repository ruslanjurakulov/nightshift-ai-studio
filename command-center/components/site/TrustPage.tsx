import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { Dictionary, Locale } from "@/lib/i18n";
import { fmt } from "@/lib/i18n/core";
import { YOUTUBE_OAUTH_SCOPES } from "@/lib/server/google-oauth";
import { GOOGLE_PERMISSIONS_URL, shortScope } from "@/lib/channel-tokens";
import { CONTACT_HREF, LEGAL } from "@/lib/legal";
import { jsonLdScript } from "@/lib/landing";
import { REFUND_PATH, TRUST_PATH } from "@/lib/public-paths";
import { SOCIAL } from "@/lib/site/social";
import { SITE_DOMAIN, TRUST_LAST_REVIEWED, TRUST_SECTIONS } from "@/lib/trust";
import "@/components/site/trust-page.css";

/**
 * /trust: what Nightshift may do with a channel, keys and money, in the order a careful person asks. A Server Component;
 * the frame is PublicShell's. The words are lib/i18n/trust; the facts that are code come from the code itself:
 *  - the YouTube permissions are YOUTUBE_OAUTH_SCOPES, the constant the connect flow sends to Google, so the list cannot
 *    drift from what Google shows on its consent screen (the copy has one entry per scope, matched by id);
 *  - the contact address is the operator's configured one (lib/legal.ts); with none set the page points at the Terms'
 *    contact details rather than printing an address nobody reads;
 *  - the accounts elsewhere are lib/site/social.ts, the same list the footer links.
 */

/** A sentence with one `{key}` placeholder, the placeholder replaced by a node (a link, a date); the rest stays text. */
function withNode(text: string, key: string, node: ReactNode): ReactNode {
  const at = text.indexOf(`{${key}}`);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      {node}
      {text.slice(at + key.length + 2)}
    </>
  );
}

/** A social link as a person reads it: host and path, no scheme, no "www.", no trailing slash. */
function shownAddress(href: string): string {
  const u = new URL(href);
  return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
}

const DATE_LOCALE: Record<Locale, string> = { en: "en-GB", ru: "ru-RU", uz: "uz-Latn-UZ" };

export function trustJsonLd(input: { t: Dictionary; locale: Locale; origin: string | null }): Record<string, unknown> {
  const tr = input.t.site.trust;
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: tr.title,
    description: tr.meta.description,
    inLanguage: input.locale,
    lastReviewed: TRUST_LAST_REVIEWED,
    ...(input.origin ? { url: new URL(TRUST_PATH, input.origin).toString(), isPartOf: { "@id": `${input.origin}/#website` } } : {}),
  };
}

export function TrustPage({ t, locale, origin }: { t: Dictionary; locale: Locale; origin: string | null }) {
  const tr = t.site.trust;
  const domain = (s: string) => fmt(s, { domain: SITE_DOMAIN });
  const reviewed = new Intl.DateTimeFormat(DATE_LOCALE[locale], { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${TRUST_LAST_REVIEWED}T00:00:00Z`));
  const scopes = YOUTUBE_OAUTH_SCOPES.map((url) => {
    const id = shortScope(url);
    return { id, url, words: tr.youtube.scopes.find((s) => s.id === id) };
  });
  const googleLink = (
    <a href={GOOGLE_PERMISSIONS_URL} className="tr-link" target="_blank" rel="noopener noreferrer">
      {shownAddress(GOOGLE_PERMISSIONS_URL)}
      <ArrowUpRight aria-hidden />
    </a>
  );

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(trustJsonLd({ t, locale, origin })) }} />

      <section aria-labelledby="trust-title" className="tr-hero">
        <div className="nx-wrap">
          <h1 id="trust-title" className="st-h1-page">
            {tr.title}
          </h1>
          <p className="tr-lead">{tr.lead}</p>
          <p className="tr-reviewed">{withNode(tr.reviewed, "date", <time dateTime={TRUST_LAST_REVIEWED}>{reviewed}</time>)}</p>
          <nav aria-label={tr.toc} className="tr-toc">
            <ul>
              {TRUST_SECTIONS.map((id) => (
                <li key={id}>
                  <a href={`#${id}`}>{tr.nav[id]}</a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>

      <div className="tr-body">
        <div className="nx-wrap tr-col">
          <section id="youtube" aria-labelledby="youtube-title" className="tr-sec">
            <h2 id="youtube-title" className="tr-h2">
              {tr.youtube.title}
            </h2>
            <p className="tr-p">{tr.youtube.lead}</p>
            <ul className="tr-scopes" aria-label={tr.youtube.caption}>
              {scopes.map((s) => (
                <li key={s.id} className="tr-scope" data-scope={s.url}>
                  <p className="tr-scope-id">
                    <code>{s.id}</code>
                  </p>
                  <dl>
                    <div>
                      <dt>{tr.youtube.cols.google}</dt>
                      <dd>“{s.words?.google}”</dd>
                    </div>
                    <div>
                      <dt>{tr.youtube.cols.why}</dt>
                      <dd>{s.words?.why}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
            <div className="tr-callout" data-tone="private">
              <h3 className="tr-h3">{tr.youtube.privateTitle}</h3>
              <p className="tr-p">{tr.youtube.privateBody}</p>
            </div>
            <h3 className="tr-h3">{tr.youtube.revokeTitle}</h3>
            <ol className="tr-steps">
              {tr.youtube.revoke.map((step, i) => (
                <li key={i}>{withNode(step, "link", googleLink)}</li>
              ))}
            </ol>
            <p className="tr-p">{tr.youtube.revokeBoth}</p>
          </section>

          <section id="keys" aria-labelledby="keys-title" className="tr-sec">
            <h2 id="keys-title" className="tr-h2">
              {tr.keys.title}
            </h2>
            <p className="tr-p">{tr.keys.lead}</p>
            <ul className="tr-cards">
              {tr.keys.items.map((item) => (
                <li key={item.id} className="tr-card" data-id={item.id}>
                  <h3 className="tr-h3">{item.title}</h3>
                  <p className="tr-p">{domain(item.body)}</p>
                </li>
              ))}
            </ul>
          </section>

          <section id="publishing" aria-labelledby="publishing-title" className="tr-sec">
            <h2 id="publishing-title" className="tr-h2">
              {tr.publishing.title}
            </h2>
            <p className="tr-p">{tr.publishing.lead}</p>
            <ol className="tr-steps">
              {tr.publishing.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ol>
          </section>

          <section id="ai-label" aria-labelledby="ai-label-title" className="tr-sec">
            <h2 id="ai-label-title" className="tr-h2">
              {tr.aiLabel.title}
            </h2>
            {tr.aiLabel.body.map((p, i) => (
              <p key={i} className="tr-p">
                {p}
              </p>
            ))}
          </section>

          <section id="no-fallback" aria-labelledby="no-fallback-title" className="tr-sec">
            <h2 id="no-fallback-title" className="tr-h2">
              {tr.fallback.title}
            </h2>
            <p className="tr-p">{tr.fallback.body}</p>
          </section>

          <section id="payments" aria-labelledby="payments-title" className="tr-sec">
            <h2 id="payments-title" className="tr-h2">
              {tr.payments.title}
            </h2>
            {tr.payments.body.map((p, i) => (
              <p key={i} className="tr-p">
                {p}
              </p>
            ))}
            <p className="tr-p">
              <Link href={REFUND_PATH} className="tr-link">
                {tr.payments.link}
                <ArrowRight aria-hidden />
              </Link>
            </p>
          </section>

          <section id="report" aria-labelledby="report-title" className="tr-sec">
            <h2 id="report-title" className="tr-h2">
              {tr.report.title}
            </h2>
            {tr.report.body.map((p, i) => (
              <p key={i} className="tr-p">
                {p}
              </p>
            ))}
            {LEGAL.contactEmail ? (
              <p className="tr-p tr-contact">
                {tr.report.write}{" "}
                <a href={`mailto:${LEGAL.contactEmail}`} className="tr-link">
                  {LEGAL.contactEmail}
                </a>
              </p>
            ) : (
              <p className="tr-p tr-contact">
                {tr.report.noEmail}{" "}
                <Link href={CONTACT_HREF} className="tr-link">
                  {tr.report.noEmailLink}
                </Link>
              </p>
            )}
          </section>

          <section id="real" aria-labelledby="real-title" className="tr-sec">
            <h2 id="real-title" className="tr-h2">
              {tr.real.title}
            </h2>
            <ul className="tr-bullets">
              {tr.real.items.map((item, i) => (
                <li key={i}>{domain(item)}</li>
              ))}
            </ul>
            <h3 className="tr-h3">{tr.real.accounts}</h3>
            <ul className="tr-accounts">
              {SOCIAL.map((s) => (
                <li key={s.id}>
                  <a href={s.href} className="tr-link" target="_blank" rel="noopener noreferrer">
                    <span>{t.site.footer[s.label]}</span> <span className="tr-account-addr">{shownAddress(s.href)}</span>
                    <ArrowUpRight aria-hidden />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
