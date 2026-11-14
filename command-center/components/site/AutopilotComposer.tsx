"use client";

import { useId, useState } from "react";
import { ArrowRight, Baby } from "lucide-react";
import type { HomeLanguage } from "@/lib/home";
import type { PillarDictionary } from "@/lib/i18n/autopilot-pillar/en";
import { PILLAR_GENRES, pillarComposeHref, type PillarGenreId } from "@/lib/site/autopilot-pillar";

type Copy = PillarDictionary["composer"];

/**
 * The pillar's composer: a topic box and four genre keys. A genre key only fills the box with its starter (and the genre's
 * length rides in the link); the button is a link to sign-up and then the run form with the topic in it. Nothing here prices,
 * holds or starts anything (CLAUDE.md #3): the run form shows the price and asks again.
 *
 * A key replaces the words only while they are empty or still one of the starters, so a topic the visitor typed is never
 * thrown away by a press on a genre.
 */
export function AutopilotComposer({ copy, language }: { copy: Copy; language: HomeLanguage }) {
  const id = useId();
  // Mystery first: its starter is the sample script's own topic, shown beside the composer.
  const first: PillarGenreId = "mystery";
  const starterOf = (g: PillarGenreId) => copy.items.find((i) => i.id === g)?.starter ?? "";
  const [genre, setGenre] = useState<PillarGenreId>(first);
  const [topic, setTopic] = useState(() => starterOf(first));
  const href = pillarComposeHref(topic, genre, language);
  const starters = copy.items.map((i) => i.starter);

  const pick = (g: PillarGenreId) => {
    setGenre(g);
    if (!topic.trim() || starters.includes(topic)) setTopic(starterOf(g));
  };

  return (
    <div className="nx-pl-composer">
      <p id={`${id}-genres`} className="nx-pl-composer-label">
        {copy.genres}
      </p>
      <div className="nx-pl-genres" role="group" aria-labelledby={`${id}-genres`}>
        {PILLAR_GENRES.map((g) => (
          <button
            key={g.id}
            type="button"
            className="nx-pl-genre"
            aria-pressed={genre === g.id}
            onClick={() => pick(g.id)}
          >
            {copy.items.find((i) => i.id === g.id)?.name}
          </button>
        ))}
      </div>
      <label htmlFor={`${id}-topic`} className="nx-pl-composer-label">
        {copy.label}
      </label>
      <textarea
        id={`${id}-topic`}
        className="nx-pl-topic"
        rows={2}
        maxLength={300}
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        aria-describedby={`${id}-note${genre === "kids" ? ` ${id}-kids` : ""}`}
      />
      {genre === "kids" && (
        <div id={`${id}-kids`} className="nx-pl-kids" role="note">
          <Baby aria-hidden />
          <p>
            <strong>{copy.kidsTitle}.</strong> {copy.kidsNote}
          </p>
        </div>
      )}
      <div className="nx-pl-composer-go">
        {href ? (
          <a href={href} className="nx-btn">
            {copy.go}
            <ArrowRight aria-hidden />
          </a>
        ) : (
          <>
            <button type="button" className="nx-btn" disabled aria-describedby={`${id}-empty`}>
              {copy.go}
              <ArrowRight aria-hidden />
            </button>
            <p id={`${id}-empty`} className="nx-pl-empty" role="status">
              {copy.empty}
            </p>
          </>
        )}
      </div>
      <p id={`${id}-note`} className="nx-pl-note">
        {copy.note}
      </p>
    </div>
  );
}
