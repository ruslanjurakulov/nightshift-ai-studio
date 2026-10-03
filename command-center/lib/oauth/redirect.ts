/**
 * Redirect URIs and resource identifiers, validated.
 *
 * validateRedirectUri is the TypeScript twin of oauth_redirect_uri_ok (0093):
 * https with a real lower-case DNS name, or http to a loopback address (a
 * native or command-line app), and exactly one private-use scheme, the Cursor
 * editor's own callback. No fragment, userinfo, wildcard, whitespace, control
 * character or backslash; no IP literal or single-label host over https; no
 * javascript:, data: or other custom scheme. The database checks again with
 * the same rule, and the authorize endpoint compares the string EXACTLY with
 * what was registered — this module never normalizes a URI into a match.
 */

export type RedirectProblem =
  | "empty"
  | "too_long"
  | "forbidden_character"
  | "not_allowed"
  | "bad_port";

const HTTPS =
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](?::([0-9]{1,5}))?(?:\/[^?#]*)?(?:\?[^#]*)?$/;
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?(?:\/[^?#]*)?(?:\?[^#]*)?$/;
const CURSOR = /^cursor:\/\/anysphere\.cursor-retrieval\/oauth\/[A-Za-z0-9._~/-]{1,200}$/;

export function validateRedirectUri(uri: unknown): { ok: true } | { ok: false; reason: RedirectProblem } {
  if (typeof uri !== "string" || uri.length === 0) return { ok: false, reason: "empty" };
  if (uri.length > 300) return { ok: false, reason: "too_long" };
  if (/[\s\u0000-\u001f\u007f-\u009f\\#@*]/.test(uri)) return { ok: false, reason: "forbidden_character" };
  const m = HTTPS.exec(uri) ?? LOOPBACK.exec(uri);
  if (m) {
    if (m[1] !== undefined && Number(m[1]) > 65535) return { ok: false, reason: "bad_port" };
    return { ok: true };
  }
  if (CURSOR.test(uri)) return { ok: true };
  return { ok: false, reason: "not_allowed" };
}

/** What the consent screen shows next to the app's name: where the browser will
 *  be sent. A loopback address is the person's own computer. */
export function describeRedirect(uri: string): { host: string; local: boolean } {
  try {
    const u = new URL(uri);
    if (u.protocol === "cursor:") return { host: "cursor://" + u.host, local: true };
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    return { host: u.host, local };
  } catch {
    return { host: "?", local: false };
  }
}

/**
 * The resource a token is for (RFC 8707). Only the MCP server's own URL is a
 * resource here; the scheme and host may arrive in any case and one trailing
 * slash is tolerated (the MCP spec asks servers to accept both). Anything else
 * — another host, a path below it, a query, a fragment, userinfo — is not ours.
 * Absent means "the MCP server": there is no other resource to mean.
 */
export function normalizeResource(raw: string | null | undefined, canonical: string): string | null {
  if (raw == null || raw === "") return canonical;
  if (raw.length > 255 || /[\s\u0000-\u001f]/.test(raw)) return null;
  let u: URL;
  let want: URL;
  try {
    u = new URL(raw);
    want = new URL(canonical);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || raw.includes("#") || raw.includes("?")) return null;
  const path = u.pathname.replace(/\/+$/, "");
  if (u.origin !== want.origin || path !== want.pathname) return null;
  return canonical;
}

/**
 * Characters that draw nothing or reorder what is drawn: C0/C1 controls, soft
 * hyphen, combining grapheme joiner, Arabic letter mark, Hangul and Khmer
 * fillers, Mongolian variation selectors, zero-width and direction marks,
 * embeddings/overrides/isolates, invisible operators and the deprecated format
 * characters (U+2060-206F), variation selectors, the BOM, halfwidth Hangul
 * filler, interlinear annotation marks and the tag characters. The SQL twin
 * (oauth_client_name_problem, 0093) lists exactly these;
 * tests/test_mcp_oauth_migration.py compares the two.
 */
export const INVISIBLE_CLASS =
  "\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4-\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u2800\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}";
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "gu");

/**
 * Lookalike folding for the brand check, one character to one: leet digits and
 * symbols, and the Latin-looking letters of other scripts. Lower and upper case
 * are both listed so the SQL twin, whose lower() depends on the database
 * locale, folds the same. These are the SQL function's translate() arguments
 * verbatim (generated from one list).
 */
export const HOMOGLYPH_FROM = "0оοօОΟøθ1!|lıɩⅼɪӏІіΙιΊίłℓ3еёЕΕєε4@аɑαАΑ5$ѕꜱʂЅςš7тτƫТΤ†8вΒɓ9ɡցԍɢğʜнһհНҺΗηɦռոпΠΝɴñԁɗĐđƒꜰſрρРΡсϲСϹçхχХΧуүγУΥкκКΚмМΜυцνѵⲚꓠ𐔓𑪾𝚴𝛮𝜨𝝢𝞜¡ǀւ׀וןا١۱ߊ।၊Ꭵᛁᛐ↿∣⍳⏽│┃Ⲓⲓⵊⵏꓲꕯꙇꞁꟾ꠰꣎꩝ꭵ︱ﺍﺎ￨𐊊𐌉𐌠𐔎𐤦𐰾𐲥𐳺𑁇𑃀𑅁𑇅𑏔𑑋𑗅𑙁𑣃𑱁𑷚𑷡𖵣𖺪𖼨𝄀𝍷𞅁𞣇𞴁𞸀𞺀ƍᏀᏳᶃꓖႹᎻᏂᕼⲎꓧ𐋏ߠᎢ⊤⟙Ⲧㄒ丅ꓔꔋ𐊗𐊱𐌕𑢼𖼊𝍳🝨ƽՏടႽჽᏕᏚᲽꓢꕶꮪ𐊖𐐠𐑈𑣁𖫖𖼺ʄϜքߓᖴẝꓝꞘꞙꬵ𐅾𐊇𐊥𐔥𑢢𑣂𝈓𝟊𜳖𜳗𜳘𜳙𜳚𜳛𜳜𜳝𜳞𜳟𜳠𜳡𜳢𜳣𜳤𜳥𜳦𜳧𜳨𜳩𜳪𜳫𜳬𜳭𜳮𜳯𜳰𜳱𜳳𜳴𜳵𜳷𜳸𜳹꟱+#𖵩𖵪ŁƑƖƼПӀԌՀՈՌՑՒՔꙆꞀꞪꞬꞮꟅ𑢡𑢣";
export const HOMOGLYPH_TO = "ooooooooiiiiiiiiiiiiiiiiieeeeeeeaaaaaaasssssssstttttttbbbbgggggghhhhhhhhhnnnnnnnddddfffppppcccccxxxxyyyyykkkkmmmuuvvnnnnnnnnniiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiggggghhhhhhhttttttttttttttttsssssssssssssssssffffffffffffffffffabcdefghijklmnopqrstuvwxyzoieastbgsthiiifisnighnngifiihgissi";
const HOMOGLYPHS = new Map([...HOMOGLYPH_FROM].map((c, i) => [c, HOMOGLYPH_TO[i]] as const));

/** The word nobody else may be named: what a person would take for Nightshift's own voice. */
export const RESERVED_NAME = "nightshift";
export const MAX_CLIENT_NAME = 80;

/**
 * What a name looks like once the tricks are taken out: lookalikes folded (upper
 * and lower case are both listed, and this runs before NFKC and before
 * lower-casing, so a character NFKC would rewrite, such as the long s, and a
 * capital whose lower-case form looks like another letter, such as Greek capital
 * Nu, are read as what they look like), NFKC (full-width, mathematical and
 * ligature forms) and lookalikes again, lower case, NFKD with the combining marks dropped (accents),
 * invisible and direction characters dropped, lower case and lookalikes once
 * more (what the steps above leave behind), then ONLY a-z kept, so spacing,
 * dots, dashes and digits used as separators cannot split the word. Twin of
 * oauth_client_name_problem.
 */
function lookalikes(s: string): string {
  let out = "";
  for (const c of s) out += HOMOGLYPHS.get(c) ?? c;
  return out;
}

export function foldClientName(raw: string): string {
  const base = lookalikes(lookalikes(raw).normalize("NFKC"))
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(INVISIBLE, "")
    .toLowerCase();
  return lookalikes(base).replace(/[^a-z]/g, "");
}

/** A name as a person reads it: printable, no direction overrides, single spaces. Not bounded. */
function visibleName(raw: string): string {
  // Line and tab characters are spaces, not nothing: "line\nbreak" reads as two words.
  return raw.replace(/[\t-\r]/g, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

export type NameProblem = "empty" | "too_long" | "reserved";

/**
 * Registration's rule for client_name. An absent name is allowed (the app is
 * then shown by its host); a name that is given must show something, be at
 * most 80 characters and not pass itself off as Nightshift.
 */
export function checkClientName(raw: unknown): { ok: true; name: string | null } | { ok: false; reason: NameProblem } {
  if (raw === undefined || raw === null) return { ok: true, name: null };
  if (typeof raw !== "string" || raw.length > 400) return { ok: false, reason: typeof raw === "string" ? "too_long" : "empty" };
  const name = visibleName(raw);
  if (name.length === 0) return { ok: false, reason: "empty" };
  if ([...name].length > MAX_CLIENT_NAME) return { ok: false, reason: "too_long" };
  if (foldClientName(name).includes(RESERVED_NAME)) return { ok: false, reason: "reserved" };
  return { ok: true, name };
}

/** An app's name as shown to a person (a second line of defence at display time): printable, bounded, host as fallback. */
export function cleanClientName(raw: unknown, fallbackHost: string): string {
  const cleaned = visibleName(typeof raw === "string" ? raw : "").slice(0, MAX_CLIENT_NAME).trim();
  return cleaned || fallbackHost.slice(0, MAX_CLIENT_NAME);
}
