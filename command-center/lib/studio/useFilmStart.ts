import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FILM_ERRORS, filmErrorFromResponse, filmsApi, newIdempotencyKey, type FilmError } from "@/lib/films";
import { coerceQuote, startOnce, type FilmQuote, type QuoteBlock } from "@/lib/studio/timeline";
import { nsMarkOnce } from "@/lib/studio/nsMark";

/**
 * The money call of a project, as a state machine any surface can drive (the Brain's Create, later the canvas): the person confirms
 * the server's quote, the start route holds it (0171 start_film), and every answer becomes a state that names its remedy.
 *
 * The browser never prices. The only numbers here are quote_film's total and the balance it read (`available`); the one subtraction
 * is the difference between two server totals, shown so a person can see by how much a re-quoted price moved before confirming it.
 */

/** Why the key cannot start right now. Every reason is listed, never only the first. */
export type BlockReason =
  | { kind: "block"; block: QuoteBlock }
  /** quote_film answered, but a line has no price: its own word (model_not_set, model_not_available…), not "pricing is not live". */
  | { kind: "unpriced"; word: string | null; detail?: string | null }
  | { kind: "not_admin" }
  | { kind: "no_quote" };

export type PriceChange = { from: number; to: number; delta: number };

/** What came with a refused answer: the database's own sentence for an NS400 refusal, and how long a rate limit asks to wait. */
export interface RefusalExtra {
  detail: string | null;
  /** Seconds, from the answer's Retry-After. */
  retryAfter: number | null;
}

export type FilmStartState =
  | { at: "idle"; quote: FilmQuote }
  | { at: "blocked"; quote: FilmQuote | null; reasons: BlockReason[] }
  | { at: "confirming"; quote: FilmQuote; change: PriceChange | null }
  | { at: "starting"; quote: FilmQuote }
  | { at: "started"; replayed: boolean }
  /** A refusal that counted (start_film's `ok: false`) or a route's refused answer. The quote it refused is spent. */
  | ({ at: "refused"; word: string; remedy: StartRemedy; quote: FilmQuote } & RefusalExtra)
  | { at: "requoting"; from: FilmQuote | null }
  /** The re-quote was refused or not read: its own word and remedy (a 404 is not a 429; Lens M3). */
  | ({ at: "requote_failed"; from: FilmQuote | null; word: string; remedy: StartRemedy } & RefusalExtra)
  /** No answer: the start may have gone through, so the key is kept and a retry replays the same start. */
  | { at: "network_error"; quote: FilmQuote }
  /** A 401. Once the person is back from signing in, the key resumes what was interrupted: the same start, or the re-quote. */
  | { at: "session_expired"; resume: { kind: "start"; quote: FilmQuote } | { kind: "requote"; from: FilmQuote | null } };

/**
 * What the person can do about a refusal. `requote`: ask for a new price (the old quote is spent). `fix_and_requote`: change the
 * project first. `wait`: the server's state, try again later. `support`: not the person's to fix. `none`: nothing on this screen helps.
 */
export type StartRemedy = "add_credits" | "plans" | "requote" | "fix_and_requote" | "wait" | "support" | "sign_in" | "none";

/**
 * Every word the start and quote paths can answer (start_film, quote_film, film_price, film_precheck, film_check_model, creative_price
 * and the routes' own), with its remedy. tests/film-create-button.test.tsx reads the migrations and fails when a word they can answer
 * has no entry here or no sentence in en/ru/uz. An unknown word is `support`, never a guess at a nearby one.
 */
export const START_REMEDIES: Readonly<Record<string, StartRemedy>> = {
  insufficient_credits: "add_credits",
  entitlement_required: "plans",
  cap_exceeded: "plans",
  run_slots_full: "plans",
  price_changed: "requote",
  quote_expired: "requote",
  film_changed: "requote",
  idempotency_conflict: "requote",
  invalid_idempotency_key: "requote",
  bad_request: "requote",
  reference_missing: "fix_and_requote",
  asset_not_usable: "fix_and_requote",
  acknowledgement_required: "fix_and_requote",
  adult_attestation_required: "fix_and_requote",
  invalid_params: "fix_and_requote",
  model_not_set: "fix_and_requote",
  prompt_missing: "fix_and_requote",
  refs_not_supported: "fix_and_requote",
  // 0239: a style kit or @character with no description whose pictures the key-frame model cannot take. Only the person adds a
  // description or picks another model; it is never dropped (rule 4).
  style_needs_description: "fix_and_requote",
  source_unavailable: "fix_and_requote",
  scene_too_long_for_model: "fix_and_requote",
  // 0218 (creative_price): a scene line's prompt is over its model's limit, or carries a negative prompt (or a seed) the model does not
  // take. The scene is never altered to fit (rule 4): only the person shortens it or chooses another model.
  prompt_too_long: "fix_and_requote",
  negative_prompt_not_supported: "fix_and_requote",
  seed_not_supported: "fix_and_requote",
  voice_not_set: "fix_and_requote",
  channel_voice_not_priced: "fix_and_requote",
  no_scenes: "fix_and_requote",
  style_unavailable: "fix_and_requote",
  capability_not_supported: "fix_and_requote",
  unpriced: "fix_and_requote",
  // S6 (#915, 0214 voice_language_problem): the voice model does not speak the film's language, or it could not be confirmed. Only
  // the person picks another voice model; nothing is swapped (rule 4).
  voice_language_unsupported: "fix_and_requote",
  voice_language_unknown: "fix_and_requote",
  // 0236 (BR-SG-01): film_price refuses a scene that asks for its clip's own sound while the cut does not keep it yet. The person turns
  // the scene's sound option off; nothing is bought that the film would drop.
  clip_sound_not_kept: "fix_and_requote",
  limit_reached: "wait",
  rate_limited: "wait",
  rate_limit_unavailable: "wait",
  model_not_available: "wait",
  model_not_offered: "wait",
  model_temporarily_off: "wait",
  model_not_sellable: "wait",
  network: "wait",
  film_studio_disabled: "support",
  hold_refused: "support",
  failed: "support",
  registry_missing: "support",
  not_configured: "support",
  session_expired: "sign_in",
  film_not_startable: "none",
  film_not_editable: "none",
  forbidden: "none",
  not_found: "none",
  org_required: "none",
  not_available: "none",
  scene_has_takes: "none",
  adult_only_service: "none",
  // 0215: only a member may start a paid project; there is nothing to retry, only someone to ask.
  not_a_member: "none",
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function startRemedy(word: string): StartRemedy {
  return own(START_REMEDIES, word) ? START_REMEDIES[word] : "support";
}

/** The model is down or off sale: said as such, because the run will not substitute another one (rule 4). */
export const PROVIDER_DOWN_WORDS = ["model_not_available", "model_not_offered", "model_temporarily_off", "model_not_sellable"] as const;
export const isProviderDown = (w: string | null) => w !== null && (PROVIDER_DOWN_WORDS as readonly string[]).includes(w);

/** Words that mean this project already started: there is nothing to press, only somewhere to go. */
export const ALREADY_STARTED_WORDS = ["film_not_startable", "film_not_editable"] as const;

/**
 * One way forward for a reason the key is blocked by (S5 SYSTEM.md §6). `recheck`: ask for the price again (after a wait, or a fix
 * in the project); `choose_another`: a model is down, and only the person may pick another (rule 4).
 */
export type BlockRemedy = "add_credits" | "plans" | "recheck" | "get_price" | "support" | "choose_another" | "none";

export function blockRemedy(r: BlockReason): BlockRemedy {
  if (r.kind === "no_quote") return "get_price";
  if (r.kind === "not_admin") return "none";
  if (r.kind === "unpriced") {
    if (isProviderDown(r.word)) return "choose_another";
    return r.word !== null && own(START_REMEDIES, r.word) ? "recheck" : "support";
  }
  switch (r.block) {
    case "insufficient_credits":
      return "add_credits";
    case "cap_exceeded":
    case "run_slots_full":
      return "plans";
    case "limit_reached":
      return "recheck";
    case "not_a_member":
      return "none";
    default:
      return "support";
  }
}

type Words = Record<string, string>;
/** The dictionaries a reason is looked up in: the start's own words only, never another surface's (Pixel M3). */
export interface ReasonDictionaries {
  create: { errors: Words; unpriced: Words; providerDown: string };
  startFailed: Words;
}

/** The sentence for a word, or null when none is written (the caller then says the generic refusal and offers support). */
export function startReasonText(word: string | null, d: ReasonDictionaries): string | null {
  if (!word || word === "other") return null;
  if (isProviderDown(word)) return d.create.providerDown;
  for (const dict of [d.create.errors, d.startFailed, d.create.unpriced]) {
    if (own(dict, word)) return dict[word];
  }
  return null;
}

const WORD_RE = /^[a-z0-9_]{1,64}$/;

/** What the quote allows, before anyone presses anything. */
export function stateOfQuote(q: FilmQuote | null): Extract<FilmStartState, { at: "idle" | "blocked" }> {
  if (!q) return { at: "blocked", quote: null, reasons: [{ kind: "no_quote" }] };
  const reasons: BlockReason[] = q.blockedBy.map((block) => ({ kind: "block", block }));
  if (!q.priced) reasons.push({ kind: "unpriced", word: q.refusal, detail: q.refusalDetail });
  else if (!q.mayStart) reasons.push({ kind: "not_admin" });
  if (q.startable && q.quoteId && q.total !== null && reasons.length === 0) return { at: "idle", quote: q };
  if (reasons.length === 0) reasons.push({ kind: "block", block: "other" });
  return { at: "blocked", quote: q, reasons };
}

/** The identity of a quote as far as the screen is concerned: a parent passing a new object for the same answer changes nothing. */
function quoteKey(q: FilmQuote | null) {
  return q ? [q.quoteId, q.total, q.priced, q.startable, q.mayStart, q.blockedBy.join(","), q.refusal, q.available, q.exempt].join("|") : "none";
}

type Sent =
  | { kind: "outcome"; ok: true; replayed: boolean }
  | { kind: "outcome"; ok: false; word: string }
  | ({ kind: "http"; error: FilmError } & RefusalExtra)
  | { kind: "network" };

/** A JSON object body, or null for anything else (HTML from a proxy, an empty body, a body cut off mid-way). */
async function jsonObject(res: Response): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  try {
    const j: unknown = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extraOf(res: Response, body: Record<string, unknown> | null): RefusalExtra {
  const after = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  // Only an NS400 refusal (400) carries a sentence about the project worth showing; others carry the route's own words.
  const detail = res.status === 400 && typeof body?.detail === "string" && body.detail.trim() ? body.detail.slice(0, 300) : null;
  return { detail, retryAfter: Number.isFinite(after) && after > 0 ? after : null };
}

/**
 * One POST to the start route. Never throws. Only an answer our route wrote counts as an answer: a `start` object, or an `error`
 * word it knows. Anything else (a gateway's HTML 502, a 200 cut off mid-body) is `network`: the start may have committed behind it,
 * so the key is kept and the screen never says "nothing was held" (rule 5; Lens H1).
 */
async function postStart(filmId: string, quoteId: string, idem: string): Promise<Sent> {
  let res: Response;
  try {
    res = await fetch(`/api/films/${encodeURIComponent(filmId)}/start`, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote_id: quoteId, idem }),
    });
  } catch {
    return { kind: "network" };
  }
  const body = await jsonObject(res);
  if (!res.ok) {
    // The session gate answers before the database is asked, so a 401 is never a start that went through.
    if (res.status === 401) return { kind: "http", error: "session_expired", ...extraOf(res, body) };
    const word = body?.error;
    if (typeof word === "string" && (FILM_ERRORS as readonly string[]).includes(word)) return { kind: "http", error: word as FilmError, ...extraOf(res, body) };
    return { kind: "network" };
  }
  const s = body?.start;
  const r = s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : null;
  if (!r) return { kind: "network" };
  if (r.ok === true) return { kind: "outcome", ok: true, replayed: r.replayed === true };
  // The raw word, not coerceStart's narrowed one: start_film also answers a line's own unpriced word (film_price's refusal), and
  // narrowing it to "other" is the "will not start right now" with no remedy that Pixel found.
  return { kind: "outcome", ok: false, word: typeof r.reason === "string" && WORD_RE.test(r.reason) ? r.reason : "unknown" };
}

/** A failed re-quote: its FilmError word (so a 401 is told from a 404 or a 429), and what came with it. */
export class RequoteError extends Error {
  constructor(
    word: string,
    readonly extra: RefusalExtra = { detail: null, retryAfter: null },
  ) {
    super(word);
  }
}

/**
 * The default re-quote: the project's current version (an edit after the quote is also answered `price_changed`, so the version in
 * the old quote id may be stale), then quote_film at it. Spends nothing.
 */
export async function requoteFilm(filmId: string): Promise<FilmQuote | null> {
  const film = await filmsApi().get(filmId);
  if (!film.ok) throw new RequoteError(film.error);
  let res: Response;
  try {
    res = await fetch(`/api/films/${encodeURIComponent(filmId)}/quote`, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: film.data.film.version }),
    });
  } catch {
    throw new RequoteError("network");
  }
  const body = await jsonObject(res);
  if (!res.ok) throw new RequoteError(filmErrorFromResponse(res.status, body).error, extraOf(res, body));
  return coerceQuote(body?.quote);
}

export interface UseFilmStart {
  state: FilmStartState;
  /** True once a start or a re-quote has waited 10 s: the screen says "Still working…" instead of looking frozen. */
  slow: boolean;
  /** A rate limit's Retry-After has not passed yet: the key waits with it rather than spend another try. */
  cooling: boolean;
  /** After a 401: false until the person is back on this page (focus or visibility), so the key cannot be pressed signed out. */
  canResume: boolean;
  /** The main key: opens the confirmation, asks for a new price after a refusal, or retries a start that got no answer. */
  press: () => void;
  confirm: () => void;
  cancel: () => void;
  /** Ask for the price again: "Get a price" with no quote, "Check again" for a blocked one. Spends nothing. */
  recheck: () => void;
}

export const SLOW_MS = 10_000;

/**
 * `quote`: the server's FilmQuote (coerceQuote of quote_film's answer), or null. `requote`: returns a fresh quote; it defaults to
 * {@link requoteFilm}. `onStarted`: called once per start that went through (a replay included).
 *
 * The idempotency key is minted once per confirmed press and forgotten only after a terminal answer (started, or a refusal): a retry
 * after no answer sends the same key, so it replays the first start instead of holding twice. A second press while one is in flight
 * sends nothing. A new `filmId` is a new press: the state goes back to what its quote allows, and an answer that arrives for the old
 * project is dropped (each send and re-quote carries a generation; Lens M2). Callers should still pass `key={filmId}`.
 *
 * Known limit (Lens L4): unmounting mid-start forgets that the start may have gone through. Nothing double-charges for it: a new
 * press mints a new key, and start_film refuses a second start of a project that already started (film_not_startable).
 */
export function useFilmStart({
  filmId,
  quote,
  requote,
  onStarted,
}: {
  filmId: string;
  quote: FilmQuote | null;
  requote?: () => Promise<FilmQuote | null>;
  onStarted?: (result: { replayed: boolean }) => void;
}): UseFilmStart {
  const [state, setStateRaw] = useState<FilmStartState>(() => stateOfQuote(quote));
  const stateRef = useRef(state);
  const setState = useCallback((s: FilmStartState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);
  const [slow, setSlow] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [canResume, setCanResume] = useState(false);

  // The quote a start is sent for. Read inside the starter, so a retry sends the quote of the press it repeats.
  const sending = useRef<FilmQuote | null>(null);
  const starter = useMemo(
    () =>
      startOnce((idem: string) => {
        const q = sending.current;
        if (!q?.quoteId) return Promise.resolve<Sent>({ kind: "http", error: "bad_request", detail: null, retryAfter: null });
        return postStart(filmId, q.quoteId, idem);
      }, newIdempotencyKey),
    [filmId],
  );
  const requoting = useRef(false);
  const requoteRef = useRef(requote);
  requoteRef.current = requote;
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;
  const latestQuote = useRef(quote);
  latestQuote.current = quote;

  // Which project's answers count. Bumped when the project changes; an answer stamped with an older one is dropped.
  const generation = useRef(0);
  const shownFilm = useRef(filmId);
  useEffect(() => {
    if (shownFilm.current === filmId) return;
    shownFilm.current = filmId;
    generation.current += 1;
    requoting.current = false;
    sending.current = null;
    setState(stateOfQuote(latestQuote.current));
  }, [filmId, setState]);

  // A new quote from the parent replaces whatever the key showed, unless a start or a re-quote is waiting for its answer (a start
  // that may go through keeps its key) or the start already went through.
  const key = quoteKey(quote);
  const seenKey = useRef(key);
  useEffect(() => {
    if (seenKey.current === key) return;
    seenKey.current = key;
    const at = stateRef.current.at;
    if (starter.busy || requoting.current || at === "started" || at === "starting" || at === "network_error" || at === "session_expired") return;
    starter.reset();
    setState(stateOfQuote(latestQuote.current));
  }, [key, starter, setState]);

  // Another project is another press: never carry a key across.
  useEffect(() => () => starter.reset(), [starter]);

  useEffect(() => {
    if (state.at !== "starting" && state.at !== "requoting") return;
    const h = setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      clearTimeout(h);
      setSlow(false);
    };
  }, [state.at]);

  const retryAfter = state.at === "refused" || state.at === "requote_failed" ? state.retryAfter : null;
  useEffect(() => {
    if (retryAfter === null) return;
    setCooling(true);
    const h = setTimeout(() => setCooling(false), retryAfter * 1000);
    return () => {
      clearTimeout(h);
      setCooling(false);
    };
  }, [retryAfter, state]);

  // Signing in happens elsewhere; the key comes back once the person does.
  useEffect(() => {
    if (state.at !== "session_expired") return;
    setCanResume(false);
    const back = () => {
      if (document.visibilityState === "visible") setCanResume(true);
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [state.at]);

  const askAgain = useCallback(
    async (from: FilmQuote | null) => {
      if (requoting.current || starter.busy) return;
      const gen = generation.current;
      requoting.current = true;
      setState({ at: "requoting", from });
      try {
        const q = await (requoteRef.current ?? (() => requoteFilm(filmId)))();
        if (gen !== generation.current) return;
        if (!q) {
          setState({ at: "requote_failed", from, word: "failed", remedy: startRemedy("failed"), detail: null, retryAfter: null });
          return;
        }
        const s = stateOfQuote(q);
        if (s.at === "blocked") {
          setState(s);
          return;
        }
        // A new total is never started on the old confirmation: the person confirms it, seeing what it was and how far it moved.
        const change = from && from.total !== null && q.total !== null ? { from: from.total, to: q.total, delta: q.total - from.total } : null;
        setState({ at: "confirming", quote: q, change });
      } catch (e) {
        if (gen !== generation.current) return;
        const word = e instanceof Error && WORD_RE.test(e.message) ? e.message : "failed";
        const extra = e instanceof RequoteError ? e.extra : { detail: null, retryAfter: null };
        if (word === "session_expired") setState({ at: "session_expired", resume: { kind: "requote", from } });
        else setState({ at: "requote_failed", from, word, remedy: startRemedy(word), ...extra });
      } finally {
        if (gen === generation.current) requoting.current = false;
      }
    },
    [filmId, starter, setState],
  );

  const send = useCallback(
    async (q: FilmQuote) => {
      const gen = generation.current;
      sending.current = q;
      setState({ at: "starting", quote: q });
      const out = await starter.run();
      if (gen !== generation.current) return;
      if (out.kind === "network") {
        setState({ at: "network_error", quote: q });
        return;
      }
      if (out.kind === "http" && out.error === "session_expired") {
        // The route answered before the database was asked: nothing started. The key stays with this press for after sign-in.
        setState({ at: "session_expired", resume: { kind: "start", quote: q } });
        return;
      }
      // Every other answer is terminal for this press: the key is forgotten, so the next press can never be read as this one.
      starter.reset();
      if (out.kind === "outcome" && out.ok) {
        setState({ at: "started", replayed: out.replayed });
        onStartedRef.current?.({ replayed: out.replayed });
        return;
      }
      const word = out.kind === "http" ? out.error : out.word;
      if (word === "price_changed" || word === "quote_expired") {
        void askAgain(q);
        return;
      }
      const extra = out.kind === "http" ? { detail: out.detail, retryAfter: out.retryAfter } : { detail: null, retryAfter: null };
      setState({ at: "refused", word, remedy: startRemedy(word), quote: q, ...extra });
    },
    [starter, askAgain, setState],
  );

  const coolingRef = useRef(cooling);
  coolingRef.current = cooling;
  const resumeRef = useRef(canResume);
  resumeRef.current = canResume;

  const press = useCallback(() => {
    const s = stateRef.current;
    if (starter.busy || requoting.current || coolingRef.current) return;
    if (s.at === "idle") setState({ at: "confirming", quote: s.quote, change: null });
    else if (s.at === "network_error") void send(s.quote);
    else if (s.at === "session_expired") {
      if (resumeRef.current) void (s.resume.kind === "start" ? send(s.resume.quote) : askAgain(s.resume.from));
    } else if (s.at === "refused" && s.remedy !== "none" && s.remedy !== "sign_in") void askAgain(s.quote);
    else if (s.at === "requote_failed" && s.remedy !== "none") void askAgain(s.from);
  }, [starter, send, askAgain, setState]);

  const recheck = useCallback(() => {
    const s = stateRef.current;
    if (starter.busy || requoting.current || coolingRef.current) return;
    if (s.at === "blocked") void askAgain(s.quote);
    else if (s.at === "refused") void askAgain(s.quote);
    else if (s.at === "requote_failed" && s.remedy !== "none") void askAgain(s.from);
  }, [starter, askAgain]);

  const confirm = useCallback(() => {
    const s = stateRef.current;
    if (s.at !== "confirming" || starter.busy) return;
    nsMarkOnce("ns:create:confirm");
    void send(s.quote);
  }, [starter, send]);

  const cancel = useCallback(() => {
    const s = stateRef.current;
    if (s.at !== "confirming") return;
    setState(stateOfQuote(s.quote));
  }, [setState]);

  return { state, slow, cooling, canResume, press, confirm, cancel, recheck };
}
