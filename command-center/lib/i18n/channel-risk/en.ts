/**
 * Channels page: the spend limit and the two video extras of a channel (components/channels/ChannelRiskSettings.tsx).
 * English is the source: ru.ts and uz.ts are typed `ChannelRiskDictionary`, so they must carry exactly these keys.
 * The ru and uz sentences are machine drafts: have a native speaker read them. No provider or model names.
 */
export const channelRiskEn = {
  title: "Spend limit and extras",
  ceilingLabel: "Monthly spend limit (USD)",
  ceilingPlaceholder: "No limit",
  ceilingHint:
    "Leave empty for no limit. Once this month's known spend reaches this amount, new runs of this channel do not start. Costs without a price are not counted, so the real total can be higher.",
  ceilingSave: "Save limit",
  ceilingRemove: "Remove limit",
  ceilingNow: "Current limit: {amount} a month.",
  ceilingNone: "No limit is set.",
  ceilingInvalid: "Enter an amount such as 25 or 25.50, or leave it empty for no limit.",
  ceilingNotPositive: "The limit must be above 0. To stop a channel spending, pause the channel instead.",
  ceilingTooLarge: "The limit can be at most {max}.",
  ceilingAdminOnly: "Only an administrator can raise or remove a limit that is already set. You can set a lower one.",
  pinnedLabel: "Question comment under each new video",
  pinnedOnHint: "After a video is really published, the channel may post a question as its own first comment. You pin it yourself in one tap.",
  pinnedOffHint: "The channel does not comment on its own videos.",
  watchLabel: "“Watch next” link in the description",
  watchOnHint: "Each description ends with a link to another video of this channel.",
  watchOffHint: "Descriptions are published without a watch-next link.",
  on: "On",
  off: "Off",
  noAccess: "You don't have access to change this.",
  saving: "Saving…",
  saved: "Saved.",
  saveFailed: "Could not save this setting.",
  notStored: "Nothing was saved. You may not be allowed to change this channel. Reload the page and try again.",
  unavailable: "This setting can't be saved right now because the service is being updated. Please try again later.",
};

export type ChannelRiskDictionary = typeof channelRiskEn;
