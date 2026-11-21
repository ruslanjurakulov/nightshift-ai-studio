import { GLOBAL_OPTIONS } from "./commands/shared.js";

function optionRows(options) {
  const lines = Object.entries(options).map(([name, o]) => {
    const flag = `${o.short ? `-${o.short}, ` : "    "}--${name}${o.arg ? ` ${o.arg}` : ""}`;
    return [flag, o.help ?? ""];
  });
  const w = Math.max(0, ...lines.map(([f]) => f.length));
  return lines.map(([f, h]) => `  ${f.padEnd(w)}  ${h}`).join("\n");
}

export function commandHelp(cmd) {
  const parts = [
    `nightshift ${cmd.path} - ${cmd.summary}`,
    `Usage:\n  ${cmd.usage}`,
  ];
  if (Object.keys(cmd.options).length) parts.push(`Options:\n${optionRows(cmd.options)}`);
  parts.push(`Global options:\n${optionRows(GLOBAL_OPTIONS)}`);
  if (cmd.examples?.length) parts.push(`Examples:\n${cmd.examples.map((e) => `  ${e}`).join("\n")}`);
  if (cmd.notes?.length) parts.push(`Notes:\n${cmd.notes.map((n) => `  ${n}`).join("\n")}`);
  parts.push("Exit codes: 0 ok, 1 error, 2 usage, 3 auth, 4 billing, 5 rate limited.");
  return parts.join("\n\n") + "\n";
}

export function topHelp(commands, version) {
  const w = Math.max(...commands.map((c) => c.path.length));
  return (
    `nightshift ${version} - make, follow, download and publish videos from the command line\n\n` +
    "Usage:\n  nightshift <command> [options]\n  nightshift help <command>\n\n" +
    "Commands:\n" +
    commands.map((c) => `  ${c.path.padEnd(w)}  ${c.summary}`).join("\n") +
    `\n  ${"commands".padEnd(w)}  List the commands (add --json for agents).\n` +
    `  ${"help".padEnd(w)}  Show help for a command.\n\n` +
    `Global options:\n${optionRows(GLOBAL_OPTIONS)}\n  --version, -V  Print the version.\n\n` +
    "Environment:\n" +
    "  NIGHTSHIFT_API_KEY    API key (wins over the saved login)\n" +
    "  NIGHTSHIFT_BASE_URL   API origin (default https://nightshift-ai.studio)\n" +
    "  NIGHTSHIFT_CONFIG_DIR Where `login` keeps the key (default: your OS user config directory)\n\n" +
    "Start:\n  nightshift login && nightshift whoami && nightshift balance && nightshift channels\n\n" +
    "Money: `create`, `download request` and `generate` spend. They print what is held; nothing is\n" +
    "charged until the work succeeds. Retry with the same --idempotency-key, never a new one.\n" +
    "Exit codes: 0 ok, 1 error, 2 usage, 3 auth, 4 billing, 5 rate limited.\n" +
    "Docs: https://github.com/ruslanjurakulov/nightshift-ai-studio/blob/main/docs/CLI.md\n"
  );
}
