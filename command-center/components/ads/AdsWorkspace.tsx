"use client";

import { useCallback, useId, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { Chip } from "@/components/ui/Chip";
import { CampaignDialog, ConceptDialog, DeleteDialog, KitDialog, ProductDialog } from "@/components/ads/AdsDialogs";
import { adsErrorText, adsRequest, newBatchKey, type AdsPayload } from "@/components/ads/api";
import {
  ADS_LIMITS,
  AD_KINDS,
  type AdCampaign,
  type AdConcept,
  type AdKind,
  type AdStatus,
  type AdsError,
  type AdsPicture,
  type AdsWorkspaceData,
  type BrandKit,
  type BrandProduct,
} from "@/lib/adsFactory/model";

/**
 * The Ads workspace (NIGHTSHIFT_ADS_FACTORY, default off; docs/ADS_FACTORY.md, Phase 1): brand kits with their products, campaigns,
 * and the concept drafts of each campaign.
 *
 * What a button here does: it writes a row through /api/ads/* and stops (CLAUDE.md rule 3). Nothing on this screen reads a web site,
 * makes a picture or a video, prices anything or spends a credit, and "Approve" marks words as final and starts nothing; the screen
 * says so where a person could expect otherwise. Every text shown is drawn as text (React escapes it): nothing a person typed is ever
 * rendered as HTML, and a colour reaches a style attribute only as a checked #rrggbb.
 *
 * States: the first read comes from the server with the page; after a change the workspace is read again (the body dims, "Updating…"
 * is announced); a failed read keeps the last good data on screen and offers Try again; a member who may only read sees every
 * button's reason instead of a dead button; a refusal is said in words next to what was pressed.
 */

type Dialog =
  | { type: "kit"; kit: BrandKit | null }
  | { type: "product"; kitId: string; product: BrandProduct | null }
  | { type: "campaign"; campaign: AdCampaign | null }
  | { type: "concept"; concept: AdConcept }
  | { type: "delete"; title: string; body: string; url: string };

type Notice = { tone: "ok" | "fail"; text: string; at: string } | null;

function Thumb({ picture, missing, small = false }: { picture: AdsPicture | null; missing: string; small?: boolean }) {
  const cls = small ? "ads-thumb ads-thumb-sm" : "ads-thumb";
  if (picture?.live && picture.thumbUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={cls} src={picture.thumbUrl} alt={picture.name ?? ""} loading="lazy" />;
  }
  return (
    <span className={cls} title={picture && !picture.live ? missing : undefined}>
      <ImageOff aria-hidden className="size-4" />
      {picture && !picture.live && <span className="ads-sr">{missing}</span>}
    </span>
  );
}

export function AdsWorkspace({
  orgId,
  canEdit,
  initial,
  libraryHref,
}: {
  orgId: string;
  /** The member's role in this organization allows changes (editor or above). The database decides again on every write. */
  canEdit: boolean;
  initial: AdsWorkspaceData;
  libraryHref: string;
}) {
  const { t } = useI18n();
  const ta = t.adsFactory;
  const [data, setData] = useState<{ kits: BrandKit[]; campaigns: AdCampaign[] }>({ kits: initial.kits, campaigns: initial.campaigns });
  const [load, setLoad] = useState<"ready" | "refreshing" | "failed">(initial.error ? "failed" : "ready");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    setLoad("refreshing");
    const out = await adsRequest<AdsPayload>("GET", `/api/ads?org=${encodeURIComponent(orgId)}`);
    if (out.ok) {
      setData({ kits: out.data.kits ?? [], campaigns: out.data.campaigns ?? [] });
      setLoad("ready");
    } else {
      // The last good data stays on screen; an empty workspace would read as "you have none".
      setLoad("failed");
    }
  }, [orgId]);

  function open(next: Dialog, from: EventTarget | null) {
    opener.current = from instanceof HTMLElement ? from : null;
    setNotice(null);
    setDialog(next);
  }

  function saved() {
    setDialog(null);
    void refresh();
  }

  /** One press of a concept button: move its status. Disabled while it runs, so a second press cannot send it twice. */
  async function setStatus(concept: AdConcept, status: AdStatus) {
    if (pending) return;
    setPending(concept.id);
    setNotice(null);
    const out = await adsRequest("PATCH", `/api/ads/concepts/${concept.id}`, { status });
    setPending(null);
    if (out.ok) {
      setNotice(status === "approved" ? { tone: "ok", text: ta.concepts.approvedNothingStarted, at: concept.campaignId } : null);
      void refresh();
    } else {
      setNotice({ tone: "fail", text: adsErrorText(ta, out), at: concept.campaignId });
    }
  }

  const kitsWithProducts = data.kits.filter((k) => k.products.length > 0);
  const busy = load === "refreshing";

  if (!initial.available) return <p className="ads-note">{ta.notAvailable}</p>;

  return (
    <div className="ads" aria-busy={busy}>
      <p className="ads-note">{ta.firstVersion}</p>
      {!canEdit && <p className="ads-note">{ta.readOnly}</p>}
      <p className="ads-sr" role="status" aria-live="polite">
        {busy ? ta.updating : ""}
      </p>
      {load === "failed" && (
        <div className="ads-row" role="alert">
          <p className="ads-fail">{ta.loadFailed}</p>
          <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => void refresh()}>
            {ta.retry}
          </button>
        </div>
      )}

      <div className="ads-body">
        {/* ── brand kits ── */}
        <section className="ads-section" aria-labelledby="ads-kits-h">
          <div className="ads-head">
            <div className="min-w-0">
              <h2 id="ads-kits-h" className="ads-h2">
                {ta.kits.heading}
              </h2>
              <p className="ads-small">{ta.kits.hint}</p>
            </div>
            {canEdit && (
              <button type="button" className="btn-primary min-h-11 px-4 text-sm" onClick={(e) => open({ type: "kit", kit: null }, e.currentTarget)}>
                {ta.kits.add}
              </button>
            )}
          </div>
          {data.kits.length === 0 ? (
            <p className="ads-note">{ta.kits.empty}</p>
          ) : (
            <ul className="ads-list">
              {data.kits.map((kit) => (
                <KitCard key={kit.id} kit={kit} canEdit={canEdit} open={open} />
              ))}
            </ul>
          )}
        </section>

        {/* ── campaigns ── */}
        <section className="ads-section" aria-labelledby="ads-campaigns-h">
          <div className="ads-head">
            <div className="min-w-0">
              <h2 id="ads-campaigns-h" className="ads-h2">
                {ta.campaigns.heading}
              </h2>
              <p className="ads-small">{ta.campaigns.hint}</p>
            </div>
            {canEdit && kitsWithProducts.length > 0 && (
              <button type="button" className="btn-primary min-h-11 px-4 text-sm" onClick={(e) => open({ type: "campaign", campaign: null }, e.currentTarget)}>
                {ta.campaigns.add}
              </button>
            )}
          </div>
          {/* Why there is no "New campaign" button yet, said instead of a disabled button with no reason. */}
          {kitsWithProducts.length === 0 && <p className="ads-note">{ta.campaigns.needKit}</p>}
          {data.campaigns.length === 0 ? (
            kitsWithProducts.length > 0 && <p className="ads-note">{ta.campaigns.empty}</p>
          ) : (
            <ul className="ads-list">
              {data.campaigns.map((campaign) => (
                <CampaignCard
                  key={campaign.id}
                  campaign={campaign}
                  kits={data.kits}
                  canEdit={canEdit}
                  pending={pending}
                  notice={notice?.at === campaign.id ? notice : null}
                  open={open}
                  setStatus={setStatus}
                  onAdded={(text) => {
                    setNotice({ tone: "ok", text, at: campaign.id });
                    void refresh();
                  }}
                  onFailed={(failure) => setNotice({ tone: "fail", text: adsErrorText(ta, failure), at: campaign.id })}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {dialog?.type === "kit" && (
        <KitDialog orgId={orgId} kit={dialog.kit} libraryHref={libraryHref} opener={opener} onClose={() => setDialog(null)} onSaved={saved} />
      )}
      {dialog?.type === "product" && (
        <ProductDialog orgId={orgId} kitId={dialog.kitId} product={dialog.product} libraryHref={libraryHref} opener={opener} onClose={() => setDialog(null)} onSaved={saved} />
      )}
      {dialog?.type === "campaign" && (
        <CampaignDialog
          // An existing campaign is edited against its own kit even when that kit has since lost its last product.
          kits={dialog.campaign ? data.kits.filter((k) => k.id === dialog.campaign?.kitId) : kitsWithProducts}
          campaign={dialog.campaign}
          opener={opener}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
      {dialog?.type === "concept" && <ConceptDialog concept={dialog.concept} opener={opener} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.type === "delete" && <DeleteDialog title={dialog.title} body={dialog.body} url={dialog.url} opener={opener} onClose={() => setDialog(null)} onDone={saved} />}
    </div>
  );
}

type Open = (next: Dialog, from: EventTarget | null) => void;

function KitCard({ kit, canEdit, open }: { kit: BrandKit; canEdit: boolean; open: Open }) {
  const { t } = useI18n();
  const ta = t.adsFactory;
  const tk = ta.kits;
  const tp = ta.products;
  const headingId = useId();
  return (
    <li>
      <article className="ads-card" aria-labelledby={headingId}>
        <div className="ads-card-head">
          <div className="ads-ident">
            <Thumb picture={kit.logo} missing={tk.logoMissing} />
            <div className="min-w-0">
              <h3 id={headingId} className="ads-h3">
                {kit.name}
              </h3>
              <p className="ads-small">{kit.source === "scan" ? tk.scanned : tk.manual}</p>
            </div>
          </div>
          {canEdit && (
            <div className="ads-actions">
              <button type="button" className="btn-quiet px-3 text-sm" onClick={(e) => open({ type: "kit", kit }, e.currentTarget)}>
                {ta.edit}
              </button>
              <button
                type="button"
                className="btn-quiet btn-danger-quiet px-3 text-sm"
                onClick={(e) =>
                  open({ type: "delete", title: tk.deleteTitle, body: fmt(tk.deleteBody, { name: kit.name, n: kit.products.length }), url: `/api/ads/kits/${kit.id}` }, e.currentTarget)
                }
              >
                {ta.delete}
              </button>
            </div>
          )}
        </div>

        {/* The address is shown as the text it is. It is not a link: nothing here opens it, and this version reads no site. */}
        {kit.siteUrl && (
          <p className="ads-small">
            {tk.siteShown} <span className="ads-text">{kit.siteUrl}</span>
          </p>
        )}
        <div className="ads-meta">
          <span className="t-label">{tk.palette}</span>
          {kit.palette.length === 0 ? (
            <span className="ads-small">{tk.noColours}</span>
          ) : (
            <ul className="ads-swatches">
              {kit.palette.map((colour) => (
                <li key={colour} className="ads-swatch">
                  <span aria-hidden style={{ background: colour }} />
                  <span>{colour}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="ads-meta">
          <span className="t-label">{tk.fonts}</span>
          {kit.fonts.length === 0 ? <span className="ads-small">{tk.noFonts}</span> : kit.fonts.map((f) => <Chip key={f} plain>{f}</Chip>)}
        </div>
        {kit.voice && (
          <div>
            <span className="t-label">{tk.voice}</span>
            <p className="ads-text">{kit.voice}</p>
          </div>
        )}

        <div className="ads-head">
          <h4 className="ads-h4">
            {tp.heading} <span className="ads-small">{fmt(tp.count, { n: kit.products.length })}</span>
          </h4>
          {canEdit && (
            <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={(e) => open({ type: "product", kitId: kit.id, product: null }, e.currentTarget)}>
              {tp.add}
            </button>
          )}
        </div>
        {kit.products.length === 0 ? (
          <p className="ads-small">{tp.empty}</p>
        ) : (
          <ul className="ads-sub">
            {kit.products.map((product) => (
              <li key={product.id}>
                <div className="ads-sub-main">
                  <Thumb picture={product.images[0] ?? null} missing={tp.imageMissing} small />
                  <div>
                    <p className="ads-h4">{product.title}</p>
                    {product.price && <p className="ads-small">{product.price}</p>}
                    {product.images.some((i) => !i.live) && <p className="ads-fail">{tp.imageMissing}</p>}
                  </div>
                </div>
                {canEdit && (
                  <div className="ads-actions">
                    <button type="button" className="btn-quiet px-3 text-sm" onClick={(e) => open({ type: "product", kitId: kit.id, product }, e.currentTarget)}>
                      {ta.edit}
                    </button>
                    <button
                      type="button"
                      className="btn-quiet btn-danger-quiet px-3 text-sm"
                      onClick={(e) => open({ type: "delete", title: tp.deleteTitle, body: fmt(tp.deleteBody, { name: product.title }), url: `/api/ads/products/${product.id}` }, e.currentTarget)}
                    >
                      {ta.delete}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </article>
    </li>
  );
}

function CampaignCard({
  campaign,
  kits,
  canEdit,
  pending,
  notice,
  open,
  setStatus,
  onAdded,
  onFailed,
}: {
  campaign: AdCampaign;
  kits: BrandKit[];
  canEdit: boolean;
  pending: string | null;
  notice: Notice;
  open: Open;
  setStatus: (concept: AdConcept, status: AdStatus) => void;
  onAdded: (text: string) => void;
  onFailed: (failure: { error: AdsError; max?: number }) => void;
}) {
  const { t } = useI18n();
  const ta = t.adsFactory;
  const tc = ta.campaigns;
  const tx = ta.concepts;
  const headingId = useId();
  const kindId = useId();
  const countId = useId();
  const kit = kits.find((k) => k.id === campaign.kitId) ?? null;
  const productName = (id: string | null) => (id ? (kit?.products.find((p) => p.id === id)?.title ?? tc.productGone) : null);
  const [kind, setKind] = useState<AdKind>("image");
  const [count, setCount] = useState(Math.min(4, ADS_LIMITS.conceptsPerAdd));
  const [adding, setAdding] = useState(false);
  // One id per press. A retry after a failure reuses it, so a press that DID reach the database is answered, never doubled.
  const batch = useRef<string | null>(null);

  async function addDrafts() {
    if (adding) return;
    setAdding(true);
    batch.current ??= newBatchKey();
    const out = await adsRequest<{ ids: string[]; replayed: boolean }>("POST", `/api/ads/campaigns/${campaign.id}/concepts`, { kind, count, batch: batch.current });
    setAdding(false);
    if (out.ok) {
      batch.current = null;
      onAdded(out.data.replayed ? tx.replayed : fmt(tx.added, { n: out.data.ids.length }));
    } else {
      // A refusal the database gave (a cap, a bad choice) is final for this press: the next press is a new one.
      if (out.error !== "failed") batch.current = null;
      onFailed(out);
    }
  }

  return (
    <li>
      <article className="ads-card" aria-labelledby={headingId}>
        <div className="ads-card-head">
          <div className="min-w-0">
            <h3 id={headingId} className="ads-h3">
              {campaign.name}
            </h3>
            <p className="ads-small">{fmt(tc.forKit, { name: kit?.name ?? tc.kitMissing })}</p>
          </div>
          {canEdit && (
            <div className="ads-actions">
              <button type="button" className="btn-quiet px-3 text-sm" onClick={(e) => open({ type: "campaign", campaign }, e.currentTarget)}>
                {ta.edit}
              </button>
              <button
                type="button"
                className="btn-quiet btn-danger-quiet px-3 text-sm"
                onClick={(e) =>
                  open({ type: "delete", title: tc.deleteTitle, body: fmt(tc.deleteBody, { name: campaign.name, n: campaign.concepts.length }), url: `/api/ads/campaigns/${campaign.id}` }, e.currentTarget)
                }
              >
                {ta.delete}
              </button>
            </div>
          )}
        </div>
        <div className="ads-meta">
          <Chip plain>{ta.objective[campaign.objective]}</Chip>
          <Chip plain>{ta.language[campaign.language]}</Chip>
          {campaign.formats.map((f) => <Chip key={f} plain>{ta.format[f]}</Chip>)}
          {campaign.directions.map((d) => <Chip key={d} plain>{ta.direction[d]}</Chip>)}
        </div>
        <p className="ads-small">
          {tc.products}: {campaign.productIds.map((id) => productName(id)).join(", ") || ta.none}
        </p>

        <div className="ads-head">
          <h4 className="ads-h4">
            {tx.heading} <span className="ads-small">{fmt(tc.conceptCount, { n: campaign.concepts.length })}</span>
          </h4>
        </div>
        <p className="ads-small">{tx.templateNote}</p>
        {notice && (
          <p className={notice.tone === "ok" ? "ads-ok" : "ads-fail"} role={notice.tone === "ok" ? "status" : "alert"}>
            {notice.text}
          </p>
        )}
        {campaign.concepts.length === 0 ? (
          <p className="ads-small">{tx.empty}</p>
        ) : (
          <ul className="ads-concepts">
            {campaign.concepts.map((concept) => (
              <ConceptCard key={concept.id} concept={concept} product={productName(concept.productId)} canEdit={canEdit} pending={pending} open={open} setStatus={setStatus} />
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="ads-add" role="group" aria-label={tx.addHeading}>
            <div className="ads-field">
              <label htmlFor={kindId} className="t-label">
                {tx.kindLabel}
              </label>
              <select id={kindId} className="ns-field" value={kind} onChange={(e) => setKind(e.target.value as AdKind)}>
                {AD_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ta.kind[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="ads-field">
              <label htmlFor={countId} className="t-label">
                {tx.countLabel}
              </label>
              <select id={countId} className="ns-field" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {Array.from({ length: ADS_LIMITS.conceptsPerAdd }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="btn-primary min-h-11 px-4 text-sm disabled:opacity-50" disabled={adding} onClick={() => void addDrafts()}>
              {adding ? tx.adding : tx.add}
            </button>
          </div>
        )}
      </article>
    </li>
  );
}

function ConceptCard({
  concept,
  product,
  canEdit,
  pending,
  open,
  setStatus,
}: {
  concept: AdConcept;
  product: string | null;
  canEdit: boolean;
  pending: string | null;
  open: Open;
  setStatus: (concept: AdConcept, status: AdStatus) => void;
}) {
  const { t } = useI18n();
  const ta = t.adsFactory;
  const tx = ta.concepts;
  const headingId = useId();
  const busy = pending !== null;
  return (
    <li>
      <article className="ads-concept" data-status={concept.status} aria-labelledby={headingId}>
        <div className="ads-meta">
          <Chip plain tone={concept.status === "approved" ? "lit" : concept.status === "archived" ? "warn" : undefined}>
            {ta.status[concept.status]}
          </Chip>
          <Chip plain>{ta.kind[concept.kind]}</Chip>
          <Chip plain>{ta.format[concept.format]}</Chip>
          <Chip plain>{ta.direction[concept.direction]}</Chip>
        </div>
        <h5 id={headingId} className="ads-h4">
          {concept.headline}
        </h5>
        <p className="ads-small">{product ? fmt(tx.product, { name: product }) : tx.noProduct}</p>
        <dl className="ads-dl">
          {concept.body && (
            <div>
              <dt>{tx.body}</dt>
              <dd className="ads-text">{concept.body}</dd>
            </div>
          )}
          {concept.cta && (
            <div>
              <dt>{tx.cta}</dt>
              <dd className="ads-text">{concept.cta}</dd>
            </div>
          )}
          {concept.visualBrief && (
            <div>
              <dt>{tx.brief}</dt>
              <dd className="ads-text">{concept.visualBrief}</dd>
            </div>
          )}
          {concept.storyboard && concept.storyboard.length > 0 && (
            <div>
              <dt>{tx.storyboard}</dt>
              <dd>
                <ol className="ads-beats">
                  {concept.storyboard.map((beat, i) => (
                    <li key={i}>
                      {beat.visual}
                      {beat.line && (
                        <>
                          {" "}
                          <em>{beat.line}</em>
                        </>
                      )}
                    </li>
                  ))}
                </ol>
              </dd>
            </div>
          )}
        </dl>
        {canEdit && (
          <>
            <div className="ads-actions">
              {concept.status === "draft" && (
                <>
                  <button type="button" className="btn-quiet px-3 text-sm" disabled={busy} onClick={(e) => open({ type: "concept", concept }, e.currentTarget)}>
                    {ta.edit}
                  </button>
                  <button type="button" className="btn-primary px-3 text-sm disabled:opacity-50" disabled={busy} onClick={() => setStatus(concept, "approved")}>
                    {tx.approve}
                  </button>
                  <button type="button" className="btn-quiet px-3 text-sm" disabled={busy} onClick={() => setStatus(concept, "archived")}>
                    {tx.archive}
                  </button>
                </>
              )}
              {concept.status === "approved" && (
                <>
                  <button type="button" className="btn-quiet px-3 text-sm" disabled={busy} onClick={() => setStatus(concept, "draft")}>
                    {tx.toDraft}
                  </button>
                  <button type="button" className="btn-quiet px-3 text-sm" disabled={busy} onClick={() => setStatus(concept, "archived")}>
                    {tx.archive}
                  </button>
                </>
              )}
              {concept.status === "archived" && (
                <button type="button" className="btn-quiet px-3 text-sm" disabled={busy} onClick={() => setStatus(concept, "draft")}>
                  {tx.restore}
                </button>
              )}
              <button
                type="button"
                className="btn-quiet btn-danger-quiet px-3 text-sm"
                disabled={busy}
                onClick={(e) => open({ type: "delete", title: tx.deleteTitle, body: fmt(tx.deleteBody, { name: concept.headline }), url: `/api/ads/concepts/${concept.id}` }, e.currentTarget)}
              >
                {ta.delete}
              </button>
            </div>
            {concept.status === "draft" && <p className="ads-small">{tx.approveNote}</p>}
            {concept.status !== "draft" && <p className="ads-small">{tx.onlyDraftEdits}</p>}
          </>
        )}
      </article>
    </li>
  );
}
