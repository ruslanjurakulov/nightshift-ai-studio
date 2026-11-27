// @vitest-environment jsdom
/**
 * Breach, commit f2a6fda (site clips keep their sound): can a page make sound nobody asked for, or keep sound nobody can stop?
 *
 * Held and pinned here: nothing but the toggle's press ever turns a clip's sound on; a clip registers muted even if its element
 * arrived unmuted; setSoundOn never starts playback itself; a removed clip stops counting as the audible one.
 *
 * FAILING (latent, low): lib/site/sound.ts keys its registry by a string (a sample's job id). A second clip registered under the
 * same key silently replaces the first in the map, and the first is then outside "one voice at a time": if its sound was on, it
 * stays on when another clip's is turned on, and no toggle can reach it any more. The landing's no-clip-twice check keeps a job
 * from appearing twice on "/" today, but the registry is the thing promising one voice, not every page that uses it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSound, resetSoundForTests, setSoundOn } from "@/lib/site/sound";

afterEach(() => resetSoundForTests());

const video = () => {
  const v = document.createElement("video");
  v.muted = false;
  return v;
};

describe("sound starts only from a press", () => {
  it("a clip registers muted even when its element arrived unmuted", () => {
    const v = video();
    registerSound("a", v);
    expect(v.muted).toBe(true);
  });

  it("turning the sound on never starts or pauses playback by itself", () => {
    const v = video();
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    v.play = play;
    v.pause = pause;
    registerSound("a", v);
    setSoundOn(v, true);
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(v.muted).toBe(false);
  });

  it("only the speaker toggle ever passes `true` to setSoundOn", () => {
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n)) files.push(p);
      }
    };
    for (const d of ["app", "components", "lib"]) walk(join(root, d));
    const callers: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/setSoundOn\(([^)]*)\)/g)) {
        const args = m[1].split(",").map((s) => s.trim());
        if (args.length === 2 && args[1] === "false") continue;
        callers.push(`${f.slice(root.length)}: ${m[0]}`);
      }
    }
    // The definition in lib/site/sound.ts and the toggle's own press.
    expect(callers.filter((c) => !c.includes("lib/site/sound.ts"))).toEqual(["/components/site/SoundToggle.tsx: setSoundOn(video, !on)"]);
  });

  it("a removed clip is no longer the audible one, and a new clip under its key starts muted", () => {
    const a = video();
    const off = registerSound("k", a);
    setSoundOn(a, true);
    off();
    const b = video();
    registerSound("k", b);
    expect(b.muted).toBe(true);
  });
});

describe("one voice at a time holds whatever the keys", () => {
  it("a clip displaced by a second clip under the same key does not keep talking", () => {
    const first = video();
    registerSound("job-1", first);
    setSoundOn(first, true);
    const second = video();
    registerSound("job-1", second);
    const other = video();
    registerSound("job-2", other);
    setSoundOn(other, true);
    expect(other.muted).toBe(false);
    expect(first.muted).toBe(true);
  });
});
