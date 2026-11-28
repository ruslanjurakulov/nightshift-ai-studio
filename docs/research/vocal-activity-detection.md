# Vocal-activity detection for Lyria's instrumental-only guarantee (S6)

Scout chose the detectors (summary of Scout's findings as relayed to Forge, 2026-11-28). Forge re-read the licences and pinned the
files on 2026-11-28; where Forge checked something itself, the entry says so. No vendor (Google) was called for this document.

## Why this exists

Lyria 3.5 is sold, when it is sold, as **instrumental only**: no proven sung language exists yet (docs/research/lyria-3-5.md).
`GoogleLyriaAdapter` (modules/capabilities/google_interactions.py) holds that in three layers:

1. a courtesy refusal of prompts shaped like lyrics;
2. Google's own instruction, `LYRIA_INSTRUMENTAL`, appended to the prompt;
3. an output check, `returned_singing`, on the lyrics or structure text Google returns.

All three read **text**. The text can be absent or wrong, and the audio is what the customer hears. So a check on the audio is a
condition of sale. Rule 8 applies: measure first, in its own PR (this one), and wire a detector only after the numbers exist.

## Candidates

| Detector | What it answers | Code licence | Weights licence | Decision |
| :-- | :-- | :-- | :-- | :-- |
| **Open-Unmix UMX-HQ, vocals model only** | Separates a vocals stem from the mix. The per-second RMS of the stem relative to the mix, in dB, is a direct "how much voice is in this second". | MIT (`openunmix==1.3.0`, [sigsep/open-unmix-pytorch](https://github.com/sigsep/open-unmix-pytorch)) | MIT License ([Zenodo 3370489](https://zenodo.org/records/3370489), `vocals-b62c91ce.pth`, 35.6 MB) | **Primary** |
| **PANNs Cnn14** | An AudioSet tagger, run on the full mix in 10 s windows. Reports the per-window maximum probability over the voice classes, and which class won. | MIT ([qiuqiangkong/audioset_tagging_cnn](https://github.com/qiuqiangkong/audioset_tagging_cnn)) | **CC BY 4.0**, attribution required ([Zenodo 3987831](https://zenodo.org/records/3987831), `Cnn14_mAP=0.431.pth`, 327 MB) | **Second signal** |
| **Silero VAD** | Speech activity, run on the 16 kHz vocal stem: seconds of speech-like voice. | MIT: the repository's LICENSE file, read by Forge on 2026-11-28 (the README badge is inconsistent, so the file is the source) | Ships inside the wheel (`silero-vad==6.2.1`), hash-pinned at load | **Optional third** |
| Demucs | Source separation | MIT | Licence of the pretrained weights unclear | **Rejected**: a model whose weights licence cannot be stated is not run, even for measurement |

The voice classes are taken from the AudioSet labels in PANNs' own `metadata/class_labels_indices.csv`. That file is pinned at a
commit and by sha256, and the indices are read from it, never typed in by hand:

- Speech
- Singing
- Choir
- Yodeling
- Chant
- Mantra
- Child singing
- Synthetic singing
- Rapping
- Humming
- Vocal music
- A capella
- Whispering
- Narration (its exact name in the file is `Narration, monologue`)

Forge found two more singing classes in the same file, **Male singing** and **Female singing**. Scout's list does not name them.
They are reported apart (`extra_singing_class_max`), so the run shows whether they matter, and they do not change what the voice
maximum means.

## Pinned files (Forge, 2026-11-28)

| File | Source | sha256 | Cross-check |
| :-- | :-- | :-- | :-- |
| `vocals-b62c91ce.pth` | Zenodo 3370489 | `b62c91cedbc7a066f1778ead5b5cecb377aa3a46a31af1cce7c5c8769339d083` | The Zenodo md5 matched. The sha256 begins with the `b62c91ce` in the file name (torch.hub's convention). |
| `Cnn14_mAP=0.431.pth` | Zenodo 3987831 | `0dc499e40e9761ef5ea061ffc77697697f277f6a960894903df3ada000e34b31` | The Zenodo md5 `541141fa2ee191a88f24a3219fff024e` matched. |
| `class_labels_indices.csv` | audioset_tagging_cnn @ `d2f4b8c18eab44737fcc0de1248ae21eb43f6aa4` | `cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429` | It has 527 rows, in the order of the model's outputs. |
| `silero_vad/data/silero_vad.jit` | wheel `silero-vad==6.2.1` | `e1122837f4154c511485fe0b9c64455f7b929c96fbb8d79fbdb336383ebd3720` | none |

## Attribution (CC BY 4.0)

The PANNs Cnn14 weights are by Qiuqiang Kong, Yin Cao, Turab Iqbal, Yuxuan Wang, Wenwu Wang and Mark D. Plumbley:

- the weights: "PANNs: Large-Scale Pretrained Audio Neural Networks for Audio Pattern Recognition (Pretrained Models)", Zenodo,
  doi:10.5281/zenodo.3987831, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/);
- the paper: IEEE/ACM TASLP 28 (2020), 2880-2894.

The weights are used unmodified, are downloaded at run time, and are not stored in this repository. The full notice is in
`THIRD_PARTY_NOTICES`, together with the MIT notices of the vendored model code (`tools/vendor_panns/`), Open-Unmix and Silero.

## Failure modes to measure, not assume

- **Humming and choir pads.** Wordless voices, which Lyria can produce even when asked for an instrumental. UMX tends to put them
  in the vocals stem. PANNs has classes for both (Humming, Choir). Whether they count as "vocals" is an **owner decision**; the
  default in docs/MEASUREMENT.md is that they do.
- **Synth and saxophone leads.** A lead instrument in the vocal range is the classic separator false positive: energy in the
  vocals stem with no voice in it. N2 in the probe is this hard negative, and it is why the stem ratio alone is not trusted.
- **Whisper and spoken word.** These are quiet and unpitched, so a ratio threshold can miss them. PANNs (Whispering, Speech,
  Narration) and Silero VAD are there for this case.
- **The separator floor.** UMX leaks some of the mix into the stem on every input. A threshold has to sit above the leak on real
  instrumentals (N1, N2), not above zero.
- **Short sung phrases.** A threshold on the share of seconds can miss a single sung line. The longest run above each threshold
  is reported for this reason.

## Open items

1. **Thresholds.** None is chosen. The probe (`.github/workflows/lyria_vocal_probe.yml`, at most 5 paid calls) produces the
   numbers, and the decision rule in docs/MEASUREMENT.md is set from them.
2. **Wordless vocals** (humming, choir, "ooh" pads). They count as vocals unless the owner decides otherwise.
3. **Five samples is a smoke measurement, not a calibration.** If the classes do not separate cleanly, a larger, owner-approved
   budget is the next step. A threshold is not guessed from five points.
4. **Memory.** On a 4-core container, a 180 s file peaked at about 3.2 GB RSS, because UMX runs on the whole track. A product
   check needs chunking, or the worker's memory budget, before it is wired in.
5. **Male singing and Female singing.** Should they join the voice set? Decide from the run.
6. **Silero's role.** It is a speech detector. Whether it adds anything on sung material beyond PANNs will show in the run.
