import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { removeSound, setClipAudio, toDoc, toModel, validateTimeline, type TimelineDoc } from "@/lib/editor";

const VIDEO = "11111111-1111-4111-8111-111111111111";
const SOUND = "22222222-2222-4222-8222-222222222222";
const reload = (doc: TimelineDoc) => toDoc(toModel(JSON.parse(JSON.stringify(doc))));

// The ordinary Python export adapter is pure here. No files, worker, codec,
// media probe or network may be executed; argv is inspected only as data.
const manifestScript = `
import json, socket, subprocess, sys
def forbidden(*args, **kwargs):
    raise AssertionError("NS407: no network or subprocess permitted")
socket.socket.connect = forbidden
socket.create_connection = forbidden
socket.getaddrinfo = forbidden
subprocess.Popen = forbidden
from modules import timeline as tl, timeline_render as tr, render_spec as rs
assets = {
    "${VIDEO}": tl.ResolvedAsset("${VIDEO}", "video", "/synthetic/video.mp4", 10, has_audio=True),
    "${SOUND}": tl.ResolvedAsset("${SOUND}", "audio", "/synthetic/sound.wav", 10),
}
result = []
for doc in json.load(sys.stdin):
    before = json.dumps(doc, sort_keys=True)
    spec = tr.to_render_spec(doc, assets.get, "/synthetic/output.mp4")
    result.append({"audio": [a.to_dict() for a in spec.audio_tracks],
                   "argv": rs.build_ffmpeg_command(spec, "/synthetic/concat.txt"),
                   "unchanged": before == json.dumps(doc, sort_keys=True)})
print(json.dumps(result))
`;

it("keeps muted clip gain and sound fades through reload; unsetting sound exports no ghost track and unmute restores only the source", () => {
  const stored: TimelineDoc = {
    version: 1, width: 320, height: 180, fps: 25,
    tracks: [
      { id: "v1", kind: "V", clips: [{ id: "video", asset_id: VIDEO, start_s: 0, in_s: 0, out_s: 6, audio: false, gain_db: -12 }] },
      { id: "a1", kind: "A", role: "music", clips: [{ id: "sound", asset_id: SOUND, start_s: 1, in_s: 2, out_s: 6, gain_db: -17.5, fade_in_s: 0.75, fade_out_s: 0.5 }] },
    ],
  };
  const before = JSON.stringify(stored);
  const loaded = reload(stored);
  expect(toModel(loaded).clips[0]).toMatchObject({ audio: false, gain_db: -12 });
  expect(toModel(loaded).sounds[0]).toMatchObject({ gain_db: -17.5, fade_in_s: 0.75, fade_out_s: 0.5 });
  const unset = reload(toDoc(removeSound(toModel(loaded), "sound")));
  expect(toModel(unset).sounds).toEqual([]);
  expect(unset.tracks.some((t) => t.kind === "A")).toBe(false);
  const unmuted = reload(toDoc(setClipAudio(toModel(unset), "video", true)));
  expect(toModel(unmuted).clips[0]).toMatchObject({ audio: true, gain_db: -12 });
  for (const doc of [loaded, unset, unmuted]) expect(validateTimeline(doc)).toEqual([]);
  const manifests = JSON.parse(execFileSync("python3", ["-c", manifestScript], {
    cwd: resolve(process.cwd(), ".."), input: JSON.stringify([loaded, unset, unmuted]), encoding: "utf8",
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", NODE_ENV: "test" },
  })) as { audio: Record<string, unknown>[]; argv: string[]; unchanged: boolean }[];
  expect(manifests[0].audio).toEqual([expect.objectContaining({ path: "/synthetic/sound.wav", gain_db: -17.5, start_s: 1, in_s: 2, duration_s: 4, fade_in_s: 0.75, fade_out_s: 0.5 })]);
  expect(manifests[1].audio).toEqual([]);
  expect(manifests[1].argv.join(" ")).not.toContain("sound.wav");
  expect(manifests[2].audio).toEqual([expect.objectContaining({ path: "/synthetic/video.mp4", gain_db: -12, fade_in_s: 0, fade_out_s: 0 })]);
  expect(manifests[2].argv.join(" ")).not.toContain("sound.wav");
  expect(manifests.every((m) => m.unchanged)).toBe(true);
  expect(JSON.stringify(stored)).toBe(before);
});
