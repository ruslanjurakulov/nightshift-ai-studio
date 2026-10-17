/**
 * A pipeline agent's id ("intelligence_poll", "youtube_uploader") as a person reads it.
 *
 * system_events.agent carries code names. A known id reads from the dictionary (ownerShell.agentNames, in
 * all three languages); any other is prettified rather than shown raw ("some_new_agent" -> "Some new agent"),
 * so a new agent is readable the day it ships and a translator can name it later. Pure.
 */

/** "some_new-agent.v2" -> "Some new agent v2". Empty in, empty out. */
export function prettifyAgentId(id: string): string {
  const words = id
    .trim()
    .replace(/[_\-.\s]+/g, " ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * The readable name for an agent id. `names` is the dictionary's agentNames map. Own keys only, so an id like
 * "constructor" never resolves to a function from the prototype.
 */
export function agentLabel(id: string | null | undefined, names: Readonly<Record<string, string>>): string {
  const key = (id ?? "").trim();
  if (!key) return "";
  const hit = Object.prototype.hasOwnProperty.call(names, key) ? names[key] : undefined;
  return hit && hit.trim() ? hit : prettifyAgentId(key);
}
