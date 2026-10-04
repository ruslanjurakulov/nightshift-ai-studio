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

> **Hetzner AX42 (nightshift-01):** 2–4-bo'limlarni qo'lda bajarmang — worker
> o'sha serverga avtomatik deploy qilinadi, kalitlar GitHub'dan olinadi:
> [`DEPLOY_AX42.md`](DEPLOY_AX42.md), **g) Worker**. Quyidagisi boshqa VPS uchun.

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
# Navbat (majburiy). Service key FAQAT shu yerda — web serverga hech qachon qo'yilmaydi.
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

# Mijoz kanallari (migration 0022): token Supabase Vault'da. Worker uni
# service key bilan ishga tushish paytida o'qiydi; yangilash uchun Command
# Center'dagi OAuth client kerak (web serverdagi qiymatlar bilan bir xil).
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=

# Ixtiyoriy — Actions VARIABLE'lari bilan bir xil ma'noda
# TTS_PROVIDER=
# NIGHTSHIFT_RENDER_THREADS=
# CHRONOS_VIDEO_PROVIDER=  CHRONOS_ENABLE_VIDEO_GEN=
# CHRONOS_IMAGE_PROVIDER=  CHRONOS_ENABLE_IMAGE_GEN=
# MINIMAX_API_KEY= HIGGSFIELD_API_KEY= KLING_API_KEY= VEO_API_KEY= SEEDANCE_API_KEY= WAN_API_KEY=
# MINIMAX_H3_MODEL= MINIMAX_V2_QUERY_PATH= KLING_ACCESS_KEY= KLING_SECRET_KEY= WAN_WORKSPACE_ID=
# LEONARDO_API_KEY= ANTHROPIC_API_KEY= OPENAI_API_KEY= VIDIQ_ACCESS_TOKEN=
# CHRONOS_AGENT_AUTOPILOT= CHRONOS_AI_CRITIC= CHRONOS_RENDER_BACKEND=

# Worker sozlamalari (ixtiyoriy)
# NIGHTSHIFT_WORKER_ID=vps-1
# WORKER_POLL_SECONDS=15
# WORKER_STALE_MINUTES=10
# WORKER_STOP_GRACE_SECONDS=3300

# Izohlar qutisi (migration 0081, modules/comment_replies.py). DEFAULT: O'CHIQ.
# NIGHTSHIFT_COMMENT_INBOX=on           # faqat "on" bo'lsa ishlaydi (0081 qo'llanganidan keyin)
# NIGHTSHIFT_INBOX_SYNC_SECONDS=300     # har oraliqda bitta kanal, navbat bilan
```

**Izohlar qutisi (0081): sukut bo'yicha o'chiq.** `NIGHTSHIFT_COMMENT_INBOX=on`
qo'yilgandagina worker render vazifalari orasida ulangan kanallarning oxirgi
izohlarini o'qiydi (har oraliqda bitta kanal, 5 ta oxirgi ochiq video,
taxminan 3-7 kvota birligi), yangilarini tasniflaydi (pullik model chaqiruvi),
odam narx bilan so'ragan javob qoralamasini yozadi va **faqat odam tasdiqlagan
matnni** `comments.insert` orqali kanalning o'z tokeni bilan, bir marta e'lon
qiladi (50 kvota birligi; kvota tugasa `quota_exceeded` yoziladi, odam keyinroq
qayta navbatga qo'yadi). Hech narsa o'zi javob bermaydi. Tartib: avval `0081`ni
qo'llang, keyin workerni `on` bilan ishga tushiring, **eng oxirida** `credit_prices`
ga `reply_draft` narxini qo'ying (narx bo'lmaguncha qoralama so'rash o'chiq).
`0081` qo'llanmagan bo'lsa worker bir marta log yozadi va hech narsani o'qimaydi
yoki tasniflamaydi. Butun quti uchun kunlik YouTube kvota chegarasi bor
(`inbox_settings.daily_quota_ceiling`, sukut 2000 birlik; faqat platforma admini
`set_inbox_quota_ceiling` bilan o'zgartiradi): chegaraga yetganda o'qish va
javoblar to'xtaydi, yuklashlar uchun kvota qoladi. Token `youtube.force-ssl`
ruxsatisiz bo'lsa yoki ulanish bekor qilingan bo'lsa, javob berilmaydi
(`channel_not_ready`) va kanalni qayta ulash so'raladi. Mijoz tashkiloti kanali
faqat Vault tokeni bilan javob beradi (muhit o'zgaruvchisidagi token faqat
operatorning o'z kanallari uchun).

**Izohlar qutisi, 0090 (keyin qo'llanadi, 0081 dan keyin).** Bitta tashkilot kunlik
chegaraning faqat o'z ulushini ishlata oladi (`inbox_settings.org_share_percent`,
sukut 25 foiz; faqat platforma admini `set_inbox_org_share(foiz)` bilan 1..100
oralig'ida o'zgartiradi): ulush tugasa, o'sha tashkilotning tasdiqlangan javobi
`queued` holatida qoladi va kartada "kunlik kvota kutilmoqda" deb ko'rinadi,
boshqa tashkilotlarning javoblari esa yuboriladi. Platforma chegarasi saqlanadi.
Javoblar o'qishdan oldin turadi: kutayotgan javob bo'lsa, o'qish ulushdan bitta javob
(60 birlik) qoldiradi, shuning uchun o'qishlar javobni och qoldirmaydi (javob ketmaguncha
shu tashkilotning o'qishlari to'xtab turadi). Tasniflagich 3 marta javob bermagan izoh
bir kunga dam oladi va keyin yana sinab ko'riladi.
Chegara **yumshoq**: bir vaqtda ishlayotgan workerlar soniga qarab (har biri
taxminan 57 birlikkacha) ozgina oshib ketishi mumkin; yuklashlar uchun qoldirilgan
zaxira buni qoplaydi. Foydalanuvchiga ayting: javoblar kunlik kvota ruxsat
berganda e'lon qilinadi. `0081` ni yolg'iz qayta qo'llash 0090 almashtirgan sakkiz
funksiyani eski holiga qaytaradi: undan keyin `0090` ni qayta qo'llang. `0090`
qo'llanmaguncha worker faqat platforma chegarasi bilan ishlaydi, sahifa esa
kutish sababini ko'rsatmaydi.

Worker kanallarni bir-biridan ajratadi: har bir vazifa faqat **o'z kanalining**
tokenini ko'radi (boshqa `CHRONOS_YT_TOKEN_*` lar `main.py` muhitidan olib
tashlanadi), token fayllari vazifa uchun yoziladi va vazifa tugashi bilan
o'chiriladi. Command Center'dan ulangan mijoz kanalining tokeni Vault'dan
o'qiladi (faol ulanish bo'lsa u ustun, bo'lmasa `CHRONOS_YT_TOKEN_<REF>`),
faqat xotirada o'sha kanal nomi ostida `main.py` ga beriladi va scrubber'ga
qo'shiladi; Vault o'qib bo'lmasa va zaxira secret bo'lmasa, vazifa hech narsa
sarflamasdan to'xtaydi. Worker loglarida qiymatlar emas, faqat "bor/yo'q" chiqadi;
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
2. GitHub → Settings → Secrets and variables → Actions → Variables:
   `NIGHTSHIFT_RUN_BACKEND` = `queue`. **Qayta deploy** qiling (`deploy_web.yml`).
3. Create sahifasida video yarating: progress panelida vazifa holati ko'rinadi
   (`navbatda — worker kutilmoqda` → `ishlamoqda` → `muvaffaqiyatli`/`xato`).

Command Center service key'ni **olmaydi**: qator foydalanuvchining o'z sessiyasi
bilan, RLS orqali qo'shiladi. 0017 dagi insert policy faqat admin'ga, faqat
`daily` turdagi, faqat "Run now" yuboradigan parametrlar bilan (privacy'siz —
ya'ni `private`, resume/repair'siz) ruxsat beradi. Vazifani o'zgartirish,
o'chirish yoki `claim` qilish faqat worker'ning service key'i bilan mumkin.

## 5b. Kreditlar (ixtiyoriy, 0020 migratsiyasi)

`render_jobs.credit_ref` to'ldirilgan vazifa uchun worker ishga tushirishdan oldin
kredit bandini (`start_credit_reservation`) oladi va oxirida hisob-kitob qiladi:
muvaffaqiyatda — shu mashinadagi xarajatlar jurnali (`history/chronos.db`) bo'yicha
`capture_credits` (band miqdoridan oshmaydi; birorta yozuv narxlanmagan bo'lsa —
butun band), xatoda — `release_credits`. 0041 migratsiyasidan beri standart
bo'lmagan tashkilot kanalining vazifasi `NIGHTSHIFT_CREDITS_ENFORCE` qiymatidan
qat'i nazar faqat o'z ochiq bandi bilan ishlaydi: bandsiz, juda kichik bandli
yoki uzunligi navbatga qo'yilganda qotirilmagan (`params.duration`) vazifa hech
narsa ishga tushirilmasdan `failed` bo'ladi. Worker aynan shu qotirilgan
uzunlikni ishlatadi — kanalning keyinroq o'zgartirilgan maqsad uzunligini emas.
Operatorning o'z (standart) tashkiloti kanallari avvalgidek bandsiz ishlaydi.
Navbat rejimida Command Center'da `NIGHTSHIFT_CREDITS_ENFORCE` o'chiq bo'lsa,
mijoz tashkilotining "Run now"i rad etiladi (`credits_not_enforced`).

## 5c. Sahnani qayta yaratish (0076 va 0085 migratsiyalari)

Command Center'dagi "Regenerate scene" bosilishi navbatga `repair` vazifasini qo'yadi
(`render_jobs.scene_regeneration_id` to'ldirilgan) va o'z kredit bandini ushlaydi.
Worker uni `modules/scene_regenerate.py` bilan bajaradi va to'lovni bazadagi
`start_scene_regeneration` / `finish_scene_regeneration` orqali hal qiladi.

**Joriy etish tartibi (BR-L-045).** Avval worker kodini yangilang (4-bo'limdagi
"Yangilash": `git pull`, image, qayta ishga tushirish). Keyin 0076, undan keyin 0085
migratsiyasini qo'llang. Faqat shundan keyin `scene_regenerate` va
`scene_regenerate_clip_<provider>` narxlarini qo'ying. Eski kodli worker
regeneratsiya vazifasini oddiy repair deb oladi: bandni daqiqalik hisob bilan ochadi
va generatsiya qilingan sahnaga stock qo'yadi. 0085 siz yangi worker ishlaydi, lekin
tugallanmagan regeneratsiyalarni diskni tekshirmasdan bo'shatadi va logda
`apply migration 0085` deb yozadi.

**Yarim qolgan regeneratsiya (BR-L-042).** Worker ishga tushganda va har 10 daqiqada,
bandlarni bo'shatishdan oldin, bazadagi `scene_regenerations_unsettled()` ro'yxatini
o'qiydi va har bir qator uchun shu mashinadagi fayllarga qaraydi: yangi kesim joyida va
natijadagi hash'ga mos bo'lsa — kvota ushlanadi, aks holda oldingi kesim (hash bo'yicha
tekshirilgan nusxadan) qaytariladi va band bo'shatiladi. Bitta qatorni hal qilib
bo'lmasa, bo'shatish keyingi davrga qoladi (28 soatdan eski qator to'sqinlik qilmaydi).
Bu bitta worker va bitta disk uchun mo'ljallangan: `output/` papkasi umumiy bo'lmagan
ikkita worker bir-birining fayllarini ko'rmaydi. 24 soatdan uzoq ishlagan va
muvaffaqiyatli tugagan regeneratsiya uchun band allaqachon bo'shatilgan bo'ladi
(`expire_credit_reservations`), shuning uchun u `succeeded` bo'ladi, lekin kvota ushlanmaydi.

**Disk (BR-L-043).** Har bir bosish `output/<run>/regenerations/<id>/` ga oldingi
master nusxasini (`previous_final_video.mp4`, hash'i `previous_take.json` da) va yangi
klip fayllarini yozadi. Faqat oxirgi 5 ta takening master'i saqlanadi; muvaffaqiyatli
takelarning klip fayllari (`s###_take_n.mp4`) va yuklangan stock klipler **o'chirilmaydi**,
chunki oldingi Video IR ularga ishora qiladi. O'sish har bosishga klip hajmicha, faqat
kreditlar bilan cheklangan; operatorning o'z tashkilotida u bepul va cheksiz.
Boshlashdan oldin worker bo'sh joyni tekshiradi: kesimning 2 baravari + 256 MB
(`CHRONOS_REGEN_MIN_FREE_MB` bilan o'zgaradi), yetmasa `disk_full` va hech narsa
sarflanmaydi. Diskni kuzatib boring; kerak bo'lsa oxirgi 5 ta takedan eski
`regenerations/<id>/*.mp4` fayllarini qo'lda o'chiring, lekin hozirgi yoki saqlangan
`project.json` ishora qilayotgan faylni emas.

## 6. Orqaga qaytish (GitHub Actions)

GitHub o'zgaruvchilarida `NIGHTSHIFT_RUN_BACKEND` ni o'chiring (yoki `actions` qiling) va qayta
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
- `SUPABASE_SERVICE_KEY` faqat worker'da. web serverda faqat anon key.
- Image'da hech qanday sir yo'q: `.dockerignore` `.env`, `youtube_token*.json`,
  `client_secret*.json` ni chiqarib tashlaydi, Dockerfile esa shunday fayl
  kirib qolsa build'ni to'xtatadi.
- Serverga SSH kalit bilan kiring, parol bilan emas; firewall'da faqat SSH ochiq
  (worker hech qanday port ochmaydi — faqat tashqariga ulanadi).
