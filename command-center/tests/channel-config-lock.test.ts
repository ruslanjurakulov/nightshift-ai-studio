import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Breach wave 7 (BR-G-002, BR-G-003), migration 0086: the browser no longer
 * writes a channel's credential, status or id, and no longer inserts a channel
 * row. The database refuses those writes whoever sends them; this pins that the
 * Command Center does not send them, so a new component cannot reintroduce a
 * write the database would only refuse at the user.
 */

const ROOT = join(__dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "tests") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = ["app", "components", "lib"].flatMap((d) => sources(join(ROOT, d)));

describe("channel writes go through the channel functions", () => {
  it("no source inserts into `channels` or writes credential_ref / status on it", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      // from("channels") ... .insert( / .upsert( / .update({ ...credential_ref|status... })
      for (const m of text.matchAll(/from\("channels"\)\s*\.(insert|upsert|update|delete)\(([\s\S]{0,400}?)\)\s*\n?\s*\.eq|from\("channels"\)\s*\.(insert|upsert|delete)\(/g)) {
        const op = m[1] ?? m[3];
        const body = m[2] ?? "";
        if (op !== "update" || /credential_ref|\bstatus\b|channel_id\s*:/.test(body)) {
          offenders.push(`${relative(ROOT, file)}: ${op}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the wizard creates a channel with create_channel and never sends a stamp of its own", () => {
    const text = readFileSync(join(ROOT, "components/channels/AddChannelWizard.tsx"), "utf8");
    expect(text).toContain('supabase.rpc("create_channel"');
    expect(text).toContain("p_verified: canConfirm");
    expect(text).not.toContain("verified_at:");
    expect(text).not.toMatch(/from\("channels"\)\s*\.insert/);
  });

  it("pause and activate go through set_channel_status", () => {
    const text = readFileSync(join(ROOT, "components/channels/ChannelCard.tsx"), "utf8");
    expect(text).toContain('supabase.rpc("set_channel_status"');
    expect(text).not.toMatch(/\.update\(\{\s*status/);
  });

  it("the controls an administrator holds are disabled for anyone else", () => {
    const text = readFileSync(join(ROOT, "components/channels/ChannelCard.tsx"), "utf8");
    expect(text).toContain("disabled={autoBusy || pending || !canControl}");
    expect(text).toContain("disabled={reviewBusy || pending || !canControl}");
    const page = readFileSync(join(ROOT, "app/(app)/[channel]/channels/page.tsx"), "utf8");
    expect(page).toContain('canControl={atLeast(orgRole, "admin")}');
  });
});
