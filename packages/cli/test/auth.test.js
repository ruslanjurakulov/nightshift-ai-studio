import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiError, fakeApi, run, stdinWith, TEST_KEY } from "./helpers.js";

const posix = process.platform !== "win32";
const ME = { organization: { id: "org-1", name: "Acme" }, key: { id: "key-1" }, tier: 2, limits: {} };

test("login validates the key with GET /me, stores it 0600 in a 0700 dir, never prints it", async () => {
  const api = await fakeApi({ "GET /me": ME });
  try {
    const dir = await mkdtemp(join(tmpdir(), "ns-cli-"));
    const cfg = join(dir, "cfg");
    const r = await run(["login", "--key", TEST_KEY], { api, keyless: true, configDir: cfg });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Logged in to Acme/);
    assert.ok(!r.all.includes(TEST_KEY));
    assert.match(r.stderr, /shell history/);
    assert.equal(api.seen[0].headers.authorization, `Bearer ${TEST_KEY}`);
    const file = join(cfg, "credentials.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.api_key, TEST_KEY);
    if (posix) {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(cfg)).mode & 0o777, 0o700);
    }
    assert.deepEqual((await readdir(cfg)).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");
    // the saved key is used when the environment has none
    const w = await run(["whoami"], { api, keyless: true, configDir: cfg });
    assert.equal(w.code, 0);
    assert.match(w.stdout, /from saved login/);
    assert.ok(!w.all.includes(TEST_KEY));
  } finally {
    await api.close();
  }
});

test("login reads the key from stdin or the environment, not only a flag", async () => {
  const api = await fakeApi({ "GET /me": ME });
  try {
    let r = await run(["login"], { api, keyless: true, stdin: stdinWith(TEST_KEY + "\n") });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /shell history/);
    r = await run(["login", "--json"], { api, keyless: false });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).organization.name, "Acme");
    assert.ok(!r.all.includes(TEST_KEY));
  } finally {
    await api.close();
  }
});

test("login with a rejected key saves nothing", async () => {
  const api = await fakeApi({ "GET /me": apiError(401, "invalid_api_key", "No such key.") });
  try {
    const dir = await mkdtemp(join(tmpdir(), "ns-cli-"));
    const r = await run(["login", "--key", TEST_KEY], { api, keyless: true, configDir: dir });
    assert.equal(r.code, 3);
    assert.deepEqual(await readdir(dir), []);
    assert.ok(!r.all.includes(TEST_KEY));
  } finally {
    await api.close();
  }
});

test("login refuses a malformed key without echoing it and without any request", async () => {
  const api = await fakeApi({ "GET /me": ME });
  try {
    const r = await run(["login", "--key", "hunter2-not-a-key"], { api, keyless: true });
    assert.equal(r.code, 3);
    assert.ok(!r.all.includes("hunter2"));
    assert.equal(api.seen.length, 0);
  } finally {
    await api.close();
  }
});

test("commands without a key say how to log in (exit 3)", async () => {
  const r = await run(["balance"], { keyless: true });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /nightshift login/);
});

test("logout removes the file and says the key still needs revoking", async () => {
  const api = await fakeApi({ "GET /me": ME });
  try {
    const dir = await mkdtemp(join(tmpdir(), "ns-cli-"));
    await run(["login", "--key", TEST_KEY], { api, keyless: true, configDir: dir });
    const r = await run(["logout"], { keyless: true, configDir: dir });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Developers > API keys/);
    assert.deepEqual(await readdir(dir), []);
    assert.equal((await run(["logout"], { keyless: true, configDir: dir })).code, 0, "idempotent");
  } finally {
    await api.close();
  }
});

test("a credentials file other users can read is flagged", { skip: !posix }, async () => {
  const api = await fakeApi({ "GET /me": ME });
  try {
    const dir = await mkdtemp(join(tmpdir(), "ns-cli-"));
    const file = join(dir, "credentials.json");
    await writeFile(file, JSON.stringify({ api_key: TEST_KEY }));
    await chmod(file, 0o644);
    const r = await run(["whoami"], { api, keyless: true, configDir: dir });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /readable by other users/);
    assert.match(r.stderr, /chmod 600/);
    assert.ok(!r.all.includes(TEST_KEY));
  } finally {
    await api.close();
  }
});

test("the key is never sent over plain http except to localhost", async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    throw new Error("must not be called");
  };
  for (const url of ["http://api.example.com", "http://203.0.113.9:8080", "http://nightshift-ai.studio.evil.example"]) {
    const r = await run(["whoami", "--base-url", url], { fetch });
    assert.equal(r.code, 2, url);
    assert.match(r.stderr, /plain http/);
    assert.ok(!r.all.includes(TEST_KEY));
  }
  assert.equal(called, false);
  const bad = await run(["whoami", "--base-url", "ftp://x"], { fetch });
  assert.equal(bad.code, 2);
  const creds = await run(["whoami", "--base-url", "https://user:pw@example.com"], { fetch });
  assert.equal(creds.code, 2);
  // localhost over http is fine
  const api = await fakeApi({ "GET /me": ME });
  try {
    assert.equal((await run(["whoami", "--base-url", api.url])).code, 0);
  } finally {
    await api.close();
  }
});

test("--base-url beats the environment; https is the default", async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify(ME), { status: 200, headers: { "content-type": "application/json" } });
  };
  await run(["whoami"], { fetch });
  assert.equal(seen[0], "https://nightshift-ai.studio/api/v1/me");
  await run(["whoami"], { fetch, env: { NIGHTSHIFT_BASE_URL: "https://env.example.com" } });
  assert.equal(seen[1], "https://env.example.com/api/v1/me");
  await run(["whoami", "--base-url", "https://flag.example.com/"], { fetch, env: { NIGHTSHIFT_BASE_URL: "https://env.example.com" } });
  assert.equal(seen[2], "https://flag.example.com/api/v1/me");
});

test("a base URL other than the default or this machine warns that the key goes there", async () => {
  const fetch = async () => new Response(JSON.stringify(ME), { status: 200, headers: { "content-type": "application/json" } });
  const flag = await run(["whoami", "--base-url", "https://flag.example.com"], { fetch });
  assert.match(flag.stderr, /API key will be sent to flag\.example\.com, not nightshift-ai\.studio/);
  const env = await run(["whoami"], { fetch, env: { NIGHTSHIFT_BASE_URL: "https://env.example.com" } });
  assert.match(env.stderr, /sent to env\.example\.com/);
  assert.ok(!env.all.includes(TEST_KEY));
  const plain = await run(["whoami"], { fetch });
  assert.doesNotMatch(plain.stderr, /will be sent to/);
  const local = await run(["whoami", "--base-url", "http://localhost:3000"], { fetch });
  assert.doesNotMatch(local.stderr, /will be sent to/);
});

test("a redirect is not followed, so the key cannot be forwarded", async () => {
  const api = await fakeApi({ "GET /me": { status: 302, headers: { location: "http://evil.example/steal" }, body: {} } });
  try {
    const r = await run(["whoami"], { api });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /redirected/);
    assert.equal(api.seen.length, 1);
  } finally {
    await api.close();
  }
});

test("the hidden prompt echoes nothing and puts the raw-mode terminal back", async () => {
  const { EventEmitter } = await import("node:events");
  const raw = [];
  const tty = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (v) => raw.push(v),
    resume() {},
    pause() {},
    setEncoding() {},
  });
  const api = await fakeApi({ "GET /me": ME });
  try {
    const dir = await mkdtemp(join(tmpdir(), "ns-cli-"));
    const pending = run(["login"], { api, keyless: true, stdin: tty, configDir: dir });
    await new Promise((r) => setTimeout(r, 50));
    tty.emit("data", TEST_KEY.slice(0, 30)); // typed or pasted in pieces
    tty.emit("data", "X\u007f" + TEST_KEY.slice(30) + "\r"); // a typo and a backspace, then Enter
    const r = await pending;
    assert.equal(r.code, 0);
    assert.match(r.stderr, /Paste your API key \(input is hidden\)/);
    assert.ok(!r.all.includes(TEST_KEY));
    assert.ok(!r.all.includes(TEST_KEY.slice(0, 12)));
    assert.deepEqual(raw, [true, false]);
    assert.equal(JSON.parse(await readFile(join(dir, "credentials.json"), "utf8")).api_key, TEST_KEY);
  } finally {
    await api.close();
  }
});
