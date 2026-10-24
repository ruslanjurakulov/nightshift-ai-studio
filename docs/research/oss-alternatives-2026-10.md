# Open-source alternatives named in a social post: licences and verdicts

Status: research notes, 2026-10-24. Internal only. Docs only: this changes no code, no default and no dependency.

How it was done: a read-only pass. Repository metadata came from the GitHub search API; repo pages and raw LICENSE
files were read through a fetch tool whose summariser read the pages, so README details are second-hand. LICENSE headers
were read from the raw files. Nothing was cloned, installed or run. Fetched text was treated as data, not instruction.
This is a description of what the licence texts say, not legal advice. Stars, forks and "last commit" are the numbers seen
on 2026-10-24 and drift daily.

Per `docs/ROADMAP_VIDEO_OS.md`, external projects are a source of patterns, never of code. Nothing below changes that.

## Do not adopt

**VoiceStudio (debpalash/VoiceStudio), as a voice engine for Nightshift or its customers.**

Verdict: do not adopt. The facts below are the project's own statements (README, model documents, website, install
script), fetched 2026-10-24, not independently checked unless marked otherwise.

Licences and weights:

- The README says AGPL-3.0 covers the application only; model weights, voices and outputs are governed separately.
- The default OmniVoice weights are non-commercial (CC-BY-NC), although the engine's code is Apache-2.0. A paid product,
  or monetised channels, are not cleared to use them.
- The same pattern repeats: the GGUF conversion of that model is CC BY-NC 4.0, the NLLB-200 600M translation model is
  CC BY-NC 4.0, and the Llama-OuteTTS family adds CC BY-NC-SA 4.0.
- Its own model inventory lists 56 repositories plus 7 families with unresolved licences, and does not claim any
  commercial clearance. The blocking issue is the weights, not the app licence.
- AGPL on the app: running it unmodified as a separate service is a grey area; modifying it and letting users reach it
  over a network brings source-offer duties. A paid Pro build is sold (reported as $99 per year or $299) and is closed
  source, and contributors sign a CLA in favour of Yupcha Softwares.

Consent and ownership:

- It would bypass the model in `docs/CUSTOM_VOICE.md`: a user clones their own voice, only that user uses it, ownership
  is enforced in the database (`voice_usable_by`), and the consent trail is append-only.
- No technical consent or ownership check at clone time was found in what was read; the README only asks the user to
  clone with permission. A third-party engine that does not go through our functions has none of our guarantees.
- `CLAUDE.md` rule 4 (no silent quality fallback) forbids quietly substituting it for the configured voice. A channel
  set to a voice either gets that voice or no video is made.

Local API and install:

- Its local API listens on port 3900. Its docs say clients on the loopback interface need no credential and remote
  clients use a bearer key, and that the key is not a substitute for network isolation. The default bind address was
  not verified.
- The homepage install command downloads and runs a PowerShell script in one step. Never run a piped installer
  unreviewed. The script was read in full: it only downloads the release installer and compares its SHA-256 with a
  checksum file from the same release host, with no signature check and no antivirus, firewall or service changes.
  What the installer itself puts on the machine was not verified.

Popularity claims do not agree:

- GitHub showed 84.7k stars next to about 300 watchers, while the project's website says 50,000 stars (as of 30
  September 2026). Neither number was reconciled.
- The "646 languages" figure has no derivation in the docs read; the website compares it to a competitor's 645 claim.
  Treat it as unverified.
- 103k Docker pulls and 93 contributors were also stated and are unverified.

**wide-trace/open-higgsfield (and any repo with no licence).**

- The repository has no licence file and its README names none. Without a licence, all rights stay with the author:
  we may not copy, modify or redistribute it. Ideas only.
- It is a web front-end, not a replacement for Higgsfield. It calls a remote generation API with a pasted key, and
  the auth scheme resembles the official Higgsfield platform's, so it is most likely a UI over Higgsfield's own paid
  API. That is an inference; its README does not say so.
- The name is ambiguous: other unrelated repos use the same or a similar name (some MIT or Apache-2.0). It cannot be
  proven which one the post meant.
- Nightshift already has a Higgsfield dialect in `modules/video_providers.py`, off unless the operator enables it.
  A model appears only after a real call through its adapter has succeeded (Definition of Done).

## Licence matrix

For a commercial SaaS. "Separate service" means we run it unmodified and only call it over HTTP.

| Project | Licence | As a separate service | Copy or link code in | Note |
| :-- | :-- | :-- | :-- | :-- |
| wide-trace/open-higgsfield | none stated | n/a | no right to copy | ideas only |
| VoiceStudio | AGPL-3.0 app; model weights under their own, partly non-commercial, licences | AGPL terms attach to that program | would put our combined work under AGPL | blocked by the non-commercial default weights |
| open-seo (every-app) | MIT | fine | fine, keep attribution | its data comes from a paid third party |
| WeKnora (Tencent) | MIT, with listed third-party components | fine | fine, keep third-party notices | |
| openwhispr | MIT | fine | fine | a desktop app, not a server component |
| cal.diy (Cal.com) | MIT | fine | fine | its README says personal, non-production use |
| chatwoot | MIT, except an `enterprise/` directory under a separate licence | fine, community code only | fine outside `enterprise/` | never touch `enterprise/` |
| openproject | GPL-3.0 | fine | copying makes the distributed combined work GPL | irrelevant for us |
| Cap (CapSoftware) | AGPL-3.0, two crate families MIT | as VoiceStudio | as VoiceStudio | using it as a recorder imposes nothing on our product |

## Verdicts

Adopt means "worth doing now". Ideas only means "read for patterns, copy nothing". Skip means "not for Nightshift now".

| Project | Verdict | Why, in one line |
| :-- | :-- | :-- |
| Cap | Adopt, as a tool | Record the Command Center for marketing demos. No integration. Keep real keys off screen (rule 1). |
| openwhispr | Ideas only | Local whisper.cpp and Parakeet are worth measuring for caption speed, but measure first and change no default (rule 8). |
| open-seo | Ideas only | The software is free; the data is pay-per-call through DataForSEO, and it is Google-oriented, not YouTube. vidIQ and NexLev already cover YouTube signal. A Scout check comes before any spike. |
| wide-trace/open-higgsfield | Ideas only | No licence. A UI, not a replacement. See "Do not adopt". |
| VoiceStudio | Do not adopt | See "Do not adopt". Its transcription route is the only part with any use, and only as an idea. |
| WeKnora | Skip | A knowledge-base and RAG platform. A channel's own transcripts do not verify facts; grounding needs external sources (see `docs/GROUNDED_FACTCHECK.md`). Large attack surface. |
| chatwoot | Skip for now | Real ops cost and a CSP change (`docs/security/CSP.md`, report-only soak first). Revisit when there are paying users. A monitored support email comes first. |
| cal.diy | Skip | Its own README says not for production. Use a hosted scheduler or a mailto link. |
| openproject | Skip | GitHub issues, PRs and the roadmap docs are the project-management system. |

The claim in the post that each is a free replacement is mostly true only for Cap, openwhispr, chatwoot, cal.diy,
openproject and WeKnora (software cost zero; hosting and ops are not). It is misleading for open-seo (paid data),
open-higgsfield (a front-end over paid credits) and VoiceStudio (GPU needed, non-commercial weights).

## What this PR does with the research

Only one code change follows from it, and it is contract-only: `SpeechToTextProvider` and `KeywordResearchProvider`
Protocols in `modules/providers.py`, with thin adapters over the existing Whisper path
(`SubtitleGenerator.transcribe`) and `vidiq_client.keyword_research`. Nothing calls them; behaviour is unchanged. They
give a later, measured swap (rule 8) a seam to land on without touching the pipeline.

## What is unverified

- Licence field per repo via the API; I used raw LICENSE files, which worked for eight of nine (wide-trace has none).
- Contributor counts and bus factor; only recent-commit authors were seen.
- VoiceStudio: everything under its "Do not adopt" section is the project's own statement. Not verified: the real star
  history, the 646-language claim, the 103k Docker pulls and 93 contributors, the default bind address of the local API,
  what the Windows installer does once run, the Pro build's price and terms beyond what was stated, voice quality against
  the current provider, whether cloning is exposed over HTTP, GPU sizing, and the contents of its licensing folder.
- open-seo: which DataForSEO endpoints it uses, whether YouTube or Trends data is included, per-call prices.
- Prices of hosted tiers (Cap, Chatwoot, OpenWhispr) and which edition Chatwoot's AI agent belongs to.
- Russian and Uzbek quality for any speech model named here, including Parakeet and Whisper `base`.
- Security advisories and CVEs for every repo (not searched).
- Which "open-higgsfield" the post meant, and whether the hosted site's operator is the repo owner.
