import Link from "next/link";
import type { Dictionary, Locale } from "@/lib/i18n";
import { UNIT_JOB_MINIMUM, UNIT_VIDEO_MINUTE } from "@/lib/credits";
import { rateText } from "@/lib/models-discovery";
import type { PlanFinderData, StudioRow } from "@/lib/plan-finder";
import { settingName, stampText } from "@/components/pricing/plan-finder-text";

const KIND_ORDER: Record<StudioRow["kind"], number> = { image: 0, video: 1, other: 2 };

/**
 * "What each item costs": credits per unit, as charged, for the YouTube autopilot (the per-minute rate and the smallest
 * hold, public since 0089) and, for a signed-in member, every setting of every Studio model the database would sell them
 * (sellable_models, priced from credit_rates — the rows lib/plan-finder.ts studioRows builds). A model listed but not on
 * sale says so; a setting with no price reads "price unavailable"; a visitor is told the per-model list needs a sign-in.
 * The rates are printed as the list holds them: a sub-credit rate keeps three significant digits (rateText), so a real
 * price is never shown as 0. A Server Component; it ends with the one line on failed runs.
 */
export function PlanCostTable({ t, locale, data }: { t: Dictionary; locale: Locale; data: PlanFinderData }) {
  const c = t.planFinder.table;
  const per = t.modelDiscovery.per;
  const minute = data.video?.[UNIT_VIDEO_MINUTE] ?? null;
  const floor = data.video?.[UNIT_JOB_MINIMUM] ?? null;
  const studio = data.studio;
  const rows =
    studio.status === "ok"
      ? studio.rows
          .map((r, i) => ({ r, i }))
          .sort((a, b) => KIND_ORDER[a.r.kind] - KIND_ORDER[b.r.kind] || a.r.model.localeCompare(b.r.model) || a.i - b.i)
          .map(({ r }) => r)
      : [];

  const credits = (r: StudioRow) => {
    if (r.state === "not_on_sale") return <span className="pf-dim">{c.notOnSale}</span>;
    if (r.state === "unavailable" || r.state === "needs_probe") return <span className="pf-dim">{c.notOpen}</span>;
    if (r.rate === null) return <span className="pf-dim">{t.planFinder.card.unavailable}</span>;
    return (
      <>
        <span className="st-num">{rateText(r.rate, locale)}</span>
        {r.state === "plan_gated" && <small className="pf-dim">{c.firstPurchase}</small>}
      </>
    );
  };
  const priced = (r: StudioRow) => r.rate !== null && (r.state === "available" || r.state === "plan_gated");

  return (
    <div className="pf-table-block" id="item-prices">
      <h3 className="st-h3">{c.title}</h3>
      <p className="st-small mt-2 max-w-3xl">{c.lead}</p>
      <div className="pf-table-wrap mt-6">
        <table className="pf-table">
          <caption className="sr-only">{c.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{c.item}</th>
              <th scope="col">{c.setting}</th>
              <th scope="col">{c.credits}</th>
              <th scope="col">{c.per}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="pf-group">
              <th scope="rowgroup" colSpan={4}>
                {c.youtube}
              </th>
            </tr>
            {minute ? (
              <>
                <tr>
                  <th scope="row">{c.minute}</th>
                  <td>—</td>
                  <td>
                    <span className="st-num">{rateText(minute.credits, locale)}</span>
                  </td>
                  <td>{c.perMinute}</td>
                </tr>
                {floor && (
                  <tr>
                    <th scope="row">{c.minimum}</th>
                    <td>—</td>
                    <td>
                      <span className="st-num">{rateText(floor.credits, locale)}</span>
                    </td>
                    <td>{c.perRun}</td>
                  </tr>
                )}
              </>
            ) : (
              <tr>
                <td colSpan={4} className="pf-dim">
                  {c.unpublished}
                </td>
              </tr>
            )}
          </tbody>
          <tbody>
            <tr className="pf-group">
              <th scope="rowgroup" colSpan={4}>
                {c.studio}
              </th>
            </tr>
            {studio.status === "ok" && rows.length > 0 ? (
              rows.map((r, i) => (
                <tr key={`${r.model}-${r.parts.join("_")}-${i}`} data-on-sale={priced(r) || undefined}>
                  <th scope="row">{r.model}</th>
                  <td>{r.parts.length ? settingName(t, r.parts) : "—"}</td>
                  <td>{credits(r)}</td>
                  <td>{priced(r) ? (r.unit ? per[r.unit] : t.modelDiscovery.perUse) : "—"}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="pf-dim">
                  {studio.status === "signed_out" ? (
                    <>
                      {c.signedOut}{" "}
                      <Link href="/login?next=/pricing" className="st-link">
                        {c.signIn}
                      </Link>
                    </>
                  ) : studio.status === "failed" ? (
                    c.failed
                  ) : studio.status === "not_enabled" ? (
                    c.notEnabled
                  ) : (
                    c.empty
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex flex-col gap-1">
        {minute && data.videoStamp && <p className="st-small">{`${c.youtube}: ${stampText(t, data.videoStamp, locale)}`}</p>}
        {studio.status === "ok" && rows.length > 0 && <p className="st-small">{`${c.studio}: ${stampText(t, studio.stamp, locale)}`}</p>}
        <p className="st-small pf-fail" data-failure-line>
          {t.planFinder.failures}
        </p>
      </div>
    </div>
  );
}
