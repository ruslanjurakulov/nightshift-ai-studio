// @vitest-environment jsdom
/**
 * The brand intro's sound (lib/site/brand-intro-sound.ts). What would break without these: an AudioContext made on a visit
 * that gets no intro (or in a hidden tab, or where the browser forbids sound, which makes Chrome log a warning); a refused
 * resume throwing, retrying or holding the picture up; sound still scheduled or audible after a skip or after the overlay left;
 * the cue drifting off the picture's timeline or past the moment the context is closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BrandIntro } from "@/components/site/BrandIntro";
import { BRAND_INTRO_SCRIPT, INTRO, INTRO_COVER_ATTR, INTRO_FALLBACK_MS, INTRO_TOTAL_MS } from "@/lib/site/brand-intro";
import { CUE, CUE_LOWPASS_HZ, CUE_STOP_MS, scheduleCue, soundAllowed, startIntroCue } from "@/lib/site/brand-intro-sound";
import { buildCsp } from "@/lib/security/csp";

const html = document.documentElement;
const overlay = () => document.querySelector<HTMLElement>("[data-testid='brand-intro']");
const runScript = () => new Function(BRAND_INTRO_SCRIPT)();
/** The overlay's first animation starting: the sound's cue to begin, in a browser. */
const begin = () => {
  const stage = document.querySelector(".ns-intro-stage");
  if (stage) act(() => {
    fireEvent.animationStart(stage);
  });
};

type Call = { node: string; method: string; args: unknown[] };

/** Any AudioParam: records every automation call. */
function param(owner: string, calls: Call[]) {
  const p: Record<string, unknown> = { value: 1 };
  for (const m of ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "setTargetAtTime", "cancelScheduledValues"]) {
    p[m] = (...args: unknown[]) => {
      calls.push({ node: owner, method: m, args });
      return p;
    };
  }
  return p;
}

/** Any AudioNode: connect chains, start/stop are recorded, and any other property read is an AudioParam. */
function node(kind: string, calls: Call[]) {
  const store: Record<string | symbol, unknown> = {};
  const self: object = new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "connect") return (dest: unknown) => dest;
      if (k === "disconnect") return () => {};
      if (k === "start" || k === "stop") return (...args: unknown[]) => calls.push({ node: kind, method: String(k), args });
      if (typeof k === "symbol" || k === "then") return undefined;
      return (t[k] = param(`${kind}.${String(k)}`, calls));
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
  return self;
}

let constructed: FakeContext[] = [];
let resumeMode: "resolve" | "reject" | "pending" = "resolve";
let startState: AudioContextState = "suspended";

class FakeContext {
  state: AudioContextState = startState;
  currentTime = 5;
  sampleRate = 48000;
  destination = {};
  calls: Call[] = [];
  createdAfterClose = 0;
  closed = false;
  resume = vi.fn(() => {
    if (resumeMode === "resolve") {
      this.state = "running";
      return Promise.resolve();
    }
    if (resumeMode === "reject") return Promise.reject(new DOMException("not allowed", "NotAllowedError"));
    return new Promise<void>(() => {});
  });
  close = vi.fn(() => {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  });
  constructor() {
    constructed.push(this);
  }
  private make(kind: string) {
    if (this.closed) this.createdAfterClose++;
    return node(kind, this.calls);
  }
  createGain() { return this.make("gain"); }
  createBiquadFilter() { return this.make("filter"); }
  createDynamicsCompressor() { return this.make("compressor"); }
  createConvolver() { return this.make("convolver"); }
  createBufferSource() { return this.make("source"); }
  createOscillator() { return this.make("osc"); }
  createStereoPanner() { return this.make("panner"); }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (c: number) => data[c] };
  }
}

let visibility: DocumentVisibilityState = "visible";
let reduced = false;

function allowSound(how: "activation" | "policy" | "none") {
  Object.defineProperty(navigator, "userActivation", { value: { hasBeenActive: how === "activation" }, configurable: true });
  Object.defineProperty(navigator, "getAutoplayPolicy", {
    value: how === "policy" ? () => "allowed" : undefined,
    configurable: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  constructed = [];
  resumeMode = "resolve";
  startState = "suspended";
  visibility = "visible";
  reduced = false;
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
  window.matchMedia = ((q: string) => ({
    matches: q.includes("prefers-reduced-motion") ? reduced : false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  Object.defineProperty(navigator, "connection", { value: undefined, configurable: true });
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  html.removeAttribute(INTRO_COVER_ATTR);
  allowSound("activation");
});

afterEach(() => {
  cleanup();
  window.dispatchEvent(new Event("keydown"));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  html.removeAttribute(INTRO_COVER_ATTR);
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
});

/** Lets resume()'s promise settle. */
const settle = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

describe("no AudioContext where there is no intro, or no sound allowed", () => {
  const paths: [string, () => void][] = [
    ["no cover (a later page, a client navigation, no script)", () => {}],
    ["reduced motion", () => { reduced = true; runScript(); }],
    ["Save-Data", () => { Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true }); runScript(); }],
    ["a slow link", () => { Object.defineProperty(navigator, "connection", { value: { effectiveType: "3g" }, configurable: true }); runScript(); }],
    ["a signed-in visitor", () => { document.cookie = "sb-abcdefghijklmnopqrst-auth-token=x; path=/"; runScript(); }],
    ["another path", () => { window.history.replaceState(null, "", "/pricing"); runScript(); }],
    ["a crawler", () => { vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Googlebot/2.1"); runScript(); }],
    ["a skip before the intro started", () => { runScript(); window.dispatchEvent(new Event("keydown")); }],
    ["the intro already seen in this tab", () => { window.sessionStorage.setItem("ns-intro", "1"); runScript(); }],
    ["a hidden tab", () => { visibility = "hidden"; runScript(); }],
    ["no user activation and no autoplay policy to ask (Chrome, Safari on a first visit)", () => { allowSound("none"); runScript(); }],
    ["the browser's policy says no (Firefox)", () => {
      Object.defineProperty(navigator, "getAutoplayPolicy", { value: () => "disallowed", configurable: true });
      runScript();
    }],
  ];
  for (const [name, setup] of paths) {
    it(name, async () => {
      setup();
      render(<BrandIntro />);
      begin();
      await settle();
      act(() => vi.advanceTimersByTime(INTRO_FALLBACK_MS + 100));
      expect(constructed).toHaveLength(0);
    });
  }

  it("asks Firefox's policy when there is one, and needs exactly 'allowed'", () => {
    Object.defineProperty(navigator, "getAutoplayPolicy", { value: () => "allowed-muted", configurable: true });
    expect(soundAllowed()).toBe(false);
    allowSound("policy");
    expect(soundAllowed()).toBe(true);
  });
});

describe("a playing intro with sound allowed", () => {
  it("makes one context, schedules the cue, and closes it when the overlay leaves", async () => {
    runScript();
    render(<BrandIntro />);
    begin();
    await settle();
    expect(constructed).toHaveLength(1);
    const ctx = constructed[0];
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.calls.some((c) => c.method === "start")).toBe(true);
    act(() => vi.advanceTimersByTime(INTRO_FALLBACK_MS));
    expect(overlay()).toBeNull();
    act(() => vi.advanceTimersByTime(CUE_STOP_MS + 20));
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(ctx.createdAfterClose).toBe(0);
  });

  for (const [name, fire] of [
    ["a click", () => fireEvent.click(overlay()!)],
    ["a key", () => fireEvent.keyDown(window, { key: "Escape" })],
    ["a wheel", () => fireEvent.wheel(window)],
    ["a touch", () => fireEvent.touchStart(overlay()!)],
  ] as [string, () => void][]) {
    it(`goes silent within ${CUE_STOP_MS} ms on ${name}, then closes`, async () => {
      runScript();
      render(<BrandIntro />);
      begin();
      await settle();
      const ctx = constructed[0];
      act(() => fire());
      expect(overlay()).toBeNull();
      const ramp = ctx.calls.filter((c) => c.node === "gain.gain" && c.method === "linearRampToValueAtTime").at(-1)!;
      expect(ramp.args).toEqual([0, ctx.currentTime + CUE_STOP_MS / 1000]);
      expect(ctx.calls.some((c) => c.method === "cancelScheduledValues")).toBe(true);
      expect(ctx.close).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(CUE_STOP_MS + 20));
      expect(ctx.close).toHaveBeenCalledTimes(1);
    });
  }

  it("a rejected resume leaves the intro running and silent, throws nothing, and does not retry", async () => {
    resumeMode = "reject";
    const errors = vi.spyOn(console, "error");
    runScript();
    render(<BrandIntro />);
    begin();
    await settle();
    const ctx = constructed[0];
    expect(overlay()).not.toBeNull();
    expect(ctx.calls.some((c) => c.method === "start")).toBe(false);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(INTRO_FALLBACK_MS));
    expect(overlay()).toBeNull();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(constructed).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("a resume that never settles (still suspended) changes nothing on screen, and the end closes the context", async () => {
    resumeMode = "pending";
    runScript();
    render(<BrandIntro />);
    begin();
    await settle();
    const ctx = constructed[0];
    expect(overlay()).not.toBeNull();
    act(() => vi.advanceTimersByTime(INTRO_FALLBACK_MS));
    expect(overlay()).toBeNull();
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(ctx.calls.some((c) => c.method === "start")).toBe(false);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it("goes silent and closes when the tab is hidden mid-intro", async () => {
    runScript();
    render(<BrandIntro />);
    begin();
    await settle();
    const ctx = constructed[0];
    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(CUE_STOP_MS + 20));
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it("does not start out of step: a context that only runs after the riser's moment stays silent", () => {
    startState = "running";
    const handle = startIntroCue(performance.now() - (CUE.riserAt + 200));
    expect(handle).not.toBeNull();
    const ctx = constructed[0];
    expect(ctx.calls.some((c) => c.method === "start")).toBe(false);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });
});

describe("the cue itself", () => {
  it("sounds only between the riser and the end of the opening, with nothing left by the time the context closes", () => {
    const ctx = new FakeContext() as unknown as BaseAudioContext;
    scheduleCue(ctx, (ctx as unknown as FakeContext).destination as AudioNode, 0);
    const calls = (ctx as unknown as FakeContext).calls;
    const starts = calls.filter((c) => c.method === "start").map((c) => c.args[0] as number);
    const stops = calls.filter((c) => c.method === "stop").map((c) => c.args[0] as number);
    expect(Math.min(...starts)).toBeCloseTo(INTRO.slitAt / 1000, 6);
    expect(Math.max(...stops)).toBeLessThanOrEqual(INTRO_TOTAL_MS / 1000 + 1e-9);
    // The master reaches 0 exactly at the end of the timeline.
    const masterEnd = calls.filter((c) => c.node === "gain.gain" && c.method === "linearRampToValueAtTime" && c.args[0] === 0);
    expect(masterEnd.length).toBeGreaterThan(0);
    expect(masterEnd[0].args[1]).toBeCloseTo(CUE.end / 1000, 6);
    expect(CUE.end).toBe(INTRO_TOTAL_MS);
  });

  it("keeps the highs off: the master low-pass is at or below 8 kHz", () => {
    expect(CUE_LOWPASS_HZ).toBeLessThanOrEqual(8000);
  });

  it("fetches nothing: no audio file, no worklet module, no media element", () => {
    // Code only: the comments name the measured render (intro-cue.wav), which the page never loads.
    const src = readFileSync(path.join(process.cwd(), "lib/site/brand-intro-sound.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/fetch\(|new Audio\(|audioWorklet|decodeAudioData|\.(mp3|wav|ogg|m4a)\b|https?:\/\//);
  });

  it("needs no CSP change: script-src gained nothing for it and media-src is what it was", () => {
    const policy = buildCsp({ nonce: "n", supabaseUrl: "https://p.supabase.test" });
    const media = policy.split("; ").find((d) => d.startsWith("media-src "));
    expect(media).toBe("media-src 'self' data: blob: https:");
  });
});
