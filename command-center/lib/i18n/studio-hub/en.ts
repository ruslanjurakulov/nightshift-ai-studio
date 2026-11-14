/**
 * Nightshift Studio's home (/{channel}/studio): the one place the creative tools now live
 * (docs/studio/STUDIO_IA.md §4, build step 1). English is the source of truth; ru.ts and uz.ts are
 * typed against it.
 *
 * "Nightshift Studio" is a brand and is never translated. A scene-to-video item is a "project",
 * never a "film" or a "long video". Nothing on the page starts a job or spends, so no sentence here
 * names a price or promises a feature that is not on main.
 */
export const studioHubEn = {
  title: "Nightshift Studio",
  subtitle: "Everything you make for this channel, in one place. Each tool opens the page it has today.",
  channelLook: "Channel look",
  channelLookHint: "Presets, style kits and characters",
  shelfLabel: "Shelf",
  shelfProjects: "Projects",
  shelfVideos: "Videos",
  projectsLead: "Cut your own videos. Editing and export are free; an export lands in the library and is never published.",
  editorProjects: "In the editor",
  toolsTitle: "Tools",
  toolsLead: "Opening a tool fills its form. Nothing starts and nothing is charged until you confirm a price there.",
  channelTitle: "Your channel",
  makeTitle: "Make",
  tiles: {
    create: "Pictures, clips, voice-overs and a YouTube video run",
    brandLook: "The channel's presets, style kits and characters",
    styles: "Browse art directions and add them as style kits",
    presets: "Ready formats, looks, templates and voices",
    library: "Uploads and everything you made, in folders",
    editor: "Cut your own videos; an export lands in the library",
    workflows: "Saved multi-step recipes, run after one total price",
    pipeline: "The autopilot's run, stage by stage",
    ads: "Brand kits, campaigns and ad concepts",
    characterStudio: "Swap the people in your own video",
    series: "Recurring content lines for the channel",
    models: "The models you can use, by task",
    inbox: "Comments on your videos, with replies you approve",
  },
  // The one-line notice a moved screen shows for one release (dismissible, remembered in this browser only).
  moved: "{name} now lives in Nightshift Studio.",
  movedOpen: "Open Studio",
  movedDismiss: "Dismiss",
};

export type StudioHubDictionary = typeof studioHubEn;
