// @vitest-environment jsdom
// The Canvas|Timeline toggle opens a page that answers "not open yet" unless projects (the Film Studio) are on. A toggle that leads
// there on every workspace is a link to a dead end, so it shows only when the Timeline has something to open.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ProjectBar } from "../components/studio-canvas/StudioCanvas";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/link", () => ({
  default: ({ href, children, scroll: _s, ...rest }: { href: string; children: ReactNode; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/alpha${p}` }));
vi.mock("@/components/shell/ShellContext", () => ({ useShell: () => ({ operator: false, features: {}, tools: undefined }) }));

afterEach(cleanup);

describe("ProjectBar's Timeline toggle", () => {
  it("is hidden on the canvas while projects are off, so it never leads to a closed page", () => {
    render(<ProjectBar filmStudio={false} inline view="canvas" />);
    expect(screen.queryByTestId("view-timeline")).toBeNull();
    expect(screen.queryByTestId("view-canvas")).toBeNull();
  });

  it("shows on the canvas when projects are on", () => {
    render(<ProjectBar filmStudio inline view="canvas" />);
    expect(screen.getByTestId("view-timeline")).toBeTruthy();
    expect(screen.getByTestId("view-canvas")).toBeTruthy();
  });

  it("stays on the Timeline page itself, so there is a way back to the canvas", () => {
    render(<ProjectBar filmStudio={false} inline view="timeline" />);
    expect(screen.getByTestId("view-canvas").getAttribute("href")).toBe("/alpha/studio");
  });
});
