/**
 * What /docs/cli and /docs/skills tell people to type — in ONE place. These are
 * the real command table of packages/cli (docs/CLI.md; `nightshift commands
 * --json`) and the eight skills in skills/ (skills/README.md); the words per
 * language are in lib/i18n/site/dev-*.ts keyed by `id`, and
 * tests/dev-pages-copy.test.ts keeps the ids equal in every language.
 * tests/test_cli_package.py and tests/test_agent_skills.py already keep the CLI
 * and skills honest against the API; tests/dev-pages-copy.test.ts keeps these
 * lists equal to them.
 *
 * The pages stay off until DEV_CLI_PAGE=1 (lib/dev-pages.ts): the package is
 * not published to npm yet, so the install line would be a false promise.
 */

export const CLI_PACKAGE = "@nightshift/cli";
export const CLI_INSTALL = `npm i -g ${CLI_PACKAGE}`;
export const CLI_LOGIN = "nightshift login";
/** The first command a new person runs after logging in. */
export const CLI_FIRST_RUN = "nightshift channels";
/**
 * How the skills are installed today: copy the folders to where the assistant
 * reads them (skills/README.md). The `npx skills add <owner>/<repo>` route
 * there is an owner TODO until the repository is public; change this line the
 * day it works.
 */
export const SKILLS_INSTALL = "mkdir -p ~/.claude/skills\ncp -R <path to the skills folder>/* ~/.claude/skills/";

/** The CLI's commands (docs/CLI.md): id → the command as typed, in the table's order. */
export const CLI_COMMANDS = [
  { id: "login", command: "nightshift login" },
  { id: "logout", command: "nightshift logout" },
  { id: "whoami", command: "nightshift whoami" },
  { id: "balance", command: "nightshift balance" },
  { id: "channels", command: "nightshift channels" },
  { id: "accounts", command: "nightshift accounts" },
  { id: "create", command: "nightshift create --channel ID --topic TEXT [--wait]" },
  { id: "jobs-get", command: "nightshift jobs get ID [--wait]" },
  { id: "videos-list", command: "nightshift videos list [--channel ID]" },
  { id: "videos-get", command: "nightshift videos get VIDEO_ID" },
  { id: "download-request", command: "nightshift download request VIDEO_ID --quality 1080p [--wait]" },
  { id: "download-get", command: "nightshift download get ID [--wait]" },
  { id: "download-save", command: "nightshift download save ID [--out FILE]" },
  { id: "publish", command: "nightshift publish VIDEO_ID --youtube CHANNEL_ID --account UUID" },
  { id: "quote", command: "nightshift quote --capability NAME --model ID --prompt TEXT" },
  { id: "generate", command: "nightshift generate --capability NAME --model ID --prompt TEXT --max-credits N [--wait]" },
  { id: "generations-get", command: "nightshift generations get ID [--wait]" },
] as const;

/** The eight skills (skills/README.md), in the README's order. The name is the folder name. */
export const SKILLS = [
  { id: "nightshift-setup", name: "nightshift-setup" },
  { id: "make-a-video", name: "make-a-video" },
  { id: "generate-media", name: "generate-media" },
  { id: "check-balance-and-costs", name: "check-balance-and-costs" },
  { id: "download-and-publish", name: "download-and-publish" },
  { id: "troubleshoot-errors", name: "troubleshoot-errors" },
  { id: "batch-videos", name: "batch-videos" },
  { id: "use-the-mcp-tools", name: "use-the-mcp-tools" },
] as const;
