import type { ActionRefusal, RpcProblem } from "@/lib/custom-voice";
import type { Dictionary } from "@/lib/i18n";

type D = Dictionary["customVoice"];

/** The sentence for a closed problem word. The raw database message is never shown. */
export function problemText(problem: RpcProblem, d: D): string {
  switch (problem) {
    case "rateLimited":
      return d.errRateLimited;
    case "voiceSlots":
      return d.errVoiceSlots;
    case "orgRequired":
      return d.errOrgRequired;
    case "nameLength":
      return d.errNameLength;
    case "nameCharacters":
      return d.errNameCharacters;
    case "nameRealPerson":
      return d.errNameRealPerson;
    case "nameLink":
      return d.errNameLink;
    case "declarations":
      return d.errDeclarations;
    case "consentVersion":
      return d.errConsentVersion;
    case "forbidden":
      return d.errForbidden;
    case "signedOut":
      return d.errSignedOut;
    case "notFound":
      return d.errNotFound;
    case "keyReused":
      return d.errKeyReused;
    case "network":
      return d.errNetwork;
    case "notAvailable":
      return d.notAvailableBody;
    default:
      return d.errGeneric;
  }
}

export function refusalText(refusal: ActionRefusal, d: D): string {
  switch (refusal) {
    case "notTesting":
      return d.refNotTesting;
    case "notVerified":
      return d.refNotVerified;
    case "notTested":
      return d.refNotTested;
    case "notApproved":
      return d.refNotApproved;
    case "voiceInUse":
      return d.refVoiceInUse;
    default:
      return d.refUnknown;
  }
}
