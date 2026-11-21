// @vitest-environment jsdom
/**
 * The project's data and state (components/films/useFilmProject), apart from any view of it. What would break without these: a board
 * edit (split, merge, insert, delete, reorder) that reaches anything but save_film, or anything that spends; undo that forgets after a
 * few steps, or redo that survives a new edit; a refresh or a closed tab that loses the unsaved work; an old buffer applied silently
 * over someone else's newer save; and the film's language tied to the screen's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { coerceFilmView, filmsApi, type FilmView } from "../lib/films";
import { FILM, S1, S2, filmJson, sceneJson } from "./films-fixtures";

const { useFilmProject, splitText, readPending, AUTOSAVE_IDLE_MS, UNDO_DEPTH } = await import("../components/films/useFilmProject");

let calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
let version = 3;

function serverAnswer(method: string, body: Record<string, unknown> | undefined) {
  if (method !== "PATCH") return { status: 200, body: { film: filmJson({ version }) } };
  const patch = body?.patch as { scenes?: Record<string, unknown>[]; language?: string; title?: string };
  version += 1;
  const scenes = patch.scenes
    ? patch.scenes.map((s, i) => sceneJson(String(s.id ?? `5${i}000000-0000-4000-8000-00000000000${i % 10}`), i, s))
    : [sceneJson(S1, 0, { planned_seconds: 12, narration: "One. Two." }), sceneJson(S2, 1)];
  return { status: 200, body: { film: filmJson({ version, ...(patch.language ? { language: patch.language } : {}), ...(patch.title ? { title: patch.title } : {}) }, scenes) } };
}

const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  calls.push({ method, url, body });
  const a = serverAnswer(method, body);
  return new Response(JSON.stringify(a.body), { status: a.status });
}) as unknown as typeof fetch;

const start = (v: FilmView = coerceFilmView(filmJson({}, [sceneJson(S1, 0, { planned_seconds: 12, narration: "One. Two." }), sceneJson(S2, 1)]))!) =>
  renderHook(() => useFilmProject(v, true, filmsApi(fakeFetch)));

beforeEach(() => {
  calls = [];
  version = 3;
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("board edits are free", () => {
  it("split, merge, insert, delete, reorder and retime reach only save_film's route, as one PATCH of the draft", async () => {
    vi.useFakeTimers();
    const { result } = start();
    act(() => {
      const added = result.current.addScene(1);
      result.current.split(result.current.draft.scenes[0].key);
      result.current.moveTo(added!.key, 0);
      result.current.merge(result.current.draft.scenes[1].key);
      result.current.changeScene(result.current.draft.scenes[0].key, { plannedSeconds: 10 }, "length");
      result.current.remove(result.current.draft.scenes.at(-1)!.key);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS + 100);
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url).toBe(`/api/films/${FILM}`);
      expect(c.method).toBe("PATCH");
      expect(Object.keys(c.body?.patch as object).every((k) => ["scenes", "refs", "title", "language", "aspect", "target_seconds"].includes(k))).toBe(true);
    }
    expect(calls.some((c) => /quote|start|credit|hold|render|creative/i.test(c.url))).toBe(false);
  });

  it("split halves the length and the narration at a sentence; the second part continues from the first", () => {
    const { result } = start();
    act(() => void result.current.split(result.current.draft.scenes[0].key));
    const [a, b] = result.current.draft.scenes;
    expect([a.plannedSeconds, b.plannedSeconds]).toEqual([6, 6]);
    expect([a.narration, b.narration]).toEqual(["One.", "Two."]);
    expect(b).toMatchObject({ id: null, firstFrame: "previous" });
    expect(a.lastFrame).toBe("none");
  });

  it("merge adds the lengths, refuses past the scene limit (never cuts), and refuses the last scene", () => {
    const { result } = start();
    let r: ReturnType<typeof result.current.merge> = null;
    act(() => {
      r = result.current.merge(result.current.draft.scenes[1].key);
    });
    expect(r).toEqual({ refused: "last" });
    act(() => {
      r = result.current.merge(result.current.draft.scenes[0].key);
    });
    expect(result.current.draft.scenes).toHaveLength(1);
    expect(result.current.draft.scenes[0].plannedSeconds).toBe(20);
    act(() => void result.current.addScene(0));
    act(() => result.current.changeScene(result.current.draft.scenes[1].key, { plannedSeconds: 15 }, "length"));
    act(() => {
      r = result.current.merge(result.current.draft.scenes[0].key);
    });
    expect(r).toEqual({ refused: "too_long" });
    expect(result.current.draft.scenes).toHaveLength(2);
  });

  it("splitText cuts at the sentence end nearest the middle, else at a space", () => {
    expect(splitText("A b c. D e f. G h.")).toEqual(["A b c.", "D e f. G h."]);
    expect(splitText("One two three. Four five six seven eight. Nine.")).toEqual(["One two three.", "Four five six seven eight. Nine."]);
    expect(splitText("one two three four")).toEqual(["one two", "three four"]);
    expect(splitText("")).toEqual(["", ""]);
    expect(splitText("single")).toEqual(["single", ""]);
  });
});

describe("undo and redo", () => {
  it(`hold at least ${UNDO_DEPTH} steps, both ways, and a new edit clears redo`, () => {
    const { result } = start(coerceFilmView(filmJson({}, [sceneJson(S1, 0)]))!);
    const original = JSON.stringify(result.current.draft);
    for (let i = 0; i < UNDO_DEPTH; i++) act(() => void result.current.addScene(null));
    const final = JSON.stringify(result.current.draft);
    expect(result.current.draft.scenes).toHaveLength(UNDO_DEPTH + 1);
    for (let i = 0; i < UNDO_DEPTH; i++) act(() => void result.current.undo());
    expect(JSON.stringify(result.current.draft)).toBe(original);
    expect(result.current.canUndo).toBe(false);
    for (let i = 0; i < UNDO_DEPTH; i++) act(() => void result.current.redo());
    expect(JSON.stringify(result.current.draft)).toBe(final);
    act(() => void result.current.undo());
    act(() => result.current.changeSettings({ title: "New" }, "title"));
    expect(result.current.canRedo).toBe(false);
  });

  it("typing into one field is one step, not one per keystroke", () => {
    const { result } = start();
    const key = result.current.draft.scenes[0].key;
    act(() => {
      for (const v of ["a", "ab", "abc"]) result.current.changeScene(key, { title: v }, "title");
    });
    act(() => void result.current.undo());
    expect(result.current.draft.scenes[0].title).toBe("Scene 1");
  });

  it("an undo is saved like any edit (through save_film)", async () => {
    vi.useFakeTimers();
    const { result } = start();
    act(() => void result.current.remove(result.current.draft.scenes[1].key));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS + 100);
    });
    act(() => void result.current.undo());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect((patches[1].body?.patch as { scenes: unknown[] }).scenes).toHaveLength(2);
  });
});

describe("a refresh or a closed tab loses nothing", () => {
  it("keeps unsaved edits in this browser and puts them back on the next load of the same version", () => {
    const first = start();
    act(() => first.result.current.changeSettings({ title: "Not saved yet" }, "title"));
    expect(readPending(FILM)?.draft.settings.title).toBe("Not saved yet");
    first.unmount();
    const again = start();
    expect(again.result.current.draft.settings.title).toBe("Not saved yet");
    expect(again.result.current.recovered).toBe("restored");
    expect(again.result.current.dirty).toBe(true);
    // Undo goes back to what the server has.
    act(() => void again.result.current.undo());
    expect(again.result.current.draft.settings.title).toBe("The stadium in orbit");
  });

  it("does not apply edits made on an older version until the person says so", () => {
    const first = start();
    act(() => first.result.current.changeSettings({ title: "Mine" }, "title"));
    first.unmount();
    const newer = coerceFilmView(filmJson({ version: 9, title: "Theirs" }, [sceneJson(S1, 0)]))!;
    const again = start(newer);
    expect(again.result.current.draft.settings.title).toBe("Theirs");
    expect(again.result.current.recovered).toMatchObject({ stale: expect.anything() });
    expect(readPending(FILM)?.draft.settings.title).toBe("Mine");
    act(() => again.result.current.applyStale());
    expect(again.result.current.draft.settings.title).toBe("Mine");
  });

  it("drops a broken buffer instead of half-applying it, and clears the buffer once saved", async () => {
    window.localStorage.setItem(`ns.films.pending.${FILM}`, JSON.stringify({ v: 1, version: 3, draft: { settings: {} } }));
    const { result } = start();
    expect(result.current.recovered).toBeNull();
    expect(window.localStorage.getItem(`ns.films.pending.${FILM}`)).toBeNull();
    act(() => result.current.changeSettings({ title: "Saved soon" }, "title"));
    expect(readPending(FILM)).not.toBeNull();
    await act(async () => {
      await result.current.save();
    });
    expect(readPending(FILM)).toBeNull();
  });
});

describe("the film's language", () => {
  it("is its own setting, saved as the project's, whatever the screen's language is", async () => {
    const { result } = start();
    act(() => result.current.changeSettings({ language: "uz" }, "language"));
    await act(async () => {
      await result.current.save();
    });
    expect(calls.at(-1)?.body?.patch).toEqual({ language: "uz" });
    expect(result.current.view.film.language).toBe("uz");
  });
});
