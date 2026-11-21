#!/usr/bin/env node
import { main } from "../src/cli.js";
import { realIo } from "../src/io.js";

main(process.argv.slice(2), realIo()).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // main() reports every expected failure itself; this is a bug.
    process.stderr.write(`nightshift: unexpected error: ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
