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
     YouTube'ga yuklangan video joylanadi. Ikki kishilik tasdiq yoqilgan
     kanalda ikkinchi adminning tasdig'i ham kerak. Aks holda so'rov
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
     tugasa — `quota_exceeded` (har yuklash ~1600 birlik, kuniga 10 000).
   - TikTok'ga har doim **SELF_ONLY (shaxsiy)** joylanadi.
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
