import { accountCommands } from "./account.js";
import { creativeCommands } from "./creative.js";
import { videoCommands } from "./video.js";

/**
 * The command table: the one place that says what the CLI can do. `--help`,
 * `nightshift commands`, the docs test and the Agent Skills test all read it.
 * Every command is over a real /api/v1 endpoint; nothing here is invented.
 */
export const COMMANDS = [...accountCommands, ...videoCommands, ...creativeCommands];

/** The endpoint(s) each command calls, for docs and tests. */
export const ENDPOINTS = {
  login: ["GET /me"],
  logout: [],
  whoami: ["GET /me"],
  balance: ["GET /balance"],
  channels: ["GET /channels"],
  accounts: ["GET /accounts"],
  create: ["POST /videos", "GET /jobs/{id}"],
  "jobs get": ["GET /jobs/{id}"],
  "videos list": ["GET /videos"],
  "videos get": ["GET /videos/{id}"],
  "download request": ["POST /videos/{id}/downloads", "GET /downloads/{id}"],
  "download get": ["GET /downloads/{id}"],
  "download save": ["GET /downloads/{id}/file"],
  publish: ["POST /videos/{id}/publish"],
  quote: ["POST /creative/quote"],
  generate: ["POST /creative/jobs", "GET /creative/jobs/{id}"],
  "generations get": ["GET /creative/jobs/{id}"],
};
