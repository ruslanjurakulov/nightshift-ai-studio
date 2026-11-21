/**
 * The light behind a hero: a faint grid and three soft amber blobs that drift
 * very slowly. Pure markup; everything about it (colour from the theme's
 * tokens, motion only where the visitor allows it, the pause switch) lives in
 * site-next.css, and it is aria-hidden and unfocusable. It sits behind the
 * hero's content (z-index 0 against 1), costs two composited transforms and no
 * filter, and the hero's height does not depend on it, so it cannot shift the
 * page.
 */
export function HeroFx() {
  return (
    <div className="nx-fx" aria-hidden>
      <span className="nx-fx-grid" />
      <i className="nx-fx-blob" data-n="1" />
      <i className="nx-fx-blob" data-n="2" />
      <i className="nx-fx-blob" data-n="3" />
    </div>
  );
}
