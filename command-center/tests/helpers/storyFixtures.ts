/**
 * Fake model output that keeps the S1 story grammar (lib/brain/logic storyProblem, lib/brain/plan sceneRules): what a well-behaved
 * model returns, so tests about something else are not refused for a missing beat or a missing first frame. Never a real call.
 */

export const LOOK = { face: "round face, brown eyes", hair: "short black hair", build: "slim, tall", outfit: "blue work jacket, grey trousers",
                      palette: "navy, grey, warm skin", signature: "a red thermos" };

/** A story outline (raw, as the model writes it) whose chapters have the given seconds. */
export function storyOutline(seconds: number[], o: Record<string, unknown> = {}): Record<string, unknown> {
  const beats = seconds.length >= 4
    ? ["setup", "longing", ...Array.from({ length: seconds.length - 3 }, () => "turn"), "payoff"]
    : seconds.length === 3 ? ["setup", "turn", "payoff"] : seconds.length === 2 ? ["setup", "payoff"] : ["setup"];
  return {
    title: "Far city", idea: "A father works far away while his daughter grows up.", story: { logline: "l", conflict: "c" },
    format: "F3", visual_style: "warm 2D cartoon", hook: "The bus doors close between them.", twist: "time_skip",
    characters: [{ id: "c1", name: "Ota", description: "the father", image_prompt: "a father", look: LOOK },
                 { id: "c2", name: "Qiz", description: "the daughter", image_prompt: "a girl", look: LOOK,
                   age_stages: [{ id: "a1", label: "6", look: LOOK }, { id: "a2", label: "16", look: LOOK }] }],
    locations: [{ id: "l1", name: "Bus stop", description: "a village bus stop", image_prompt: "a village bus stop at dawn" }],
    props: [{ id: "p1", name: "Thermos", description: "red" }],
    chapters: seconds.map((s, i) => ({ id: `ch${i + 1}`, title: `Chapter ${i + 1}`, seconds: s, beat: beats[i], emotion: "hope",
                                       beats: [{ at_s: 0, text: "something happens" }] })),
    ...o,
  };
}

/** One scene as a well-behaved plan answer writes it. */
export function storyScene(seconds: number, i: number, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `shot ${i + 1}`, duration_s: seconds, shot: i === 0 ? "wide" : "close", camera: { position: "cam1", move: i === 0 ? "static" : "push_in" },
    lighting: "soft dawn light", first_frame: "the father stands at the bus stop, facing right", visual_prompt: "a father waves goodbye",
    motion: "slow push in; the man in the blue jacket raises his hand", last_frame: "the father's hand is raised", variation: "small",
    in_frame: [{ character_id: "c1", age_stage: null }], location_id: "l1", prop_ids: [], speech: "none", sfx: "bus engine", ...o,
  };
}
