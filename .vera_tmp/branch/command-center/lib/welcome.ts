/**
 * The one thing /welcome carries forward: what the person said they are
 * making, as a pre-fill for the channel wizard.
 *
 * There is no column for "what a new account intends to create", and inventing
 * one for a form field would be schema for its own sake. The channel is where
 * niche and language already live, so the answers ride to the wizard in its
 * URL and are saved only when that channel is created — through the wizard's
 * existing insert, under the existing policies.
 */

import { channelPath } from "@/lib/channels";

export const WELCOME_NICHE_MAX = 200;
export const WELCOME_LANGUAGE_MAX = 40;

/** Trimmed, whitespace-collapsed, length-capped; empty becomes null. */
function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(/\s+/g, " ").trim().slice(0, max);
  return v ? v : null;
}

export interface ChannelPrefill {
  niche: string | null;
  language: string | null;
}

/** Read the wizard's pre-fill from its search params (arbitrary user input). */
export function readChannelPrefill(params: Record<string, string | string[] | undefined>): ChannelPrefill {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return {
    niche: clean(first(params.niche), WELCOME_NICHE_MAX),
    language: clean(first(params.language), WELCOME_LANGUAGE_MAX),
  };
}

/** `/{slug}/channels/new`, with whatever was answered on /welcome. */
export function newChannelHref(slug: string, answers: { niche?: string; language?: string }): string {
  const q = new URLSearchParams();
  const niche = clean(answers.niche, WELCOME_NICHE_MAX);
  const language = clean(answers.language, WELCOME_LANGUAGE_MAX);
  if (niche) q.set("niche", niche);
  if (language) q.set("language", language);
  const query = q.toString();
  return channelPath(slug, "/channels/new") + (query ? `?${query}` : "");
}
