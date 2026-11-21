import { describe, expect, it } from "vitest";
import { isSmallTalk, modelText, readModelAnswer, unsafeText } from "@/lib/brain/logic";

// Breach on 0198's Lens round: the route-side checks a model's answer (or a person's chosen plan) passes through. A failing case
// here is a bypass still open: what the person reads names the vendor, shows a price, or a floor word is drafted.
const IDENTITY = "I am Nightshift AI.";
const reply = (r: string) =>
  readModelAnswer(JSON.stringify({ reply: r, slots: {}, card: { thread_title: "t", question: "q", options: ["a", "b", "c"] } }), {}, "c1", {
    identityReply: IDENTITY, shortAvailable: true, kindOptions: ["Long", "Short"],
  })!.reply;

describe("namesVendor after modelText: what the person reads never names the vendor", () => {
  it.each([
    ["full-width (NFKC folds it)", "I am Ｃｌａｕｄｅ."],
    ["plain", "I am Claude, made by Anthropic."],
  ])("caught: %s", (_n, r) => expect(reply(r)).toBe(IDENTITY));

  it.each([
    ["zero-width inside (plain() turns it into a space: 'Cl aude')", "I am Cl​aude."],
    ["soft hyphen inside (renders as 'Anthropic')", "Made by Anthrop­ic."],
    ["Cyrillic homoglyph C", "I am Сlaude."],
    ["Greek omicron in OpenAI", "Built by ΟpenAI."],
    ["letter-spaced", "I am C l a u d e."],
    ["hyphen-spaced", "I am C-l-a-u-d-e."],
    ["Russian transliteration", "Я — Клод от компании Антропик."],
    ["Russian ChatGPT", "Я работаю на ЧатГПТ."],
    ["Uzbek Cyrillic", "Мен Клодман."],
    ["variation selector inside", "I am Cla️ude."],
  ])("bypass: %s", (_n, r) => expect(reply(r)).toBe(IDENTITY));
});

describe("isSmallTalk: a greeting is free (not_sent), so it must not carry a request", () => {
  it.each([
    "hello there ai ai ai ai",
    "hi nightshift",
  ])("still small talk, harmless: %s", (t) => expect(isSmallTalk(t)).toBe(true));
  it.each([
    "hello\nmake me a 10 minute video about sharks",
    "hi, write the script now",
    "hello ​ make a video",
  ])("not small talk: %j", (t) => expect(isSmallTalk(t)).toBe(false));
});

describe("MONEY: no price, credit or currency figure survives in the model's words", () => {
  it.each([
    ["currency code before the amount", "It costs UZS 120 000."],
    ["USD before the amount", "Only USD 5 today."],
    ["symbol after the amount", "Only 5$ today."],
    ["euro after", "Only 5 € today."],
    ["full-width digits", "That is １００ credits."],
    ["soft hyphen inside the unit", "That is 100 cr­edits."],
    ["Cyrillic homoglyph i in credits", "That is 100 credіts."],
    ["Uzbek Cyrillic so'm", "Narxi 10 000 сўм."],
    ["word number not listed", "That is fifteen credits."],
    ["zero", "That is zero credits."],
  ])("stripped: %s", (_n, t) => expect(modelText(t, 300)).not.toMatch(/\d|fifteen|zero/i));
});

describe("unsafeText: the floor holds against spacing, plurals, homoglyphs and other scripts", () => {
  it.each([
    ["plural", "a set of nudes"],
    ["adjective", "a suicidal teenager"],
    ["spaced", "n u d e beach"],
    ["dotted", "n.a.k.e.d"],
    ["Cyrillic homoglyph e", "nudе beach"],
    ["soft hyphen", "na­ked figure"],
    ["zero-width", "na​ked figure"],
    ["Uzbek Cyrillic naked", "яланғоч одам"],
    ["self-harming", "a self-harming character"],
  ])("refused: %s", (_n, t) => expect(unsafeText(modelText(t, 600))).toBe(true));
});
