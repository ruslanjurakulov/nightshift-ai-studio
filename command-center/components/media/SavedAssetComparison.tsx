"use client";

import { useId, useState } from "react";

/** Explicit saved images to inspect; matching names or version numbers imply no lineage. */
export interface ComparisonAsset {
  readonly id: string;
  readonly name: string | null;
  readonly version: number;
  readonly previewUrl: string | null;
}

export interface ComparisonLabels {
  readonly title: string;
  readonly left: string;
  readonly right: string;
  readonly unnamed: string;
  readonly unavailable: string;
  readonly dismiss: string;
  readonly version: (version: number) => string;
}

function Preview({ url, name, unavailable }: { url: string | null; name: string; unavailable: string }) {
  const [failed, setFailed] = useState(false);
  return url?.trim() && !failed ? (
    // eslint-disable-next-line @next/next/no-img-element -- caller supplies the preview; no image loader or read here.
    <img src={url} alt={name} onError={() => setFailed(true)} className="aspect-[4/3] w-full object-contain" />
  ) : (
    <p role="status" className="m-0 flex aspect-[4/3] items-center justify-center p-4 text-center text-sm text-[var(--color-muted)] [overflow-wrap:anywhere]">
      {unavailable}
    </p>
  );
}

function ComparisonFigure({ asset, side, labels }: { asset: ComparisonAsset; side: string; labels: ComparisonLabels }) {
  const captionId = useId();
  const name = asset.name?.trim() ? asset.name : labels.unnamed;
  return (
    <figure aria-labelledby={captionId} className="m-0 flex min-w-0 flex-col gap-2">
      <figcaption id={captionId} className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">
        <span className="text-sm text-[var(--color-muted)]">{side}</span>
        <span className="font-medium">{name}</span>
        <span className="text-sm text-[var(--color-muted)]">{labels.version(asset.version)}</span>
      </figcaption>
      <Preview key={`${asset.id}:${asset.previewUrl ?? ""}`} url={asset.previewUrl} name={name} unavailable={labels.unavailable} />
    </figure>
  );
}

/** Props-only, read-only presentation. The caller owns the pair and whether this section is open. */
export function SavedAssetComparison({ left, right, labels, onDismiss }: {
  left: ComparisonAsset;
  right: ComparisonAsset;
  labels: ComparisonLabels;
  onDismiss: () => void;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <h2 id={titleId} className="m-0 min-w-0 text-base font-semibold [overflow-wrap:anywhere]">{labels.title}</h2>
        <button type="button" onClick={onDismiss} className="btn-quiet min-h-11 shrink-0">{labels.dismiss}</button>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <ComparisonFigure asset={left} side={labels.left} labels={labels} />
        <ComparisonFigure asset={right} side={labels.right} labels={labels} />
      </div>
    </section>
  );
}
