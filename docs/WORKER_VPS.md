# Pipeline worker'ni VPS'da ishga tushirish (render_jobs navbati)

> Roadmap: [`ROADMAP_SAAS.md`](ROADMAP_SAAS.md), **B bosqichi**. Video yaratishning
> ikkinchi yo'li: GitHub Actions o'rniga istalgan VPS'da Docker bilan ishlaydigan
> doimiy worker. **Standart yo'l o'zgarmaydi** — navbat faqat siz yoqsangiz ishlaydi.

## Qanday ishlaydi

```
Command Center "Run now"
   │  NIGHTSHIFT_RUN_BACKEND=actions (standart)  →  daily_video.yml (GitHub Actions)
   │  NIGHTSHIFT_RUN_BACKEND=queue               →  render_jobs jadvaliga bitta qator
   ▼
Supabase: render_jobs  ──claim_render_job()──►  VPS: tools/queue_worker.py (Docker)
                                                  └─ python main.py … (workflow bilan bir xil)
```

- Worker navbatdan eng eski `queued` vazifani oladi (`select … for update skip locked`),
  uni `running` qiladi va har 30 soniyada `heartbeat_at` ni yangilaydi.
- Vazifa uchun workflow'dagi **aynan o'sha** buyruq ishga tushadi: bir xil `main.py`
  argumentlari, bir xil env qoidalari (`modules/run_request.py`). Maxfiylik (privacy)
  standart holatda `private`; publish gate, auto-publish va ikki kishilik tasdiq
  `main.py` ichida — worker ularni chetlab o'tmaydi va o'zgartirmaydi.
- Kanal workflow'dagi kabi tekshiriladi (`tools/list_channels.py` → `resolve_only`):
  noma'lum yoki YouTube'da tasdiqlanmagan kanal hech narsa sarflanmasdan `failed` bo'ladi.
- Bitta kanal uchun bir vaqtda faqat bitta vazifa `running` bo'ladi (bazadagi qoida).
- Tugagach: `succeeded` yoki `failed` + qisqa xato matni (oxirgi log qatorlari,
  **sirlardan tozalangan**, 2000 belgigacha).
- Worker o'lib qolsa (VPS qayta yuklandi, OOM), heartbeat eskiradi va 10 daqiqadan
  keyin vazifa navbatga qaytadi; 3 urinishdan keyin `failed`.
- Navbatga qaytgan vazifa uchun `output/` da o'sha run'ning checkpoint'i qolgan bo'lsa,
  worker uni `--resume --topic <o'sha mavzu>` bilan ishga tushiradi — skript va
  boshqa pullik bosqichlar qayta to'lanmaydi.
- Soatlik jadval (cron) **har doim GitHub Actions'da qoladi**. Navbat faqat
  "Run now" (va qo'lda qo'shilgan vazifalar) uchun.

## 1. Bazani tayyorlash (bir marta)

Supabase → **SQL Editor** → yangi query → `supabase/migrations/0017_render_jobs.sql`
faylining butun matnini qo'ying → **Run**. Qayta ishga tushirish xavfsiz.

Tekshirish:

```sql
select
  to_regclass('public.render_jobs')                                   as jadval,
  (select relrowsecurity from pg_class where oid = 'public.render_jobs'::regclass) as rls_yoqilgan,
  has_function_privilege('authenticated', 'public.claim_render_job(text, interval)', 'execute') as authenticated_claim_qila_oladimi,
  (select count(*) from pg_policies where tablename = 'render_jobs')  as policy_soni;
```

Kutilgan natija: `render_jobs | true | false | 2`.

## 2. Server

**O'lcham:** 8 vCPU / 16–32 GB RAM, 80+ GB SSD. Render vaqtining ~80% i CPU
filtrlari (Ken Burns, subtitr), RAM eng ko'pi ~4 GB — shuning uchun yadrolar
muhimroq. GPU shart emas. Bitta serverda **bitta worker** ishlating (bitta
render butun CPU'dan foydalanadi).

**Provayder farqi yo'q:** Docker o'rnatiladigan istalgan Linux VPS (Hetzner,
DigitalOcean, Contabo, OVH, mahalliy provayder…).

```bash
# Ubuntu/Debian: Docker o'rnatish
curl -fsSL https://get.docker.com | sh

# Kodni olish (private repo — deploy key yoki shaxsiy token bilan)
git clone https://github.com/ruslanjurakulov/nightshift-ai-studio.git
cd nightshift-ai-studio

# Image yig'ish (ffmpeg, ImageMagick, DejaVu shriftlari, Python 3.11, requirements.txt)
docker build -f Dockerfile.worker -t nightshift-worker .
```

## 3. Sirlar — faqat serverda, faqat env faylda

Hech qanday kalit image'ga, git'ga yoki Supabase'ga yozilmaydi. Ular faqat
serverdagi bitta faylda turadi va konteynerga ishga tushirish paytida beriladi.

```bash
sudo mkdir -p /etc/nightshift
sudo touch /etc/nightshift/worker.env
sudo chmod 600 /etc/nightshift/worker.env
sudo nano /etc/nightshift/worker.env
```

`worker.env` — GitHub Actions secret/variable'laridagi qiymatlar bilan bir xil
nomlar (bitta qatorda `NOM=qiymat`, qo'shtirnoqsiz):

```dotenv
# Navbat (majburiy). Service key FAQAT shu yerda — Vercel'ga hech qachon qo'yilmaydi.
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=...

# Pipeline kalitlari (Actions secret'lari bilan bir xil)
GEMINI_API_KEY=...
PEXELS_API_KEY=...
ELEVENLABS_API_KEY=...
YOUTUBE_CHANNEL_ID=UC...

# YouTube: OAuth client va default kanal tokeni (JSON bitta qatorda)
YOUTUBE_CLIENT_SECRET_JSON={"installed":{...}}
YOUTUBE_TOKEN_JSON={"token":...,"refresh_token":...}

# Qolgan kanallar: har biriga o'z tokeni, CHRONOS_YT_TOKEN_<REF>
CHRONOS_YT_TOKEN_FINANCE={"token":...,"refresh_token":...}

# Ixtiyoriy — Actions VARIABLE'lari bilan bir xil ma'noda
# TTS_PROVIDER=
# NIGHTSHIFT_RENDER_THREADS=
# CHRONOS_VIDEO_PROVIDER=  CHRONOS_ENABLE_VIDEO_GEN=
# CHRONOS_IMAGE_PROVIDER=  CHRONOS_ENABLE_IMAGE_GEN=
# MINIMAX_API_KEY= HIGGSFIELD_API_KEY= KLING_API_KEY= VEO_API_KEY= SEEDANCE_API_KEY= WAN_API_KEY=
# LEONARDO_API_KEY= ANTHROPIC_API_KEY= OPENAI_API_KEY= VIDIQ_ACCESS_TOKEN=
# CHRONOS_AGENT_AUTOPILOT= CHRONOS_AI_CRITIC= CHRONOS_RENDER_BACKEND=

# Worker sozlamalari (ixtiyoriy)
# NIGHTSHIFT_WORKER_ID=vps-1
# WORKER_POLL_SECONDS=15
# WORKER_STALE_MINUTES=10
# WORKER_STOP_GRACE_SECONDS=3300
```

Worker kanallarni bir-biridan ajratadi: har bir vazifa faqat **o'z kanalining**
tokenini ko'radi (boshqa `CHRONOS_YT_TOKEN_*` lar `main.py` muhitidan olib
tashlanadi), token fayllari vazifa uchun yoziladi va vazifa tugashi bilan
o'chiriladi. Worker loglarida qiymatlar emas, faqat "bor/yo'q" chiqadi;
`main.py` chiqishidagi kalitlar ham `[redacted]` bilan almashtiriladi.

## 4. Ishga tushirish

```bash
docker run -d --name nightshift-worker \
  --restart unless-stopped \
  --stop-timeout 3600 \
  --env-file /etc/nightshift/worker.env \
  -v nightshift-output:/app/output \
  -v nightshift-history:/app/history \
  -v nightshift-logs:/app/logs \
  nightshift-worker
```

- `--restart unless-stopped` — server qayta yuklansa worker o'zi qaytadi.
- `--stop-timeout 3600` — `docker stop` paytida ishlayotgan video tugashiga
  vaqt beradi (worker `WORKER_STOP_GRACE_SECONDS` = 55 daqiqa kutadi). Vaqt
  tugasa yoki ikkinchi marta to'xtatilsa — run to'xtatiladi va vazifa navbatga
  qaytadi (keyingi safar `--resume` bilan davom etadi).
- Volume'lar: `output/` (checkpoint'lar, resume ledger'lari, renderlar),
  `history/` (mavzular xotirasi, chronos.db), `logs/`. Actions'dagi kesh
  o'rnini bosadi va o'chib ketmaydi.

Loglar va holat:

```bash
docker logs -f nightshift-worker
```

```sql
select id, channel_id, kind, status, attempts, worker_id, heartbeat_at, error
from render_jobs order by created_at desc limit 20;
```

Sinov uchun bitta vazifa: `docker run --rm --env-file … nightshift-worker python tools/queue_worker.py --once`.

**Yangilash:** `git pull && docker build -f Dockerfile.worker -t nightshift-worker . && docker stop nightshift-worker && docker rm nightshift-worker` va yuqoridagi `docker run`.
Ishlayotgan video bo'lsa, `docker stop` uning tugashini kutadi.

**Disk:** `output/` o'sib boradi. Eski renderlarni vaqti-vaqti bilan tozalang
(masalan 14 kundan eskisini), lekin tugallanmagan run'lar (`checkpoint.json`
bor papkalar) resume uchun kerak.

## 5. "Run now" ni navbatga ulash

1. 0017 migratsiyasi qo'llangan (1-bo'lim) va worker ishlab turibdi (4-bo'lim).
2. Vercel → Project → Settings → Environment Variables:
   `NIGHTSHIFT_RUN_BACKEND` = `queue` (Production). **Qayta deploy** qiling.
3. Create sahifasida video yarating: progress panelida vazifa holati ko'rinadi
   (`navbatda — worker kutilmoqda` → `ishlamoqda` → `muvaffaqiyatli`/`xato`).

Command Center service key'ni **olmaydi**: qator foydalanuvchining o'z sessiyasi
bilan, RLS orqali qo'shiladi. 0017 dagi insert policy faqat admin'ga, faqat
`daily` turdagi, faqat "Run now" yuboradigan parametrlar bilan (privacy'siz —
ya'ni `private`, resume/repair'siz) ruxsat beradi. Vazifani o'zgartirish,
o'chirish yoki `claim` qilish faqat worker'ning service key'i bilan mumkin.

## 6. Orqaga qaytish (GitHub Actions)

Vercel'da `NIGHTSHIFT_RUN_BACKEND` ni o'chiring (yoki `actions` qiling) va qayta
deploy qiling. "Run now" darhol yana workflow'ni dispatch qiladi. Navbatda
qolgan vazifalar worker ishlab tursa bajariladi; kerak bo'lmasa bekor qiling:

```sql
update render_jobs set status = 'cancelled', finished_at = now()
where status = 'queued';
```

Ishlayotgan vazifani to'xtatish: yuqoridagi `update` ni `where id = …` bilan
`running` vazifaga qo'llang — worker keyingi heartbeat'da (≤30 s) run'ni to'xtatadi.

Worker'ni butunlay o'chirish: `docker stop nightshift-worker && docker rm nightshift-worker`.
`render_jobs` jadvali qoladi va hech narsaga xalaqit bermaydi.

## Qo'lda vazifa qo'shish (SQL, service role)

Actions'dagi `workflow_dispatch` inputlari bilan bir xil parametrlar
(`topic, niche, privacy, duration, language, visual_style, video_provider,
image_provider, resume, repair_scenes`), masalan sahnani tuzatish:

```sql
insert into render_jobs (channel_id, kind, params)
values ('default', 'repair', '{"repair_scenes": "3,17"}');
```

Boshqa kalitlar yoki noto'g'ri qiymatlar bazaning o'zida rad etiladi.

## Xavfsizlik qoidalari

- `worker.env` faqat serverda, `chmod 600`. Git'ga, image'ga, chatga hech qachon.
- `SUPABASE_SERVICE_KEY` faqat worker'da. Vercel'da faqat anon key.
- Image'da hech qanday sir yo'q: `.dockerignore` `.env`, `youtube_token*.json`,
  `client_secret*.json` ni chiqarib tashlaydi, Dockerfile esa shunday fayl
  kirib qolsa build'ni to'xtatadi.
- Serverga SSH kalit bilan kiring, parol bilan emas; firewall'da faqat SSH ochiq
  (worker hech qanday port ochmaydi — faqat tashqariga ulanadi).
