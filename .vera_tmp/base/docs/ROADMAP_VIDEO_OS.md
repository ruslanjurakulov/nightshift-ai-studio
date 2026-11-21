# Nightshift → Video Production OS: integratsiya rejasi

> Manba: tashqi benchmarklar (AgentTube / youtube-automation-agent, OpenMontage,
> Orkas VideoStudio, Video Factory, Remotion ekotizimi, video-talkcraft /
> shotcraft, Remotion Superpowers, video-podcast-maker) **va** Nightshift'ning
> `main` branch'idagi **real kodi** (README emas). Har bir baho quyidagi
> jadvalda fayl bilan isbotlangan.
>
> Tamoyil: noldan qayta yozmaymiz — mavjud modullarni **bitta kontrakt (Video IR)**
> atrofida birlashtiramiz. Tashqi repolardan kod ko'chirilmaydi, faqat pattern
> olinadi (ularning litsenziyasi alohida tekshirilmagan).

---

## 1. Audit: kod hozir nima qila oladi

### ✅ BOR va ishlaydi — ustiga quramiz

| Komponent | Isbot (fayl) |
|---|---|
| Stage state machine (Topic→Research→Script→Fact→Approval→Publish) | `modules/pipeline_stages.py` |
| Run checkpoint + `--resume` (script bosqichidan) | `modules/run_checkpoint.py`, `main.py` (`resume`) |
| Director Mode — har sahna uchun shot plan (kamera, yorug'lik, kayfiyat) | `modules/director.py` |
| Character Bible / Elements | `modules/elements.py` + Cast editor |
| Style presets + kanal `visual_style` | `modules/style_presets.py` |
| B-roll ↔ matn moslashtirish | `modules/broll_match.py` |
| Real audio bo'yicha bo'lim vaqti (`start_ms/end_ms`) | `modules/audio_mixer.py` → `timeline` |
| Whisper word-level subtitrlar | `modules/subtitle_generator.py` (`word_timestamps=True`) |
| Claim extraction + fact-check (advisory) | `modules/claim_extractor.py`, `modules/fact_checker.py` |
| Originality engine | `modules/originality_engine.py` |
| Publish gate (sanity + fact + originality) + 2 kishilik tasdiq | `modules/publish_gate.py`, `modules/publish_approval.py` |
| Shorts — tayyor videodan kesib olinadi (qayta render yo'q) | `modules/shorts.py` |
| Series, strategy, agent planner, content opportunity, audience demand | `modules/series.py`, `strategy.py`, `agent_planner.py`, `content_opportunity.py`, `audience_demand.py` |
| Retention tahlili, feedback engine, thumbnail/title va hook A/B | `retention_analyzer.py`, `feedback_engine.py`, `ab_testing.py`, `hook_ab.py` |
| Cost ledger, budget, balanslar, billing | `cost_ledger.py`, `budget.py`, `provider_balance.py`, `/billing` |
| Credential preflight | `modules/credential_health.py` |
| Provider interfeyslari (vendor lock-in yo'q) | `modules/providers.py`, `video_providers.py`, `image_providers.py` |
| Structured scenes (Storyboard) | `Script.scene_plan()`, `videos.scenes` (0011) |

### 🟡 QISMAN — bor, lekin tugallanmagan yoki ulanmagan

| # | Komponent | Hozirgi holat | Nima yetishmaydi |
|---|---|---|---|
| Q1 | **ffmpeg render backend** | `render_spec.py` + `render_backend.py` yozilgan, `config.RENDER_BACKEND` flag bor | `main.py`/`compositor.py` flagni **o'qimaydi** — backend hech qachon ishlamaydi. Ken Burns va word-highlight captions yo'q |
| Q2 | **Audio master clock** | Bo'lim vaqtlari real audiodan olinadi | `videos.scenes` hali `duration_hint` (taxmin) saqlaydi, real `start/end` emas; sahna ↔ so'z vaqti bog'lanmagan |
| Q3 | **Checkpoint/resume** | Script bosqichini qayta ishlatadi | Media/render/upload bosqichlari artefakt sifatida tiklanmaydi; provider `task_id` saqlanmaydi (crash → qayta pul) |
| Q4 | **Storyboard / scenes** | UI + DB bor | Director shot, asset, claim, retention bilan bog'lanmagan — faqat ko'rsatadi |
| Q5 | **Regenerate** | Review'da "butun video / script"ni qayta yaratish so'rovi | **Sahna darajasida** qayta yaratish yo'q |
| Q6 | **Publish gate sanity** | Sarlavha, bo'lim, fayl mavjudligi/hajmi | ffprobe tekshiruvi yo'q: davomiylik ≈ audio, oqimlar, qora kadr, jimlik |
| Q7 | **Fact-check** | Claim'lar advisory | Claim ↔ sahna bog'lanishi yo'q; research'da jonli manba (web search) yo'q — model xotirasi |
| Q8 | **Retention** | Video darajasida qayerda tashlab ketishadi | Sahnalarga map qilinmagan |
| Q9 | **Learning loop** | Feedback engine skorlaydi, strategy moslashadi | Tavsiyalar "pending → inson tasdiqlaydi → planner ishlatadi" oqimisiz |
| Q10 | **A/B** | Thumbnail/title (CTR), hook (retention) alohida | Umumiy Experiment Engine yo'q |
| Q11 | **Render muhiti** | GitHub Actions (2 CPU, ~7.9 GB), exit 143 tarixi, thread/GC tuzatishlari | Real 5/10/15 daqiqalik benchmark o'lchanmagan; alohida render worker yo'q |
| Q12 | **`main.py` orkestratsiya** | 1244 qator, hamma bosqich bitta funksiyada | Bosqichlar alohida, qayta ishga tushiriladigan birliklar emas |

### ❌ YO'Q — yangi komponentlar

| # | Komponent | Nega kerak |
|---|---|---|
| Y1 | **Video IR / loyiha manifesti** (bitta kanonik JSON) | Barcha bosqichlar orasidagi kontrakt; sahna darajasida tahrir/render uchun asos |
| Y2 | **Asset manifest + provenance** (manba, litsenziya, model, prompt, narx, hash) | Mualliflik huquqi, takrorlanuvchanlik, qayta generatsiyani nazorat qilish |
| Y3 | **Sahna darajasida render + render cache** | Bitta sahna xatosi uchun butun videoni qayta render qilmaslik |
| Y4 | **Shot recipe kutubxonasi** (yopiq katalog) | AI har safar animatsiya o'ylab topmaydi — tayyor retseptdan tanlaydi |
| Y5 | **Remotion video engine** (`video-engine/`) | Motion graphics: titr, grafik, xarita, timeline, kinetik matn |
| Y6 | **Deterministik video QC** (ffprobe/blackdetect/silencedetect) | O'lchanadigan sifat darvozasi |
| Y7 | **Kadr QA + AI Critic** (contact sheet + vision) | Ko'rinadigan muammolarni topish |
| Y8 | **Targeted repair loop** | Faqat muammoli sahnani tuzatish |
| Y9 | **Rights holati** har asset uchun | Huquqi noma'lum asset bilan publish bloklanadi |
| Y10 | **Upload idempotency / reconciliation** | Noaniq upload'dan keyin dublikat video chiqmasligi |
| Y11 | **Tasdiqlangan learning memory** | Analytics → tavsiya → tasdiq → keyingi video |
| Y12 | **Render benchmark to'plami** | Har o'zgarishda RAM/vaqt/sifat solishtiriladi |

---

## 2. Asosiy arxitektura qarori

```text
Script ─► Audio (REAL vaqt) ─► Director (shot recipe) ─► Assets (+provenance)
                                        │
                                        ▼
                         VIDEO IR  (output/<slug>/project.json)
                                        │
                 ┌──────────────────────┼───────────────────────┐
                 ▼                      ▼                       ▼
          ffmpeg backend          Remotion backend         MoviePy (legacy)
        (b-roll/rasm sahnalar)   (motion-graphics sahnalar)  (fallback)
                 └───────────── sahna .mp4 (cache) ─────────────┘
                                        ▼
                             FFmpeg assembly + audio mux
                                        ▼
                     Deterministik QC ─► AI Critic ─► targeted repair
                                        ▼
                     Publish gate (QC + fact + rights + approval)
```

Uchta qoida:
1. **Audio — master clock.** Sahna davomiyligi real TTS'dan olinadi, taxmindan emas.
2. **Tekshiruvdan o'tgan narsa qayta yaratilmaydi.** Sahna hash'i o'zgarmasa — render yo'q.
3. **AI qaror qiladi, kod bajaradi, validator tekshiradi.** Production vaqtida har video uchun yangi TSX yozilmaydi — IR mavjud komponentlarga beriladi.

---

## 3. Bosqichma-bosqich reja (har band = alohida draft PR)

### Faza 0 — O'lchov (hamma narsadan oldin)

**PR 0.1 — ffmpeg backend'ni ulash + render benchmark** · Q1, Q11, Y12
- `main.py`: `config.RENDER_BACKEND == "ffmpeg"` bo'lsa `render_backend` ishlaydi, xatoda MoviePy'ga qaytadi.
- Yangi `render_benchmark.yml`: `samples/demo_script.json` bilan `--no-upload`, 5/10/15 daqiqa; peak RAM, vaqt, exit code, fayl hajmi → artefakt + `system_events`.
- **Qabul mezoni:** 3 davomiylik uchun ikkala backend'ning raqamlari jadvalda. Exit 143 masalasi raqam bilan yopiladi yoki ochiq qoladi.

### Faza 1 — Poydevor: Video IR

**PR 1.1 — `modules/video_ir.py` + schema** · Y1, Q2, Q4
- `VideoProject / Scene / AssetRef` dataclass'lari va `schemas/video_ir.schema.json`.
- Builder mavjud qismlardan yig'adi: `Script.scene_plan()` + `audio_mixer.timeline` (real `start/end`) + `director` shotlari + `elements` + `broll_match` joylashuvi.
- `output/<slug>/project.json` sifatida saqlanadi, checkpoint'ga yoziladi; `videos.scenes` real vaqtlar bilan to'ldiriladi (migratsiya 0013: `videos.manifest jsonb`).
- **Qabul mezoni:** sahnalar davomiyliklari yig'indisi narration'dan ±0.5 s farq qiladi; Storyboard real vaqtni ko'rsatadi.

**PR 1.2 — Asset manifest + provenance** · Y2, Y9
- `media_fetcher`, `video_providers`, `image_providers` har asset uchun yozadi: manba, URL, litsenziya (Pexels License / provayder ToS / remix gate), muallif, model, prompt, `task_id`, narx, sha256.
- **Qabul mezoni:** IR'dagi har asset'da `rights.status` bor; noma'lum bo'lsa publish gate ogohlantiradi (keyinchalik bloklaydi).

**PR 1.3 — IR → RenderSpec kompilyator + sahna darajasida render + cache** · Y3, Q1
- IR har sahnani alohida `.mp4` qiladi; kalit = `hash(narration, asset, shot_recipe, duration, style)`; mos kelsa — render qilinmaydi.
- FFmpeg concat + audio mux + subtitr.
- **Qabul mezoni:** bitta sahnani o'zgartirgach qayta ishga tushirishda faqat o'sha sahna render bo'ladi (log bilan isbot).

### Faza 2 — Sifat darvozasi (IR'dan keyin darhol)

**PR 2.1 — Deterministik QC** · Y6, Q6
- `modules/video_qc.py`: ffprobe (davomiylik ≈ audio, video+audio oqimlari, 1920×1080, fps), `blackdetect`, `silencedetect`, sahna fayllarining mavjudligi → `qc_report.json`.
- `publish_gate` `_check_sanity`'ga qo'shiladi (jiddiylari — blok).

**PR 2.2 — Kadr QA + AI Critic (dastlab advisory)** · Y7
- Har sahnadan 1–3 kadr → contact sheet → Gemini vision: matn chiqib ketishi, bo'sh kadr, takroriy vizual, matn–vizual nomuvofiqligi → sahnaga bog'langan `issues[]`.
- Review sahifasida sahnalar bo'yicha ko'rsatiladi. Narxi `cost_ledger`'ga yoziladi.

**PR 2.3 — Targeted repair** · Y8, Q5
- `daily_video.yml` yangi inputi `repair_scenes=3,17` → faqat shu sahnalar uchun asset qayta olinadi/render qilinadi, keyin qayta yig'iladi (cache tufayli).
- Storyboard'da "Sahnani qayta yaratish" tugmasi (mavjud regenerate so'rovi pattern'i bilan).
- Tuzatilgan video bo'yicha avvalgi tasdiq **bekor qilinadi**.

### Faza 3 — Director va Remotion

**PR 3.1 — Shot recipe kutubxonasi + Style Bible** · Y4
- Yopiq katalog: `slow_push`, `parallax`, `archival_reveal`, `map_zoom`, `quote_card`, `stat_counter`, `chapter_card`, `crossfade`…
- `director.py` erkin matn o'rniga katalogdan tanlaydi; `style_presets` → shrift, palitra, caption uslubi, o'tishlar.

**PR 3.2 — Remotion engine (`video-engine/`)** · Y5
- 6 ta bazaviy komponent: `ImageScene` (Ken Burns), `VideoScene`, `TitleCard`, `Captions` (word-level), `StatCard`, `Transition`. Kirish — IR sahnasi (props JSON).
- `modules/remotion_renderer.py` — uchinchi backend, **faqat motion-graphics sahnalar uchun**; b-roll ffmpeg'da qoladi.
- Workflow: Node + Chromium o'rnatish, `concurrency=1`.
- ⚠️ Remotion litsenziyasi: shaxsiy va kichik jamoalar uchun bepul, kattaroq kompaniyalar uchun pullik — tijoriy kengayishdan oldin tekshiriladi.

**PR 3.3 — Qo'shimcha komponentlar**: `Map`, `Timeline`, `Quote`, `LowerThird`, `EvidenceCard`.

### Faza 4 — Dalil, huquq, ishonchlilik

**PR 4.1 — Claim ↔ sahna bog'lanishi** · Q7
- `claim_extractor` claim'larni bo'lim indeksi bilan belgilaydi → IR sahnasida `claim_ids` + fakt holati; Review'da sahna bo'yicha ko'rinadi.
- Ixtiyoriy: research'ga Gemini'ning Google Search grounding'i (alohida flag bilan; qo'llab-quvvatlanishi PR'da tekshiriladi).

**PR 4.2 — Rights darvozasi** · Y9
- `rights.status != ok` bo'lgan asset bilan publish — blok (hozirgi remix gate kengaytiriladi).

**PR 4.3 — Provider task persistence + upload idempotency** · Q3, Y10
- Video provider `task_id` checkpoint'ga yoziladi; resume vaqtida yangi so'rov yubormasdan poll qilinadi.
- Upload noaniq tugasa — qayta yuklashdan oldin kanaldagi so'nggi upload'lar ichidan run-hash (description'dagi yashirin marker) bo'yicha qidiriladi.
- Bu ledger'lar (`checkpoint.json`, `provider_tasks.json`, `upload_attempt.json`, `script.json`) GitHub Actions run'lari orasida har kanal uchun `actions/cache` orqali saqlanadi — `tools/run_state_cache.py`; qo'lda davom ettirish: workflow'ning `resume` inputi.

### Faza 5 — O'rganish halqasi

**PR 5.1 — Sahna darajasida retention** · Q8
- `retention_points` IR sahna oynalariga map qilinadi → sahna bo'yicha tashlab ketish skori; Storyboard'da ko'rsatiladi va script feedback'iga beriladi.

**PR 5.2 — Tasdiqlangan learning memory** · Q9, Y11
- Feedback/strategy tavsiyalari `pending` holatda saqlanadi → Learning sahifasida inson tasdiqlaydi → faqat tasdiqlanganlar planner'ga ta'sir qiladi.

**PR 5.3 — Experiment Engine** · Q10
- `ab_testing` + `hook_ab` + yangi (shot recipe / style) tajribalari bitta interfeys: gipoteza, metrika, minimal namuna, holat.

### Faza 6 — Operatsiyalar

**PR 6.1 — Render worker tanlovi** · Q11
- `vars.RENDER_RUNNER`: `ubuntu-latest` yoki `self-hosted` (sizning kompyuteringiz GitHub runner sifatida). Yangi infratuzilmasiz lokal render; bulut keyinroq.

**PR 6.2 — `main.py` dekompozitsiyasi** · Q12
- IR tayyor bo'lgach, bosqichlar alohida funksiyalarga ajratiladi (`stages/`), har biri IR'ni oladi va qaytaradi. Faqat testlar bilan himoyalangan holda.

---

## 4. Tartib va bog'liqliklar

```text
0.1 ─► 1.1 ─► 1.2 ─► 1.3 ─► 2.1 ─► 2.2 ─► 2.3
                 │            │
                 │            └─► 3.1 ─► 3.2 ─► 3.3
                 └─► 4.1 ─► 4.2       4.3 (mustaqil, istalgan vaqtda)
                                1.1 ─► 5.1 ─► 5.2 ─► 5.3
                                6.1 (mustaqil) · 6.2 (oxirida)
```

Birinchi 5 ta PR: **0.1 → 1.1 → 1.2 → 1.3 → 2.1**. Ular birgalikda "bitta prompt → real vaqtli sahnalar → sahna darajasida render → o'lchanadigan QC" zanjirini yopadi. Qolgan hamma narsa shu zanjir ustiga quriladi.

## 5. Hozir QILMAYMIZ

- Yangi dashboard sahifalari, yangi provayderlar, UI polish — zanjir yopilmaguncha.
- Har video uchun Claude/LLM yozadigan TSX (production'da faqat IR → tayyor komponentlar).
- Bulut/Lambda render, 70B lokal model — o'lchov ko'rsatmaguncha kerak emas.
- Noldan qayta yozish yoki tashqi repolardan kod ko'chirish.

## 6. Ochiq xavflar

- **GitHub Actions resurslari:** Remotion (Chromium) + 15 daqiqalik video 2 CPU'da sekin bo'lishi mumkin — PR 0.1 benchmarki va PR 6.1 buni hal qiladi.
- **Research:** jonli manba yo'q — faktlar model xotirasidan; PR 4.1 gacha fact-check advisory bo'lib qoladi, yakuniy mas'uliyat — inson tasdig'ida.
- **Xarajat:** AI Critic va vision chaqiruvlari pullik — `budget` shipi ichida, `cost_ledger`'da hisoblanadi.
