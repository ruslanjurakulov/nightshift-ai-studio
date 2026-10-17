/**
 * The platform owner's phone shell: the bottom tabs, the one-row header's
 * workspace picker, the "all sections" page, the at-a-glance strip on the
 * Command Center and the readable names of the pipeline's agents. English is
 * the source of truth; ru.ts and uz.ts are typed against it.
 */
export const ownerShellEn = {
  // The bottom tab bar (operator, below `lg`). Short on purpose: five tabs share a 320px phone.
  tabsLabel: "Owner navigation",
  tabHome: "Home",
  tabVideos: "Videos",
  tabBilling: "Billing",
  tabAlerts: "Alerts",
  tabMore: "More",
  // The workspace picker in the one-row phone header.
  ctxLabel: "Switch organization or channel",
  ctxOrg: "Organization",
  ctxChannel: "Channel",
  ctxClose: "Close",
  ctxFailed: "Could not switch. Try again.",
  // "All sections": the page behind the More tab.
  allSectionsLead: "Every section of the platform, one tap away.",
  // The strip at the top of the Command Center on a phone.
  glanceLabel: "At a glance",
  gBalance: "Lowest balance",
  gBalanceNone: "no balance data",
  gBalanceLow: "running low",
  gFailed: "Failed (24h)",
  gWaiting: "Waiting for you",
  gWaitingSub: "approve or reject",
  gAlerts: "Alerts (24h)",
  gAlertsSub: "warnings and critical",
  gWorkers: "Workers alive",
  gWorkersAll: "all reporting",
  gWorkersSilent: "{n} not reporting",
  gWorkersNone: "none registered",
  gSystem: "System",
  // Readable names for the agent ids in system_events.agent. Any id not listed is shown prettified.
  agentNames: {
    pipeline: "Pipeline",
    scene_regenerate: "Scene regenerator",
    scene_repair: "Scene repair",
    youtube_uploader: "YouTube uploader",
    shorts: "Shorts maker",
    publish_gate: "Publish gate",
    avatar: "Avatar",
    topic_manager: "Topic manager",
    research_engine: "Research engine",
    minimax_broll: "B-roll (MiniMax)",
    feedback_engine: "Feedback engine",
    budget: "Budget guard",
    audio_mixer: "Audio mixer",
    vidiq: "vidIQ",
    thumbnail_generator: "Thumbnail generator",
    storyboard: "Storyboard",
    script_engine: "Script writer",
    media_fetcher: "Media fetcher",
    dna_render: "Channel-style renderer",
    compositor: "Compositor",
    watch_next: "Watch-next picker",
    video_critic: "Video critic",
    title_planner: "Title planner",
    sponsorship: "Sponsorships",
    spend_overview: "Spend overview",
    revenue_tracker: "Revenue tracker",
    repackage: "Repackager",
    quota_allocator: "Quota allocator",
    publish_timing: "Publish timing",
    publish_score: "Publish score",
    playlist: "Playlists",
    pinned_comment: "Pinned comment",
    niche_rpm: "Niche RPM",
    intelligence_poller: "Intelligence poller",
    intelligence_poll: "Intelligence poller",
    image_providers: "Image providers",
    elements: "Elements",
    durability: "Durability check",
    director: "Director",
    credential_health: "Credential health",
  },
};

export type OwnerShellDictionary = typeof ownerShellEn;
