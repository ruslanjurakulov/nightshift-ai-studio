import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The human-type sweep took monospace off numbers and labels. A string the
 * person must read exactly, copy or read out (an API key, an invite link, a
 * secret, a key id, the reference on the error screen) stays monospace, where
 * 0/O and l/I/1 are told apart. This pins those places so a later style sweep
 * cannot flatten them without a test saying so.
 */
const root = join(__dirname, "..");
const src = (f: string) => readFileSync(join(root, f), "utf8");

const PLACES: [string, RegExp][] = [
  ["components/developers/DeveloperConsole.tsx", /<code className="mono[^"]*">\{shown\}<\/code>/],
  ["components/developers/DeveloperConsole.tsx", /<td className="mono[^"]*">\{k\.id\}<\/td>/],
  ["components/credits/InviteFriendsCard.tsx", /id="invite-link"[\s\S]{0,400}className="mono /],
  ["components/feedback/ErrorScreen.tsx", /<p className="mono[^"]*">\{fmt\(t\.ux\.errorRef/],
  ["components/security/SecurityBoard.tsx", /<code className="mono[^"]*">\s*\{enrollment\.secret\}/],
  ["components/autonomy/AutonomyView.tsx", /className="[^"]*\bmono\b[^"]*">\{a\.videoId/],
  ["app/(app)/[channel]/jobs/page.tsx", /className="mono[^"]*">\{j\.id\}/],
  ["app/(app)/[channel]/videos/[id]/page.tsx", /className="mono[^"]*">\{video\.video_id\}/],
];

describe("strings read exactly stay monospace", () => {
  it.each(PLACES)("%s %s", (file, re) => {
    expect(src(file)).toMatch(re);
  });
});
