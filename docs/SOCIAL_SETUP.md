# Instagram va TikTok akkauntlarini ulash — sozlash qo'llanmasi

Bu hujjat Nightshift egasi uchun: Instagram (Meta) va TikTok ilovalarini qanday
yaratish, qaysi manzillarni ro'yxatdan o'tkazish, qaysi kalitlarni serverga
qo'yish va ilovalar tekshiruvdan (review / audit) o'tmaguncha nimalar ishlashini
tushuntiradi.

Hammasi tayyor bo'lgach, foydalanuvchilar **Channels** sahifasidagi
**"Ulangan akkauntlar"** bo'limida Instagram va TikTok akkauntlarini ulaydi.
Kalitlar sozlanmagan platforma uchun tugma o'rnida **"hozircha mavjud emas"**
yozuvi chiqadi — sahifa buzilmaydi.

> Tokenlar hech qachon brauzerga, logga yoki GitHub'ga tushmaydi. Ular
> Supabase Vault ichida shifrlangan holda saqlanadi va faqat worker (service
> key bilan) o'qiy oladi (migratsiya `0028_social_accounts.sql`).

---

## 0. Avval: migratsiya

1. Supabase → **Database → Extensions** → `supabase_vault` yoqilganini tekshiring
   (yangi loyihalarda odatda yoqilgan).
2. Supabase → **SQL Editor** → `supabase/migrations/0028_social_accounts.sql`
   faylining butun matnini qo'yib, **Run** bosing. Fayl oxiridagi "Verify"
   so'rovini ishga tushirsangiz, barcha ustunlar `true` bo'lishi kerak.

---

## 1. Instagram (Meta ilovasi)

Ishlatiladigan API: **Instagram API with Instagram Login** (Facebook sahifasi
kerak emas). Faqat **Business** yoki **Creator** (professional) Instagram
akkauntlari ulanadi — shaxsiy akkaunt ulanmaydi, foydalanuvchi uni Instagram
ilovasida *Settings → Account type and tools → Switch to professional account*
orqali professionalga o'tkazishi kerak.

Rasmiy hujjatlar:
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
- https://developers.facebook.com/docs/instagram-platform/content-publishing/
- https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/

### Qadamlar

1. https://developers.facebook.com/apps → **Create app**.
   - Use case: **"Manage messaging & content on Instagram"** (Instagram use case).
   - App type so'ralsa: **Business**.
2. Ilova ichida **Instagram → API setup with Instagram login** bo'limini oching.
3. **"Set up Instagram business login"** → **Business login settings**:
   - **OAuth redirect URIs** ga aynan shuni qo'shing:
     ```
     https://nightshift-ai.studio/api/oauth/instagram/callback
     ```
     (Boshqa domen ishlatsangiz: `https://<DOMAIN>/api/oauth/instagram/callback`.
     Oxirida `/` bo'lmasin — bir harf farq qilsa ham Meta rad etadi.)
4. Ruxsatlar (permissions), aynan shu ikkitasi:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
5. Shu sahifadagi **Instagram app ID** va **Instagram app secret** ni oling
   (diqqat: bu Facebook "App ID" emas, Instagram bo'limidagi alohida ID/secret).
6. **App settings → Basic**: Privacy Policy URL
   (`https://nightshift-ai.studio/privacy`), Terms URL
   (`https://nightshift-ai.studio/terms`), ilova ikonkasi va kategoriyasini
   to'ldiring — review uchun shart.

### Review'dan oldin nima ishlaydi

- Ilova **Development** rejimida bo'lganda faqat ilovaga rol berilgan
  odamlar ulana oladi: **App roles → Roles → Add People → Instagram Tester**.
  Tester o'z Instagram ilovasida (yoki instagram.com → *Settings → Apps and
  websites → Tester invites*) taklifni qabul qilishi kerak.
- Testerlar o'z akkauntiga haqiqiy post (Reels) joylay oladi.

### Review (App Review) — hamma uchun ochish

- **App Review → Permissions and features**: `instagram_business_basic` va
  `instagram_business_content_publish` uchun **Advanced Access** so'rang.
- Screencast (ekran yozuvi) kerak: Nightshift'da akkaunt ulash → video
  tayyorlash → "Platformalarga joylash" → Instagram'da post chiqqanini
  ko'rsating.
- **Business verification** (kompaniya hujjatlari) talab qilinishi mumkin.
- Tasdiqlangach ilovani **Live** rejimiga o'tkazing.

### Cheklovlar (bilib qo'ying)

- Token 60 kun amal qiladi; worker uni avtomatik yangilaydi (kamida 24 soatlik
  va muddati o'tmagan token). 60 kun ichida umuman ishlatilmasa, qayta ulash
  kerak bo'ladi.
- Instagram API orqali bir akkauntga 24 soatda ko'pi bilan 100 ta post.
- Video Instagram serveriga **ochiq URL** orqali yuklanadi — worker Supabase
  Storage'dan qisqa muddatli imzolangan (signed) havola beradi.

---

## 2. TikTok (TikTok for Developers ilovasi)

Ishlatiladigan mahsulotlar: **Login Kit** + **Content Posting API**.

Rasmiy hujjatlar:
- https://developers.tiktok.com/doc/login-kit-web
- https://developers.tiktok.com/doc/oauth-user-access-token-management
- https://developers.tiktok.com/doc/content-posting-api-get-started
- https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- https://developers.tiktok.com/doc/content-sharing-guidelines

### Qadamlar

1. https://developers.tiktok.com → tizimga kiring → **Manage apps → Connect an app**
   (yoki **Create app**). Tashkilot (organization) sifatida ro'yxatdan o'tish
   tavsiya etiladi.
2. **App details**: nom, ikonka, kategoriya, tavsif, **Terms of Service URL**
   (`https://nightshift-ai.studio/terms`), **Privacy Policy URL**
   (`https://nightshift-ai.studio/privacy`). Platforms: **Web**, website URL:
   `https://nightshift-ai.studio`.
3. **Add products**:
   - **Login Kit** → Redirect URI (Web) ga aynan shuni qo'shing:
     ```
     https://nightshift-ai.studio/api/oauth/tiktok/callback
     ```
   - **Content Posting API** → **Direct Post** ni yoqing.
4. **Scopes** (ruxsatlar):
   - `user.info.basic`
   - `video.publish`
   - `video.upload`
5. **Client key** va **Client secret** ni oling.
6. Ilovani **Submit for review** qiling (Login Kit va Content Posting API
   uchun). Ilova tasdiqlanmaguncha faqat **Sandbox** rejimi ishlaydi:
   Sandbox'da **Target users** ga o'z TikTok akkauntlaringizni qo'shing.

### Audit'dan oldin nima ishlaydi (muhim!)

- TikTok **audit'dan o'tmagan** ilovalar uchun: barcha postlar faqat
  **SELF_ONLY (shaxsiy — faqat egasi ko'radi)** bo'lib chiqadi, va 24 soat
  ichida faqat cheklangan sondagi (5 tagacha) foydalanuvchi post joylay oladi.
  Nightshift buni sahifada ogohlantirib turadi.
- Postlarni ommaviy (public) qilish uchun Content Posting API bo'yicha
  **audit**dan o'tish kerak: https://developers.tiktok.com/application/content-posting-api
  — TikTok'ning UX talablari (post oldidan creator nomi ko'rinishi, privacy
  tanlash, musiqa huquqlari haqida rozilik va h.k.) bajarilganini ko'rsatuvchi
  video/screenshotlar so'raladi.

### Cheklovlar

- Access token 24 soat, refresh token 365 kun amal qiladi; worker access
  tokenni avtomatik yangilaydi (buning uchun workerda ham
  `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` bo'lishi shart).
- Video davomiyligi har bir akkaunt uchun TikTok aytgan maksimaldan
  oshmasligi kerak (odatda 10 daqiqagacha); vertikal (9:16) video tavsiya
  etiladi.

---

## 3. Kalitlarni serverga qo'yish

GitHub → repozitoriy → **Settings → Secrets and variables → Actions →
Repository secrets** (yoki `production` Environment secrets) ga qo'shing:

| Nomi | Qayerdan | Kim ishlatadi |
|---|---|---|
| `INSTAGRAM_APP_ID` | Meta → Instagram → API setup with Instagram login | web (Command Center) |
| `INSTAGRAM_APP_SECRET` | o'sha joy | web |
| `TIKTOK_CLIENT_KEY` | TikTok → app → Client key | web **va** worker |
| `TIKTOK_CLIENT_SECRET` | TikTok → app → Client secret | web **va** worker |

`deploy_web.yml` ularni avtomatik ravishda serverdagi `.env.web` (va worker
yoqilgan bo'lsa, `.env.worker`) ga yozadi. Command Center boshqa joyda (masalan
lokal) ishlasa, xuddi shu to'rtta nomni o'sha muhitning environment o'zgaruvchilariga
ham qo'shing.

Keyin **Deploy web** workflow'ini qayta ishga tushiring (yoki `main` ga navbatdagi
push). Channels sahifasida "hozircha mavjud emas" yozuvi o'rniga **Ulash**
tugmasi chiqadi.

---

## 4. Tekshirish

1. Tashkilotning egasi/admini/muharriri (editor) sifatida kiring.
2. **Channels → Ulangan akkauntlar → Instagramni ulash** → Instagram'da
   ruxsat bering → sahifaga qaytganda akkaunt nomi, rasmi va yashil ✓ chiqadi.
3. TikTok uchun ham xuddi shunday.
4. **Uzish** tugmasi tokenni Vault'dan o'chiradi. Platforma tomonida ham
   ruxsatni olib tashlang:
   - Instagram: https://www.instagram.com/accounts/manage_access/
   - TikTok: *Settings and privacy → Security → Apps and services*.

Xatolar sahifada qisqa so'z bilan ko'rsatiladi (masalan "Barcha ruxsatlar
berilmadi", "Bu Instagram akkaunti shaxsiy"). Hech qanday token yoki kalit
xabarlarda ko'rinmaydi.

---

## 5. Tayyor videoni platformalarga joylash (migratsiya 0029)

1. Supabase → SQL Editor → `supabase/migrations/0029_publish_targets.sql` ni
   ishga tushiring (0022 va 0028 dan keyin).
2. **Create** sahifasining tepasida ixtiyoriy **"Qaysi akkaunt uchun"** tanlovi
   bor — bu faqat eslatma (hint), hech narsani joylamaydi.
3. Video sahifasida **"Yuklab olish va joylash"** bo'limi:
   - **Yuklab olish** — saqlangan 480p tekshiruv nusxasi (10 daqiqalik havola).
   - **Platformalarga joylash** — ulangan Instagram/TikTok akkauntlarini
     belgilang va **Yuborish** ni bosing. Brauzer hech narsa yuklamaydi:
     so'rov navbatga yoziladi, VPS'dagi **worker** uni bajaradi.
4. Qoidalar (o'zgarmaydi):
   - Faqat joylash tekshiruvidan (publish gate) o'tgan, **tasdiqlangan** va
     YouTube'ga yuklangan video joylanadi. (Ikki kishilik tasdiq mijozlarga
     taklif qilinmaydi; u faqat avvaldan yoqilgan kanallarda ishlaydi va u
     yerda ikkinchi adminning tasdig'i ham kerak.) Aks holda so'rov
     "RAD ETILDI" holatida sababi bilan ko'rinadi.
   - YouTube'da video o'z kanalida allaqachon bor; uning maxfiyligi kanal
     qoidalariga ko'ra qoladi (standart — private). Bu yerdan o'zgarmaydi —
     ro'yxatda "allaqachon shu kanalda" deb ko'rinadi va belgilab bo'lmaydi.
   - Tashkilotning **boshqa YouTube kanallari** ham ro'yxatda (logo, nom,
     ulanganlik belgisi). Belgilansa, worker master faylni o'sha kanalga
     **yangi, har doim PRIVATE** video sifatida yuklaydi (sarlavha ≤ 100
     belgi, tavsif ≤ 5000 bayt, teglar ≤ 500 belgi — videoning o'z
     metama'lumotidan). Kanal ACTIVE va ulangan bo'lishi kerak; token render
     paytidagidek olinadi (Vault ulanishi yoki `CHRONOS_YT_TOKEN_<REF>`,
     standart kanal uchun `YOUTUBE_TOKEN_JSON`). YouTube API kvotasi
     tugasa — `quota_exceeded`. Eski «har yuklash ~1600 birlik, kuniga
     10 000» raqami eskirgan (YouTube API o'zgarishlar tarixi, 2025-12-04 va
     2026-06-01 yozuvlari); joriy qiymat **TEKSHIRILMAGAN** — Google Cloud
     Console → Quotas sahifasida tasdiqlang.
   - TikTok'ga har doim **SELF_ONLY (shaxsiy)** joylanadi. Audit'dan o'tmagan
     ilova uchun TikTok postni faqat **shaxsiy (private) TikTok akkauntdan**
     qabul qiladi; akkaunt ochiq bo'lsa, so'rov `tiktok_unaudited` sababi
     bilan "XATO" bo'ladi va panelda akkauntni shaxsiy qilish aytiladi.
   - **AI-kontent belgisi.** Video haqiqiy ko'rinishdagi sun'iy intellekt
     materiali (AI klip/rasm, AI boshlovchi, boshqa odamning ovoziga
     o'xshash ovoz) bo'lsa, Instagram'ga `is_ai_generated=true`, TikTok'ga
     `is_aigc=true` yuboriladi va izohga qator qo'shiladi (YouTube'da —
     `containsSyntheticMedia`). Qoida kanal sozlamasi `ai_disclosure`
     (`auto` / `always` / `never`) bilan boshqariladi; hammasi
     `docs/AI_DISCLOSURE.md` da.
   - **Fayl tekshiruvi.** Yuklashdan oldin worker faylni o'qiydi (kodek,
     kadr chastotasi, o'lcham, indeks boshida ekani) va platforma rad
     etadigan faylni darhol "RAD ETILDI" qiladi (`bad_codec`, `bad_audio`,
     `bad_framerate`, `too_wide`, `bad_resolution`, `not_faststart`,
     `unreadable_video`). Fayl qayta kodlanmaydi. Diqqat: `moov` indeksi
     boshida bo'lmagan master Instagram'ga `not_faststart` bilan rad etiladi.
     Yangi masterlar indeksni boshida yozadi; faqat #555 dan oldin render
     qilingan videolar (va shu o'zgarishgacha ffmpeg/sahna backend'i)
     rad etiladi, ular joyida o'zgartirilmaydi (`docs/AI_DISCLOSURE.md`,
     "Which masters have `moov` first").
   - Kredit yechilmaydi (platformalarga yuklash bepul).
5. Cheklovlar:
   - Worker to'liq sifatli (master) faylni o'z diskida (`output/`) topishi
     kerak — ya'ni video **queue worker**da render qilingan bo'lishi kerak.
     Faqat 480p nusxa bo'lsa, sifatni jim pasaytirmaslik uchun so'rov rad
     etiladi (`master_not_available`).
   - Instagram Reels: 3 soniya – 15 daqiqa, ≤ 300 MB. TikTok: akkaunt
     ruxsat bergan maksimal davomiylik (odatda 10 daqiqagacha). Uzun video
     uchun uning **Short** (vertikal) versiyasini joylash taklif qilinadi.
   - Instagram videoni ochiq havoladan oladi: worker faylni vaqtincha
     yopiq `publish-staging` bucket'iga qo'yadi va 1 soatlik imzolangan havola
     beradi, keyin o'chiradi. Supabase'ning bepul tarifida bitta fayl 50 MB
     bilan cheklangan — kattaroq videolar uchun Supabase → Storage →
     Settings'da **upload size limit** ni oshiring (Pro tarif).

---

## 7. X (Twitter) video — QORONG'I: kod yozilgan, lekin hozircha ulanmaydi

Holat: `modules/social_x.py` (API v2: chunked media upload, so'ng `POST /2/tweets`) va `XPublisher` yozilgan va worker'ning
publisher ro'yxatida turibdi, lekin **hech narsa unga yetib bormaydi**: `social_accounts` va `publish_requests` jadvallari
(migratsiya 0028 / 0029) `x` so'zini qabul qilmaydi, "Ulash" tugmasi, OAuth route va X developer ilovasi yo'q. Panelda X
kartochkasi "tez orada" holatida qoladi. Hech qanday kalit yoki deploy sozlamasi qo'shilmagan.

Rasmiy hujjatlar (2026-10-25 da o'qilgan; ishlatishdan oldin qayta o'qing):
- https://docs.x.com/x-api/media/quickstart/media-upload-chunked
- https://docs.x.com/x-api/media/media-upload-status
- https://docs.x.com/x-api/posts/create-post
- https://docs.x.com/x-api/fundamentals/rate-limits
- https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- https://docs.x.com/x-api/getting-started/pricing

### Egasi (siz) qilishi kerak bo'lgan ishlar — faqat siz qila olasiz

1. **X developer akkaunti va ilova** (https://developer.x.com): OAuth 2.0 (Authorization Code + PKCE) mijozi, callback manzili
   (`https://nightshift-ai.studio/api/oauth/x/callback`, hali yo'q — keyingi PR).
2. Ruxsatlar (scopes): `tweet.write`, `tweet.read`, `users.read`, `media.write`, `offline.access` (`offline.access`siz
   refresh token berilmaydi, access token esa 2 soat yashaydi).
3. **Pul**: X hozir faqat "pay-per-usage" ko'rsatadi (narx sahifasi 2026-10-24 da o'qilgan, sana yozilmagan): post yaratish
   $0.015, **havolali post $0.200**, media metadata $0.005. To'lov **sizning ilovangizdan** har bir mijoz posti uchun
   olinadi. Kod postga havola qo'ymaydi (matndan olib tashlanadi), shuning uchun arzon tarif qo'llanadi. Oldindan kredit
   to'ldiring va xarajat chegarasi qo'ying; mijozlarga narx qo'yish yoki pass-through — sizning qaroringiz (kredit narxi
   bu PR'da YO'Q).
4. Worker uchun (refresh): `X_CLIENT_ID` (va maxfiy ilova bo'lsa `X_CLIENT_SECRET`) — hozircha hech qayerda ulanmagan;
   ulash PR'ida `deploy/.env.worker.example` va `deploy_web.yml` ga qo'shiladi.
5. Keyingi PR'lar uchun (hali QILINMAGAN): migratsiya (ikkala `check` va `store_social_account` ruxsat ro'yxati),
   `app/api/oauth/x/{start,callback}`, `social-oauth.ts` sozlamasi va `isSocialConfigured`, i18n, huquqiy hujjatlar
   jadvali, ilova uchun mijoz-boshiga xarajat chegarasi.
6. X **ommaviy post** qiladi: bu API'da qoralama yoki shaxsiy holat yo'q (Instagram kabi). Yagona nazorat — tasdiqlash
   darvozasi (`publish_request_refusal`), u yuborishdan oldin yana tekshiriladi.

### Cheklovlar (kod shularni yuklashdan OLDIN tekshiradi)

- Davomiylik 1 soniya – 20 daqiqa (oddiy akkaunt; Premium 125 daqiqa), H.264, ko'pi bilan 60 kadr/s. Hajm: X 8 GB
  yozgan, bizning qattiq chegara 512 MB. X bo'yicha o'lcham va ovoz formatini rad etmaymiz (joriy sahifada raqam topilmadi).
- Matn: 280 "og'irlikdagi" belgi (bizning konservativ chegara; Premium ko'proq mumkin), 2 ta hashtag, havolasiz.
- Yuklash 4 MB bo'laklar bilan (X: tavsiya 5 MB, server chegarasi 8 MB). Xato bo'lgan bo'lak o'sha indeks bilan 3 martagacha
  qayta yuboriladi; `finalize` javobi yo'qolsa `STATUS` o'qiladi (ikkinchi `finalize` yuborilmaydi).
- `POST /2/tweets`: foydalanuvchi uchun 100 / 15 daqiqa, ilova uchun 10 000 / 24 soat (X sahifasi). 429 da `x-rate-limit-reset`
  dan "taxminan N daqiqadan keyin" xabari yoziladi (`rate_limited`).
- Akkaunt Premium bo'lmasa va video 20 daqiqadan uzun bo'lsa X `403` qaytaradi (`too_long`); takroriy matn `403` →
  `duplicate_post`; `401` → `token_expired`; `402` (tekshirilmagan taxmin) → `credits_exhausted`.
- AI belgisi: `made_with_ai=true` — **rasmiy sahifada bor** (avvalgi ichki eslatmada "X'da API maydoni yo'q"
  deyilgan edi; rasmiy sahifada bor), faqat belgi kerak bo'lganda yuboriladi; izohga qator ham qo'shiladi.

### Javob yo'qolsa (takror yuborish yo'q)

`POST /2/tweets` javobi yo'qolsa (timeout, uzilgan ulanish, 5xx, post id'siz 2xx) so'rov `publish_unconfirmed` bilan "XATO"
bo'ladi ("avval akkaunt lentasini tekshiring") va **hech qachon avtomatik qayta yuborilmaydi**: X'da idempotentlik kaliti yo'q.
O'qib tekshirish (o'z postimizni lentadan qidirish) pulli o'qish va matn bo'yicha moslashtirish bo'lardi, shuning uchun
qilinmagan. Worker `POST /2/tweets`dan keyin o'lsa, so'rov `interrupted` bo'ladi (0029) — qayta navbatga qo'yilmaydi.

### Faqat jonli sinov tasdiqlay oladigan narsalar

`media.write` ruxsati bilan `Authorization: Bearer` bilan `initialize/append/finalize`; `append` ning muvaffaqiyatli javob
shakli (kod har qanday 2xx ni qabul qiladi); `finalize` dan keyin `processing_info.state` qiymatlari (`pending`,
`in_progress`, `succeeded`, `failed` — sahifada enum yo'q); `STATUS` ning shu `media_id` uchun natijasi; refresh token
aylanadimi; `402` kodining ma'nosi; video formati talablari (joriy "best practices" sahifasi o'qilmadi, H.264/60 fps eski
v1.1 sahifasidan); akkaunt Premium holatini oldindan bilib bo'lmasligi.
