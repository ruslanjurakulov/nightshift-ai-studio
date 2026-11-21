/**
 * The series format templates (docs/SERIES_FACTORY.md, "Format templates"): a closed list of three formats a person may pick when
 * planning a series, and the bounds each one asks of the plan. Pure: no server import, no network.
 *
 * The table is the TypeScript twin of `modules/series_planner.TEMPLATES`. The ids are also in the database (a CHECK on the
 * plans table, the request function and the queue's params validator: migration 0122), and `samples/series_templates.json` is
 * the file that `tests/test_series_template.py` and `tests/series-template.test.ts` both read, so the three copies cannot drift apart.
 *
 * Two rules this file exists to keep:
 *
 *  - **An id is one of the three words, or it is refused.** `templateFor` never turns an unknown, empty or differently cased id into
 *    "no format" or into another format (CLAUDE.md rule 4: a format that is asked for and unavailable stops the request, it is not
 *    swapped for something else). The only "no format" is `null`.
 *  - **A bound is not a price.** The bounds narrow what the form offers, and `clampDurationsToTemplate` brings the length of a PREVIEW
 *    inside them. They never change what the database charges: it prices the length that was asked for, and the planner refuses
 *    (`bad_template`) a request outside the format's bounds instead of moving it.
 */

/** The closed list. The same three words are in migration 0122 and in `modules/series_planner.TEMPLATE_IDS`. */
export const TEMPLATE_IDS = ["myth_vs_fact", "top5_countdown", "one_question_one_answer"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** An inclusive `[low, high]` pair. */
export type Bounds = readonly [number, number];

export interface FormatTemplate {
  id: TemplateId;
  /** How many episodes the format fits (the database accepts 3 or 4 whatever this says). */
  episodes: Bounds;
  /** The length of one episode, in seconds. */
  lengthS: Bounds;
  /** How many scenes one episode is planned as. A request to the model: nothing checks the answer against it. */
  scenes: Bounds;
}

export const FORMAT_TEMPLATES: Readonly<Record<TemplateId, FormatTemplate>> = {
  myth_vs_fact: { id: "myth_vs_fact", episodes: [3, 4], lengthS: [60, 480], scenes: [4, 10] },
  top5_countdown: { id: "top5_countdown", episodes: [3, 4], lengthS: [180, 600], scenes: [6, 12] },
  one_question_one_answer: { id: "one_question_one_answer", episodes: [3, 4], lengthS: [60, 300], scenes: [3, 8] },
};

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === "string" && (TEMPLATE_IDS as readonly string[]).includes(value);
}

/** Raised for an id that is not in the closed list. Carries the planner's word; never repeats the value, which may be hostile. */
export class TemplateError extends Error {
  readonly code = "bad_template";
  constructor() {
    super("bad_template: the format is not one of the known formats");
    this.name = "TemplateError";
  }
}

/** `null` and `undefined` are "no format". One of the three ids is its template. Anything else, the empty string included, throws
 *  `TemplateError`: it is never read as "no format". */
export function templateFor(value: unknown): FormatTemplate | null {
  if (value === null || value === undefined) return null;
  if (!isTemplateId(value)) throw new TemplateError();
  return FORMAT_TEMPLATES[value];
}

function within(value: number, [low, high]: Bounds): boolean {
  return value >= low && value <= high;
}

/** The values of `options` that the template allows; all of them for no template. */
export function allowedOptions(template: TemplateId | null, options: readonly number[], pick: "episodes" | "lengthS"): number[] {
  const t = templateFor(template);
  return t ? options.filter((v) => within(v, t[pick])) : [...options];
}

/** The member of `options` to move a current choice to when a template is picked: the choice itself when the template allows it, else
 *  the allowed option nearest to it (the lower one on a tie), else the choice unchanged (no option fits: the caller shows it as is). */
export function nearestAllowed(template: TemplateId | null, options: readonly number[], pick: "episodes" | "lengthS", current: number): number {
  const allowed = allowedOptions(template, options, pick);
  if (allowed.length === 0 || allowed.includes(current)) return current;
  return allowed.reduce((best, v) => (Math.abs(v - current) < Math.abs(best - current) ? v : best), allowed[0]);
}

/** `{ durationsS, clamped }`: each known duration brought inside the template's length bounds, and the (1-based) numbers of the episodes
 *  that moved. For the INPUT of a price preview (`quoteSeries` is unchanged and prices what it is given). A duration that is not a
 *  positive finite number stays as it is (unknown stays unknown). No template changes nothing. The twin of
 *  `modules/series_planner.clamp_durations`. */
export function clampDurationsToTemplate(
  template: unknown,
  durationsS: readonly (number | null)[],
): { durationsS: (number | null)[]; clamped: number[] } {
  const t = templateFor(template);
  const clamped: number[] = [];
  const out = durationsS.map((d, i) => {
    if (!t || typeof d !== "number" || !Number.isFinite(d) || d <= 0) return d;
    const c = Math.min(Math.max(d, t.lengthS[0]), t.lengthS[1]);
    if (c !== d) clamped.push(i + 1);
    return c;
  });
  return { durationsS: out, clamped };
}
