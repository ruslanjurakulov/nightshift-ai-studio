"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { Chip } from "@/components/ui/Chip";
import { newBatchKey } from "@/components/ads/api";
import { brandScanStrings, type AdsBrandScanDictionary } from "@/lib/i18n/ads-brand-scan";
import type { BrandKit } from "@/lib/adsFactory/model";
import {
  SCAN_FAILURES,
  coveredBy,
  offeredFields,
  parseScanHost,
  parseScanUrl,
  scanUrlHost,
  type BrandDomain,
  type BrandScan,
  type ScanError,
  type ScanQuote,
  type ScanSource,
} from "@/lib/adsFactory/scan";

/**
 * "Scan my site" (docs/ADS_FACTORY.md, Phase 2; migration 0133). Drawn only with NIGHTSHIFT_ADS_BRAND_SCAN on (the page decides, on the
 * server). Three steps: prove the domain with a DNS TXT record, start one priced scan, review what was found next to the kit and
 * accept it field by field.
 *
 * What a button here does: it writes a row through /api/ads/scan/* and stops (CLAUDE.md rule 3); the worker does the DNS check and the
 * scan. Nothing here opens the scanned site: every value it read is shown as TEXT (React escapes it), a source address is text and
 * never a link, a colour reaches a style attribute only as a checked #rrggbb, and a picture is the organization's own library asset.
 * The price shown is the one the database quoted, and the scan is started with that price as its ceiling: a different price is
 * refused by the database and said in words, never charged.
 */

type Payload = {
  org: string;
  quote: ScanQuote | null;
  domains: BrandDomain[];
  scans: BrandScan[];
  pictures: Record<string, { thumbUrl: string | null; name: string | null }>;
};
type Failure = { error: ScanError; max?: number; retry_after?: number; price?: number; hold?: number };
type Result<T> = { ok: true; data: T } | ({ ok: false } & Failure);

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !json) {
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      return { ok: false, error: typeof json?.error === "string" ? (json.error as ScanError) : "failed", max: num(json?.max), retry_after: num(json?.retry_after), price: num(json?.price), hold: num(json?.hold) };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/** A refusal in the reader's language; a number only when the database gave one (rule 5). */
export function scanErrorText(t: AdsBrandScanDictionary, f: Failure): string {
  if (f.error === "limit_reached" && typeof f.max === "number") return fmt(t.errors.limit_reached_max, { max: f.max });
  if (f.error === "too_soon" && typeof f.retry_after === "number") return fmt(t.errors.too_soon_after, { seconds: f.retry_after });
  if (f.error === "price_changed" && typeof f.price === "number") return fmt(t.errors.price_changed_to, { credits: f.price });
  if (f.error === "scan_hold_unavailable" && typeof f.hold === "number" && typeof f.price === "number")
    return fmt(t.errors.scan_hold_unavailable_for, { hold: f.hold, credits: f.price });
  return (t.errors as Record<string, string>)[f.error] ?? t.errors.failed;
}

export function failureText(t: AdsBrandScanDictionary, code: string | null): string {
  return code && (SCAN_FAILURES as readonly string[]).includes(code) ? (t.failures as Record<string, string>)[code] : t.failures.other;
}

function noteText(t: AdsBrandScanDictionary, code: string): string {
  if (code.endsWith("_svg")) return t.review.notes.svg;
  if (code.endsWith("_off_site")) return t.review.notes.off_site;
  if (code.endsWith("_robots")) return t.review.notes.robots;
  return t.review.notes.other;
}

const POLL_MS = 4000;
const POLL_FOR_MS = 3 * 60 * 1000;

export function BrandScanPanel({ orgId, canEdit, kits, onAccepted }: { orgId: string; canEdit: boolean; kits: BrandKit[]; onAccepted: () => void }) {
  const { locale } = useI18n();
  const t = brandScanStrings(locale);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [load, setLoad] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [polling, setPolling] = useState(false);
  const pollUntil = useRef(0);
  const panelId = useId();

  const refresh = useCallback(async () => {
    setLoad((l) => (l === "idle" ? "loading" : l));
    const out = await call<Payload>("GET", `/api/ads/scan?org=${encodeURIComponent(orgId)}`);
    if (out.ok) {
      setData(out.data);
      setLoad("ready");
      return out.data;
    }
    setLoad("failed");
    return null;
  }, [orgId]);

  useEffect(() => {
    if (open && load === "idle") void refresh();
  }, [open, load, refresh]);

  // While a check or a scan waits on the worker, read again every few seconds, for a few minutes at most.
  const waiting = Boolean(data && (data.domains.some((d) => d.pending) || data.scans[0]?.status === "requested" || data.scans[0]?.status === "running"));
  useEffect(() => {
    if (!open || !waiting) {
      setPolling(false);
      return;
    }
    if (pollUntil.current < Date.now()) pollUntil.current = Date.now() + POLL_FOR_MS;
    setPolling(true);
    const id = window.setInterval(() => {
      if (Date.now() > pollUntil.current) {
        window.clearInterval(id);
        setPolling(false);
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [open, waiting, refresh]);

  const startPolling = () => {
    pollUntil.current = Date.now() + POLL_FOR_MS;
  };

  return (
    <div className="ads-scan">
      <button type="button" className="btn-quiet min-h-11 px-4 text-sm" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        {open ? t.close : t.open}
      </button>
      {open && (
        <section id={panelId} className="ads-card ads-scan-panel" aria-label={t.heading}>
          <h3 className="ads-h3">{t.heading}</h3>
          <p className="ads-small">{t.intro}</p>
          {!canEdit && <p className="ads-note">{t.readOnly}</p>}
          <p className="ads-sr" role="status" aria-live="polite">
            {load === "loading" || polling ? t.updating : ""}
          </p>
          {load === "failed" && (
            <div className="ads-row" role="alert">
              <p className="ads-fail">{t.loadFailed}</p>
              <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => void refresh()}>
                {t.retry}
              </button>
            </div>
          )}
          {data && (
            <ScanSteps
              t={t}
              orgId={orgId}
              canEdit={canEdit}
              kits={kits}
              data={data}
              refresh={async () => {
                startPolling();
                await refresh();
              }}
              onAccepted={() => {
                onAccepted();
                void refresh();
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}

function ScanSteps({
  t,
  orgId,
  canEdit,
  kits,
  data,
  refresh,
  onAccepted,
}: {
  t: AdsBrandScanDictionary;
  orgId: string;
  canEdit: boolean;
  kits: BrandKit[];
  data: Payload;
  refresh: () => Promise<void>;
  onAccepted: () => void;
}) {
  const verified = data.domains.filter((d) => d.verifiedAt);
  const unverified = data.domains.filter((d) => !d.verifiedAt);
  const latest = data.scans[0] ?? null;
  return (
    <div className="ads-form">
      <DomainStep t={t} orgId={orgId} canEdit={canEdit} verified={verified} unverified={unverified} refresh={refresh} />
      {verified.length > 0 && <ScanStep t={t} orgId={orgId} canEdit={canEdit} verified={verified} quote={data.quote} latest={latest} refresh={refresh} />}
      {latest?.status === "ready" && <ReviewStep t={t} canEdit={canEdit} kits={kits} scan={latest} pictures={data.pictures} onAccepted={onAccepted} />}
    </div>
  );
}

function DomainStep({
  t,
  orgId,
  canEdit,
  verified,
  unverified,
  refresh,
}: {
  t: AdsBrandScanDictionary;
  orgId: string;
  canEdit: boolean;
  verified: BrandDomain[];
  unverified: BrandDomain[];
  refresh: () => Promise<void>;
}) {
  const td = t.domain;
  const inputId = useId();
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(verified.length === 0 && unverified.length === 0);

  async function ask() {
    if (busy) return;
    const parsed = parseScanHost(host);
    if (!parsed.ok) {
      setError(scanErrorText(t, { error: parsed.error }));
      return;
    }
    setBusy(true);
    setError(null);
    const out = await call("POST", "/api/ads/scan/domains", { org_id: orgId, host: parsed.host });
    setBusy(false);
    if (!out.ok) return setError(scanErrorText(t, out));
    setHost("");
    setAdding(false);
    await refresh();
  }

  return (
    <div className="ads-fieldset">
      <h4 className="ads-h4">{td.heading}</h4>
      {verified.map((d) => (
        <p key={d.id} className="ads-ok">
          {fmt(td.verified, { host: d.host })}
        </p>
      ))}
      {unverified.map((d) => (
        <PendingDomain key={d.id} t={t} domain={d} canEdit={canEdit} refresh={refresh} />
      ))}
      {canEdit && (adding || (verified.length === 0 && unverified.length === 0)) ? (
        <div className="ads-field">
          <p className="ads-small">{td.hint}</p>
          <label htmlFor={inputId} className="t-label">
            {td.label}
          </label>
          <div className="ads-row">
            <input
              id={inputId}
              className="ns-field"
              value={host}
              maxLength={260}
              autoComplete="off"
              spellCheck={false}
              placeholder={td.placeholder}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void ask();
              }}
            />
            <button type="button" className="btn-primary min-h-11 px-4 text-sm" disabled={busy || !host.trim()} onClick={() => void ask()}>
              {td.submit}
            </button>
          </div>
          {error && (
            <p className="ads-fail" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        canEdit && (
          <button type="button" className="btn-quiet min-h-11 px-3 text-sm ads-self-start" onClick={() => setAdding(true)}>
            {td.another}
          </button>
        )
      )}
    </div>
  );
}

function Copyable({ label, value, t }: { label: string; value: string; t: AdsBrandScanDictionary }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ads-dl">
      <dt>{label}</dt>
      <dd className="ads-row">
        <code className="ads-code">{value}</code>
        <button
          type="button"
          className="btn-quiet min-h-11 px-3 text-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? t.domain.copied : t.domain.copy}
        </button>
      </dd>
    </div>
  );
}

function PendingDomain({ t, domain, canEdit, refresh }: { t: AdsBrandScanDictionary; domain: BrandDomain; canEdit: boolean; refresh: () => Promise<void> }) {
  const td = t.domain;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function check() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const out = await call("POST", `/api/ads/scan/domains/${domain.id}/check`);
    setBusy(false);
    if (!out.ok) return setError(scanErrorText(t, out));
    await refresh();
  }
  const last = domain.lastCheckCode ? (td.results as Record<string, string>)[domain.lastCheckCode] ?? td.results.other : null;
  return (
    <div className="ads-concept">
      <p className="ads-h4">{domain.host}</p>
      <p className="ads-small">{td.addRecord}</p>
      <dl className="ads-dl">
        <p className="ads-small">{td.recordType}</p>
        <Copyable label={td.recordName} value={domain.recordName} t={t} />
        <Copyable label={td.recordValue} value={domain.recordValue} t={t} />
      </dl>
      {domain.pending ? (
        <p className="ads-small" role="status">
          {td.checking}
        </p>
      ) : (
        last && <p className={domain.lastCheckCode === "verified" ? "ads-ok" : "ads-small"}>{fmt(td.lastCheck, { result: last })}</p>
      )}
      <p className="ads-small">{td.cacheNote}</p>
      {canEdit && (
        <button type="button" className="btn-primary min-h-11 px-4 text-sm ads-self-start" disabled={busy || domain.pending} onClick={() => void check()}>
          {td.check}
        </button>
      )}
      {error && (
        <p className="ads-fail" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ScanStep({
  t,
  orgId,
  canEdit,
  verified,
  quote,
  latest,
  refresh,
}: {
  t: AdsBrandScanDictionary;
  orgId: string;
  canEdit: boolean;
  verified: BrandDomain[];
  quote: ScanQuote | null;
  latest: BrandScan | null;
  refresh: () => Promise<void>;
}) {
  const ts = t.scan;
  const urlId = useId();
  const [url, setUrl] = useState(`https://${verified[0].host}/`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per press: a retry of the SAME press after a lost answer reuses it, so the database answers the first scan, never a second hold.
  const press = useRef<string | null>(null);
  const running = latest?.status === "requested" || latest?.status === "running";

  async function start() {
    if (busy || !quote?.onSale || quote.credits === null) return;
    const clean = parseScanUrl(url);
    const host = clean ? scanUrlHost(clean) : null;
    if (!clean || !host || !verified.some((d) => coveredBy(host, d.host))) {
      setError(scanErrorText(t, { error: clean ? "domain_not_verified" : "invalid_url" }));
      return;
    }
    setBusy(true);
    setError(null);
    press.current ??= newBatchKey();
    const out = await call<{ id: string }>("POST", "/api/ads/scan", { org_id: orgId, url: clean, idem: press.current, max_credits: quote.credits });
    setBusy(false);
    if (out.ok || out.error !== "failed") press.current = null;
    if (!out.ok) {
      setError(scanErrorText(t, out));
      if (out.error === "price_changed") await refresh();
      return;
    }
    await refresh();
  }

  const priceLine = !quote
    ? null
    : !quote.onSale
      ? ts.notOnSale
      : quote.exempt || quote.credits === 0
        ? ts.free
        : quote.hold !== null && quote.credits !== null && quote.hold > quote.credits
          ? fmt(ts.priceHeld, { hold: quote.hold, credits: quote.credits })
          : fmt(ts.price, { credits: quote.credits ?? "" });

  return (
    <div className="ads-fieldset">
      <h4 className="ads-h4">{ts.heading}</h4>
      {priceLine && <p className={quote?.onSale ? "ads-small" : "ads-note"}>{priceLine}</p>}
      {running && (
        <p className="ads-small" role="status">
          {latest?.status === "running" ? ts.running : ts.queued}
        </p>
      )}
      {latest?.status === "failed" && (
        <p className="ads-fail" role="alert">
          {fmt(ts.failed, { reason: failureText(t, latest.errorCode) })}
        </p>
      )}
      {latest?.status === "ready" && typeof latest.charged === "number" && latest.charged > 0 && (
        <p className="ads-small">{fmt(ts.charged, { credits: latest.charged })}</p>
      )}
      {canEdit && quote?.onSale && !running && (
        <div className="ads-field">
          <label htmlFor={urlId} className="t-label">
            {ts.urlLabel}
          </label>
          <p className="ads-small">{ts.urlHint}</p>
          <div className="ads-row">
            <input id={urlId} className="ns-field" value={url} maxLength={300} autoComplete="off" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
            <button type="button" className="btn-primary min-h-11 px-4 text-sm" disabled={busy} onClick={() => void start()}>
              {quote.exempt || quote.credits === 0 ? ts.startFree : fmt(ts.start, { credits: quote.credits ?? "" })}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="ads-fail" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Source({ t, source }: { t: AdsBrandScanDictionary; source: ScanSource }) {
  // The address as text: not a link, nothing here opens the scanned site.
  return (
    <span className="ads-small">
      {(t.review.places as Record<string, string>)[source.where] ?? source.where} · <span className="ads-text ads-url">{source.url}</span>
    </span>
  );
}

function Swatches({ colours }: { colours: string[] }) {
  return (
    <ul className="ads-swatches">
      {colours
        .filter((c) => /^#[0-9a-f]{6}$/.test(c))
        .map((c) => (
          <li key={c} className="ads-swatch">
            <span aria-hidden style={{ background: c }} />
            <span>{c}</span>
          </li>
        ))}
    </ul>
  );
}

function Picture({ id, pictures, missing }: { id: string; pictures: Payload["pictures"]; missing: string }) {
  const p = pictures[id];
  if (p?.thumbUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="ads-thumb ads-thumb-sm" src={p.thumbUrl} alt={p.name ?? ""} loading="lazy" />;
  }
  return (
    <span className="ads-thumb ads-thumb-sm" title={missing}>
      <ImageOff aria-hidden className="size-4" />
    </span>
  );
}

type Row = { key: string; label: string; proposed: React.ReactNode; current: React.ReactNode; source: ScanSource | null };

function ReviewStep({
  t,
  canEdit,
  kits,
  scan,
  pictures,
  onAccepted,
}: {
  t: AdsBrandScanDictionary;
  canEdit: boolean;
  kits: BrandKit[];
  scan: BrandScan;
  pictures: Payload["pictures"];
  onAccepted: () => void;
}) {
  const tr = t.review;
  const targetId = useId();
  const [kitId, setKitId] = useState<string>(scan.kitId && kits.some((k) => k.id === scan.kitId) ? scan.kitId : "");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);
  const kit = kits.find((k) => k.id === kitId) ?? null;
  const offered = offeredFields(scan);
  const none = <span className="ads-small">{tr.none}</span>;
  const f = scan.fields;

  const rows: Row[] = offered.map((key) => {
    if (key.startsWith("product:")) {
      const p = scan.products[Number(key.slice(8))];
      return {
        key,
        label: fmt(tr.fields.product, { title: p.title.value }),
        proposed: (
          <div className="ads-sub-main">
            {p.image && <Picture id={p.image.value} pictures={pictures} missing={tr.savedToLibrary} />}
            <div>
              <p className="ads-text">{p.title.value}</p>
              {p.price && <p className="ads-small">{p.price.value}</p>}
              {p.description && <p className="ads-small">{p.description.value}</p>}
            </div>
          </div>
        ),
        current: none,
        source: p.title.source,
      };
    }
    switch (key) {
      case "name":
        return { key, label: tr.fields.name, proposed: <span className="ads-text">{f.name!.value}</span>, current: kit ? <span className="ads-text">{kit.name}</span> : none, source: f.name!.source };
      case "description":
        return { key, label: tr.fields.description, proposed: <p className="ads-text">{f.description!.value}</p>, current: kit?.voice ? <p className="ads-text">{kit.voice}</p> : none, source: f.description!.source };
      case "site_url":
        return { key, label: tr.fields.site_url, proposed: <span className="ads-text ads-url">{scan.url}</span>, current: kit?.siteUrl ? <span className="ads-text ads-url">{kit.siteUrl}</span> : none, source: null };
      case "logo":
        return {
          key,
          label: tr.fields.logo,
          proposed: (
            <span className="ads-row">
              <Picture id={f.logo!.value} pictures={pictures} missing={tr.savedToLibrary} />
              <span className="ads-small">{tr.savedToLibrary}</span>
            </span>
          ),
          current: kit?.logo?.live && kit.logo.thumbUrl ? <Picture id={kit.logo.assetId} pictures={{ [kit.logo.assetId]: { thumbUrl: kit.logo.thumbUrl, name: kit.logo.name } }} missing="" /> : none,
          source: f.logo!.source,
        };
      case "palette":
        return { key, label: tr.fields.palette, proposed: <Swatches colours={f.palette!.value} />, current: kit?.palette.length ? <Swatches colours={kit.palette} /> : none, source: f.palette!.source };
      case "theme_color":
        return { key, label: tr.fields.theme_color, proposed: <Swatches colours={[f.themeColor!.value]} />, current: kit?.palette.length ? <Swatches colours={kit.palette} /> : none, source: f.themeColor!.source };
      default:
        return {
          key,
          label: tr.fields.fonts,
          proposed: <span className="ads-meta">{f.fonts!.value.map((n) => <Chip key={n} plain>{n}</Chip>)}</span>,
          current: kit?.fonts.length ? <span className="ads-meta">{kit.fonts.map((n) => <Chip key={n} plain>{n}</Chip>)}</span> : none,
          source: f.fonts!.source,
        };
    }
  });

  async function accept() {
    if (busy) return;
    const fields = offered.filter((k) => ticked.has(k));
    if (!fields.length) return setMessage({ tone: "fail", text: tr.nothingTicked });
    if (!kitId && !fields.includes("name")) return setMessage({ tone: "fail", text: tr.nameForNewKit });
    setBusy(true);
    setMessage(null);
    const out = await call<{ kit_id: string }>("POST", `/api/ads/scan/${scan.id}/accept`, { kit_id: kitId || null, fields });
    setBusy(false);
    if (!out.ok) return setMessage({ tone: "fail", text: scanErrorText(t, out) });
    setTicked(new Set());
    setKitId(out.data.kit_id);
    setMessage({ tone: "ok", text: tr.accepted });
    onAccepted();
  }

  return (
    <div className="ads-fieldset">
      <h4 className="ads-h4">{tr.heading}</h4>
      <p className="ads-small">{tr.hint}</p>
      <p className="ads-small">{fmt(tr.pagesRead, { n: scan.pages.length })}</p>
      {canEdit && (
        <div className="ads-field">
          <label htmlFor={targetId} className="t-label">
            {tr.target}
          </label>
          <select id={targetId} className="ns-field" value={kitId} onChange={(e) => setKitId(e.target.value)}>
            <option value="">{tr.newKit}</option>
            {kits.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="ads-scan-table" role="table" aria-label={tr.heading}>
        <div className="ads-scan-tr ads-scan-th" role="row">
          <span role="columnheader">{tr.field}</span>
          <span role="columnheader">{tr.proposed}</span>
          <span role="columnheader">{tr.current}</span>
        </div>
        {rows.map((r) => (
          <div key={r.key} className="ads-scan-tr" role="row">
            <span role="cell" className="ads-check">
              {canEdit && (
                <input
                  type="checkbox"
                  aria-label={`${tr.accept}: ${r.label}`}
                  checked={ticked.has(r.key)}
                  onChange={(e) =>
                    setTicked((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.add(r.key);
                      else next.delete(r.key);
                      return next;
                    })
                  }
                />
              )}
              <span>
                {r.label}
                {scan.accepted.includes(r.key) && <span className="ads-small"> · {tr.alreadyAccepted}</span>}
              </span>
            </span>
            <span role="cell" className="ads-scan-td">
              {r.proposed}
              {r.source && (
                <span className="ads-small">
                  {tr.from}: <Source t={t} source={r.source} />
                </span>
              )}
            </span>
            <span role="cell" className="ads-scan-td">
              {r.current}
            </span>
          </div>
        ))}
      </div>
      {scan.notes.length > 0 && (
        <div>
          <span className="t-label">{tr.skipped}</span>
          <ul className="ads-sub">
            {scan.notes.map((n, i) => (
              <li key={`${n.code}-${i}`} className="ads-small">
                {noteText(t, n.code)}
                {n.url && <span className="ads-text ads-url"> · {n.url}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canEdit && (
        <button type="button" className="btn-primary min-h-11 px-4 text-sm ads-self-start" disabled={busy} onClick={() => void accept()}>
          {busy ? tr.accepting : tr.acceptSelected}
        </button>
      )}
      {message && (
        <p className={message.tone === "ok" ? "ads-ok" : "ads-fail"} role={message.tone === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
