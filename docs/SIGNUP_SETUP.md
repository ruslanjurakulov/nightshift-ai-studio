# O'z-o'zidan ro'yxatdan o'tish (self-serve signup)

Landing'dagi **"Start creating"** tugmasi `/signup` sahifasiga olib boradi. Har kim
email va parol bilan hisob ochadi, emailini tasdiqlaydi, o'z ish maydonini
(tashkilotini) yaratadi va birinchi videoga yo'l ko'rsatuvchi ro'yxatni ko'radi.
Kod tayyor — lekin u ishlashi uchun Supabase'da bir necha sozlamani **siz**
yoqishingiz kerak. Quyidagi hammasi Supabase Dashboard'da, bir marta qilinadi.

## Qanday ishlaydi

```
/signup ──► supabase.auth.signUp (anon key)
              │  "Emailingizni tekshiring"
              ▼
     Supabase tasdiqlash xati ──► {{ .ConfirmationURL }}
              │   (Supabase emailni tasdiqlaydi, keyin qaytaradi)
              ▼
/auth/callback?code=…&next=/welcome
     exchangeCodeForSession → sessiya cookie'lari
     next faqat shu saytdagi yo'l bo'lishi mumkin (//evil.com, https://… rad etiladi)
              ▼
/welcome   1. Ish maydoni nomi → create_organization()   (tashkiloti bo'lmasa)
              → 0027: birinchi tashkilotga 100 bepul kredit (bir foydalanuvchiga bir marta)
           2. Nima yaratyapsiz? nisha + til (ixtiyoriy — kanal ustasini oldindan to'ldiradi)
           3. Keyingi qadamlar: kanal qo'shish · YouTube ulash · ovoz va uslub ·
              kredit sotib olish · birinchi video
              ▼
/all-channels/command-center
```

Qoidalar (o'zgarmaydi):

- **Command Center faqat anon key ishlatadi.** Ro'yxatdan o'tish, callback va
  tashkilot yaratish — hammasi foydalanuvchining o'z sessiyasi bilan, RLS ostida.
- **Tashkiloti yo'q foydalanuvchi** ilovaning istalgan sahifasini ochsa `/welcome`'ga
  yuboriladi — bo'sh yoki buzilgan sahifa ko'rmaydi.
- **YouTube ulash** hozircha platforma operatori (siz) orqali: Google OAuth ilovasi
  tekshiruvdan o'tmaguncha faqat siz qo'shgan hisoblar ruxsat bera oladi. Mijozga
  buzuq tugma emas, tushuntirish va "Kanal ulanishini so'rash" havolasi ko'rsatiladi.
- **Bepul ishga tushirish yo'q.** Kredit tekshiruvi (`credits_not_enforced`) o'zgarmagan.

## 1. Email provayderini yoqing

**Authentication → Sign In / Providers → Email**:

| Sozlama | Qiymat |
| :-- | :-- |
| Enable Email provider | **ON** |
| Confirm email | **ON** — tasdiqlanmagan email bilan kirib bo'lmaydi |
| Minimum password length | **8** (forma ham 8 talab qiladi) |
| Allow new users to sign up (Authentication → Sign In / Providers, yuqorida) | **ON** |

"Confirm email" o'chiq bo'lsa ham kod ishlaydi (foydalanuvchi darhol `/welcome`'ga
o'tadi), lekin **yoqilgan bo'lishi shart** — aks holda istalgan birovning emaili
bilan hisob ochish mumkin.

## 2. URL sozlamalari

**Authentication → URL Configuration**:

- **Site URL:** `https://nightshift-ai.studio`
- **Redirect URLs** (ikkalasini ham qo'shing):
  - `https://nightshift-ai.studio/auth/callback`
  - `https://nightshift-ai.studio/**`
- Lokal sinov uchun qo'shimcha: `http://localhost:3000/**`

Redirect URL ro'yxatda bo'lmasa, Supabase tasdiqlash xatidagi havolani Site URL'ga
(landing'ga) qaytaradi va foydalanuvchi tizimga kirmaydi.

O'z serveringizda (Docker, `deploy/`) ishlatsangiz `APP_ORIGIN` o'rnatilganiga
ishonch hosil qiling — callback yo'naltirishni shu manzildan quradi.

## 3. SMTP — ishga tushirishdan oldin majburiy

Supabase'ning o'rnatilgan pochta xizmati **faqat sinov uchun**: soatiga juda kam
xat yuboradi va yangi loyihalarda faqat loyiha jamoasi a'zolarining manziliga
yetkazadi. Mijozlarga tasdiqlash xati bormasa, hech kim ro'yxatdan o'ta olmaydi.

1. Tranzaksion pochta xizmatida hisob oching (masalan Resend, Postmark, Amazon SES,
   Brevo) va `nightshift-ai.studio` domenini tasdiqlang (SPF/DKIM yozuvlari).
2. **Authentication → Emails → SMTP Settings → Enable custom SMTP**: host, port,
   foydalanuvchi, parol, jo'natuvchi (masalan `no-reply@nightshift-ai.studio`,
   nomi `Nightshift`).
3. **Authentication → Rate Limits**: "emails sent per hour" ni kutilgan
   ro'yxatdan o'tishlar soniga moslang.
4. **Authentication → Emails → Templates → Confirm signup**: standart shablon
   (`{{ .ConfirmationURL }}`) o'zgarishsiz ishlaydi. Matnni o'zbek/rus/ingliz
   tilida o'zingizga moslashingiz mumkin — havolani o'chirmang.

SMTP parolini hech qayerga (repo, chat, log) yozmang — faqat Supabase maydoniga.

## 4. Migratsiya 0027 — xush kelibsiz kreditlari

**SQL Editor → New query** → [`supabase/migrations/0027_welcome_credits.sql`](../supabase/migrations/0027_welcome_credits.sql)
mazmunini joylang → **Run**. 0018 va 0020 avval qo'llangan bo'lishi kerak.
Qayta ishga tushirish xavfsiz.

Nima qiladi:

- Foydalanuvchi **birinchi** tashkilotini yaratganda (`create_organization()`)
  shu tashkilot hisobiga **100 kredit** qo'shiladi — ledger'da `grant` yozuvi,
  izoh `welcome credits`, `external_id = welcome:<user id>`.
- **Bir foydalanuvchiga bir marta.** Belgi — ledger'ning o'zgarmas (append-only)
  jadvalidagi unikal `external_id`; ikkinchi tashkilot, qayta so'rov yoki bir
  vaqtdagi ikki so'rov ikkinchi marta kredit bermaydi.
- Faqat emaili **tasdiqlangan** hisobga; operatorning standart tashkilotiga emas;
  SQL editor'dan yaratilgan tashkilotga emas.
- Brauzer chaqira oladigan yangi funksiya **yo'q** — bu faqat trigger, `EXECUTE`
  hammadan olib qo'yilgan. RLS va jadval ruxsatlari o'zgarmagan.

Miqdorni o'zgartirish: migratsiyadagi `welcome_credits constant numeric := 100;`
qatorini tahrirlang va qayta ishga tushiring (keyingi yangi foydalanuvchilarga
ta'sir qiladi). Migratsiya qo'llanmagan bo'lsa ro'yxatdan o'tish baribir ishlaydi,
faqat bepul kredit berilmaydi va `/welcome` bu haqda hech narsa demaydi.

## 5. Ixtiyoriy: aloqa emaili

`NEXT_PUBLIC_CONTACT_EMAIL` (Vercel env) o'rnatilgan bo'lsa, `/welcome`'dagi
"Kanal ulanishini so'rash" tugmasi shu manzilga xat ochadi. O'rnatilmagan bo'lsa,
"Nightshift jamoasi bilan bog'laning" degan matn ko'rinadi.

## 6. Tekshirish

1. Shaxsiy oynada `https://nightshift-ai.studio/signup` ni oching, yangi email
   bilan ro'yxatdan o'ting → "Emailingizni tekshiring".
2. Xatdagi havolani **shu brauzerda** oching → `/welcome` ochiladi.
3. Ish maydoni nomini kiriting → "100 bepul kredit" xabari chiqadi.
4. Supabase → Table Editor → `credit_transactions`: `external_id = welcome:<uuid>`
   bitta qator. Ikkinchi tashkilot yarating — yangi qator **qo'shilmaydi**.
5. Chiqib, tasdiqlanmagan boshqa email bilan kirishga urining → "Avval emailingizni
   tasdiqlang" xabari.
