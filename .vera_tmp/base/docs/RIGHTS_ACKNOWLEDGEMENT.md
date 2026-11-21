# Rights acknowledgement (migration 0174)

Wherever a provider or the law restricts what a person may send, the person confirms it, explicitly, before the input is sent:
*"Do you take responsibility for using the face of this person? I confirm I have the consent of every person shown."* This is how a
restricted model is opened instead of being kept hidden. Our Terms §6.2 already forbid a real person's likeness without consent and
infringing material; this step makes the promise explicit, per input, and recorded.

## What it is

| Piece | Where | What it does |
| :-- | :-- | :-- |
| Kinds and their text version | `rights_acknowledgement_kinds` (0174), `command-center/lib/rights-acknowledgement.ts` | The closed list below, and the CURRENT version of each kind's words |
| The words | `command-center/lib/i18n/rights-acknowledgement/{en,ru,uz}.ts` | The question and the statement the person confirms, per kind |
| The record | `rights_acknowledgements` (0174) | Who (`auth.uid()`), which organization, which kind, which text version, **which language the words were read in** (en / ru / uz), which input (asset id and its sha256), when. **Append-only**; written only by `acknowledge_rights()`, at most 60 new rows a person an hour; members of the organization read it |
| The model's requirement | `model_registry.requires_acknowledgement` and `spec.requires_acknowledgement` (`schemas/model_registry.json`) | The kinds a job of the model needs, for each input. The UNION of the two counts. The column only grows: a sync copies the spec's kinds into it, and only a migration (the table's owner) can remove one; the service key cannot |
| The gate | `create_creative_job` (0174 on 0075's body) | Refuses `acknowledgement_required` (NS400, HTTP 428; detail `kind=… version=… subject=…`) after the price and before the ceiling, the hold and the job row |
| Workflows | `workflow_quote_steps`, `start_workflow_run` (0174 on 0073's bodies) | A step whose model requires a kind and takes a media input is refused at the quote and at the start, before any hold: an earlier step's output cannot be acknowledged in advance, and a later step may run in another member's session. Such a model is used from the Studio |
| The public API | `api_creative_refusal` (0174 on 0124's body) | 428 `acknowledgement_required`: "confirm in the Studio"; the API has no call to acknowledge |
| The dialog | `components/studio/RightsAcknowledgementDialog.tsx` | The exact words, one unticked "I take responsibility" box **per file**, a link to Terms §6.2; records the answer with the language shown, then the same press is sent again |

## The kinds

| Kind | Text version | Covers | Words (en) |
| :-- | :-- | :-- | :-- |
| `likeness_photo` | `likeness_photo.v1` | A real person's face in an uploaded image or video | "Do you take responsibility for using the face of this person?" / "I confirm I have the consent of every person shown in this picture or video to use their face and likeness here." |
| `voice_clone` | `voice_clone.v1` | A real person's voice | "Do you take responsibility for using this person's voice?" / "I confirm this is my own voice, or that the person whose voice it is gave me their explicit consent to use it here." |
| `third_party_content` | `third_party_content.v1` | Copyrighted material the person owns or licensed | "Do you take responsibility for using this material?" / "I confirm I own this material, or that I have a licence to use it here." |

Uzbek keeps the owner's tone, plain and direct: *"Bu odamning yuzidan foydalanish uchun javobgarlikni oʻz zimmangizga olasizmi?
Rasmda yoki videoda koʻringan har bir insonning yuzi va qiyofasidan bu yerda foydalanishga roziligi borligini tasdiqlayman."* The ru
and uz texts are **pending native review**: machine drafts that a native speaker must read and correct before any model that
requires a kind (today Runway) is sold. A correction that changes the meaning is a new text version (below).

## Known provider restrictions, mapped to a kind

From `schemas/model_registry.json` `terms_notes` (read 2026-11-14). Only the Runway entries are seeded in 0174; every other row is a
map for the PR that opens that model, not a change.

| Provider / model | Restriction (as the registry records it) | Kind | State |
| :-- | :-- | :-- | :-- |
| Runway `runway-gen4.5`, `runway-gen4-turbo` | Terms of Use §4.2: no photograph of another person without that person's permission; "the i2v upload needs a photo-consent confirmation in the UI" | `likeness_photo` | **Seeded** (column and registry file). Availability unchanged: both stay unsold until a later PR opens them |
| ElevenLabs (custom voice, 0117, `docs/CUSTOM_VOICE.md`) | A voice clone needs the speaker's consent | `voice_clone` | Not seeded: custom voice has its own five declarations (`voice_consents`), which already cover it. Dubbing and voice change (`dub`, `voice_change`) keep a speaker's voice and stay behind a `terms_gate` |
| Pika `pika-2.5`, `pika-pikaframes` | AUP: no uploads of real people without consent | `likeness_photo` | Not seeded (`terms_gate` `terms_review_required`) |
| Kling `kling-4.0-omni-edit` | 3.7: uploaded data is authorised; 8.2.6: nothing infringing third parties' rights | `likeness_photo`, `third_party_content` | Not seeded; Character Studio's consent step (0137) is in front of it today |
| BytePlus Seedream / Seedance (`seedream-*`, `seedance-2.*`) | AUP: no real person's likeness without consent; Seedance 2.x refuses real faces unless verified through BytePlus | `likeness_photo` | Not seeded (`terms_gate` `written_consent_required`) |
| Krea `krea-3`, `krea-3-regional`; Grounded `grounded-image-1.0` | No deepfakes / real likeness without consent | `likeness_photo` | Not seeded (`terms_gate` `terms_review_required`) |
| LTX `ltx-2.*` | AUP: commercially used output must not replicate a real likeness or brand | `likeness_photo`, `third_party_content` | Not seeded (`terms_gate` `terms_review_required`) |
| Our Terms §6.2 (every model) | No realistic image, video or voice of a real person without consent; nothing infringing copyright | all three | The baseline every kind restates |

Opening a model that needs one: add the kind to the entry's `requires_acknowledgement` in the registry file (synced into `spec`),
and, for a restriction the database must hold even if the file is edited, to `model_registry.requires_acknowledgement` in a migration.

## The rules it keeps

- **The database decides** (CLAUDE.md rule 3). The browser shows words and records an answer; `create_creative_job` refuses a job
  without the record. Every way a generation starts goes through it: the Studio, the public API (`api_creative_create`), MCP and
  workflow runs.
- **Before any spend** (rule 6). The check runs after an idempotent replay is answered and after the price (so a model that is
  refused anyway never asks anyone to take responsibility), and before the price ceiling, the hold and the job row. A refused press
  leaves no job, no hold and no ledger row. Workflows are refused at the quote and the start, before their first hold.
- **This person, this input, these words.** A colleague's acknowledgement, another organization's, and one of an older text version
  do not count. Each file has its own box, never pre-ticked; nothing is kept in the browser; a new input or new words ask again.
- **Words the page does not carry are not shown.** When the database names a version this build does not have, the dialog asks for a
  reload and records nothing, so nobody acknowledges words they were not shown.
- **A typo fails closed.** A kind outside the closed list can never be acknowledged, so a model that names one refuses every input.
- **No text-only gate.** A job with no input (text to video) has nothing to acknowledge and is not asked.

## Changing the words

A change of meaning in any language is a new version: a migration updates `rights_acknowledgement_kinds.text_version`, and the same
PR updates `RIGHTS_TEXT_VERSIONS` and the words (`tests/rights-acknowledgement.test.ts` fails when the two disagree). Every earlier
acknowledgement then stops counting, and the record keeps both. Fixing a typo that changes nothing is not a new version.

## Verify, undo, replay

- md5 after 0174: `create_creative_job` `88107b00b0a8c143606ed17f5898c98d` (before `4c74918fd9d938c8fe4f5a3d26a09d84`, 0075), `workflow_quote_steps` `8f9f42da9844571a18a285d87bcffc84`,
  `start_workflow_run` `8b3c4b4afbc19e6f336c09b4692ad7ed`, `api_creative_refusal` `e6ec45d0d912389a05eb2d40261c2c2a`. The migration's Verify query checks all four.
- **Replay.** Re-running 0075 or 0073 over 0174 is NOT refused (0075's guard is a `position()` check that 0174's body passes; 0073
  has none): it silently puts the old body back and the gate is gone. Undo 0174 first, and run the Verify query after any manual
  replay.
- Undo: `docs/sql/rollback_0174_rights_acknowledgement.sql` puts the four earlier bodies back and drops 0174's functions and the
  requirement guard; it **keeps the record** (the tables with their rows, the append-only triggers, the column). Apply it only
  while no model that requires a kind is on sale.
- 0187 (`0187_rights_acknowledgement_inputs.sql`) widens the gate to every file a job sends: the style kit's reference
  pictures and every @character's pictures count as inputs; a failover (`reroute_creative_job`) skips a candidate that would
  ask for an acknowledgement the requester never gave; and `start_film` refuses `acknowledgement_required` before the hold
  when a clip's uploaded first/last frame, or a key frame's references, characters or style kit, reach a model that requires one.
