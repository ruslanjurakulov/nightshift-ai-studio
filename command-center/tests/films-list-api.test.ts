/**
 * filmsApi().list reads GET /api/films's answer. The route sends rows it already read (coerceFilmList → camelCase); the browser once
 * read them again as database rows and dropped every one, so FilmList's archived tab (the only client-side list read) was always empty.
 */
import { describe, expect, it } from "vitest";
import { coerceFilmList, filmsApi } from "../lib/films";
import { FILM } from "./films-fixtures";

const row = {
  id: FILM, channel_id: "night-owl", title: "Football in 2050", source_kind: "topic", language: "en", aspect: "16:9",
  target_seconds: 300, status: "archived", updated_at: "2026-11-14T09:00:00Z", archived_at: "2026-11-14T10:00:00Z",
};

describe("filmsApi().list", () => {
  it("keeps the rows the route sends (the route's own coerced shape, round-tripped through JSON)", async () => {
    const routeBody = JSON.stringify({ films: coerceFilmList([row]) });
    const api = filmsApi((async () => new Response(routeBody, { status: 200 })) as typeof fetch);
    const r = await api.list(true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(coerceFilmList([row]));
  });

  it("still drops a row that is not a project", async () => {
    const api = filmsApi((async () => new Response(JSON.stringify({ films: [{ id: "nope" }] }), { status: 200 })) as typeof fetch);
    const r = await api.list();
    expect(r.ok && r.data).toEqual([]);
  });
});
