import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COMMANDS, ENDPOINTS } from "../src/commands/index.js";
import { VERSION } from "../src/cli.js";
import { fakeApi, run, TEST_KEY } from "./helpers.js";

test("every command has --help with usage and examples; so does the top level", async () => {
  for (const c of COMMANDS) {
    const r = await run([...c.path.split(" "), "--help"], { keyless: true });
    assert.equal(r.code, 0, c.path);
    assert.match(r.stdout, new RegExp(`nightshift ${c.path} -`), c.path);
    assert.match(r.stdout, /Usage:/, c.path);
    assert.match(r.stdout, /Examples:/, c.path);
    assert.match(r.stdout, /Exit codes: 0 ok, 1 error, 2 usage, 3 auth, 4 billing, 5 rate limited\./);
    const viaHelp = await run(["help", ...c.path.split(" ")], { keyless: true });
    assert.equal(viaHelp.stdout, r.stdout, `help ${c.path}`);
  }
  const top = await run(["--help"], { keyless: true });
  assert.equal(top.code, 0);
  for (const c of COMMANDS) assert.ok(top.stdout.includes(c.path), c.path);
  assert.equal((await run([], { keyless: true })).code, 0);
});

test("the command table, ENDPOINTS and `commands --json` agree", async () => {
  const paths = COMMANDS.map((c) => c.path).sort();
  assert.deepEqual(Object.keys(ENDPOINTS).sort(), paths);
  const r = await run(["commands", "--json"], { keyless: true });
  const names = JSON.parse(r.stdout).commands.map((c) => c.name);
  for (const p of paths) assert.ok(names.includes(p), p);
});

test("only real /api/v1 endpoints are used", () => {
  const real = new Set([
    "GET /me", "GET /balance", "GET /channels", "GET /accounts", "POST /videos", "GET /videos", "GET /videos/{id}",
    "POST /videos/{id}/publish", "POST /videos/{id}/downloads", "GET /downloads/{id}", "GET /downloads/{id}/file",
    "GET /jobs/{id}", "POST /creative/quote", "POST /creative/jobs", "GET /creative/jobs/{id}",
  ]);
  for (const eps of Object.values(ENDPOINTS)) for (const e of eps) assert.ok(real.has(e), e);
});

test("usage errors exit 2: unknown command, missing subcommand, options before the command, extra arguments", async () => {
  for (const argv of [["frobnicate"], ["videos"], ["--channel", "x", "create"], ["whoami", "extra"], ["jobs", "get"], ["jobs", "get", "1", "2"], ["help", "nope"]]) {
    const r = await run(argv, { keyless: true });
    assert.equal(r.code, 2, argv.join(" "));
  }
  assert.equal((await run(["--version"], { keyless: true })).stdout.trim(), VERSION);
});

test("usage errors in --json mode are JSON on stdout", async () => {
  const r = await run(["create", "--json"], { keyless: true });
  assert.equal(r.code, 2);
  const j = JSON.parse(r.stdout);
  assert.equal(j.error.code, "usage");
  assert.equal(j.exit_code, 2);
  assert.equal(r.stderr, "");
});

test("the real binary runs end to end against a fake server and leaks no key", async () => {
  const api = await fakeApi({ "GET /balance": { currency: "usd", available_cents: 1000, balance_cents: 1000, reserved_cents: 0, month_spend_cents: 0, monthly_limit_cents: null, tier: 1 } });
  try {
    const bin = fileURLToPath(new URL("../bin/nightshift.js", import.meta.url));
    const child = spawn(process.execPath, [bin, "balance", "--debug"], {
      env: { PATH: process.env.PATH, NIGHTSHIFT_API_KEY: TEST_KEY, NIGHTSHIFT_BASE_URL: api.url, NIGHTSHIFT_CONFIG_DIR: "/nonexistent-ns-config" },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0);
    assert.match(out, /Available:\s+\$10\.00/);
    assert.ok(!out.includes(TEST_KEY));
  } finally {
    await api.close();
  }
});
