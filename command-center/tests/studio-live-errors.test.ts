/**
 * The failure words on a live step (components/studio-live/LiveView.tsx failureText). What would break without these: a film
 * code from the worker (S6's table) shown as a bare code with a remedy that does not fit it, or a code translated in one language
 * and missing in another.
 */
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { failureText } from "../components/studio-live/LiveView";
import type { LiveNode } from "../lib/studio/liveGraph";

const WORKER_CODES = [
  "auth", "quota", "plan_required", "rate_limited", "bad_request", "voice_not_found", "moderated", "provider_error", "timeout",
  "too_short", "no_output", "worker_lost", "film_studio_off", "assembly_unavailable", "assembly_failed", "music_missing", "first_frame_missing",
];
const node = (error: string | null): LiveNode => ({ id: "x", kind: "clip", status: "failed", error, col: 0, row: 0 }) as LiveNode;

describe("film failure words", () => {
  it("every worker code has its own reason and remedy in en, ru and uz", () => {
    for (const d of [en, ru, uz]) for (const code of WORKER_CODES) expect(d.studioLive.errors[code], `${code}`).toBeTruthy();
    expect(Object.keys(ru.studioLive.errors).sort()).toEqual(Object.keys(en.studioLive.errors).sort());
    expect(Object.keys(uz.studioLive.errors).sort()).toEqual(Object.keys(en.studioLive.errors).sort());
  });

  it("a known code reads its own words, with no generic remedy appended", () => {
    expect(failureText(en as never, node("moderated"), false)).toEqual({ reason: en.studioLive.errors.moderated, remedy: null });
  });

  it("an unknown code shows the code and the generic remedy; no code says none was recorded", () => {
    expect(failureText(en as never, node("brand_new_code"), false)).toEqual({ reason: "This step failed (brand_new_code).", remedy: en.studioLive.remedyGeneric });
    expect(failureText(en as never, node(null), false).reason).toBe(en.studioLive.failedNoCode);
  });
});
