/**
 * The mark: a lit lamp in its bezel — the one light in the control room that
 * means "this is waiting for you". Decorative beside the wordmark, which
 * carries the name.
 */
export function BrandMark({ className }: { className?: string }) {
  return <span aria-hidden className={`st-brand-lamp${className ? ` ${className}` : ""}`} />;
}
