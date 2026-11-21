/**
 * The one rule both Nightshift AI chats (the Studio's planning chat, lib/brain/prompt.ts, and the owner's console,
 * lib/owner-console/ai-prompt.ts) share about which language to answer in. The app's locale only chooses the UI: an Uzbek
 * owner reading the console in English who types in Uzbek was answered in English, because the owner prompt said "answer in
 * LANGUAGE" (the locale). One text, imported by both, so the two chats cannot drift apart again.
 */
export const REPLY_LANGUAGE_RULE =
  "Answer in the language of the message you are answering (Uzbek, Russian, English or any other), even when it differs from the app's language. Use the app's language only when the message has no clear language of its own (a number, a name, an emoji).";
