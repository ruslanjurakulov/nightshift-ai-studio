// @vitest-environment jsdom
/**
 * The shared chat shell (components/chat) is black in both themes, the owner's /owner/ai and the customer's Studio panel alike.
 * What would break without these (Pixel on #900):
 *  - a .btn-quiet nested in the shell keeping the light theme's silver glass under the shell's white legend (2.4:1: "Make it 2 min
 *    instead", "Upgrade plan", "Buy credits" unreadable), because the shell pinned its colours but not the glass a key reads;
 *  - the history drawer (outside .chat-shell) drawing its close X and "Show older" in the page's light-theme tokens on black;
 *  - a control's or a field's edge fainter than 3:1 (the composer at 1.70:1, the cards at 1.12:1);
 *  - the side panel tucked under the app's sticky top bar, or the trial's upgrade link a 16px-tall target;
 *  - an empty box left two lines tall after its placeholder got shorter.
 * The contrast is computed from the values in the stylesheets, so a token changed to a fainter one fails here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatShell, type ChatLabels } from "@/components/chat/ChatShell";

const css = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const shellCss = css("components/chat/chat-shell.css");
const historyCss = css("components/chat/chat-history.css");
const panelCss = css("components/brain/nightshift-ai-panel.css");

/** The declarations of the first rule whose selector is exactly `selector`. */
function block(src: string, selector: string): Record<string, string> {
  const at = src.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = src.slice(src.indexOf("{", at) + 1, src.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const d of body.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
}

type Rgb = [number, number, number];
const hex = (h: string): Rgb => {
  const x = h.replace("#", "");
  const full = x.length === 3 ? x.split("").map((c) => c + c).join("") : x;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
};
const lum = ([r, g, b]: Rgb) => {
  const l = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * l(r) + 0.7152 * l(g) + 0.0722 * l(b);
};
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as Rgb;
const alphaOf = (v: string) => Number(/\/\s*([\d.]+)\s*\)/.exec(v)?.[1] ?? NaN);

const tokens = block(shellCss, ".chat-shell,\n.chat-frame");
const resolve = (v: string): string => {
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  return m ? resolve(tokens[m[1]]) : v;
};
const BLACK = hex("#000000");

describe("the shell's tokens, pinned dark for everything nested in it, in light and dark alike", () => {
  it("is declared once for the shell and the history frame (the drawer sits outside .chat-shell)", () => {
    for (const k of ["--color-fg", "--color-muted", "--color-border", "--glass-tint", "--glass-tint-hover", "--glass-gloss", "--glass-edge-hi", "--glass-edge-lo", "--ns-rule-strong", "--ns-act", "--ns-focus", "--studio-field"])
      expect(tokens[k], k).toBeTruthy();
    expect(tokens["color-scheme"]).toBe("dark");
  });

  it("text on a quiet key keeps 4.5:1 with its glass lit to the full (hover, gloss and sheen over a card)", () => {
    const fg = hex(resolve(tokens["--color-fg"]));
    for (const ground of [BLACK, hex(resolve(tokens["--studio-field"])), hex(resolve(tokens["--color-panel"]))]) {
      let lit = over([255, 255, 255], alphaOf(tokens["--glass-tint-hover"]), ground);
      lit = over([255, 255, 255], alphaOf(tokens["--glass-gloss"]), lit);
      lit = over([255, 255, 255], alphaOf(tokens["--glass-sheen"]), lit);
      expect(ratio(fg, lit)).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(hex(resolve(tokens["--color-muted"])), BLACK)).toBeGreaterThanOrEqual(4.5);
  });

  it("every control's edge is at least 3:1 against what it sits on", () => {
    const edge = hex(resolve(tokens["--color-border"]));
    for (const k of ["--glass-edge-hi", "--glass-edge-lo", "--ns-rule-strong"]) expect(resolve(tokens[k])).toBe(resolve(tokens["--color-border"]));
    for (const ground of ["#000000", resolve(tokens["--studio-field"]), resolve(tokens["--color-panel-2"])]) expect(ratio(edge, hex(ground))).toBeGreaterThanOrEqual(3);
    // The composer's pill (rgb 28 28 32 at 0.92 over black) and its border.
    expect(shellCss).toMatch(/\.chat-pill \{[^}]*border: 1px solid var\(--color-border\)/);
    expect(ratio(edge, over([28, 28, 32], 0.92, BLACK))).toBeGreaterThanOrEqual(3);
    // The person's bubble and a nested Studio card are edged too.
    expect(shellCss).toMatch(/\.chat-bubble-you \{[^}]*border: 1px solid var\(--chat-edge\)/);
    expect(shellCss).toMatch(/\.chat-shell \.studio-field \{ border-color: var\(--chat-edge\); \}/);
    expect(ratio(hex(resolve(tokens["--ns-focus"])), BLACK)).toBeGreaterThanOrEqual(3);
  });

  it("the drawer's icon keys use the panel's grey and its edges are 3:1", () => {
    const h = block(historyCss, ".chat-frame");
    expect(historyCss).toMatch(/\.chat-history \.chat-act \{ color: var\(--ch-muted\); \}/);
    expect(ratio(hex(h["--ch-muted"]), hex(h["--ch-bg"]))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(h["--ch-fg"]), hex(h["--ch-bg"]))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(h["--ch-edge"]), hex(h["--ch-bg"]))).toBeGreaterThanOrEqual(3);
    expect(ratio(hex(h["--ch-edge"]), hex("#161619"))).toBeGreaterThanOrEqual(3);
    for (const sel of [".chat-history-new {", ".chat-history-edit input {"]) {
      const at = historyCss.indexOf(sel);
      expect(historyCss.slice(at, historyCss.indexOf("}", at))).toContain("var(--ch-edge)");
    }
  });
});

describe("the customer's side panel", () => {
  it("sticks below the app's measured top bar, not under it", () => {
    expect(panelCss).toMatch(/top: calc\(var\(--ns-shell-h, 4rem\) \+ 1rem\)/);
  });

  it("gives the trial's upgrade link a 44x44 target", () => {
    const at = panelCss.indexOf(".ns-ai-dock .chat-meter-link {");
    const rule = panelCss.slice(at, panelCss.indexOf("}", at));
    expect(rule).toContain("min-height: 2.75rem");
    expect(rule).toContain("min-width: 2.75rem");
  });

  it("keeps room under the composer below lg, so focusing it stops above the canvas's dock", () => {
    expect(panelCss).toMatch(/@media \(max-width: 63\.99rem\) \{\s*\.ns-ai-dock \.chat-composer \{ scroll-margin-bottom:/);
  });
});

const labels: ChatLabels = {
  title: "Nightshift AI", newChat: "New chat", greeting: "Hello", label: "Message", placeholder: "", send: "Send", sending: "Sending",
  you: "You", ai: "AI", copy: "Copy", copied: "Copied", copyFailed: "Copy failed", good: "Good", bad: "Bad", keys: "Enter", counter: "{n}/{max}",
  disclaimer: "Nothing starts",
};

describe("the box's height", () => {
  afterEach(cleanup);
  it("follows the placeholder: an empty box shrinks back when a long placeholder is replaced by a short one", () => {
    // jsdom lays nothing out: a placeholder over 30 characters wraps to two 24px lines here.
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return (this.value || this.placeholder).length > 30 ? 48 : 24;
      },
    });
    try {
      const props = { turns: [], pending: false, pendingQuestion: null, maxLength: 2000, counterFrom: 1800, inputId: "x-input", onSend: async () => true, onNewChat: () => {} };
      const view = render(<ChatShell {...props} labels={{ ...labels, placeholder: "Qanday video kerakligini tasvirlab bering" }} />);
      const el = document.getElementById("x-input") as HTMLTextAreaElement;
      expect(el.style.height).toBe("48px");
      act(() => view.rerender(<ChatShell {...props} labels={{ ...labels, placeholder: "Yoki oʻz javobingizni yozing" }} />));
      expect(el.style.height).toBe("24px");
    } finally {
      // Own property on the textarea prototype only: deleting it restores the inherited one.
      delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  });
});
