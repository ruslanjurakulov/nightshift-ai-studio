# Google OAuth verification — egasi uchun checklist

Mijozlarning YouTube kanaliga video yuklash uchun Google Cloud'dagi OAuth ilovamiz
"Testing" holatidan chiqib, **tekshiruvdan (verification)** o'tishi kerak. Busiz faqat
qo'lda qo'shilgan 100 tagacha test foydalanuvchi ulana oladi va ularning tokeni 7 kunda
eskiradi. Bu hujjat — ariza topshirishdan oldin nimalar tayyor bo'lishi kerakligi.

Kod tomonidan tayyor bo'lgan narsalar (shu PR):

| Sahifa | URL | Kirish |
| :-- | :-- | :-- |
| Bosh sahifa (landing) | `https://<domen>/` | Ochiq (tizimga kirmagan uchun) |
| Maxfiylik siyosati | `https://<domen>/privacy` | Ochiq |
| Foydalanish shartlari | `https://<domen>/terms` | Ochiq |
| OAuth callback | `https://<domen>/api/oauth/youtube/callback` | Faqat tizimga kirgan |

Qolgan hamma sahifa va API avvalgidek login ortida (`command-center/lib/public-paths.ts`).

## 1. Operator ma'lumotlarini kiritish (Vercel)

Vercel loyihasi → **Settings → Environment Variables** (Production), so'ng qayta deploy:

| O'zgaruvchi | Misol | Izoh |
| :-- | :-- | :-- |
| `NEXT_PUBLIC_LEGAL_NAME` | `"MChJ «...»"` yoki F.I.Sh. | Yuridik shaxs yoki YaTT nomi |
| `NEXT_PUBLIC_CONTACT_EMAIL` | `privacy@<domen>` | Foydalanuvchi yozadigan haqiqiy manzil |
| `NEXT_PUBLIC_LEGAL_COUNTRY` | `Uzbekistan` | Shartlar shu mamlakat qonuni bilan tartibga solinadi |
| `NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE` | `2026-10-01` | Faqat `YYYY-MM-DD` |

Hech biri uchun standart qiymat yo'q: bo'sh yoki noto'g'ri qiymat sahifada sariq
**NOT CONFIGURED** belgisi bo'lib ko'rinadi. Ariza topshirishdan oldin `/privacy` va
`/terms` sahifalarida bitta ham shunday belgi qolmaganini tekshiring.

Egasi tasdiqlashi kerak bo'lgan matnlar:

- [ ] Maxfiylik siyosatidagi **"so'rovdan keyin 30 kun ichida o'chiramiz"** va'dasi — bu
      kod emas, sizning majburiyatingiz. Bajara olmasangiz, muddatni o'zgartiring.
- [ ] Supabase loyihasi qaysi mintaqada ekanini tekshiring (siyosatda "EU, AQSh va boshqa
      mamlakatlar" deyilgan; Vercel `fra1`).
- [ ] Shartlardagi **8-bo'lim (kreditlar) — SHABLON**, kuchda emas. Pullik tarifdan oldin
      yurist bilan ko'rib chiqing va `[...]` qiymatlarni to'ldiring. Butun Shartlar matnini
      ham yurist ko'rgani ma'qul.
- [ ] Kontakt pochtasi haqiqatan ishlaydi va javob beriladi (Google unga yozadi).

## 2. Domen

- [ ] O'z domeningiz bo'lishi shart — `*.vercel.app` bo'lmaydi, uni Search Console'da
      o'zingizniki deb tasdiqlab bo'lmaydi.
- [ ] Vercel → **Settings → Domains** da domenni ulang (DNS yozuvini o'zingiz qo'shasiz).
- [ ] [Google Search Console](https://search.google.com/search-console) → **Domain property**
      → DNS `TXT` yozuvi bilan tasdiqlang. Buni Google Cloud loyihasida **Owner** yoki
      **Editor** bo'lgan o'sha Google akkaunt bilan qiling — aks holda consent screen
      domenni "tasdiqlanmagan" deb ko'rsatadi.
- [ ] Bosh sahifa, siyosat va shartlar bir xil domenda ekanini tekshiring.

## 3. OAuth consent screen (Google Cloud → Google Auth Platform)

**Branding:**

- [ ] App name: `Nightshift` (landingdagi nom bilan bir xil bo'lsin).
- [ ] User support email: `NEXT_PUBLIC_CONTACT_EMAIL` bilan bir xil manzil.
- [ ] App logo (ixtiyoriy, 120×120 PNG). Logo qo'shilsa, u ham tekshiriladi.
- [ ] Application home page: `https://<domen>/`
- [ ] Application privacy policy link: `https://<domen>/privacy`
- [ ] Application terms of service link: `https://<domen>/terms`
- [ ] Authorized domains: `<domen>`
- [ ] Developer contact email.

**Audience:** User type — **External**; tekshiruvga tayyor bo'lgach **Publish app**
(Testing → In production).

**Clients:** OAuth client (Web application) → Authorized redirect URIs:
`https://<domen>/api/oauth/youtube/callback`. Client ID/secret Vercel'da
`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (server-only, `NEXT_PUBLIC_`
prefiksisiz).

## 4. Scope'lar va asoslash matni

**Data access** bo'limiga aynan kod so'raydigan scope'larni qo'shing
(`command-center/lib/server/google-oauth.ts` → `YOUTUBE_OAUTH_SCOPES`). Ortiqcha scope
qo'shmang — Google har birini so'raydi va keraksizini rad etadi. YouTube scope'lari
"sensitive" toifasida; "restricted" (Gmail/Drive) emas, shuning uchun odatda CASA
xavfsizlik auditi talab qilinmaydi, lekin Google qo'shimcha savol berishi mumkin.

Har bir scope uchun Google'ga **ingliz tilida** yoziladigan asoslash (nusxa olib qo'yish mumkin):

**`https://www.googleapis.com/auth/youtube.upload`**
> Nightshift produces videos for a YouTube channel the user connects and uploads them to that
> channel with videos.insert, then sets the custom thumbnail with thumbnails.set. Uploads are
> private by default. Uploading is the core feature of the app and cannot work without this scope.

**`https://www.googleapis.com/auth/youtube.readonly`**
> Used to read the connected channel's identity (channels.list, mine=true) so the user can confirm
> which channel was connected, and to list the channel's recent uploads (playlistItems.list,
> videos.list) so the same video is never uploaded twice after a retry. It also reads basic details
> of the channel's own videos for the user's dashboard.

**`https://www.googleapis.com/auth/youtube.force-ssl`**
> Required by three write calls that youtube.upload does not cover: captions.insert (adding the
> caption track Nightshift generated to a video it uploaded), playlistItems.insert (adding a
> published video to the user's series playlist) and commentThreads.insert (posting one question to
> viewers from the channel under a video Nightshift published). It is also used to read comments on
> the channel's own videos (commentThreads.list) to show the user which topics their audience asks
> for. Nightshift never deletes or edits existing videos, playlists or comments.

**`https://www.googleapis.com/auth/yt-analytics.readonly`**
> Reads YouTube Analytics reports (views, watch time, average view duration/percentage, likes,
> comments, shares, subscribers gained/lost, impressions, click-through rate, audience retention)
> for the channel's own videos, to show performance in the user's dashboard and to pick better
> topics for the user's future videos.

`yt-analytics-monetary.readonly` **so'ralmaydi** (sayt orqali ulanishda yo'q; faqat bot
tomonida `CHRONOS_ENABLE_REVENUE=1` bilan). Uni yoqmoqchi bo'lsangiz, avval siyosat va
bu ro'yxatni yangilang, keyin arizaga qo'shing.

`youtube.force-ssl` keng scope (videoni o'chirishga ham ruxsat beradi). Google "tor
scope yetmaydimi?" deb so'rasa, javob: captions/playlist/comment yozish uchun boshqa
scope yo'q. Muqobil — uni olib tashlash (`config.py`dagi izohga qarang): shunda subtitr,
pleylist va izoh funksiyalari yo'qoladi, yuklash ishlayveradi. Bu holda siyosat
jadvalidan ham qatorni olib tashlang.

## 5. Demo video

Google YouTube'ga yuklangan (unlisted) video havolasini so'raydi. Talablar:

- [ ] Interfeys **ingliz tilida** (til tanlagichda EN).
- [ ] Brauzer manzil satri ko'rinib tursin — domen va consent screen URL'idagi
      `client_id` ko'rinishi kerak (u Cloud'dagi client ID bilan bir xil bo'lishi shart).
- [ ] Ketma-ketlik:
  1. `https://<domen>/` landing → pastdagi Privacy/Terms havolalari.
  2. Sign in → Providers sahifasi → **Connect YouTube**.
  3. Google consent screen: app nomi, tanlangan akkaunt va **har bir scope** ko'rinsin.
  4. Ruxsat berilgach, "connected" holati.
  5. Har bir scope ishlatilishini ko'rsating: video yuklanishi (YouTube Studio'da
     *private* video va uning muqovasi), subtitr yo'lagi, pleylistga qo'shilishi, kanal
     izohi, izohlar asosidagi mavzular va Analytics raqamlari panelda.
  6. `https://myaccount.google.com/permissions` da ruxsatni bekor qilish.
- [ ] Reviewer uchun test akkaunt (email/parol) arizaning izoh maydoniga — kirish taklif
      orqali, ro'yxatdan o'tish sahifasi yo'q.

## 6. Topshirish va keyin

- [ ] Branding → **Verify branding** (domen va havolalar tekshiruvi, odatda bir necha kun).
- [ ] Data access → scope'lar bilan **Submit for verification**.
- [ ] Google yozgan xatlarga ariza sahifasi orqali javob bering; odatda bir necha hafta.
- [ ] Kvota 10 000 birlik/kun yetmasa, alohida **YouTube API Services audit and quota
      extension** formasi to'ldiriladi — u YouTube API Developer Policies'ga moslikni
      tekshiradi (YouTube ToS va Google Privacy Policy havolalari siyosatda bor).
- [ ] Kod qaysi API chaqiruvlarini yoki provayderlarni ishlatishini o'zgartirsa,
      `command-center/lib/legal-docs/{en,ru,uz}.ts` ni ham yangilang — Google siyosatni
      ilova xatti-harakati bilan solishtiradi. `tests/legal-docs.test.ts` kod so'raydigan
      har bir scope siyosatda borligini tekshiradi.

## Havolalar

- Google API Services User Data Policy: https://developers.google.com/terms/api-services-user-data-policy
- YouTube Terms of Service: https://www.youtube.com/t/terms
- Google Privacy Policy: https://policies.google.com/privacy
- Ruxsatlarni boshqarish: https://myaccount.google.com/permissions
- OAuth verification FAQ: https://support.google.com/cloud/answer/9110914
