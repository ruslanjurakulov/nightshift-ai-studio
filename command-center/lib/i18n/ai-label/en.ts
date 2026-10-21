/**
 * Channels page: the AI-content label settings of a channel (components/channels/AiDisclosureSettings.tsx).
 * English is the source: ru.ts and uz.ts are typed `AiLabelDictionary`, so they must carry exactly these keys.
 * The ru and uz sentences are machine drafts: have a native speaker read them. No role words (the lock is the
 * platform team's), no provider or model names.
 */
export const aiLabelEn = {
  title: "AI-content label",
  intro:
    "Whether each video is sent to YouTube, Instagram and TikTok marked as containing altered or synthetic content. Automatic decides for each video from what it contains.",
  modeLabel: "Label on uploads",
  modeOptions: {
    auto: "Automatic (recommended)",
    always: "Always label",
    never: "Never label",
  },
  modeHint: "Automatic labels a video that contains realistic AI-made video, pictures or a presenter, or whose origin is unknown.",
  voiceLabel: "Narrator's voice",
  voiceOptions: {
    generic: "A standard text-to-speech voice",
    own_clone: "My own cloned voice",
    real_person: "Another real person's voice (cloned or similar)",
  },
  voiceHint: "The pipeline cannot hear the voice, so this is what it is told. Pick the voice that is really used.",
  locked: "Locked",
  lockedNote:
    "Never label and My own cloned voice reduce what is declared to the platforms, so only the platform team can set them. To change one, ask the platform team.",
  currentLocked: "This channel already uses a setting only the platform team can change. You can switch it to another option.",
  noAccess: "You don't have access to change this.",
  saving: "Saving…",
  saved: "Saved.",
  saveFailed: "Could not save this setting.",
  lockRefused: "That option is set by the platform team, so it was not saved. Your other settings were not changed.",
};

export type AiLabelDictionary = typeof aiLabelEn;
