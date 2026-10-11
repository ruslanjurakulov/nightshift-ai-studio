# Google bilan kirish ("Continue with Google")

`/login` va `/signup` sahifalarida email formasi ustida **"Continue with Google"**
tugmasi turadi. Kod tayyor va Supabase Auth'ning Google provayderidan
foydalanadi (`signInWithOAuth`, PKCE). Ishlashi uchun **siz** ikki joyda sozlama
qilasiz: Google Cloud Console va Supabase Dashboard. Hammasi bir marta qilinadi.

> **Eng muhim qoida.** Google'dan olinadigan **Client Secret** faqat Supabase
> Dashboard'dagi maydonga yoziladi. Uni chatga, git'ga, GitHub'ga (issue, PR,
> fayl), skrinshotga yoki `.env` fayllarga **hech qachon** qo'ymang. Command
> Center kodiga ham kerak emas: u faqat Supabase'ning ochiq (anon) kalitini
> ishlatadi. Secret tasodifan oshkor bo'lsa — Google Cloud Console'da yangisini
> yarating (Reset secret) va Supabase'dagisini almashtiring.

## Qanday ishlaydi

```
/login yoki /signup  ──►  "Continue with Google" bosiladi
        supabase.auth.signInWithOAuth({ provider: "google",
          redirectTo: https://nightshift-ai.studio/auth/callback?next=…&provider=google })
              ▼
Google tanlov va ruxsat oynasi (faqat openid, email, profile)
              ▼
https://kgqzdjttlnhrxrlqxqge.supabase.co/auth/v1/callback   (Supabase)
              ▼
/auth/callback?code=…      exchangeCodeForSession  →  sessiya cookie'lari
     • Google manzilni TASDIQLAGAN bo'lishi shart (email_verified === true),
       aks holda sessiya darhol yopiladi va /login?error=google_unverified
     • do'st taklifi cookie'si (joinFromCookie) email bilan ro'yxatdan
       o'tishdagi kabi shu yerda hisoblanadi
              ▼
/welcome (yangi hisob)  yoki  next (mavjud hisob)
```

Xatolar `/login?error=<kod>` ko'rinishida qaytadi va qat'iy matn bilan
ko'rsatiladi (en/ru/uz); Google yoki Supabase matni hech qachon ko'rsatilmaydi:

| Kod | Qachon |
| :-- | :-- |
| `google_denied` | Foydalanuvchi Google oynasida "Cancel" bosdi |
| `google_unverified` | Google manzilni tasdiqlamagan (yoki hisob tasdiqlanmagan) |
| `google_failed` | Boshqa har qanday xato |

## Yangi Google foydalanuvchisi nima oladi

Email bilan ro'yxatdan o'tgandagi bilan **aynan bir xil** holat; Google uchun
alohida hech narsa yaratilmaydi va qo'shimcha migratsiya kerak emas:

1. Kirgach `/welcome` ochiladi (tashkiloti yo'q hisob har qanday sahifadan
   shu yerga yuboriladi). Ish maydoni **faqat shu sahifada**, `create_organization()`
   orqali yaratiladi (email bilan ro'yxatdan o'tganda ham xuddi shunday).
2. Birinchi tashkilot yaratilganda `0027`/`0042` trigger'i 100 bepul kreditni
   beradi. U `auth.users.email_confirmed_at` bo'sh emasligini talab qiladi;
   Google tasdiqlagan manzil uchun Supabase buni o'zi to'ldiradi. Kredit
   bir foydalanuvchiga va bir (normallashtirilgan) pochta qutisiga bir marta.
3. Ro'yxatdan o'tishda tarif tanlanmaydi va hisobga tarif yozilmaydi: kredit hisobi tashkilot bilan birga ochiladi (bepul boshlanish). Google yo'li buni o'zgartirmaydi, shuning uchun standart tarif ham email bilan ro'yxatdan o'tganlarniki bilan bir xil. Ish maydoni egasi `auth.jwt()` email'idan olinadi; Google foydalanuvchisida u ham bor.
4. Do'st taklifi: `/i/<token>` cookie'si Google yo'lida ham saqlanadi va
   `/auth/callback`da hisoblanadi.

## Xavfsizlik: hisoblarni bog'lash

- **Mavjud email+parol foydalanuvchisi Google bilan kirsa** (bir xil, Google
  tasdiqlagan manzil): Supabase avtomatik bog'laydi (bitta foydalanuvchi, ikki
  identity). Hisob, ish maydoni va kreditlar o'sha-o'sha qoladi, ikkinchi
  hisob yaratilmaydi.
- **Pre-account takeover** (hujumchi qurbonning emaili bilan parol qo'yib
  ro'yxatdan o'tadi, lekin emailni tasdiqlamaydi; keyin qurbon Google bilan
  kiradi): Supabase hujjatiga ko'ra, yangi (tasdiqlangan) identity mavjud
  foydalanuvchiga bog'langanda boshqa **tasdiqlanmagan identity'lar o'chiriladi**.
  > **Halollik bilan:** bu himoya Supabase (GoTrue) xatti-harakatiga tayanadi
  > va biz uni **jonli sinab ko'rmadik**; kodimiz bu holatni o'zi tekshirmaydi.
  > Muhim nuqta: hujumchining paroli `auth.users` qatorida saqlanadi, identity
  > jadvalida emas. Himoya GoTrue Google identity'ni tasdiqlanmagan foydalanuvchiga
  > bog'lashda o'sha parolni tozalashiga bog'liq. Shuning uchun quyidagi 3-bo'limdagi
  > 5-qo'lda sinovni **ishga tushirishdan oldin** o'tkazing. Agar parol bilan
  > kirish hali ham ishlasa, Google kirishini yoqmang va bizga xabar bering.
  Bu **"Confirm email" yoqilgan** bo'lishiga ham tayanadi (`docs/SIGNUP_SETUP.md`,
  1-bo'lim). Uni o'chirmang.
- **Google manzilni tasdiqlamagan bo'lsa** — Supabase o'zi kirishni to'xtatadi
  (`provider_email_needs_verification`), kod esa qo'shimcha himoya qiladi:
  `/auth/callback` sessiyani faqat Google identity'sida `email_verified === true`
  va foydalanuvchida `email_confirmed_at` bo'lsagina qoldiradi, aks holda
  `signOut` qiladi. Belgi (`provider=google`) o'chirilsa ham tekshiruv Google
  identity'si bor har bir hisobga qo'llanadi.
- **Qo'lda bog'lash (manual linking)** — yoqmang: kod `linkIdentity`
  ishlatmaydi. Sozlama Authentication → Sign In / Providers sozlamalarida,
  "Allow manual linking" nomi bilan qidiring (dashboard joylashuvi o'zgarib turadi).

## 1. Google Cloud Console

1. https://console.cloud.google.com → yuqoridagi loyiha tanlagich → **New
   Project** (masalan `nightshift-signin`). Mavjud loyiha ham bo'ladi.
2. **APIs & Services → OAuth consent screen** (yangi interfeysda **Google Auth
   Platform → Branding / Audience / Data Access**):
   - **User type: External**.
   - App name: `Nightshift`; User support email va Developer contact email —
     o'zingizning pochtangiz.
   - App domain: Home page `https://nightshift-ai.studio`, Privacy policy
     `https://nightshift-ai.studio/privacy`, Terms `https://nightshift-ai.studio/terms`.
     Authorized domain: `nightshift-ai.studio` va `supabase.co`.
   - **Scopes** (Data Access): faqat asosiylari — `openid`, `.../auth/userinfo.email`,
     `.../auth/userinfo.profile`. Boshqa scope qo'shmang: shunda Google'ning
     qo'shimcha tekshiruvi (verification) talab qilinmaydi.
   - **Publishing status: In production** ("Publish app"). "Testing" holatida
     faqat qo'lda qo'shilgan test foydalanuvchilar kira oladi.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - **Application type: Web application**, nomi `Nightshift web`.
   - **Authorized JavaScript origins**: bo'sh qoldirish mumkin (oqim serverda,
     Supabase orqali o'tadi).
   - **Authorized redirect URIs** — aynan shu bitta:
     `https://kgqzdjttlnhrxrlqxqge.supabase.co/auth/v1/callback`
   - **Create**. Chiqqan **Client ID** va **Client secret** ni nusxalang
     (secret'ni faqat keyingi qadamda Supabase'ga qo'yasiz).

> Eslatma: mavjud YouTube ulash uchun ishlatilayotgan OAuth client bilan
> adashtirmang. Kirish uchun alohida client yarating; YouTube ulash
> (`youtube.upload`) o'z sozlamasi bilan qoladi (`docs/GOOGLE_OAUTH_VERIFICATION.md`).

## 2. Supabase Dashboard

Loyiha: `kgqzdjttlnhrxrlqxqge`.

1. **Authentication → Sign In / Providers → Google**:
   - **Enable Sign in with Google: ON**.
   - **Client IDs**: Google'dan olingan Client ID.
   - **Client Secret (for OAuth)**: Google'dan olingan Client secret.
     **Faqat shu maydonga** qo'ying, boshqa hech yerga emas.
   - **Skip nonce checks: OFF** (o'chiq turaversin). **Save**.
2. **Authentication → URL Configuration**:
   - **Site URL:** `https://nightshift-ai.studio`
   - **Redirect URLs** (mavjudlarini o'chirmang). Google uchun kerakli yozuv:
     `https://nightshift-ai.studio/auth/callback`. Tugma callback'ga `?next=…`
     va `provider=google` qo'shib qaytaradi; Supabase ro'yxatni aniq moslik
     bilan yoki andoza bilan solishtirishi mumkinligi uchun
     `docs/SIGNUP_SETUP.md` dagi `https://nightshift-ai.studio/**` yozuvi ham
     **qolsin** (u allaqachon bor; Google uchun alohida qo'shish shart emas, lekin
     o'chirmang).
   - Lokal sinov uchun: `http://localhost:3000/**`
3. **Authentication → Sign In / Providers**: **Email → Confirm email = ON**
   (yuqoridagi xavfsizlik bandi shunga tayanadi) va **Allow new users to sign up
   = ON**. **"Allow manual linking"** = OFF (Sign In / Providers sozlamalarida qidiring).

O'zingizning serveringizda (Docker, `deploy/`) bo'lsa: `APP_ORIGIN` o'rnatilgan
bo'lsin (`docs/SIGNUP_SETUP.md`, 2-bo'lim) va Supabase tarafdagi redirect
ro'yxatiga o'sha domen ham qo'shilsin.

## 3. Sinash

Kodni sinash uchun Google'ga to'liq aylanish kerak emas — `npm test` (tarmoqsiz)
tugma, xato kodlari va `email_verified` tekshiruvini qamrab oladi. Haqiqiy
aylanishni sozlamadan keyin qo'lda sinang:

1. Yangi (inkognito) oynada `https://nightshift-ai.studio/signup` → **Continue
   with Google** → yangi Google akkaunti bilan kiring → `/welcome` ochilishi,
   ish maydoni nomini kiritgach **100 kredit** ko'rinishi kerak.
2. Chiqing, `/login` → **Continue with Google** → o'sha akkaunt bilan →
   to'g'ridan-to'g'ri ilovaga tushishi kerak (ikkinchi hisob yaratilmaydi).
3. Email+parol bilan ochilgan va tasdiqlangan hisobning Gmail manzili bilan
   Google orqali kiring → o'sha hisobning ma'lumotlari ko'rinishi kerak.
4. Google oynasida **Cancel** bosing → `/login` sahifasida "Google sign-in was
   cancelled…" xabari chiqishi kerak.
5. **Pre-account takeover sinovi (majburiy):** (a) inkognito oynada
   `/signup` orqali yangi email+parol bilan ro'yxatdan o'ting va tasdiqlash
   xatini **ochmang**; (b) shu manzildagi Google akkaunti bilan **Continue with
   Google** orqali kiring; (c) chiqing va `/login` da (a) dagi **parol bilan
   kirishga urining** — kirish **ishlamasligi** kerak (xato: noto'g'ri email
   yoki parol). Supabase → Authentication → Users: shu foydalanuvchida faqat
   `Google` identity bo'lishi kerak. Agar parol bilan kirish **ishlasa** — bu
   xavfsizlik teshigi: Google kirishini o'chiring va xabar bering.
6. Supabase → Authentication → Users: foydalanuvchi qatorida provider `Google`
   (va bog'langan bo'lsa `Email`) ko'rinadi.
7. Tarmoq/CSP: brauzer konsolida yangi CSP buzilishi bo'lmasligi kerak (kod
   CSP'ni o'zgartirmaydi: o'tish Google'ga oddiy sahifa almashtirish orqali bo'ladi).

## Muammolar

| Belgi | Sabab |
| :-- | :-- |
| Google'da `redirect_uri_mismatch` | 1-qadamdagi redirect URI Supabase manzili bilan aynan bir xil emas |
| Google'da "Access blocked: app not verified / Testing" | Consent screen hali "In production" emas |
| Supabase: `Unsupported provider: provider is not enabled` | 2-qadamdagi Google provayder yoqilmagan |
| Kirgach landing sahifasiga qaytadi | `https://nightshift-ai.studio/auth/callback` Redirect URLs ro'yxatida yo'q |
| `/login?error=google_failed` | Boshqa brauzerda/oynada tugatilgan oqim (PKCE cookie yo'q), yoki Supabase'da sign-up o'chiq — qayta urinib ko'ring |
