import { homedir } from "node:os";

/**
 * Everything the CLI touches in the outside world, in one object, so tests
 * can run the real command code against a fake server and a temp directory.
 *
 * @typedef {object} Io
 * @property {{write(s: string): unknown, isTTY?: boolean}} stdout
 * @property {{write(s: string): unknown, isTTY?: boolean}} stderr
 * @property {any} stdin
 * @property {Record<string, string|undefined>} env
 * @property {string} platform
 * @property {string} home
 * @property {string} cwd
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now
 * @property {typeof fetch} fetch
 */

/** @returns {Io} */
export function realIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    platform: process.platform,
    home: homedir(),
    cwd: process.cwd(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    fetch: (...a) => globalThis.fetch(...a),
  };
}
