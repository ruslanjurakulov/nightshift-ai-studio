import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { devEn } from "@/lib/i18n/site/dev-en";
import { devRu } from "@/lib/i18n/site/dev-ru";
import { devUz } from "@/lib/i18n/site/dev-uz";
import { MCP_CLIENTS, MCP_CLIENT_IDS, MCP_TOOL_IDS } from "@/lib/dev/mcp-clients";
import { CLI_COMMANDS, SKILLS } from "@/lib/dev/cli-skills";
import { TOOL_NAMES } from "@/lib/api/mcp";
import { PROVIDER_BRANDS } from "./helpers/brands";

/**
 * The developer pages' copy (lib/i18n/site/dev-*.ts) is complete in all three
 * languages: the same keys, list lengths, ids and {placeholders}, no empty
 * string. The lists that are code (clients, tools, commands, skills) have
 * exactly one entry of copy per id, in the same order in every language.
 */
type Node = string | number | boolean | null | Node[] | { [k: string]: Node };

function walk(a: Node, b: Node, path: string, out: string[]) {
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return void out.push(`${path}: not a list`);
    if (a.length !== b.length) out.push(`${path}: ${a.length} vs ${b.length} items`);
    a.forEach((x, i) => b[i] !== undefined && walk(x, b[i], `${path}[${i}]`, out));
    return;
  }
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object" || Array.isArray(b)) return void out.push(`${path}: not an object`);
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${path}: keys ${ka.join(",")} vs ${kb.join(",")}`);
    for (const k of ka) {
      if (!(k in b)) continue;
      // ids and status codes are data, not copy: they must match exactly.
      if ((k === "id" || k === "status") && a[k] !== b[k]) out.push(`${path}.${k}: ${String(a[k])} vs ${String(b[k])}`);
      walk(a[k], b[k], `${path}.${k}`, out);
    }
    return;
  }
  if (typeof a === "string") {
    if (typeof b !== "string") return void out.push(`${path}: not a string`);
    if (!b.trim()) out.push(`${path}: empty`);
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    if (ph(a) !== ph(b)) out.push(`${path}: placeholders ${ph(a)} vs ${ph(b)}`);
  }
}

function strings(n: Node): string[] {
  if (typeof n === "string") return [n];
  if (Array.isArray(n)) return n.flatMap(strings);
  if (n && typeof n === "object") return Object.values(n).flatMap(strings);
  return [];
}

describe("developer pages copy", () => {
  it.each([
    ["ru", devRu],
    ["uz", devUz],
  ] as const)("is complete in %s, with the same shape, ids and placeholders as English", (_, dict) => {
    const out: string[] = [];
    walk(devEn as unknown as Node, dict as unknown as Node, "dev", out);
    expect(out).toEqual([]);
  });

  it.each([
    ["en", devEn],
    ["ru", devRu],
    ["uz", devUz],
  ] as const)("names no AI model or provider and no team-role word (%s)", (_, dict) => {
    // The assistants a person connects FROM are named on the MCP page (they are
    // the tools the page is about); no model or provider that does the work is.
    const clients = /\b(?:claude|chatgpt|gemini|openai|anthropic)\b/gi;
    for (const s of strings(dict as unknown as Node)) {
      expect(s.replace(clients, "")).not.toMatch(PROVIDER_BRANDS);
      expect(s).not.toMatch(/\b(?:owner|viewer)s?\b/i);
    }
  });

  it("types no money amount into the copy: prices come from the live list", () => {
    const MONEY = /[$€£₽]\s?\d|\d\s?(?:USD|EUR|UZS|RUB|so'm|сум)\b/i;
    for (const dict of [devEn, devRu, devUz]) for (const s of strings(dict as unknown as Node)) expect(s).not.toMatch(MONEY);
  });

  it("has one entry of copy per MCP client, tool, command and skill — in code order, in every language", () => {
    expect(MCP_CLIENT_IDS).toHaveLength(MCP_CLIENTS.length);
    for (const dict of [devEn, devRu, devUz]) {
      expect(dict.mcp.clients.map((c) => c.id)).toEqual(MCP_CLIENT_IDS);
      expect(dict.mcp.tools.list.map((t) => t.id)).toEqual([...MCP_TOOL_IDS]);
      expect(Object.keys(dict.mcp.tools.paid).sort()).toEqual(["create_video", "request_download"]);
      expect(dict.cli.commands.list.map((c) => c.id)).toEqual(CLI_COMMANDS.map((c) => c.id));
      expect(dict.skills.list.items.map((s) => s.id)).toEqual(SKILLS.map((s) => s.id));
      expect(dict.cli.steps.map((s) => s.id)).toEqual(["install", "login", "run"]);
    }
  });

  it("lists the tools the server really has, in the server's order", () => {
    expect([...MCP_TOOL_IDS]).toEqual([...TOOL_NAMES]);
  });

  it("lists the CLI's real commands, in its own order (packages/cli, docs/CLI.md)", () => {
    const root = join(__dirname, "..", "..", "packages", "cli", "bin");
    const bin = join(root, readdirSync(root)[0]);
    const table = JSON.parse(execFileSync("node", [bin, "commands", "--json"], { encoding: "utf8" })) as { commands: { name: string }[] };
    const real = table.commands.map((c) => c.name).filter((n) => n !== "commands" && n !== "help");
    const typed = CLI_COMMANDS.map((c) => c.command.replace(/^nightshift /, "").split(/ (?:--|[A-Z\[])/)[0].trim());
    expect(typed).toEqual(real);
    for (const c of CLI_COMMANDS) expect(c.command.startsWith("nightshift ")).toBe(true);
  });

  it("lists the skills that are really in skills/", () => {
    const dir = join(__dirname, "..", "..", "skills");
    const real = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(SKILLS.map((s) => s.name).sort()).toEqual(real);
  });
});
