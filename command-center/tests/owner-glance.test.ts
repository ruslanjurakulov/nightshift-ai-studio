import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relativeTime } from "@/lib/format";
import { formatAgo, naWord } from "@/lib/date-format";
import { agentLabel, prettifyAgentId } from "@/lib/agent-names";
import { dictionaries } from "@/lib/i18n";
import { BALANCE_CRITICAL_PCT, BALANCE_LOW_PCT, balanceTone, lowestProviderBalance, workersAlive } from "@/lib/owner-glance";
import type { BalanceRow } from "@/lib/billing";
import type { WorkerRow } from "@/lib/workers";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime speaks the viewer's language", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("keeps English short and unchanged without a locale", () => {
    expect(relativeTime(ago(10 * HOUR))).toBe("10h ago");
    expect(relativeTime(ago(5 * MIN), "en")).toBe("5m ago");
    expect(relativeTime(ago(30_000), "en")).toBe("30s ago");
    expect(relativeTime(ago(3 * DAY), "en")).toBe("3d ago");
  });

  it("reads '10 hours ago' in Uzbek and Russian, with no English left", () => {
    expect(relativeTime(ago(10 * HOUR), "uz")).toBe("10 soat oldin");
    expect(relativeTime(ago(5 * MIN), "uz")).toBe("5 daqiqa oldin");
    expect(relativeTime(ago(30_000), "uz")).toBe("30 soniya oldin");
    expect(relativeTime(ago(3 * DAY), "uz")).toBe("3 kun oldin");
    expect(relativeTime(ago(10 * HOUR), "ru")).toBe("10 ч назад");
    expect(relativeTime(ago(5 * MIN), "ru")).toBe("5 мин назад");
    expect(relativeTime(ago(3 * DAY), "ru")).toBe("3 дн назад");
    for (const loc of ["uz", "ru"]) {
      for (const ms of [20_000, 5 * MIN, 10 * HOUR, 3 * DAY]) expect(relativeTime(ago(ms), loc)).not.toMatch(/ago|\d[smhd]\b/);
    }
  });

  it("treats a locale with a region and an unknown one sensibly", () => {
    expect(relativeTime(ago(2 * HOUR), "uz-UZ")).toBe("2 soat oldin");
    expect(relativeTime(ago(2 * HOUR), "de")).toBe("2h ago");
  });

  it("never reads negative for a clock a few seconds ahead", () => {
    expect(relativeTime(new Date(NOW + 4_000).toISOString(), "uz")).toBe("0 soniya oldin");
  });

  it("says 'no value' in the viewer's language, and returns an unparseable text as is", () => {
    expect(relativeTime(null)).toBe("N/A");
    expect(relativeTime(undefined, "ru")).toBe(dictionaries.ru.common.na);
    expect(relativeTime(null, "uz")).toBe(dictionaries.uz.common.na);
    expect(naWord("en")).toBe(dictionaries.en.common.na);
    expect(relativeTime("whenever", "uz")).toBe("whenever");
  });

  it("formatAgo is null for a language it has no table for", () => {
    expect(formatAgo(3, "hour", "de")).toBeNull();
    expect(formatAgo(-1, "hour", "en")).toBeNull();
  });
});

describe("agent ids a person can read", () => {
  const names = dictionaries.uz.ownerShell.agentNames as Record<string, string>;

  it("maps the ids on the owner's screen to names, per language", () => {
    expect(agentLabel("intelligence_poll", dictionaries.en.ownerShell.agentNames)).toBe("Intelligence poller");
    expect(agentLabel("pipeline", names)).toBe("Konveyer");
    expect(agentLabel("youtube_uploader", dictionaries.ru.ownerShell.agentNames)).toBe("Загрузка на YouTube");
    // No raw snake_case id survives for any known agent, in any language.
    for (const loc of ["en", "ru", "uz"] as const) {
      for (const [id, label] of Object.entries(dictionaries[loc].ownerShell.agentNames)) {
        expect(label, `${loc}.${id}`).not.toMatch(/_/);
        expect(label.trim(), `${loc}.${id}`).not.toBe("");
      }
    }
  });

  it("prettifies an unknown id instead of showing it raw", () => {
    expect(agentLabel("some_new-agent.v2", names)).toBe("Some new agent v2");
    expect(prettifyAgentId("  trend_scout ")).toBe("Trend scout");
    expect(agentLabel(null, names)).toBe("");
    expect(agentLabel("  ", names)).toBe("");
  });

  it("does not resolve prototype keys", () => {
    expect(agentLabel("constructor", names)).toBe("Constructor");
    expect(agentLabel("toString", names)).toBe("ToString");
  });
});

describe("the owner's strip numbers", () => {
  const snap = (provider: string, remaining: number | null, total: number | null, checked = "2026-10-17T08:00:00Z"): BalanceRow => ({
    provider,
    metric: "credits",
    remaining,
    total,
    unit: "credits",
    tier: null,
    resets_at: null,
    source: "api",
    checked_at: checked,
  });

  it("picks the provider with the least left, from each provider's newest snapshot", () => {
    const low = lowestProviderBalance([
      snap("elevenlabs", 5000, 100000), // old: 5%
      snap("elevenlabs", 30000, 100000, "2026-10-17T09:00:00Z"), // newer: 30%
      snap("minimax", 12, 100), // 12%
      snap("gemini", 90, 100),
    ]);
    expect(low).toMatchObject({ provider: "minimax", name: "MiniMax", pct: 12 });
  });

  it("skips what cannot be a percentage instead of calling it empty", () => {
    expect(lowestProviderBalance([])).toBeNull();
    expect(lowestProviderBalance([snap("elevenlabs", null, 100), snap("gemini", 10, null), snap("kling", 5, 0)])).toBeNull();
    expect(lowestProviderBalance([snap("not-a-provider", 1, 100)])).toBeNull();
    expect(lowestProviderBalance([snap("kling", 250, 100)])?.pct).toBe(100);
    expect(lowestProviderBalance([snap("kling", -5, 100)])?.pct).toBe(0);
  });

  it("tones: critical below 5%, low below 20%, else fine", () => {
    expect(balanceTone(BALANCE_CRITICAL_PCT - 1)).toBe("fail");
    expect(balanceTone(BALANCE_CRITICAL_PCT)).toBe("warn");
    expect(balanceTone(BALANCE_LOW_PCT - 1)).toBe("warn");
    expect(balanceTone(BALANCE_LOW_PCT)).toBe("ok");
  });

  it("counts only workers that are reporting now", () => {
    const w = (id: string, state: WorkerRow["state"], updatedAt: string | null): WorkerRow => ({
      workerId: id,
      kind: "media",
      state,
      detail: null,
      version: null,
      startedAt: null,
      updatedAt,
    });
    const rows = [
      w("a", "running", ago(30_000)),
      w("b", "running", ago(10 * MIN)), // says running, silent for 10 minutes
      w("c", "failed", ago(30_000)),
      w("d", "stopped", ago(DAY)),
      w("e", "starting", ago(10_000)),
    ];
    expect(workersAlive(rows, NOW)).toEqual({ alive: 2, total: 5, silent: 2 });
    expect(workersAlive([], NOW)).toEqual({ alive: 0, total: 0, silent: 0 });
  });
});
