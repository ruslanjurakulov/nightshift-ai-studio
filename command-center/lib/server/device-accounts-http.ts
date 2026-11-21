import "server-only";
import { NextResponse } from "next/server";
import { SMALL_BODY_BYTES, readJsonBodyCapped } from "@/lib/server/json-body";

export const NO_STORE = { "cache-control": "no-store" };

export function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** The small JSON object these routes take, or null for anything else (too large, not JSON, not an object). */
export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const read = await readJsonBodyCapped(request, SMALL_BODY_BYTES);
  if (!read.ok || !read.value || typeof read.value !== "object" || Array.isArray(read.value)) return null;
  return read.value as Record<string, unknown>;
}
