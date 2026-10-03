/**
 * What /docs/cli and /docs/skills tell people to type — in ONE place, so the
 * day the command-line tool and the skills are published (they are built on
 * branch claude/dev-cli-skills: packages/cli, skills/) this is the only file
 * that changes. The pages themselves are off until DEV_CLI_PAGE=1
 * (lib/dev-pages.ts).
 *
 * PLACEHOLDER: the install, login and skills-install lines are the ones agreed
 * for the first release. The command list and the skill list below are
 * PLACEHOLDERS drawn from what the public API can do — replace them with the
 * names and one-line descriptions from packages/cli and skills/ before the flag
 * is switched on (their text, per language, is in lib/i18n/site/dev-*.ts keyed
 * by `id`; tests/dev-pages-copy.test.ts keeps the ids equal in every language).
 */

export const CLI_PACKAGE = "@nightshift/cli";
export const CLI_INSTALL = `npm i -g ${CLI_PACKAGE}`;
export const CLI_LOGIN = "nightshift login";
/** The first command a new person runs after logging in. */
export const CLI_FIRST_RUN = "nightshift channels";
/** PLACEHOLDER until skills/README lands: how the skills are installed. */
export const SKILLS_INSTALL = "nightshift skills install";

/** PLACEHOLDER command list: id → the command as typed. */
export const CLI_COMMANDS = [
  { id: "login", command: "nightshift login" },
  { id: "channels", command: "nightshift channels" },
  { id: "create", command: "nightshift videos create" },
  { id: "job", command: "nightshift jobs get <id>" },
  { id: "publish", command: "nightshift videos publish <id>" },
  { id: "download", command: "nightshift videos download <id>" },
  { id: "balance", command: "nightshift balance" },
] as const;

/** PLACEHOLDER skill list: id → the skill's name as installed. */
export const SKILLS = [
  { id: "make-video", name: "nightshift-make-video" },
  { id: "publish", name: "nightshift-publish" },
  { id: "balance", name: "nightshift-balance" },
] as const;
