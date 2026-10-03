import { CliError, EXIT } from "./errors.js";

/** The whole of stdin as text (for `echo $KEY | nightshift login`). */
export function readAllStdin(stdin) {
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (c) => (data += c));
    stdin.on("end", () => resolve(data));
    stdin.on("error", reject);
  });
}

/**
 * Ask for a secret on a terminal without echoing a single character. The
 * prompt goes to stderr so stdout stays clean for scripts.
 */
export function readHidden(io, prompt) {
  const { stdin, stderr } = io;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function")
    return Promise.reject(new CliError("usage", "No terminal to ask on.", { exit: EXIT.USAGE }));
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buf = "";
    const finish = (fn, value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      fn(value);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(resolve, buf.trim());
        if (ch === "\u0003") return finish(reject, new CliError("cancelled", "Cancelled.", { exit: EXIT.ERROR }));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}
