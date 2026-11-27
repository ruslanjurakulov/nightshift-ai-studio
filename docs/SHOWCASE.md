# Model samples on the public site

The landing page's "Made with Nightshift" gallery shows real generations made in the operator's own Studio. Each card says
"AI-generated", names the model, shows the prompt and the day it was made, and has a **Try this prompt** button (ru "Попробовать этот запрос", uz "Shu soʻrovni sinab koʻrish") that opens the
Studio with that tool and prompt in the form, and with the model too when customers can use it. A model only the operator can
try yet (registry `operator_preview`, today both Runway models) is left out of the link, and its card says "This model is not
in the Studio yet"; once a model is past its announced shutdown date, the same happens with "This model is no longer in the
Studio". A signed-out visitor goes through sign-up first; the form opens after /welcome. The button only fills the form:
nothing is priced or started until the person presses Generate and sees the price.

The gallery is empty, and renders nothing, until the first sample is merged.

The public site shows the AI-generated label and the model name only: no "Powered by" line and no link to a model's maker, on
any public surface (owner decision 2026-11-13). The maker's required credit (Runway API Terms §1: "Powered by Runway" linking
runway.com; Ideogram Developer API Agreement 2.3.1) is shown in the Studio, where the models are used
(`components/studio/ModelAttribution.tsx`, in the generate panel and the job feed). The entry's `attribution` stays in
`showcase.json` and the exporter, as data; `tests/site-showcase.test.tsx` pins that no public surface renders it.

## Putting a sample in a picture slot

Every picture place on the public site is a line in `command-center/components/site/slots.ts` `SLOTS` (and, for /mcp's
example cards, `components/docs/SampleFrame.tsx` `SCENE_SAMPLE`). A line's `ai` is the job id of the sample that fills it:

```ts
hero: { ai: "9a52ebf1-bbe3-473c-b77c-7553bc18e0d8", id: "cloud", clip: "cloud" },
```

- The slot shows that sample only once its entry and files are merged (the showcase PR); until then it keeps the stock picture
  (`id`, `clip`), so setting `ai` before the PR lands is safe. Exporting with the workflow's **slot** input does the same for a
  slot whose `ai` is null.
- A sample in a slot is labelled with the "AI-generated" badge only, never a stock label: no model name, no **Try this
  prompt** and no footnote (owner, 2026-11-13). A slot's picture is the backdrop for copy about something else, and naming the
  model and offering its prompt there read as if the section were about that clip; the model and the prompt are on the sample's
  own gallery card and on the tool wall. `aiPosition` frames it in the slot's box (CSS `object-position`) when the centre is wrong.
- Pick a slot's sample for the copy it sits under. Where no sample illustrates the words, draw the product instead: the landing's
  Approvals band is a drawn approval screen (`components/landing/ApprovalCard.tsx`), not a wave.
- The landing leaves a sample shown in its own slots (hero, show.studio, landing.final), on the tool wall, in the steps or on the
  approval screen out of its gallery, and also the repeated sea and sky samples in `LANDING_LEFT_OUT` (`slots.ts`), so the page
  does not read as all sea.
- The footer credits only the stock pictures some page still shows, so a stock picture drops out of the credits by itself
  once every place that used it holds a sample. When none is left, the credits say so and list no Pexels item. The stock files
  stay in the repository even then: every line still names its stock fallback (`id`, a `lib/site/media.ts` item), which the
  place shows if its sample's files were ever missing. Deleting them needs a change that makes the fallback optional first.
- The landing's format cards (`lib/site/formats.ts`) name a sample by job id the same way; their titles are in
  `lib/i18n/site/{en,ru,uz}.ts` `site.formats.items` and describe that sample, so change them together.

## Adding a sample (the owner's steps)

1. Sign in as the operator, in the operator's own workspace, and make the clip in the Studio (for example Animate with
   Runway Gen-4.5 or Gen-4 Turbo). The input picture must be ours: one of the site's AI pictures
   (`command-center/components/site/art/*.webp`, uploaded unchanged) or a picture made in the Studio. A stock photograph or any
   other upload is refused. Do not use a style kit.
2. Copy an id. The screens do not show a job id yet, so either of these works:
   - the **library file's id**: open the clip in the Library, right-click **Open in a new tab** ("Yangi oynada ochish") →
     Copy link. The id is the part after `/api/media/file/` (36 characters, up to the next `/`);
   - or the **job id**: Supabase → Table editor → `creative_jobs`, newest first, the operator's `org_id`, status `completed`
     → copy `id`.
3. GitHub → **Actions** → **Showcase asset** → **Run workflow** → paste the id (slot, caption and the three card lines are optional) → Run.
4. The run opens a **draft pull request** named "Showcase: sample from Studio job …". Its description lists the model, the
   input's provenance, the prompt and the recorded cost (or "unknown"). Watch the clip in the PR's files.
5. Checks do not start by themselves on a PR the workflow opened: close and reopen it to run them. Then merge it. The sample is
   on the site after the next deploy.

Running it again for the same job does nothing: a job already in the data file is a no-op, and a job with an open PR gets
no second one. A branch `showcase/<id>` left from an earlier run without an open PR (for example one you closed) stops the run
with an error: delete the branch and run again. Run it from main; a run dispatched on another branch fails and says so.

**One at a time:** every export edits the same two files (`showcase.json`, `showcase-assets.ts`), so two showcase PRs open at
once conflict. Merge one before exporting the next.

## What the workflow checks (tools/export_showcase.py)

Before it downloads anything: the id is a uuid and names the job or the library file it made; the job belongs to the
operator's organization (`00000000-0000-0000-0000-000000000001`), is a generation and `completed`; no style kit; the model (the routed one on Auto) is
in `schemas/model_registry.json`, its vendor terms are cleared (no `terms_gate`) and it is not past an announced
`shutdown.on`; the output is a library file this job made, not deleted, an image or a video of at most
30 s (measured with ffprobe on the downloaded file; a length that cannot be read is refused); every input picture is our AI art (matched by sha256) or the output of another completed operator job, followed back to
its first picture. Then it downloads the file through the Library's own signed link (five minutes) and refuses it unless its
sha256 is the stored one. It also refuses an entry the site would not show (a prompt over 4000 characters as the page counts
them), rather than cutting it.

It writes `command-center/components/site/showcase/<job id>/` (clip.mp4 / clip.webm at 1280 wide, clip-sm.* at 640, and a
poster of the first frame; a picture gets the two posters), appends the entry to
`command-center/lib/site/showcase.json` and regenerates `command-center/components/site/showcase-assets.ts`. The output is not
graded or retouched.

Cost: what `creative_job_costs` recorded, summed in USD with its price source, or **unknown** when there is no row or a row
has no figure (never 0); and the vendor's own measure per row (for example Runway credits).

Card line (optional): the inputs `card_line_en`, `card_line_ru` and `card_line_uz` give the sample's card a short line per
language. All three or none; each at most 140 characters after invisible characters are stripped (a longer one is refused, not
cut), and one line (a line break or a tab is refused). The entry carries it as `cardLine: {en, ru, uz}`, or `null` without one.

### Sound

Owner decision (2026-11-22): every video on the site is cinematic and has sound. The export records `audio: true` only for
sound a visitor will hear: ffprobe finds an audio stream, and one ffmpeg pass (`astats`) measures it, a peak above -60 dB (digital
silence, which generators pad with, reads -inf) and a length covering at least 80% of the picture (a few-millisecond blip is not
the clip's sound). Anything else is recorded as `audio: false`; a measurement that cannot be read refuses (`audio_unknown`). The
length limit is the VIDEO stream's, and a kept track is cut at the picture's length, so a long track never stretches clip.mp4
into a frozen frame. When there is sound, the **1280 copies keep it**: AAC 128 kb/s stereo 48 kHz in `clip.mp4`, Opus 96 kb/s stereo 48 kHz in
`clip.webm`. The 640 copies (`clip-sm.*`, the phone and grid files) stay silent (`-an`); a grid or phone clip whose sound a visitor turns
on switches, inside that press, to its full file and plays on from the same moment (`components/site/LoopClip.tsx`), so the
bytes of sound are spent only for whoever asked. The entry records what was found as
`audio: true | false` and the generated module marks such a clip `audio: true`; an entry without the field (every sample
exported before this) is silent. The site shows its sound toggle only on a clip marked `audio: true`. A probe that fails is a
refusal (`audio_unknown`), never a silent copy.

Size impact, per full copy (computed from the bitrate, then measured on a 5 s and a 10 s test tone encoded with the very
settings above):

| Copy | Bitrate | 5 s clip | 10 s clip |
| :-- | :-- | :-- | :-- |
| clip.mp4, AAC | 128 kb/s = 16 KB/s | ~80 KB (measured 80 KB) | ~160 KB (measured 159 KB) |
| clip.webm, Opus | 96 kb/s = 12 KB/s (VBR ceiling) | ~60 KB (measured 41 KB) | ~120 KB (measured 82 KB) |

Against today's 35 video samples (all silent; `components/site/showcase/*/clip.mp4`, measured 2026-11-22: median 1371 KB,
smallest 216 KB, largest 5614 KB, median length 5.2 s, longest 10.1 s; `clip.webm` median 1289 KB), sound adds about 6% to a
median 5 s `clip.mp4` and about 5% (at most) to its `clip.webm`, up to roughly a third of the smallest one. The phone files
(`clip-sm.mp4` median 345 KB) do not change.

Where the toggle shows today: nowhere. None of the 35 samples has sound, and the one Studio piece with a real track
(`language-duo`, `lib/showcase/items.ts`) is in `components/landing/home/HomePage.tsx`'s reel, which no route mounts (the
homepage is `Landing`, the owner's choice of 2026-11-22). The toggle appears by itself on the first clip exported with sound,
and only while that clip is playing (never over its still).

## Secrets and permissions

The export job reads the repository secrets `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and `MEDIA_URL_SECRET` (the same one
`deploy_web.yml` gives the server) and the variable `DOMAIN`; it cannot write to the repository. The publish job holds no
secret: it checks every file it was handed (`--verify-export`), pushes one branch `showcase/<job id>` and opens a draft PR with
the workflow's own token. Nothing pushes to main, and the workflow runs only when dispatched on main. If the repository setting "Allow GitHub Actions to create and approve pull
requests" is off, the push succeeds and the PR step fails; open the PR from the pushed branch by hand.
