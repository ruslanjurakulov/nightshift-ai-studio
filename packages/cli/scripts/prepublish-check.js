// Runs from `prepublishOnly`, after the tests. Refuses to publish a package
// whose licence the owner has not chosen: the repository has no licence file,
// and this package must not invent one.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const problems = [];
if (!pkg.license) problems.push('package.json has no "license" field: the owner must choose one (and add a LICENSE file) before publishing.');
if (pkg.private) problems.push('package.json is "private": npm will refuse to publish it.');
if (pkg.publishConfig?.access !== "public") problems.push('publishConfig.access must be "public" for a scoped package.');
if (problems.length) {
  for (const p of problems) process.stderr.write(`prepublish check: ${p}\n`);
  process.exit(1);
}
