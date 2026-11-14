/**
 * The rights acknowledgement dialog (components/studio/RightsAcknowledgementDialog.tsx, migration 0174,
 * docs/RIGHTS_ACKNOWLEDGEMENT.md). English is the source: ru.ts and uz.ts are typed `RightsAckDictionary`, so they carry exactly
 * these keys.
 *
 * `kinds.*.question` and `kinds.*.statement` ARE the versioned text (lib/rights-acknowledgement.ts RIGHTS_TEXT_VERSIONS): a person
 * acknowledges exactly these words. Changing their meaning in any language is a new text version (a new migration and a new
 * constant), never an edit in place. Fixing a typo that changes nothing is not.
 */
export const rightsAckEn = {
  title: "Before you generate",
  intro: "This model's maker and our Terms require your confirmation before your file is sent.",
  kinds: {
    likeness_photo: {
      question: "Do you take responsibility for using the face of this person?",
      statement: "I confirm I have the consent of every person shown in this picture or video to use their face and likeness here.",
    },
    voice_clone: {
      question: "Do you take responsibility for using this person's voice?",
      statement: "I confirm this is my own voice, or that the person whose voice it is gave me their explicit consent to use it here.",
    },
    third_party_content: {
      question: "Do you take responsibility for using this material?",
      statement: "I confirm I own this material, or that I have a licence to use it here.",
    },
  },
  subjectsLabel: "This applies to",
  subjects: {
    source_asset_id: "The picture you attached",
    end_asset_id: "The end picture",
    other: "An attached file",
  },
  checkbox: "I take responsibility",
  termsLink: "Our Terms, section 6.2",
  version: "Text version {version}",
  recordNote: "Your confirmation is recorded with your account, this file and the time. It is asked again for another file, and when this text changes.",
  confirm: "Confirm and generate",
  confirming: "Recording your confirmation…",
  cancel: "Cancel",
  close: "Close",
  checking: "Checking what this model needs…",
  retry: "Try again",
  problems: {
    version_changed: "The wording of this confirmation changed since the page was loaded. Reload the page to read the current text. Nothing was started or charged.",
    stale: "This page does not have the current wording of this confirmation. Reload the page to read it. Nothing was started or charged.",
    rate_limited: "You have confirmed many files in the last hour. Try again later. Nothing was started or charged.",
    source_unavailable: "This file is no longer in your organization's library. Pick it again. Nothing was started or charged.",
    unavailable: "This confirmation is not available on this deployment yet, so this model cannot be used with your file. Nothing was started or charged.",
    forbidden: "You can't confirm for this workspace. Nothing was started or charged.",
    failed: "Your confirmation could not be recorded. Nothing was started or charged.",
  },
};

export type RightsAckDictionary = typeof rightsAckEn;
