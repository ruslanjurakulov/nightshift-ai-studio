# Render'ni o'z kompyuteringizda ishlatish (self-hosted runner)

> Roadmap: **Faza 6, PR 6.1** (Q11). `daily_video.yml` dagi `make-video` job'i
> endi repo o'zgaruvchisi `RENDER_RUNNER` ko'rsatgan runner'da ishlaydi.
> O'zgaruvchi **o'rnatilmagan** bo'lsa — hammasi avvalgidek, GitHub'ning
> `ubuntu-latest` mashinasida.

## Nima uchun

GitHub-hosted runner: 2 CPU, ~7.9 GB RAM. Render bir necha marta exit 143
(xotira tugashi) bilan o'ldirilgan. Sizning kompyuteringiz (masalan 8+ CPU,
32 GB RAM) GitHub Actions runner sifatida ulansa, xuddi shu workflow, xuddi shu
secret'lar bilan render sizning mashinangizda bajariladi — yangi server yoki
bulut infratuzilmasiz.

## Qanday ishlaydi

| `RENDER_RUNNER` qiymati | `make-video` qayerda ishlaydi |
|---|---|
| o'rnatilmagan / bo'sh | `ubuntu-latest` (GitHub) — avvalgi xatti-harakat |
| `nightshift-render` (sizning label'ingiz) | shu label'li self-hosted runner |

- Soatlik `resolve` job'i **har doim** GitHub'da qoladi (arzon, bir necha soniya).
- GitHub-hosted mashinada workflow avvalgidek `sudo apt-get` bilan ffmpeg /
  ImageMagick / shriftlarni o'rnatadi. **Self-hosted mashinada workflow hech
  qachon `sudo` yoki `apt-get` ishlatmaydi** — faqat kerakli dasturlar borligini
  tekshiradi va yo'q bo'lsa aniq xabar bilan darhol to'xtaydi.
- Self-hosted mashinada job oxirida (`if: always()`) workspace'dagi
  `youtube_token*.json` va `client_secret.json` fayllari o'chiriladi — OAuth
  tokenlari kompyuteringiz diskida qolib ketmaydi.

---

## ⚠️ Xavfsizlik — avval shuni o'qing

Self-hosted runner — bu repo'dagi workflow kodini **sizning kompyuteringizda,
sizning tarmog'ingizda** bajaradigan dastur. Shuning uchun:

1. **Faqat shu private repo uchun.** Runner'ni hech qachon public repo'ga
   ulamang. Public repo'da istalgan odam fork ochib, pull request orqali
   sizning mashinangizda o'z kodini ishga tushirishi mumkin.
2. **Fork PR'lardan hech qachon.** `daily_video.yml` faqat `schedule` va
   `workflow_dispatch` bilan ishga tushadi — `pull_request` trigger'i yo'q.
   Shunday qoldiring: self-hosted runner'da ishlaydigan job'ga hech qachon
   `pull_request` / `pull_request_target` qo'shmang. Settings → Actions →
   General'da "Fork pull request workflows" o'chirilgan bo'lsin.
3. **Repo private bo'lib qolishi shart.** Agar repo qachondir public qilinsa —
   avval runner'ni o'chiring (Settings → Actions → Runners → Remove) va
   `RENDER_RUNNER` o'zgaruvchisini o'chiring.
4. **Alohida, huquqsiz foydalanuvchi.** Runner'ni `root` yoki shaxsiy
   akkauntingizdan emas, alohida foydalanuvchidan (masalan `nsrunner`)
   ishga tushiring. Unga `sudo` bermang — workflow'ga kerak emas.
5. **Secret'lar mashinaga keladi.** Job ishlayotganda Gemini, ElevenLabs,
   YouTube token va boshqa kalitlar shu mashinaning xotirasida va
   workspace'ida bo'ladi. Diskni shifrlang, mashinaga boshqalar kira olmasin.
6. Runner dasturini yangilab turing (GitHub eski versiyalarni rad etadi).

---

## Mashinaga talablar

| Talab | Tafsilot |
|---|---|
| OS | **Linux x64**. Tavsiya: Ubuntu 22.04 yoki 24.04. Windows'da — WSL2 ichidagi Ubuntu. macOS qo'llab-quvvatlanmaydi (qadamlar Linux yo'llariga tayanadi). |
| Resurs | ≥ 4 CPU, ≥ 16 GB RAM, ≥ 30 GB bo'sh disk (torch + Whisper modeli + pip kesh + render). |
| Tizim paketlari | `ffmpeg` (ffprobe bilan), `imagemagick`, `fonts-dejavu` (`/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`), `git`, `bash`, `curl`, `tar`. |
| ImageMagick policy | `@`-yo'l o'qishga ruxsat (pastda, 2-qadam). Busiz subtitr bosqichi yiqiladi. |
| Python | Workflow `actions/setup-python` bilan Python 3.11 ni o'zi yuklab oladi (Ubuntu uchun). Boshqa distro'da — Python 3.11 ni runner'ning tool cache'iga oldindan o'rnating. |
| Tarmoq | Chiquvchi HTTPS: `github.com`, `*.actions.githubusercontent.com`, `pypi.org`, `files.pythonhosted.org`, hamda API'lar (Gemini, Pexels, ElevenLabs, YouTube, Supabase, tanlangan video provayder). Kiruvchi port kerak emas. |
| Yoqilgan holat | Job vaqtida mashina yoqiq va onlayn bo'lishi shart (pastdagi "Cheklovlar"ga qarang). |

---

## O'rnatish (bir marta)

### 1. Alohida foydalanuvchi va paketlar

```bash
sudo adduser --disabled-password --gecos "" nsrunner
sudo apt-get update
sudo apt-get install -y ffmpeg imagemagick fonts-dejavu git curl
```

### 2. ImageMagick policy tuzatishi

MoviePy subtitr matnini `label:@/tmp/…` orqali uzatadi, Ubuntu'ning standart
`policy.xml` fayli esa buni taqiqlaydi. Faqat shu bitta qoidani oching
(GitHub-hosted runner'da workflow xuddi shuni qiladi):

```bash
for p in /etc/ImageMagick-6/policy.xml /etc/ImageMagick-7/policy.xml; do
  [ -f "$p" ] && sudo sed -i 's/rights="none" pattern="@\*"/rights="read|write" pattern="@*"/' "$p"
done
```

### 3. Runner'ni ro'yxatdan o'tkazish

GitHub'da: **Settings → Actions → Runners → New self-hosted runner → Linux x64**.
U yerda ko'rsatilgan buyruqlarni `nsrunner` foydalanuvchisi sifatida bajaring
(yuklab olish, tekshirish, arxivni ochish), `config.sh` ga esa **o'z label'ingizni**
qo'shing:

```bash
sudo -iu nsrunner
mkdir actions-runner && cd actions-runner
# ... GitHub sahifasidagi download + tar buyruqlari ...
./config.sh --url https://github.com/<owner>/nightshift-ai-studio \
            --token <GitHub bergan bir martalik token> \
            --labels nightshift-render --unattended
exit
```

Servis sifatida (qayta yuklanganda ham ishlashi uchun):

```bash
cd /home/nsrunner/actions-runner
sudo ./svc.sh install nsrunner
sudo ./svc.sh start
```

Runner Settings → Actions → Runners ro'yxatida **Idle** holatda ko'rinishi kerak.

### 4. Workflow'ni runner'ga yo'naltirish

**Settings → Secrets and variables → Actions → Variables → New repository
variable**:

- Name: `RENDER_RUNNER`
- Value: `nightshift-render` (3-qadamdagi label)

Label noyob bo'lsin — shunda job faqat sizning mashinangizga tushadi.

### 5. Sinov

**Actions → Daily YouTube Video → Run workflow**, `privacy = private`. Log'da
`Check system dependencies (self-hosted runner)` qadami "present" deb yozishi,
`Install system dependencies` esa **skipped** bo'lishi kerak.

Resurslar ko'p bo'lsa, `NIGHTSHIFT_RENDER_THREADS` repo o'zgaruvchisini
oshirish mumkin (standart 2).

### Orqaga qaytarish

`RENDER_RUNNER` o'zgaruvchisini o'chiring — keyingi run yana `ubuntu-latest`'da.

---

## Cheklovlar va bilish kerak bo'lganlar

- **Mashina o'chiq bo'lsa, video chiqmaydi.** Job runner onlayn bo'lishini
  navbatda kutadi (GitHub ~24 soatgacha kutadi, keyin bekor qiladi). Kunlik
  jadval muhim bo'lsa — mashina doim yoqiq bo'lsin yoki `RENDER_RUNNER` ni
  o'chirib GitHub'ga qayting.
- `timeout-minutes: 60` va `max-parallel: 1` o'zgarmagan.
- `actions/checkout` har run boshida workspace'ni tozalaydi, shuning uchun
  `output/` (video, audio, rasmlar) run'lar orasida saqlanmaydi. Tarix
  (`history/`) avvalgidek `actions/cache` orqali tiklanadi, video artefakt
  sifatida yuklanadi.
- **Resume holati esa saqlanadi** (GitHub runner'da ham, self-hosted'da ham):
  tugallanmagan run'ning kichik JSON fayllari — `checkpoint.json` (run epoch),
  `provider_tasks.json` (pullik video task'lar), `upload_attempt.json` (upload
  ledger + marker) va `script.json` — har kanal uchun alohida `actions/cache`
  kaliti bilan (`chronos-runstate-v1.<kanal>.…`) `.run_state/` orqali keyingi
  run'ga o'tkaziladi (`tools/run_state_cache.py`). Shu sababli run
  generatsiya yoki upload o'rtasida o'lsa, keyingi run task'ni qayta to'lamasdan
  poll qiladi va upload'ni marker bo'yicha tekshiradi (dublikat yo'q).
  Chegaralar: faqat oxirgi 7 kun ichidagi, tugallanmagan, ko'pi bilan 10 ta run;
  har fayl ≤ 1 MB (amalda jami bir necha o'n KB). Publish bo'lgan run'ning
  checkpoint'i o'chadi — u keshga tushmaydi; qaytib kelgan eski ledger ham
  run-epoch kaliti tufayli e'tiborsiz qoladi. Media, `project.json` va
  **hech qanday token/secret fayl** (`youtube_token*.json`,
  `client_secret.json`) keshlanmaydi.
- Oxirgi tugallanmagan run'ni davom ettirish uchun: Actions → Daily YouTube
  Video → Run workflow → kanalni tanlang va **resume** belgisini qo'ying
  (saqlangan skript qayta ishlatiladi, Gemini'ga qayta pul to'lanmaydi).
  Jadval bo'yicha run'lar avvalgidek yangi video boshlaydi.
- `pip install` setup-python'ning tool cache'idagi Python'ga o'rnatiladi va
  mashinada qoladi — keyingi run'lar tezroq bo'ladi.
