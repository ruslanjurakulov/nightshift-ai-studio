"use client";

import type { FilmStudioDictionary } from "@/lib/i18n/film-studio";
import type { FilmError } from "@/lib/films";

/**
 * One refusal, said in the reader's language, with the remedy (CLAUDE.md rule 6): an ended session links to sign-in (in a new tab, so
 * the unsaved work on this screen stays), a rate limit says to wait, and the database's own sentence for a refused value is shown under
 * the message as a technical detail.
 */
export function FilmErrorNotice({
  t,
  error,
  detail,
  fallback,
  onRetry,
}: {
  t: FilmStudioDictionary;
  error: FilmError;
  detail?: string;
  fallback?: string;
  onRetry?: () => void;
}) {
  const tone = error === "rate_limited" || error === "rate_limit_unavailable" ? "warn" : "fail";
  const text = error === "failed" && fallback ? fallback : t.errors[error] ?? t.errors.failed;
  return (
    <div className="fs-notice" data-tone={tone} role="alert" data-testid={`fs-error-${error}`}>
      <span className="fs-lamp" data-s={tone === "warn" ? "warn" : "failed"} aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-2">
        <p>{text}</p>
        {detail && <p className="fs-mono fs-small">{detail}</p>}
        {error === "session_expired" ? (
          <a className="btn-quiet min-h-11 self-start px-4 text-sm" href="/login" target="_blank" rel="noopener">
            {t.signIn}
          </a>
        ) : onRetry ? (
          <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" onClick={onRetry}>
            {t.retry}
          </button>
        ) : null}
      </div>
    </div>
  );
}
