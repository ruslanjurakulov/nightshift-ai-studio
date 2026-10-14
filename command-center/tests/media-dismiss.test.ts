import { describe, expect, it, vi } from "vitest";

/**
 * The hide list behind the Dismiss button (lib/media-dismiss.ts) and the
 * library read that applies it. What would break without these: a hand-edited
 * metadata value crashing the page or hiding things it should not; an
 * in-flight card being hidden because its id was once on the list; the library
 * going blank when the person's metadata cannot be read; and another person's
 * dismissal leaking into this person's list.
 */

vi.mock("server-only", () => ({}));

const ORG = "0a000000-0000-4000-8000-00000000000a";
const id = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const h = vi.hoisted(() => ({
  meta: undefined as unknown,
  authThrows: false,
  noAuth: false,
  rows: [] as Record<string, unknown>[],
}));

function builder(result: () => unknown): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return () => q;
    },
  });
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (name: string) => builder(() => ({ data: name === "media_uploads" ? h.rows : [], error: null })),
    rpc: () => builder(() => ({ data: null, error: null })),
    ...(h.noAuth
      ? {}
      : {
          auth: {
            getUser: async () => {
              if (h.authThrows) throw new Error("down");
              return { data: { user: { user_metadata: h.meta } }, error: null };
            },
          },
        }),
  }),
  getUser: async () => ({ id: "u1" }),
}));

const { DISMISS_MAX, DISMISS_META_KEY, isDismissableStatus, parseDismissed, withDismissed, withoutDismissed } = await import("../lib/media-dismiss");
const { loadMediaLibrary } = await import("../lib/server/media");
const { coerceUploads } = await import("../lib/media");

const row = (n: number, status: string) => ({ id: id(n), original_name: `f${n}.png`, status, declared_bytes: 5, received_bytes: 5, reason: null });

describe("the hide list", () => {
  it("reads only canonical ids, once each, and survives any junk a person wrote into their own metadata", () => {
    for (const junk of [undefined, null, "x", 5, [], { [DISMISS_META_KEY]: "x" }, { [DISMISS_META_KEY]: { a: 1 } }]) {
      expect(parseDismissed(junk)).toEqual([]);
    }
    expect(parseDismissed({ [DISMISS_META_KEY]: [id(1), "no", 3, id(1), null, id(2)] })).toEqual([id(1), id(2)]);
  });

  it("is capped on the way in and on the way out", () => {
    const big = Array.from({ length: DISMISS_MAX + 25 }, (_, i) => id(i + 1));
    expect(parseDismissed({ [DISMISS_META_KEY]: big })).toHaveLength(DISMISS_MAX);
    expect(withDismissed(big, id(5000))).toHaveLength(DISMISS_MAX);
    expect(withDismissed(big, id(5000))[0]).toBe(id(5000));
  });

  it("only a rejected or expired ticket is dismissable", () => {
    for (const s of ["rejected", "expired"]) expect(isDismissableStatus(s)).toBe(true);
    for (const s of ["requested", "receiving", "uploaded", "ingesting", "ingested", "", null, undefined, 3]) expect(isDismissableStatus(s)).toBe(false);
  });

  it("hides dismissed cards that ended badly, and never one that is still working", () => {
    const ups = coerceUploads([row(1, "rejected"), row(2, "expired"), row(3, "uploaded"), row(4, "rejected")]);
    const out = withoutDismissed(ups, new Set([id(1), id(2), id(3)]));
    expect(out.map((u) => u.id)).toEqual([id(3), id(4)]);
  });
});

describe("loadMediaLibrary applies the person's list", () => {
  const read = async () => (await loadMediaLibrary(ORG)).uploads.map((u) => u.id);

  it("dismissed cards are gone after a reload; the others stay", async () => {
    h.noAuth = false;
    h.authThrows = false;
    h.rows = [row(1, "rejected"), row(2, "expired"), row(3, "receiving")];
    h.meta = { [DISMISS_META_KEY]: [id(1)] };
    expect(await read()).toEqual([id(2), id(3)]);
    h.meta = {};
    expect(await read()).toEqual([id(1), id(2), id(3)]);
  });

  it("an id on the list does not hide a ticket that is still on its way", async () => {
    h.noAuth = false;
    h.rows = [row(3, "receiving")];
    h.meta = { [DISMISS_META_KEY]: [id(3)] };
    expect(await read()).toEqual([id(3)]);
  });

  it("when the person cannot be read, nothing is hidden and the library still loads", async () => {
    h.rows = [row(1, "rejected")];
    h.meta = { [DISMISS_META_KEY]: [id(1)] };
    h.authThrows = true;
    expect(await read()).toEqual([id(1)]);
    h.authThrows = false;
    h.noAuth = true;
    const lib = await loadMediaLibrary(ORG);
    expect(lib.available).toBe(true);
    expect(lib.error).toBeUndefined();
    expect(lib.uploads.map((u) => u.id)).toEqual([id(1)]);
  });
});
