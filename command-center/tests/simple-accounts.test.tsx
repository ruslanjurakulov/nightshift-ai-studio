// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Two kinds of people (migration 0091): an ordinary signed-in user who owns
 * everything in their own workspace, and the platform operator. Nothing a
 * customer can open names a role, offers an invitation, or lists a team.
 * What would break without these: the Settings page growing a team board
 * again, a role word creeping back into customer copy, or a screen calling an
 * invite function the database no longer allows.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/organization",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { WorkspaceNameForm } from "@/components/org/WorkspaceNameForm";
import { CUSTOMER_NAV_KEYS, CUSTOMER_SECTIONS, isOperatorOnlySection, sectionAllowed } from "@/lib/navigation";

afterEach(cleanup);

const ROOT = path.resolve(__dirname, "..");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Role and invitation words, per language. "Editor" the tool is not a role. */
const ROLE_WORDS: Record<Locale, RegExp> = {
  en: /\b(owners?|admins?|administrators?|viewers?|roles?|invit\w+|teammates?)\b|\beditors? (role|or higher|or above)\b/i,
  ru: /админ|наблюдател|\bрол[ьиюе]\b|приглаш/i,
  uz: /admin|kuzatuvchi|\brol(lar)?\b|taklifnoma/i,
};

/** The namespaces a customer reaches (their screens, refusals and the public site). */
const CUSTOMER_NAMESPACES = [
  "org",
  "create",
  "publish",
  "socialAccounts",
  "channelTokens",
  "channels",
  "series",
  "media",
  "creative",
  "developers",
  "assistant",
  "shell",
  "notifications",
  "site",
] as const;

function strings(node: unknown, trail: string, out: [string, string][] = []): [string, string][] {
  if (typeof node === "string") out.push([trail, node]);
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) strings(v, `${trail}.${k}`, out);
  return out;
}

describe("customer copy names no role and no invitation", () => {
  for (const locale of ["en", "ru", "uz"] as const) {
    it(`(${locale}) the namespaces a customer reaches`, () => {
      const dict = dictionaries[locale] as unknown as Record<string, unknown>;
      const hits: string[] = [];
      for (const ns of CUSTOMER_NAMESPACES) {
        for (const [key, text] of strings(dict[ns], ns)) {
          if (ROLE_WORDS[locale].test(text)) hits.push(`${key}: ${text.slice(0, 90)}`);
        }
      }
      expect(hits).toEqual([]);
    });
  }

  it("the invitation and team keys are gone from the dictionary", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const dict = dictionaries[locale] as unknown as Record<string, Record<string, unknown>>;
      expect(dict.invites).toBeUndefined();
      for (const k of ["inviteTitle", "inviteNote", "emailInvalid", "lastOwner", "subtitle"]) expect(dict.org[k]).toBeUndefined();
    }
  });
});

describe("Settings", () => {
  it("is the workspace name, with no role card, invitation form or members table", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const org = { id: "o1", name: "My Studio", slug: "my-studio", role: "owner", is_default: false } as never;
      const { container, unmount } = render(
        <I18nProvider locale={locale}>
          <WorkspaceNameForm org={org} />
        </I18nProvider>,
      );
      const text = container.textContent ?? "";
      expect(text).not.toMatch(ROLE_WORDS[locale]);
      expect(container.querySelector('input[type="email"]')).toBeNull();
      expect(container.querySelector("select")).toBeNull();
      expect(container.querySelector("table")).toBeNull();
      expect((container.querySelector("input") as HTMLInputElement).value).toBe("My Studio");
      unmount();
    }
  });

  it("the page is built from the name form and a Developers entry, not a team board", () => {
    const page = readFileSync(path.join(ROOT, "app/(app)/[channel]/organization/page.tsx"), "utf8");
    expect(page).toContain("WorkspaceNameForm");
    expect(page).toContain('path("/developers")');
    expect(page).not.toMatch(/OrgMembersBoard|PendingInvites|MembersBoard/);
    expect(existsSync(path.join(ROOT, "components/org/OrgMembersBoard.tsx"))).toBe(false);
    expect(existsSync(path.join(ROOT, "components/org/PendingInvites.tsx"))).toBe(false);
  });

  it("Developers is its own entry, not a tab under Settings", () => {
    expect(CUSTOMER_NAV_KEYS).toContain("developers");
    expect(CUSTOMER_SECTIONS).toContain("developers");
    expect(CUSTOMER_SECTIONS).toContain("organization");
  });
});

describe("the operator's roster is the operator's", () => {
  it("a customer cannot open the team, approvals or platform screens", () => {
    for (const s of ["members", "approvals", "providers", "margin", "accounts"]) {
      expect(isOperatorOnlySection(s)).toBe(true);
      expect(sectionAllowed(s, false)).toBe(false);
      expect(sectionAllowed(s, true)).toBe(true);
    }
    expect(CUSTOMER_NAV_KEYS).not.toContain("members");
  });
});

describe("no screen touches the closed doors", () => {
  it("nothing in app/, components/ or lib/ invites, accepts, lists invitations or writes org_members", () => {
    const bad: string[] = [];
    for (const dir of ["app", "components", "lib"]) {
      for (const f of files(path.join(ROOT, dir))) {
        const src = readFileSync(f, "utf8");
        // Comments may name them (history); calls may not.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/rpc\(\s*["'`](invite_org_member|accept_org_invite|decline_org_invite|my_invites)["'`]/.test(code)) bad.push(`${f}: invite rpc`);
        if (/from\(\s*["'`]org_members["'`]\s*\)\s*\.\s*(insert|update|delete|upsert)/.test(code)) bad.push(`${f}: org_members write`);
        if (/from\(\s*["'`]org_members["'`]\s*\)\s*\.\s*select/.test(code)) bad.push(`${f}: org_members read`);
      }
    }
    expect(bad).toEqual([]);
  });
});
