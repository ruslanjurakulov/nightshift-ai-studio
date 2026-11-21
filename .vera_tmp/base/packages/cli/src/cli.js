import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { COMMANDS } from "./commands/index.js";
import { GLOBAL_OPTIONS } from "./commands/shared.js";
import { CliError, EXIT, hintFor, usageError } from "./errors.js";
import { commandHelp, topHelp } from "./help.js";
import { redact } from "./redact.js";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const GROUPS = new Set(COMMANDS.filter((c) => c.path.includes(" ")).map((c) => c.path.split(" ")[0]));
const LEADING_FLAGS = new Set(["--json", "--debug", "--help", "-h"]);

function toParseArgsOptions(options) {
  return Object.fromEntries(
    Object.entries({ ...GLOBAL_OPTIONS, ...options }).map(([k, o]) => [
      k,
      { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) },
    ]),
  );
}

/**
 * Find the command in argv: `[leading global flags] word [word] [rest]`.
 * Command words come first; options may follow in any order.
 */
function locate(argv) {
  const pre = [];
  let i = 0;
  while (i < argv.length && LEADING_FLAGS.has(argv[i])) pre.push(argv[i++]);
  const w0 = argv[i];
  if (w0 === undefined) return { path: null, rest: pre };
  if (w0.startsWith("-")) return { path: null, rest: [...pre, ...argv.slice(i)], bad: w0 };
  if (GROUPS.has(w0)) {
    const w1 = argv[i + 1];
    if (!w1 || w1.startsWith("-")) return { path: null, group: w0, rest: [...pre, ...argv.slice(i + 1)] };
    return { path: `${w0} ${w1}`, rest: [...pre, ...argv.slice(i + 2)] };
  }
  return { path: w0, rest: [...pre, ...argv.slice(i + 1)] };
}

function printError(ctx, e) {
  const { stdout, stderr } = ctx.io;
  if (ctx.json) {
    const envelope = {
      error: {
        type: e.type,
        code: e.code,
        message: e.message,
        ...(e.requestId ? { request_id: e.requestId } : {}),
        ...(e.retryAfter != null ? { retry_after: e.retryAfter } : {}),
        ...e.details,
      },
      ...(e.status != null ? { http_status: e.status } : {}),
      ...(e.idempotencyKey ? { idempotency_key: e.idempotencyKey } : {}),
      ...(e.hint ? { hint: e.hint } : {}),
      exit_code: e.exit,
    };
    stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return;
  }
  let text = `Error: ${e.message}\n`;
  const meta = [`code: ${e.code}`, `type: ${e.type}`];
  if (e.status != null) meta.push(`HTTP ${e.status}`);
  if (e.requestId) meta.push(`request_id: ${e.requestId}`);
  text += `  ${meta.join("   ")}\n`;
  if (e.retryAfter != null) text += `  Retry-After: ${e.retryAfter}s. Wait that long, then retry the same command.\n`;
  if (Object.keys(e.details).length) text += `  details: ${JSON.stringify(e.details)}\n`;
  if (e.idempotencyKey && (e.status == null || e.status >= 500 || e.code === "idempotency_in_progress"))
    text += `  Idempotency-Key: ${e.idempotencyKey} (retry with --idempotency-key ${e.idempotencyKey}; the same key never charges twice)\n`;
  const hint = e.hint ?? hintFor(e.code);
  if (hint) text += `Hint: ${hint}\n`;
  stderr.write(text);
}

/**
 * Run the CLI. Returns the exit code; never throws for an expected failure.
 * @param {string[]} argv
 * @param {import("./io.js").Io} rawIo
 */
export async function main(argv, rawIo) {
  const secrets = new Set();
  const clean = (s) => redact(s, secrets);
  // Everything printed passes through redact(): the key never reaches a terminal or a log.
  const io = {
    ...rawIo,
    stdout: { isTTY: rawIo.stdout.isTTY, write: (s) => rawIo.stdout.write(clean(s)) },
    stderr: { isTTY: rawIo.stderr.isTTY, write: (s) => rawIo.stderr.write(clean(s)) },
  };
  const wantsJson = argv.includes("--json");
  const ctx = {
    io,
    json: wantsJson,
    values: {},
    positionals: [],
    exitCode: EXIT.OK,
    keySource: "",
    clean,
    addSecret: (k) => secrets.add(k),
    say: (s) => io.stdout.write(s),
    note: (s) => {
      if (!ctx.json) io.stderr.write(s);
    },
    warn: (s) => io.stderr.write(`warning: ${s}\n`),
    result: (obj, human) => io.stdout.write(ctx.json ? JSON.stringify(obj, null, 2) + "\n" : human()),
  };
  // The key in the environment is a secret before any command looks at it.
  if (rawIo.env.NIGHTSHIFT_API_KEY) secrets.add(rawIo.env.NIGHTSHIFT_API_KEY);

  try {
    if (argv.length === 0) {
      ctx.say(topHelp(COMMANDS, VERSION));
      return EXIT.OK;
    }
    if (argv[0] === "--version" || argv[0] === "-V") {
      ctx.say(`${VERSION}\n`);
      return EXIT.OK;
    }
    if (argv[0] === "help" || argv[0] === "commands") return builtin(ctx, argv);

    const found = locate(argv);
    if (found.bad) throw usageError(`Put the command first, then its options (got ${found.bad}).`, "Run `nightshift --help`.");
    if (found.group && found.rest.some((a) => a === "--help" || a === "-h")) {
      ctx.say(COMMANDS.filter((c) => c.path.startsWith(found.group + " ")).map((c) => `nightshift ${c.path}  ${c.summary}`).join("\n") + "\n");
      return EXIT.OK;
    }
    if (found.group) throw usageError(`\`nightshift ${found.group}\` needs a subcommand.`, `Try: ${COMMANDS.filter((c) => c.path.startsWith(found.group + " ")).map((c) => c.path).join(", ")}`);
    if (!found.path) {
      ctx.say(topHelp(COMMANDS, VERSION));
      return EXIT.OK;
    }
    const cmd = COMMANDS.find((c) => c.path === found.path);
    if (!cmd) throw usageError(`Unknown command: ${found.path}`, "Run `nightshift --help` for the list.");

    let parsed;
    try {
      parsed = parseArgs({ args: found.rest, options: toParseArgsOptions(cmd.options), allowPositionals: true, strict: true });
    } catch (e) {
      throw usageError(String(e && e.message ? e.message : e).split(/\.\s|\n/)[0].replace(/\.?$/, "."), `Run \`nightshift ${cmd.path} --help\`.`);
    }
    ctx.values = parsed.values;
    ctx.positionals = parsed.positionals;
    ctx.json = !!parsed.values.json;
    if (parsed.values.help) {
      ctx.say(commandHelp(cmd));
      return EXIT.OK;
    }
    const { min, max, names } = cmd.positionals;
    if (ctx.positionals.length < min || ctx.positionals.length > max)
      throw usageError(
        max === 0 ? `\`nightshift ${cmd.path}\` takes no arguments.` : `\`nightshift ${cmd.path}\` needs ${names.join(" ")}.`,
        `Run \`nightshift ${cmd.path} --help\`.`,
      );
    await cmd.run(ctx);
    return ctx.exitCode;
  } catch (e) {
    if (!(e instanceof CliError)) {
      const err = new CliError("internal_error", `Unexpected failure: ${e && e.message ? e.message : String(e)}`);
      printError(ctx, err);
      return err.exit;
    }
    printError(ctx, e);
    return e.exit;
  }
}

function builtin(ctx, argv) {
  const json = argv.includes("--json");
  if (argv[0] === "commands") {
    const list = [...COMMANDS, { path: "commands", summary: "List the commands." }, { path: "help", summary: "Show help for a command." }];
    const describe = (c) => ({
      name: c.path,
      summary: c.summary,
      options: Object.keys({ ...GLOBAL_OPTIONS, ...(c.options ?? {}) }),
      positionals: c.positionals?.names ?? [],
    });
    ctx.say(json ? JSON.stringify({ commands: list.map(describe) }, null, 2) + "\n" : list.map((c) => `${c.path}  ${c.summary}`).join("\n") + "\n");
    return EXIT.OK;
  }
  const words = argv.slice(1).filter((a) => !a.startsWith("-"));
  if (words.length === 0) {
    ctx.say(topHelp(COMMANDS, VERSION));
    return EXIT.OK;
  }
  const path = words.join(" ");
  const cmd = COMMANDS.find((c) => c.path === path) ?? COMMANDS.find((c) => c.path === words[0]);
  if (!cmd) {
    const group = COMMANDS.filter((c) => c.path.startsWith(words[0] + " "));
    if (group.length) {
      ctx.say(group.map((c) => `nightshift ${c.path}  ${c.summary}`).join("\n") + "\n");
      return EXIT.OK;
    }
    throw usageError(`Unknown command: ${path}`, "Run `nightshift --help` for the list.");
  }
  ctx.say(commandHelp(cmd));
  return EXIT.OK;
}
