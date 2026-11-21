import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { CliError } from "./errors.js";

/**
 * Where the key lives: the operating system's per-user config directory.
 *   Linux    $XDG_CONFIG_HOME/nightshift or ~/.config/nightshift
 *   macOS    ~/Library/Application Support/nightshift
 *   Windows  %APPDATA%\nightshift
 * NIGHTSHIFT_CONFIG_DIR overrides all of them (tests, containers).
 */
export function configDir(io) {
  const o = io.env.NIGHTSHIFT_CONFIG_DIR;
  if (o) return o;
  if (io.platform === "win32") return join(io.env.APPDATA || join(io.home, "AppData", "Roaming"), "nightshift");
  if (io.platform === "darwin") return join(io.home, "Library", "Application Support", "nightshift");
  return join(io.env.XDG_CONFIG_HOME || join(io.home, ".config"), "nightshift");
}

export function credentialsPath(io) {
  return join(configDir(io), "credentials.json");
}

/**
 * The saved credentials, or null when there are none.
 * @returns {Promise<{api_key: string, base_url?: string, warnings: string[]} | null>}
 */
export async function readCredentials(io) {
  const path = credentialsPath(io);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new CliError("config_unreadable", `Cannot read ${path}: ${e && e.code ? e.code : "error"}.`);
  }
  const warnings = [];
  if (io.platform !== "win32") {
    try {
      const s = await stat(path);
      if (s.mode & 0o077) warnings.push(`${path} is readable by other users. Run: chmod 600 "${path}"`);
    } catch {
      /* the read above succeeded; a stat race is not worth failing for */
    }
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CliError("config_unreadable", `${path} is not valid JSON. Run \`nightshift login\` to write it again.`);
  }
  if (!data || typeof data.api_key !== "string" || !data.api_key)
    throw new CliError("config_unreadable", `${path} holds no key. Run \`nightshift login\`.`);
  return { api_key: data.api_key, base_url: typeof data.base_url === "string" ? data.base_url : undefined, warnings };
}

/**
 * Write the credentials: directory 0700, file 0600, replaced atomically so a
 * crash never leaves a half-written key. (Windows ignores POSIX modes; the
 * profile directory's own ACL protects the file there.)
 */
export async function writeCredentials(io, { api_key, base_url }) {
  const path = credentialsPath(io);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (io.platform !== "win32") await chmod(dir, 0o700).catch(() => {});
  const tmp = join(dir, `.credentials.${randomBytes(6).toString("hex")}.tmp`);
  const body = JSON.stringify(base_url ? { api_key, base_url } : { api_key }) + "\n";
  try {
    await writeFile(tmp, body, { mode: 0o600, flag: "wx" });
    if (io.platform !== "win32") await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new CliError("config_unwritable", `Cannot save the key to ${path}: ${e && e.code ? e.code : "error"}.`);
  }
  return path;
}

/** @returns {Promise<boolean>} whether a file was removed */
export async function deleteCredentials(io) {
  try {
    await rm(credentialsPath(io));
    return true;
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw new CliError("config_unwritable", `Cannot remove ${credentialsPath(io)}: ${e && e.code ? e.code : "error"}.`);
  }
}
