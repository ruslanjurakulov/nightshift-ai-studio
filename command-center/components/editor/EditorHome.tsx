"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clapperboard, Film, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import {
  parseTitle,
  type EditorAsset,
  type EditorError,
} from "@/lib/editor";
import { Timecode } from "@/components/ui/Timecode";
import { ContactSheet, Frame } from "@/components/ui/ContactSheet";
import { formatDuration } from "@/lib/media";
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
    <div className="flex flex-col gap-8">
      <p className="m-0 max-w-[62ch] text-base text-[var(--color-muted)]">
        {te.freeNote} {te.publishNote}
      </p>

      <section aria-labelledby={`${titleId}-new`} className="g3-section ns-desk">
        <header className="g3-head">
          <h2 id={`${titleId}-new`} className="t-panel">
            {te.newProject}
          </h2>
        </header>
        {videos === null ? (
          <p className="m-0 text-base text-[var(--color-fail)]">{te.readFailed}</p>
        ) : videos.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="m-0 text-base text-[var(--color-muted)]">{te.noVideos}</p>
            <Link href={path("/library")} className="btn-quiet text-sm">
              {te.openLibrary}
            </Link>
          </div>
        ) : (
          <>
            <label htmlFor={titleId} className="flex max-w-xl flex-col gap-1.5 text-sm text-[var(--color-muted)]">
              {te.projectTitle}
              <input
                id={titleId}
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
                className="ns-field"
              />
            </label>
            <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
              <legend className="mb-1 p-0 text-sm text-[var(--color-muted)]">{te.pickVideo}</legend>
              <ContactSheet min={220} ragged label={te.pickVideo} className="g3-picker">
                {videos.map((v, i) => (
                  <Frame
                    key={v.id}
                    number={String(i + 1).padStart(2, "0")}
                    edge={[v.durationS ? formatDuration(v.durationS) : null]}
                    aspect="16 / 9"
                    selected={picked === v.id}
                    caption={<span className="block truncate text-sm text-[var(--ns-on-film)]">{v.name ?? te.untitledVideo}</span>}
                  >
                    <label className="g3-pick">
                      <input
                        type="radio"
                        name={`${titleId}-video`}
                        value={v.id}
                        checked={picked === v.id}
                        onChange={() => setPicked(v.id)}
                        className="g3-pick-input"
                      />
                      {v.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={v.thumbUrl} alt="" className="size-full object-cover" />
                      ) : (
                        <Film className="size-6 text-[var(--ns-on-film)] opacity-60" aria-hidden />
                      )}
                      <span className="sr-only">
                        {v.name ?? te.untitledVideo}, <Timecode value={v.durationS} format="duration" />
                      </span>
                    </label>
                  </Frame>
                ))}
              </ContactSheet>
            </fieldset>
            {error ? (
              <p role="alert" className="m-0 text-base text-[var(--color-fail)]">
                {te.errors[error]}
              </p>
            ) : null}
            <div>
              <button
                type="button"
                onClick={onCreate}
                disabled={busy || !picked}
                className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm"
              >
                <Plus className="size-4" aria-hidden />
                {busy ? te.creating : te.create}
              </button>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby={`${titleId}-list`} className="g3-section">
        <header className="g3-head">
          <h2 id={`${titleId}-list`} className="t-panel">
            {te.projects}
          </h2>
        </header>
        {projects.length === 0 ? (
          <div className="g3-empty">
            <Clapperboard className="size-6 text-[var(--color-muted)]" aria-hidden strokeWidth={1.5} />
            <p className="m-0 max-w-[46ch] text-base text-[var(--color-muted)]">{te.noProjects}</p>
          </div>
        ) : (
          <ul className="g3-projects">
            {projects.map((p) => (
              <li key={p.id}>
                <Link href={path(`/editor/${p.id}`)} className="g3-project">
                  <span className="g3-project-frame" aria-hidden>
                    <Clapperboard className="size-5" strokeWidth={1.5} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-base font-medium text-[var(--color-fg)]">{p.title}</span>
                    <span className="block text-sm text-[var(--color-muted)]">{fmt(te.updated, { when: when(p.updatedAt) })}</span>
                  </span>
                  <span className="g3-project-open">{te.open}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
