/**
 * Custom voice page (components/voice/*, slice V3 of docs/CUSTOM_VOICE.md). English is the source: ru.ts and uz.ts are typed
 * `CustomVoiceDictionary`, so they must carry exactly these keys. The ru and uz sentences are machine drafts: have a native speaker
 * read them. No provider or model names, and no voice id, reference, hash or path is ever put into a sentence.
 *
 * The consent text is a PLACEHOLDER (consentPlaceholderBody): no legal wording is written here, counsel supplies it. The five
 * declaration labels are short statements of the five facts the database requires; counsel reviews them with the consent text.
 */
export const customVoiceEn = {
  title: "Custom voice",
  subtitle: "Create a voice from your own voice, and use it on your channels.",

  // What it is, and what it is not
  introTitle: "How it works",
  introBody:
    "You record yourself reading a short phrase. We check that the phrase was read aloud, create a voice from the recording, and let you hear it before you approve it. Only you can use the voice, and only on channels you attach it to.",
  how1: "Agree to the declarations and name the voice.",
  how2: "Read the phrase we show you, aloud, into your microphone.",
  how3: "We check the recording and create the voice. This can take a few minutes.",
  how4: "Hear the voice, approve it, and attach it to a channel.",
  limitsTitle: "What the check does and does not prove",
  limitsBody:
    "The check proves that a live person read a phrase in this recording. It does not prove whose voice it is: someone could play a recording of another person and read the phrase over it. It lowers casual misuse, nothing more. Use only your own voice.",
  recordOnlyBody: "You record here, in your browser, in one take. Uploading an audio file is not possible.",
  deletionBody: "The raw recording is deleted soon after the voice is created. You can delete the voice at any time.",
  disclosureBody: "Attaching the voice to a channel also records, in that channel's AI disclosure, that its voice is a clone of your own.",

  // Not available (the database refuses, or is not ready)
  notAvailableTitle: "Not available yet",
  notAvailableBody:
    "Creating a custom voice is not switched on yet. Nothing was recorded or sent. You can come back later.",

  // The list
  yourVoices: "Your voices",
  noVoices: "You have no custom voices yet.",
  addVoice: "Add a voice",
  loading: "Loading your voices…",
  loadFailed: "Your voices could not be loaded.",
  retry: "Try again",
  refresh: "Check again",
  checkingStatus: "Your recording is being checked. This page updates by itself.",
  checkingPaused: "Automatic checking stopped. Use “Check again” to look for an update.",

  // Statuses and their one-line meaning
  statusPending: "Checking your recording",
  statusTesting: "Ready to try",
  statusApproved: "Approved",
  statusRejected: "Not created",
  statusDeleted: "Deleted",
  statusUnknown: "Unknown",
  pendingAwaitingBody:
    "No recording has been checked for this request yet. If you did not finish recording, delete this request and start again.",
  pendingBody: "We are checking the recording and creating the voice. This can take a few minutes, and longer when we are busy.",
  testingBody: "The voice was created. Hear it with a test sentence, then approve it. It is not usable on a channel before you approve it.",
  approvedBody: "You approved this voice. You can attach it to a channel.",
  rejectedBody: "This voice was not created: {reason}",
  deletedBody:
    "Deletion was requested. The voice and the recording are removed in the background, which can take a little while.",
  unknownBody: "The state of this voice could not be read. Reload the page.",

  // Why a voice was not created (closed reasons)
  reasonSampleTimeout: "no recording arrived within 2 hours. Start again and record straight away.",
  reasonPhrase: "we could not hear the phrase read in the recording. Start again, read the phrase clearly and exactly.",
  reasonTooLong: "the recording was too long.",
  reasonTooLarge: "the recording file was too large.",
  reasonNotAudio: "the recording could not be read as audio.",
  reasonNotReceived: "the recording was not found.",
  reasonNotEnabled: "creating voices is not switched on for this service yet.",
  reasonProvider: "the recording could not be turned into a voice. Start again with a clearer recording.",
  reasonOurSide: "there was a problem on our side, not with your recording. Try again later.",
  reasonUnknown: "no reason could be shown.",

  // Consent
  consentTitle: "Before you start",
  nameLabel: "Name of the voice",
  nameHint: "2 to 60 characters. Only you see this name. Do not name a voice after another person.",
  declarationsLegend: "I declare that",
  decOwnVoice: "this is my own voice",
  decSoleSpeaker: "I am the only person speaking in the recording",
  decOver18: "I am over 18 years old",
  decDataToPartner: "I understand that my recording is sent to our voice technology partner to create the voice",
  decNoImpersonation: "I will not use this voice to imitate or impersonate any other person",
  consentTextTitle: "Consent text",
  consentPlaceholderMarker: "PLACEHOLDER: counsel review required",
  consentPlaceholderBody:
    "The consent text has not been written yet. It will be supplied after review by counsel. Nothing on this page is legal text.",
  consentVersion: "Consent text version: {version}",
  continue: "Continue",
  cancel: "Cancel",
  requesting: "Starting…",

  // Errors of the request
  errRateLimited: "You have reached the limit of voice requests for today. Try again tomorrow.",
  errVoiceSlots: "You already have the most voices allowed at a time. Delete one first.",
  errOrgRequired: "Choose a workspace first, then try again.",
  errNameLength: "Use 2 to 60 characters for the name.",
  errNameCharacters: "The name has characters that are not allowed.",
  errNameRealPerson: "A name that points to another person is not allowed. Name the voice anything that does not.",
  errNameLink: "A name cannot contain a link or symbols such as @ or /.",
  errDeclarations: "Every declaration must be ticked.",
  errConsentVersion: "The consent text on this page is out of date. Reload the page.",
  errForbidden: "You do not have permission to do this here.",
  errSignedOut: "You are signed out. Sign in again and retry.",
  errNotFound: "That voice or channel could not be found.",
  errKeyReused: "That request changed after it was sent. Reload the page and start again.",
  errNetwork: "The request did not reach the server. Check your connection and try again.",
  errGeneric: "Something went wrong. Nothing was changed. Try again.",

  // Recording
  recordTitle: "Record the phrase",
  phraseLabel: "Read this phrase aloud",
  phraseHelp:
    "Read it once, clearly, at a normal pace, then keep the recording running. A recording must last between {min} and {max} seconds.",
  expiresNote: "This request ends at {time}. After that you need to start again.",
  startRecording: "Start recording",
  stopRecording: "Stop recording",
  reRecord: "Record again",
  uploadRecording: "Use this recording",
  timerLabel: "Recording time",
  timerValue: "{seconds} s of {max} s",
  recRecording: "Recording. {seconds} seconds.",
  recRequesting: "Waiting for your permission to use the microphone…",
  recTooShort: "That recording was {seconds} seconds. It must be at least {min} seconds. Record again.",
  recReady: "Recorded {seconds} seconds. Listen to it, then use it or record again.",
  recMaxReached: "The recording stopped at the {max} second limit.",
  listenLabel: "Listen to your recording",
  recUnsupported: "This browser cannot record audio here. Use a current version of Chrome, Edge, Firefox or Safari.",
  recBlockedBySite: "Recording is not enabled for this site yet, so it cannot use your microphone.",
  recDenied: "Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.",
  recNoDevice: "No microphone was found. Connect one and try again.",
  recFailed: "The recording failed. Try again.",

  // Upload
  uploading: "Sending your recording…",
  uploadDone: "Recording sent. It is now being checked.",
  uploadExpired: "This request has ended, so the recording was not accepted. Start a new one.",
  uploadExists: "A recording was already sent for this request.",
  uploadTooLarge: "The recording is too large to send.",
  uploadNetwork: "The recording did not reach the server. Your take is kept: try sending it again.",
  uploadFailed: "The recording could not be sent. Try again.",
  retryUpload: "Send again",
  close: "Close",

  // Test step
  testTitle: "Hear the voice",
  testStubLabel: "Not connected yet",
  testStub:
    "Hearing a test sentence here is not connected yet. TODO: a short test through the Studio speech tool. Until it exists, a voice cannot be approved.",

  // Approve
  approve: "Approve this voice",
  approveTitle: "Approve this voice?",
  approveMessage: "Approving says you have heard this voice and it is yours to use. You can still delete it at any time.",
  approveDone: "Voice approved.",
  refNotTesting: "This voice is not ready to approve.",
  refNotVerified: "The recording check has not passed for this voice.",
  refNotTested: "Approval needs a finished test with this voice in Studio first.",

  // Channel
  channelTitle: "Use on this channel",
  attachNeedsChannel: "Open a single channel to attach a voice to it.",
  attachedHere: "This voice narrates this channel.",
  attachedElsewhere: "Attached to {count} channel(s).",
  attach: "Attach to this channel",
  detach: "Detach from this channel",
  attachTitle: "Attach this voice?",
  attachMessage: "This channel's narration will use this voice, and the channel's AI disclosure will say its voice is a clone of your own.",
  detachTitle: "Detach this voice?",
  detachMessage: "Runs on this channel are refused until you choose another voice for it.",
  attachDone: "Voice attached.",
  detachDone: "Voice detached.",
  refNotApproved: "Only an approved voice can be attached.",
  refVoiceInUse: "This voice is already the narrator of another channel.",
  refUnknown: "The change was not made.",

  // Delete
  deleteVoice: "Delete voice",
  deleteVoiceTitle: "Delete this voice?",
  deleteVoiceMessage: "The voice stops working at once and is taken off every channel. This cannot be undone.",
  deleteVoiceDone: "Voice deleted.",
  deleteSample: "Delete my recording",
  deleteSampleTitle: "Delete the recording?",
  deleteSampleMessage: "The raw recording is deleted. The voice stays.",
  deleteSampleDone: "Recording deletion requested.",
  sampleStored: "Your raw recording is stored.",
  samplePurgePending: "Your raw recording is queued for deletion.",
  samplePurged: "Your raw recording has been deleted.",
  working: "Working…",
};

export type CustomVoiceDictionary = typeof customVoiceEn;
