# Paddle orqali kredit sotish (SaaS C4)

Mijoz tashkiloti Command Center'ning **Credits** sahifasida kredit paketini sotib
oladi. To'lovni **Paddle** (Merchant of Record — soliq, VAT, chek, qaytarish ham
Paddle zimmasida) qabul qiladi, kreditlarni esa Paddle webhook'i orqali
**Supabase Edge Function** qo'shadi. Avval hammasi **sandbox**'da sinaladi,
keyin production'ga o'tiladi.

## Qanday ishlaydi

```
Credits sahifasi (owner/admin)          Paddle                        Supabase
──────────────────────────────          ──────                        ────────
"Sotib olish" ─► Paddle.js overlay ─► karta Paddle'ning o'z
                 (priceId + customData   oynasida kiritiladi
                  {org_id, user_id})          │
                                             ▼
                                    transaction.completed ──► Edge Function paddle-webhook
                                    (Paddle-Signature)          1. imzo (HMAC-SHA256, ≤5 daqiqa)
                                                                2. price id → bizning paket jadvali
                                                                3. tashkilot mavjudmi
                                                                4. add_purchased_credits(org, kredit,
                                                                   txn_…)  — takror kelsa ham 1 marta
                                                                5. payment_events ga yozuv
Balans o'sguncha sahifa har 3 soniyada yangilanadi ◄───────────────────────┘
```

Qoidalar (o'zgarmaydi):

- **Karta ma'lumoti bizga hech qachon kelmaydi.** Uni Paddle'ning o'z oynasi
  (iframe) oladi; biz saqlamaymiz, ko'rmaymiz, log'ga yozmaymiz.
- **Command Center service key'ni olmaydi.** Kredit qo'shish (`add_purchased_credits`)
  faqat service role'ga ruxsat etilgan, shuning uchun webhook Command Center'da
  emas, Supabase Edge Function'da ishlaydi.
- **Miqdorni brauzer belgilamaydi.** `customData` faqat "kim uchun" ekanini aytadi;
  nechta kredit qo'shilishi Paddle price id bo'yicha bizning paket jadvalidan
  olinadi. Noma'lum price yoki mavjud bo'lmagan tashkilot — kredit qo'shilmaydi,
  hodisa `rejected` bo'lib yoziladi (pul olingan — odam hal qiladi: Paddle'da
  qaytarish yoki qo'lda `grant`).
- **Standart (operator) tashkiloti** kredit to'lamaydi, unga "Sotib olish" ko'rsatilmaydi.
- Paddle sozlanmagan bo'lsa (token bo'sh) panel umuman ko'rinmaydi.

### Paketlar

Kod ichida belgilangan (`supabase/functions/_shared/paddle.ts` va
`command-center/lib/paddle.ts` — test ikkalasi bir xilligini tekshiradi):

| Paket | Kredit | Env (Command Center) | Secret (Edge Function) |
| :-- | --: | :-- | :-- |
| Starter | 1 000 | `NEXT_PUBLIC_PADDLE_PRICE_STARTER` | `PADDLE_PRICE_STARTER` |
| Creator | 5 000 | `NEXT_PUBLIC_PADDLE_PRICE_CREATOR` | `PADDLE_PRICE_CREATOR` |
| Studio | 20 000 | `NEXT_PUBLIC_PADDLE_PRICE_STUDIO` | `PADDLE_PRICE_STUDIO` |

Narxni (dollarda) Paddle'da o'zingiz qo'yasiz. Kreditning qiymati Credits
sahifasidagi narx jadvaliga (`credit_prices`, masalan `usd` birligi) bog'liq —
paket narxini shu bilan moslang. Misol uchun `usd = 100` (1 dollar xarajat = 100
kredit) bo'lsa, 1 000 kredit ≈ 10 dollarlik xarajat; paket narxi bundan yuqori
bo'lishi kerak (marja). Price id bo'sh qoldirilgan paket sahifada ko'rsatilmaydi.

---

## 1. Bazani tayyorlash — 0021 migratsiyasi (bir marta)

0018 (tashkilotlar) va 0020 (kreditlar) allaqachon qo'llangan bo'lishi kerak.
Supabase → **SQL Editor** → `supabase/migrations/0021_credit_refunds.sql` faylining
butun matnini qo'yib **Run**. Qayta ishga tushirish xavfsiz.

Tekshiruv (har bir ustun `true` bo'lishi kerak):

```sql
select
  (select count(*) from information_schema.tables where table_schema = 'public'
    and table_name in ('payment_events', 'credit_refunds')) = 2
    as tables_exist,
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.payment_events'::regclass, 'public.credit_refunds'::regclass))
    as rls_enabled,
  not has_table_privilege('authenticated', 'public.payment_events', 'SELECT')
    and not has_table_privilege('authenticated', 'public.credit_refunds', 'SELECT')
    and not has_table_privilege('anon', 'public.payment_events', 'SELECT')
    and not has_table_privilege('service_role', 'public.credit_refunds', 'INSERT')
    as tables_not_writable_directly,
  not has_function_privilege('authenticated',
    'public.refund_purchased_credits(text,text,numeric,text,text)', 'EXECUTE')
    and not has_function_privilege('anon',
    'public.record_payment_event(text,text,text,timestamptz,text,text,uuid,text,text,numeric,text,bigint)', 'EXECUTE')
    and has_function_privilege('service_role',
    'public.refund_purchased_credits(text,text,numeric,text,text)', 'EXECUTE')
    as service_only_functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('record_payment_event', 'refund_purchased_credits')
      and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 2
    as definer_functions_pin_search_path;
```

0021 nima qo'shadi:

- `payment_events` — kelgan har bir webhook hodisasi: nima qaror qilindi
  (`processed | duplicate | ignored | rejected | failed`) va nima uchun. Faqat
  id'lar va summalar — ism, email, manzil, karta yo'q.
- `credit_refunds` — har bir qaytarish/chargeback: qancha so'raldi, qancha
  olindi, qancha **olib bo'lmadi** (`shortfall`).
- `refund_purchased_credits(...)`, `record_payment_event(...)` — faqat service role.

## 2. Paddle sandbox akkaunti

1. <https://sandbox-vendors.paddle.com/signup> da ro'yxatdan o'ting (sandbox'da
   haqiqiy pul yurmaydi, hujjat tekshiruvi yo'q).
2. **Paddle → Checkout → Checkout settings → Default payment link** ga
   `https://nightshift-ai.studio/all-channels/credits` ni yozing. Paddle
   checkout ochishdan oldin shu maydon to'ldirilgan bo'lishini talab qiladi.
   (Sandbox'da domen tasdig'i shart emas; production'da domen tasdiqlanadi — 7-bo'lim.)

## 3. Mahsulot va narxlar

**Paddle → Catalog → Products → New product**:

- Nomi: `Nightshift credits`, Tax category: **Standard digital goods** (yoki
  Paddle taklif qilgan SaaS toifasi).
- Shu mahsulotga **uchta narx** (Prices → New price), har biri **One-time**
  (takrorlanmaydigan, obuna emas):
  - `Starter — 1,000 credits`
  - `Creator — 5,000 credits`
  - `Studio — 20,000 credits`
- Har bir narxning id'sini (`pri_01…`) nusxalang — ular 4- va 5-bo'limda kerak.

Miqdorni (quantity) mijoz o'zgartira olmasin: narx sozlamasida quantity
min = max = 1 qoldiring. (O'zgartirsa ham xavfli emas — webhook kreditni
`paket × quantity` qilib hisoblaydi.)

## 4. Command Center: client-side token va env

**Paddle → Developer tools → Authentication → Client-side tokens → New** —
`test_…` bilan boshlanadigan token. U brauzer uchun mo'ljallangan (ochiq),
API key emas. **API key'ni hech qayerga qo'ymang — u kerak emas.**

Self-hosted server (`/opt/nightshift/.env.web`, `deploy/.env.web.example` ga qarang)
yoki Vercel → Settings → Environment Variables:

```dotenv
NEXT_PUBLIC_PADDLE_ENV=sandbox
NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_xxxxxxxxxxxxxxxxxxxx
NEXT_PUBLIC_PADDLE_PRICE_STARTER=pri_01...
NEXT_PUBLIC_PADDLE_PRICE_CREATOR=pri_01...
NEXT_PUBLIC_PADDLE_PRICE_STUDIO=pri_01...
```

`NEXT_PUBLIC_*` build vaqtida sahifaga yoziladi — o'zgartirgandan keyin
**qayta build** kerak (`docker compose up -d --build` yoki Vercel redeploy).
Token muhitga mos bo'lishi shart: `sandbox` ↔ `test_…`, `production` ↔ `live_…`;
mos kelmasa panel yashiriladi (yarim yo'lda qolgan production'ga o'tish
noto'g'ri Paddle'ni ochmasligi uchun).

## 5. Webhook: Edge Function'ni deploy qilish

Supabase CLI kerak (<https://supabase.com/docs/guides/cli>). `<REF>` — Supabase
loyihangiz id'si (Settings → General → Reference ID).

```bash
cd nightshift-ai-studio            # repo ildizi
supabase login
supabase functions deploy paddle-webhook --no-verify-jwt --project-ref <REF>
```

`--no-verify-jwt` **majburiy**: Paddle Supabase JWT yubormaydi, u o'z imzosini
yuboradi — funksiya o'sha imzoni tekshiradi. Bu flag'siz Paddle har safar 401 oladi.

Funksiya manzili:

```
https://<REF>.supabase.co/functions/v1/paddle-webhook
```

### Paddle'da webhook manzili (notification destination)

**Paddle → Developer tools → Notifications → New destination**:

- Type: **Webhook**, URL: yuqoridagi funksiya manzili.
- Events: `transaction.completed`, `adjustment.created`, `adjustment.updated`
  (boshqalari ham kelsa zarari yo'q — 200 bilan `ignored` bo'ladi).
- Agar "usage type" so'ralsa — simulyatsiya ham ishlashi uchun **Platform and simulation**.
- Saqlagandan keyin **Secret key** (`pdl_ntfset_…`) ni oching va nusxalang.

### Secret'larni Supabase'ga qo'yish

Shell tarixida qolmasligi uchun faylga yozib, fayl orqali bering:

```bash
cat > /tmp/paddle.env <<'EOF'
PADDLE_WEBHOOK_SECRET=pdl_ntfset_...
PADDLE_PRICE_STARTER=pri_01...
PADDLE_PRICE_CREATOR=pri_01...
PADDLE_PRICE_STUDIO=pri_01...
EOF
supabase secrets set --env-file /tmp/paddle.env --project-ref <REF>
rm /tmp/paddle.env
supabase secrets list --project-ref <REF>    # faqat nomlar va hash ko'rinadi
```

(Bitta qiymat uchun: `supabase secrets set PADDLE_WEBHOOK_SECRET=... --project-ref <REF>`.)

`SUPABASE_URL` va `SUPABASE_SERVICE_ROLE_KEY` ni **qo'ymang** — Supabase ularni
har bir Edge Function'ga o'zi beradi. Service key shu funksiyadan tashqariga
chiqmaydi.

Price id'lar ikki joyda turadi (Command Center env'ida — tugmalar uchun;
Supabase secret'larida — kredit hisoblash uchun). Ikkalasi bir xil bo'lishi
kerak: Supabase'da yo'q price bilan to'langan xarid `rejected` bo'ladi.

## 6. Sinash (sandbox)

### a) Paddle webhook simulyatori

**Paddle → Developer tools → Simulations → New simulation** → destination'ni
tanlang → *Single event* → `transaction.completed` → **Run**.

Simulyator namunaviy ma'lumot yuboradi (begona `custom_data` va price id), shuning
uchun kutilgan natija: Paddle'da **200**, bazada `rejected` yozuvi — bu imzo va
manzil to'g'ri ishlayotganini ko'rsatadi. Payload'ni tahrirlab
`custom_data.org_id` ga haqiqiy tashkilot id'sini va `items[0].price.id` ga
Starter price id'sini qo'ysangiz — kredit haqiqatan qo'shiladi.

```sql
select event_id, event_type, status, detail, received_at
from public.payment_events order by received_at desc limit 20;
```

401 kelsa: `PADDLE_WEBHOOK_SECRET` noto'g'ri yoki deploy `--no-verify-jwt`
siz qilingan (Supabase logs'da farqini ko'rasiz: bizning funksiya
`signature mismatch` deb yozadi).

### b) Haqiqiy sandbox xaridi

1. Standart bo'lmagan tashkilotni oching (owner/admin sifatida) → **Credits**.
2. Paketni tanlang → **Sotib olish** → Paddle oynasida test karta:
   `4242 4242 4242 4242`, muddati — kelajakdagi istalgan oy, CVC `100`.
3. To'lovdan keyin sahifa "To'lov qabul qilindi…" deydi va bir necha soniyada
   balans o'sadi; Transactions jadvalida `purchase` qatori paydo bo'ladi.

```sql
select kind, amount, balance_after, external_id, note, created_at
from public.credit_transactions order by id desc limit 10;
```

Xuddi shu webhook'ni simulyatordan yoki Paddle'dan qayta yuborsangiz ham kredit
ikkinchi marta qo'shilmaydi (`external_id` = Paddle transaction id).

### c) Qaytarish (refund)

Paddle → Transactions → xaridni oching → **Refund** (to'liq yoki qisman). Sandbox'da
tasdiqlangandan keyin `adjustment.updated` (status `approved`) keladi va Credits
jadvalida manfiy `refund` qatori paydo bo'ladi. Qisman qaytarishda kredit
qaytarilgan pul ulushiga mutanosib olinadi (masalan 25% pul → 25% kredit).

## 7. Production'ga o'tish

1. <https://vendors.paddle.com> da **live** akkaunt (sandbox'dan alohida; hamma narsa
   qaytadan yaratiladi — id'lar boshqacha bo'ladi).
2. **Seller verification** (pastdagi bo'lim) va **domen tasdig'i**:
   Paddle → Checkout → Website approval → `nightshift-ai.studio`.
3. Live'da xuddi shu mahsulot va 3 ta narx; live client-side token (`live_…`);
   Default payment link = `https://nightshift-ai.studio/all-channels/credits`.
4. Live notification destination (xuddi shu funksiya URL'i) → yangi secret key.
5. Supabase secret'larini live qiymatlarga almashtiring (5-bo'limdagi fayl usuli):
   `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_*`. Funksiyani qayta deploy qilish shart emas.
6. Command Center env: `NEXT_PUBLIC_PADDLE_ENV=production`, live token, live
   price id'lar → qayta build.
7. Kichik haqiqiy xarid qiling, ledger'ni tekshiring, keyin Paddle'dan refund qiling.

Bitta funksiya bir vaqtda bitta muhitga (sandbox yoki live) xizmat qiladi — secret
kimniki bo'lsa, o'sha muhitning imzosi o'tadi.

## Paddle seller verification talablari

Paddle Merchant of Record bo'lgani uchun live to'lovdan oldin biznesni va saytni
tekshiradi. Odatda so'raladi:

- **Shaxs/biznes ma'lumotlari**: yuridik nom, manzil, egasining hujjati (KYC),
  to'lov olinadigan bank hisobi.
- **Ishlab turgan sayt** (`https://nightshift-ai.studio`): mahsulot nima qilishi
  aniq yozilgan, **narxlar ochiq ko'rinadi** (kirishsiz), aloqa uchun email.
- **Terms of Service**, **Privacy Policy** va **Refund Policy** — shu domenda,
  kirishsiz ochiladi. #224 bilan `/terms` va `/privacy` jonli.
- Mahsulot Paddle'ning Acceptable Use Policy'siga mos bo'lishi.

**Hozirgi holat — production'dan oldin tugatilishi kerak (alohida PR, huquqiy
matn — yurist ko'rib chiqsin):**

- `/terms` dagi **"8. Prepaid credits"** bo'limi hali *"TEMPLATE — NOT IN EFFECT"*
  va qavs ichidagi joylar to'ldirilmagan: to'lov provayderi (**Paddle**), qaytarish
  muddati, kreditlarning amal qilish muddati. Paddle refund siyosatini aniq
  ko'rishni xohlaydi, va u Paddle'ning xaridorlar uchun shartlariga (Buyer Terms)
  zid bo'lmasligi kerak.
- `/privacy` dagi provayderlar jadvaliga **Paddle** (to'lov, Merchant of Record;
  oladi: email, mamlakat, to'lov ma'lumoti — biz emas) qo'shilishi kerak.
- Kirishsiz ko'rinadigan **narxlar** (landing sahifada paketlar va narxlari) —
  hozir yo'q.

Sandbox uchun bularning hech biri shart emas.

## Kuzatish

Odam aralashishi kerak bo'lgan hodisalar (pul olingan, kredit qo'shilmagan yoki
Paddle qayta urinib ko'ryapti):

```sql
select provider, event_id, event_type, status, detail, org_id, transaction_id, received_at
from public.payment_events
where status in ('rejected', 'failed')
order by received_at desc;
```

Qaytarishda olib bo'lmagan kreditlar (mijoz ularni allaqachon videoga sarflagan):

```sql
select refund_id, purchase_external_id, org_id, reason, requested, taken, shortfall, created_at
from public.credit_refunds where shortfall > 0 order by created_at desc;
```

### Nega balans manfiy bo'lmaydi

0020 `balance >= 0` va `reserved <= balance` ni CHECK bilan kafolatlaydi va
`reserve_credits` / `add_purchased_credits` "qarz" tushunchasini bilmaydi. Qarzni
yuritish ularni o'zgartirishni talab qilardi (additive emas) va keyingi xaridni
jimgina "yeb qo'yardi". Shuning uchun refund faqat **mavjud** (band qilinmagan)
kreditni oladi — ishlayotgan run'ning bandiga tegmaydi — qolgani `shortfall`
sifatida yoziladi va ledger izohida ochiq aytiladi. Chargeback'da shortfall bo'lsa
bu yo'qotilgan pul: tashkilotni to'xtatish yoki yo'qligini siz hal qilasiz.

Bitta xaridning qaytarishlari yig'indisi xarid miqdoridan oshmaydi. Chargeback
keyinchalik bekor qilinsa (`chargeback_reverse`), kredit avtomatik qaytarilmaydi —
kerak bo'lsa Credits sahifasidan `grant` qiling.

## Muammolar

| Belgi | Sabab | Yechim |
| :-- | :-- | :-- |
| Credits'da "Sotib olish" paneli yo'q | Standart tashkilot; yoki token/price bo'sh; yoki token muhitga mos emas | Boshqa tashkilotni oching; env'ni tekshirib qayta build |
| "Faqat owner yoki admin…" | Siz editor/viewer'siz | Tashkilot owner'i sotib oladi |
| Paddle oynasi "Something went wrong" | Default payment link qo'yilmagan; live'da domen tasdiqlanmagan | 2-bo'lim / 7-bo'lim |
| Webhook 401 | Secret noto'g'ri yoki `--no-verify-jwt` yo'q | 5-bo'lim |
| `rejected: price … is not a credit pack` | Supabase'da `PADDLE_PRICE_*` yo'q yoki boshqa | `supabase secrets set …` |
| `rejected: organization does not exist` | Tashkilot o'chirilgan / payload qo'lda yasalgan | Paddle'da refund yoki qo'lda `grant` |
| `failed: purchase not recorded yet` | Refund xariddan oldin keldi | Kutish — Paddle qayta yuboradi |
| To'lov bo'ldi, kredit 1 daqiqada tushmadi | Webhook yetib bormadi | Paddle → Notifications → destination → loglar; `payment_events` |

## Xavfsizlik

- `PADDLE_WEBHOOK_SECRET` va service key faqat Supabase secret'larida. Git'ga,
  chatga, log'ga — hech qachon. Funksiya log'ga faqat hodisa id'si va qaror
  sababini yozadi.
- Paddle API key bu integratsiyaga **kerak emas** — yaratmang yoki hech qayerga qo'ymang.
- Secret almashtirish: Paddle'da yangi secret'ni oling va darhol
  `supabase secrets set PADDLE_WEBHOOK_SECRET=…` qiling; almashtirish oralig'ida
  imzo o'tmay qolgan hodisalarni Paddle qayta yuboradi.
- Imzo 5 daqiqadan eski bo'lsa rad etiladi (qayta yuborilgan eski so'rov o'tmaydi).
