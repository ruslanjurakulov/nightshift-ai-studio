"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clapperboard, Film, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import {
  formatTime,
  parseTitle,
  type EditorAsset,
  type EditorError,
} from "@/lib/editor";
import { createProject } from "./editorApi";

export interface ProjectRow {
  id: string;
  title: string;
  updatedAt: string | null;
}

/**
 * The editor's first screen: the organization's projects, and a new project
 * started from one library video. Creating one stores a document (the whole
 * video, with its sound) — nothing is rendered, priced or published.
 */
export function EditorHome({
  orgId,
  projects,
  videos,
}: {
  orgId: string;
  projects: readonly ProjectRow[];
  videos: readonly EditorAsset[] | null;
}) {
  const { t, locale } = useI18n();
  const te = t.editor;
  const path = useChannelPath();
  const router = useRouter();
  const titleId = useId();
  const [title, setTitle] = useState(te.defaultTitle);
  const [picked, setPicked] = useState<string | null>(videos?.[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EditorError | null>(null);

  const when = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? "—"
      : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  };

  async function onCreate() {
    const name = parseTitle(title);
    if (!name.ok) {
      setError("invalid_title");
      return;
    }
    if (!picked) return;
    setBusy(true);
    setError(null);
    const out = await createProject(orgId, name.value, picked);
    if (!out.ok) {
      setBusy(false);
      setError(out.error);
      return;
    }
    router.push(path(`/editor/${out.value.id}`));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[13px] text-[var(--color-muted)]">
        {te.freeNote} {te.publishNote}
      </p>

      <section
        aria-labelledby={`${titleId}-new`}
        className="panel flex flex-col gap-3 p-4"
      >
        <h2 id={`${titleId}-new`} className="m-0 text-[15px] font-semibold">
          {te.newProject}
        </h2>
        {videos === null ? (
          <p className="m-0 text-[13px] text-[var(--color-fail)]">
            {te.readFailed}
          </p>
        ) : videos.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="m-0 text-[13px] text-[var(--color-muted)]">
              {te.noVideos}
            </p>
            <Link
              href={path("/library")}
              className="btn-sky ghost pill px-4 py-2 text-[13px]"
            >
              {te.openLibrary}
            </Link>
          </div>
        ) : (
          <>
            <label
              htmlFor={titleId}
              className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]"
            >
              {te.projectTitle}
              <input
                id={titleId}
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
                className="pill border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-[16px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]"
              />
            </label>
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="mb-1 p-0 text-[12px] text-[var(--color-muted)]">
                {te.pickVideo}
              </legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {videos.map((v) => (
                  <label
                    key={v.id}
                    className={`press flex min-w-0 cursor-pointer flex-col gap-1 rounded-2xl border p-2 text-[12px] ${
                      picked === v.id
                        ? "border-[var(--color-primary)]"
                        : "border-[var(--color-border)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`${titleId}-video`}
                      value={v.id}
                      checked={picked === v.id}
                      onChange={() => setPicked(v.id)}
                      className="sr-only"
                    />
                    <span className="relative block aspect-video overflow-hidden rounded-xl bg-[var(--color-panel-2)]">
                      {v.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={v.thumbUrl}
                          alt=""
                          className="size-full object-cover"
                        />
                      ) : (
                        <Film
                          className="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 text-[var(--color-muted)]"
                          aria-hidden
                        />
                      )}
                    </span>
                    <span className="truncate text-[var(--color-fg)]">
                      {v.name ?? te.untitledVideo}
                    </span>
                    <span className="text-[var(--color-muted)]">
                      {formatTime(v.durationS ?? 0)}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {error ? (
              <p
                role="alert"
                className="m-0 text-[13px] text-[var(--color-fail)]"
              >
                {te.errors[error]}
              </p>
            ) : null}
            <div>
              <button
                type="button"
                onClick={onCreate}
                disabled={busy || !picked}
                className="btn-sky is-solid pill inline-flex items-center gap-2 px-4 py-2 text-[13px]"
              >
                <Plus className="size-4" aria-hidden />
                {busy ? te.creating : te.create}
              </button>
            </div>
          </>
        )}
      </section>

      <section
        aria-labelledby={`${titleId}-list`}
        className="flex flex-col gap-2"
      >
        <h2 id={`${titleId}-list`} className="m-0 text-[15px] font-semibold">
          {te.projects}
        </h2>
        {projects.length === 0 ? (
          <div className="panel flex flex-col items-center gap-3 px-6 py-10 text-center">
            <Clapperboard
              className="size-6 text-[var(--color-primary)]"
              aria-hidden
            />
            <p className="m-0 max-w-[46ch] text-[13px] leading-relaxed text-[var(--color-muted)]">
              {te.noProjects}
            </p>
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={path(`/editor/${p.id}`)}
                  className="panel flex items-center justify-between gap-3 px-4 py-3 text-[13px]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-[var(--color-fg)]">
                      {p.title}
                    </span>
                    <span className="block text-[12px] text-[var(--color-muted)]">
                      {fmt(te.updated, { when: when(p.updatedAt) })}
                    </span>
                  </span>
                  <span className="shrink-0 text-[var(--color-primary)]">
                    {te.open}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
