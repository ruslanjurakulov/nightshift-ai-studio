/**
 * YouTube's "made for kids" declaration, the pure half (migration 0145, modules/made_for_kids.py).
 *
 * Every upload used to declare "not made for kids", while the product offers a Kids story format and kids looks: a children's
 * video declared that way breaks YouTube's policy and COPPA. The pipeline now decides the declaration from the run (the kids
 * format, a kids series, a kids look, a kids channel); a person sees it, and may change it, on the review panel. Kids content
 * starts ON, and turning it off takes an explicit confirmation that the database records (set_video_made_for_kids).
 *
 * Pure and client-safe: the switch, the review panel, the Create form and the tests import it.
 */
import type { HomeFormatId } from "@/lib/home";

/** The Kids story format of Home (lib/home.ts HOME_FORMATS). */
export const KIDS_FORMAT = "kids" satisfies HomeFormatId;

/**
 * The Style Library looks made for children and nothing else: these make a video "made for kids". An explicit list, not the
 * "kids" tag, which is the library's browsing filter ("good for kids") and also sits on looks a travel film or a history
 * documentary uses (tilt-shift-miniature, oil-pastel, central-asian-miniature): their videos must not lose comments for it.
 * modules/made_for_kids.py KIDS_LIBRARY_STYLES lists the same ids; tests/made-for-kids.test.tsx pins both, and that each id
 * is a look of the library that carries the kids tag.
 */
export const KIDS_LIBRARY_STYLES: readonly string[] = [
  "cut-paper-collage",
  "claymation-set",
  "felt-and-wool",
  "gouache-storybook",
  "chalk-on-slate",
];

/** Tagged "kids" for browsing, but used by grown-up films too: never a "made for kids" source. */
export const KIDS_TAGGED_NOT_KIDS_ONLY: readonly string[] = ["tilt-shift-miniature", "oil-pastel", "central-asian-miniature"];

export function isKidsFormat(id: unknown): boolean {
  return id === KIDS_FORMAT;
}

export function isKidsLook(libraryId: unknown): boolean {
  return typeof libraryId === "string" && KIDS_LIBRARY_STYLES.includes(libraryId.trim().toLowerCase());
}

/** The videos columns of 0145, all optional: a row before 0145, or a database without it, simply has none. */
export interface MadeForKidsFields {
  made_for_kids?: boolean | null;
  kids_content?: boolean | null;
  made_for_kids_off_by?: string | null;
  made_for_kids_off_at?: string | null;
  made_for_kids_answered_by?: string | null;
  made_for_kids_answered_at?: string | null;
  /** The cut the answer is about (0145); an answer counts only for the row's own cut_sha256. */
  made_for_kids_answered_cut_sha256?: string | null;
  cut_sha256?: string | null;
}

export interface MadeForKidsView {
  /** Something was recorded for this video (an upload since 0145, or a person's decision). */
  recorded: boolean;
  /** What the video declares; null when nothing was recorded (never shown as "off": an unknown is not a no). */
  value: boolean | null;
  /** Kids content: starts on, and turning it off needs a confirmation. */
  kids: boolean;
  /** A person confirmed "not made for kids" for kids content. */
  confirmedOff: boolean;
  /** A person answered "is this made for kids?". Until then `value` is the pipeline's detection: a hint, never an answer. */
  answered: boolean;
}

export function madeForKidsView(v: MadeForKidsFields | null | undefined): MadeForKidsView {
  const value = typeof v?.made_for_kids === "boolean" ? v.made_for_kids : null;
  const kids = v?.kids_content === true;
  return {
    recorded: value !== null,
    value,
    kids,
    confirmedOff: kids && value === false && !!v?.made_for_kids_off_by,
    answered: answeredForThisCut(v),
  };
}

/** A person's answer, about the cut the row holds now: an answer about an earlier cut is about another video. */
function answeredForThisCut(v: MadeForKidsFields | null | undefined): boolean {
  return !!v?.made_for_kids_answered_by && !!v.cut_sha256 && v.made_for_kids_answered_cut_sha256 === v.cut_sha256;
}

/**
 * The video's row carries 0145's answer column and nobody has answered (the owner's decision on PR #699: who a video is for is a
 * person's explicit choice, asked before approving, as YouTube Studio asks before publishing). A row without the column (a
 * database before 0145) asks nothing: approve_video_publish there does not ask either.
 */
export function audienceUnanswered(v: MadeForKidsFields | null | undefined): boolean {
  return !!v && "made_for_kids_answered_by" in v && !answeredForThisCut(v);
}

/** Turning the switch to `next` needs the "not made for kids" confirmation: kids content going off. */
export function needsConfirm(view: Pick<MadeForKidsView, "kids">, next: boolean): boolean {
  return view.kids && next === false;
}

export type MadeForKidsBlocker = "already_public" | "cut_unknown" | "approval_live" | "not_admin" | "not_member";

/**
 * Why the review panel's switch cannot be changed now, in the order set_video_made_for_kids refuses, then the person's own
 * standing; null when it may. Presentation only: the database function asks again.
 */
export function madeForKidsBlocker(
  video: { privacy?: string | null; cut_sha256?: string | null },
  opts: { approvalLive: boolean; access: "ok" | "not_admin" | "not_member" },
): MadeForKidsBlocker | null {
  if (video.privacy === "public") return "already_public";
  // The answer is about one cut; a row with no recorded cut has nothing to bind it to (the database refuses cut_unknown).
  if (!video.cut_sha256) return "cut_unknown";
  if (opts.approvalLive) return "approval_live";
  if (opts.access === "not_member") return "not_member";
  if (opts.access === "not_admin") return "not_admin";
  return null;
}

/** The words set_video_made_for_kids answers with ({ ok: false, error }), plus the two it raises. */
export const MADE_FOR_KIDS_ERRORS = [
  "bad_value",
  "rate_limited",
  "already_public",
  "approval_live",
  "confirm_required",
  "bad_hash",
  "cut_unknown",
  "cut_changed",
  "forbidden",
  "not_found",
] as const;
export type MadeForKidsError = (typeof MADE_FOR_KIDS_ERRORS)[number] | "failed";

export function madeForKidsError(raw: unknown): MadeForKidsError {
  return typeof raw === "string" && (MADE_FOR_KIDS_ERRORS as readonly string[]).includes(raw) ? (raw as MadeForKidsError) : "failed";
}

/** The word a PostgREST error carries for the two raised refusals (42501 forbidden, P0002 not found); anything else is "failed". */
export function errorFromRpc(err: { code?: string; message?: string } | null | undefined): MadeForKidsError {
  if (!err) return "failed";
  if (err.code === "42501" || err.message === "forbidden") return "forbidden";
  if (err.code === "P0002" || err.message === "not_found") return "not_found";
  return "failed";
}
