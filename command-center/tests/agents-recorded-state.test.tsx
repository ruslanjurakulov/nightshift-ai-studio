// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCard, type AgentSummary } from "@/components/agents/AgentCard";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

const copy: Record<Locale, { task: string; prefix: string }> = {
  en: { task: "Last recorded task", prefix: "Last recorded state:" },
  ru: { task: "Последняя записанная задача", prefix: "Последнее записанное состояние:" },
  uz: { task: "Oxirgi qayd etilgan vazifa", prefix: "Oxirgi qayd etilgan holat:" },
};

describe.each(["en", "ru", "uz"] as const)("%s event-derived agent wording", (locale) => {
  it.each(["RUNNING", "FAILED", "IDLE"] as const)("labels a stale %s event as recorded, not verified current activity", (status) => {
    const agent: AgentSummary = {
      agent: "pipeline", status, tone: status === "RUNNING" ? "run" : status === "FAILED" ? "fail" : "idle",
      currentTask: "synthetic old event", lastActivity: "2020-01-01T00:00:00Z",
      lastSuccess: null, lastFailure: null, durationMs: null, eventCount: 1,
    };
    render(<I18nProvider locale={locale}><ul><AgentCard agent={agent} /></ul></I18nProvider>);
    expect(screen.getByText(copy[locale].task)).toBeTruthy();
    const state = dictionaries[locale].status;
    const word = status === "RUNNING" ? state.running : status === "FAILED" ? state.failed : state.idle;
    expect(screen.getByText(`${copy[locale].prefix} ${word}`)).toBeTruthy();
    expect(screen.getByText("synthetic old event")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
