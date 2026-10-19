/**
 * The confirm sheets for the one-tap owner actions that used to act on a single press: channel switches, extra
 * credits, publish approvals, the review panel, API access and limits, and claiming the team. Each says what will
 * happen and what it costs or lets go, in plain words; the ones that are hard to undo or that spend ask for a word
 * to be typed. English is the source of truth; ru.ts and uz.ts are typed against it. `{name}` style fillers are
 * filled with fmt().
 */
export const confirmSheetsEn = {
  // Shared detail labels
  dChannel: "Channel",
  dNow: "Now",
  dAfter: "After",
  dVideo: "Video",
  dRequestedBy: "Requested by",
  dAccount: "Account",
  dRole: "Role",
  dKey: "API key",
  dEffect: "Effect",
  dAutoPublish: "Auto publish",
  dExtraBalance: "Extra credits you hold",

  // Channel: auto publish
  autoOnTitle: "Turn on auto publish for “{name}”?",
  autoOnBody:
    "Videos publish without asking you. Once a video passes the publish gate it goes public on its own and nobody approves it first. The gate still runs, but it is the only check left.",
  autoOnConfirm: "Turn on auto publish",
  autoOnWord: "PUBLISH",
  autoModeAsk: "Asks you first",
  autoModeSelf: "Publishes by itself",

  // Channel: pause and resume
  pauseTitle: "Pause “{name}”?",
  pauseBody: "The scheduler skips this channel until you resume it, so no new videos are made. Its videos and history stay.",
  pauseConfirm: "Pause channel",
  resumeTitle: "Resume “{name}”?",
  resumeBody:
    "The scheduler starts making videos for this channel again, on its schedule. Each run it starts uses credits or provider usage.",
  resumeConfirm: "Resume channel",
  resumeAutoOn: "Auto publish is on for this channel, so what it makes can go public without asking you.",

  // Channel: storyboard review
  reviewOffTitle: "Turn off storyboard review for “{name}”?",
  reviewOffBody:
    "Runs go straight from the plan to the render. You are no longer asked to approve the price before the render is paid for.",
  reviewOffConfirm: "Turn off review",

  // Usage: extra credits
  extraOnTitle: "Spend your extra credits?",
  extraOnBody:
    "When your plan credits run out, new runs keep going on the credits you bought instead of being refused. This spends credits you paid for.",
  extraOnConfirm: "Turn on extra credits",
  extraOnWord: "SPEND",

  // Publish approvals
  approveTitle: "Approve “{video}”?",
  approveBody:
    "This lets the video go public. The publish gate still runs in front of it.",
  approveConfirm: "Approve",
  rejectTitle: "Reject “{video}”?",
  rejectBody:
    "The video is not approved to go public. The request is closed as rejected, and a new request is needed to ask again.",
  rejectConfirm: "Reject",

  // The review panel on a video
  rvApproveTitle: "Record your approval of “{title}”?",
  rvApproveBody:
    "This records that you approve the video. It does not publish it: the video was uploaded as private and stays private until you make it public on YouTube. Nothing is carried out automatically yet.",
  rvRegenTitle: "Render “{title}” again?",
  rvRegenBody:
    "This records your request to render the video again. Nothing is rendered yet: no run picks the request up, so nothing is spent and the video stays as it is.",
  rvScriptTitle: "New script for “{title}”?",
  rvScriptBody:
    "This records your request for a new script and a new video. Nothing is written or rendered yet: no run picks the request up, so nothing is spent and the video stays as it is.",
  staleSheet: "This changed while the question was open, so nothing was sent. Open it again and check.",

  // API access and limits
  apiActivateTitle: "Activate the API?",
  apiActivateBody:
    "You can then create API keys. A program that holds a key can spend your prepaid API balance, up to the limits you set. You accept the API terms.",
  apiActivateConfirm: "Activate API",
  limitOrgTitle: "Change the monthly API limit?",
  limitKeyTitle: "Change the monthly limit of “{name}”?",
  limitBody: "API calls are refused once this month's API spending reaches the new limit.",
  limitConfirm: "Change limit",
  limitNone: "No limit",
  limitPlanCeiling: "None set, the plan ceiling of {cap} applies",
  limitUp: "Higher: more can be spent through the API each month.",
  limitDown: "Lower: calls are refused sooner.",
  limitSame: "The same as now: nothing changes.",
  limitOrgBlocked: "A limit of $0 blocks every API call from this account until you raise it.",
  limitKeyRemoved: "Limit removed: this key is held back only by the limits of the account.",
  limitKeySet: "A limit is added: this key stops when it is reached.",
  limitKeyBlocked: "A limit of $0 blocks every call made with this key until you raise it.",
  limitCeilingBinds: "You entered {entered} but your plan ceiling is {cap}, so {cap} applies.",

  // Team: claiming ownership
  claimTitle: "Make yourself the owner?",
  claimBody:
    "You become the owner of this workspace, with full access to keys, providers, credits and the team. Your own role cannot be changed from here afterwards: only another owner can do that.",
  claimConfirm: "Become the owner",
};

export type ConfirmSheetsDictionary = typeof confirmSheetsEn;
