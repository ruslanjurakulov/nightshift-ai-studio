# Tariflar (obuna) + kredit paketlari — migratsiya 0034

Nightshift endi oddiy SaaS modelida sotiladi:

- **Oylik tariflar** — Free, Creator, Pro, Studio. Har bir pullik tarif har
  to'langan oy (billing period) uchun **kredit ajratmasi** beradi. Bu kreditlar
  **o'sha davr oxirida yonadi** (keyingi oyga o'tmaydi). Tarif qo'shimcha
  **imkoniyatlar** (entitlements) ham beradi: bir vaqtda nechta video ishlashi,
  navbatdagi ustuvorlik, API'ni yoqish huquqi va keyinchalik model darajalari va
  funksiyalar.
- **Kredit paketlari** (Starter / Creator / Studio, `lib/paddle.ts`) — endi
  **to'ldirish (top-up)** paketlari: sotib olingan kundan **12 oy** amal qiladi.
- **Sarflash tartibi:** avval obuna kreditlari (eng tez yonadigani birinchi),
  keyin paket kreditlari (eng tez yonadigani birinchi), eng oxirida muddatsiz
  kreditlar (xush kelibsiz 100 kredit, operator bergan kreditlar, 0034 dan oldingi
  balans).
- **Free tarif** — faqat bir martalik 100 ta xush kelibsiz kredit (0027), oylik
  ajratma yo'q.
- **API balansi** (0031, dollarda) — alohida mahsulot, unga tegilmagan. Faqat
  `api_access` imkoniyati bor tarif ham API'ni yoqa oladi (paket sotib olganlar
  avvalgidek yoqa oladi).

Hammasi **bazadagi jadvallardan** boshqariladi (`plans`, `plan_entitlements`,
`entitlement_keys`, `credit_lot_policies`). Kodda tarif nomlari bo'yicha `if`
yo'q: raqamni o'zgartirish — SQL'da bitta `update`.

## 1. Narx taklifi va hisob-kitob

Repodagi haqiqiy iqtisod:

| Ko'rsatkich | Qiymat | Qayerdan |
| :-- | --: | :-- |
| 1 daqiqa tayyor video | 60 kredit | `credit_prices.video_minute` |
| 1 daqiqa tannarxi | ≈ $0.20 | 0031 izohi, `unitEconomics` |
| → 1 kredit tannarxi | ≈ $0.00333 | 0.20 / 60 |
| 1 kredit chakana (paket) | ≈ $0.01 | Starter 1 000 kredit ≈ 10 USD |
| Paddle komissiyasi | 5% + $0.50 | har bir to'lov uchun |

Taklif (0034 shu raqamlar bilan seed qiladi — `plans.monthly_credits`):

| Tarif | Narx / oy | Kredit / oy | ≈ daqiqa video | 1 kredit narxi | To'liq sarflansa tannarx | Paddle | **Yalpi foyda** |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| Free | 0 | 100 (bir marta) | ≈ 1.7 | — | $0.33 (bir marta) | — | marketing xarajati |
| Creator | 19 USD | 2 000 | ≈ 33 | $0.0095 | $6.67 | $1.45 | **$10.88 (57%)** |
| Pro | 49 USD | 6 000 | ≈ 100 | $0.0082 | $20.00 | $2.95 | **$26.05 (53%)** |
| Studio | 129 USD | 18 000 | ≈ 300 | $0.0072 | $60.00 | $6.95 | **$62.05 (48%)** |

Formula: `foyda = narx − kredit × 0.00333 − (0.05 × narx + 0.50)`.

Nega shunday:

- **Eng yomon holatda ham (kreditlar 100% sarflanganda) har bir tarif ≥ 48%
  foyda** beradi. Amalda obuna kreditlarining bir qismi davr oxirida yonadi
  (odatda 20–35%), shuning uchun haqiqiy marja yuqoriroq bo'ladi.
- Kattaroq tarif — arzonroq kredit (0.95 → 0.82 → 0.72 sent): yuqoriga o'tishga
  sabab bor, lekin Studio'da ham kredit tannarxining 2.1 baravaridan qimmat.
- **Paket narxlari bilan moslang:** obuna har doim muntazam hajmni sotib olishning
  eng arzon yo'li bo'lishi kerak, paket esa "moslashuvchanlik uchun ustama".
  Tavsiya: paketlar ≥ $0.010 / kredit, masalan Starter 1 000 = **12 USD**,
  Creator 5 000 = **55 USD**, Studio 20 000 = **200 USD**. (Agar hozir 10/45/160
  USD bo'lsa, Creator paketi 0.9 sent — Creator obunasidan arzon; bu obunani
  kamroq jozibador qiladi.)
- Pastki chegara: tarif narxi hech qachon `kredit × 0.00333 + Paddle` dan past
  bo'lmasin — aks holda to'liq sarflagan mijoz zarar keltiradi. Masalan Creator
  2 000 kredit uchun break-even ≈ 8.60 USD.

Yakuniy narxni **siz** Paddle'da qo'yasiz; kredit miqdorini bazada o'zgartirasiz
(3-bo'lim).

### Tariflar imkoniyatlari (seed)

| Kalit | Free | Creator | Pro | Studio | Holat |
| :-- | :-: | :-: | :-: | :-: | :-- |
| `concurrency` — bir vaqtda ishlaydigan videolar | 1 | 2 | 4 | 8 | **enforced** |
| `queue_priority` — navbatda boshlab olish (har daraja = 15 daqiqa) | 0 | 1 | 2 | 3 | **enforced** |
| `api_access` — API'ni yoqish huquqi | – | ✓ | ✓ | ✓ | **enforced** |
| `models_image` / `models_video` / `models_audio` | basic | premium | all | all | planned |
| `series`, `channel_dna`, `thumbnail_studio` | – | ✓ | ✓ | ✓ | planned |
| `autopilot`, `workflows`, `repurposing` | – | – | ✓ | ✓ | planned |
| `mcp` — AI ilovalarni (Claude, ChatGPT va boshqalar) OAuth bilan ulash | – | ✓ | ✓ | ✓ | **enforced** (0093) |

- **enforced** — bugun tekshiriladi va `/pricing` sahifasida ko'rsatiladi.
- **`mcp`** (0093) — obuna xususiyati: Free ham, faqat paket sotib olgan (obunasi yo'q) mijoz ham ulay olmaydi; Creator, Pro, Studio ulaydi. Ulangan ilova **sayt kreditlarini** sarflaydi (API'ning dollar balansini emas), har bir ulanish uchun oylik kredit limiti bilan. Tekshiruv uch joyda: rozilik sahifasida, token/refresh endpointlarida va **har bir chaqiruvda**; obuna bekor bo'lsa, ulanish "to'xtatilgan" bo'ladi va tarif qaytganda qayta ulanmasdan ishlaydi. Qaysi tariflarda borligi — `plan_entitlements` dagi bitta qator: `update plan_entitlements set value = 'false' where plan_id = 'creator' and key = 'mcp';`
- **planned** — bazada saqlanadi, lekin hali hech narsa tekshirmaydi, shuning
  uchun **sahifada ko'rsatilmaydi** (va'da qilinmagan narsani sotmaymiz). Funksiya
  tayyor bo'lganda, uni tekshiradigan kod bilan **bir PR'da** `status` ni
  `enforced` ga o'zgartiring.
- Operator tashkiloti (default org) — hamma narsa cheksiz (`exempt_value`).
- Model darajasi uchun kelgusi model registri `model_tier_allowed(org, 'video',
  'premium')` ni chaqiradi (daraja: `basic` < `premium` < `ultra`; `all` hammasini
  ochadi).

## 2. Qanday ishlaydi (qisqa)

```
Paddle checkout (tarif price) ─► subscription.created / updated / canceled …
                                   └► upsert_subscription()  → subscriptions (status, tarif, davr)
                               ─► transaction.completed (birinchi to'lov, har oy yangilanish, upgrade)
                                   └► grant_subscription_credits() → credit_lots (source=subscription,
                                                                      expires_at = davr oxiri)
Paket (bir martalik)          ─► transaction.completed ─► add_purchased_credits() → lot source=pack, +12 oy
```

- Har bir kredit **lot**da yashaydi (`credit_lots`): manba, miqdor, qolgan, band
  (hold), yonish vaqti. `credit_accounts.balance` = lotlardagi qolganlar yig'indisi,
  `reserved` = band qilinganlar yig'indisi — har bir tranzaksiya oxirida baza buni
  **tekshiradi**; mos kelmasa, butun tranzaksiya bekor bo'ladi.
- Run uchun hold lotlardan sarflash tartibida olinadi; charge o'sha hold'dan
  yechiladi; qolgani qaytadi. Yonib ketgan lotdagi **band** kreditlar himoyalangan:
  ish tugaguncha yonmaydi.
- Yangilanish (renewal) → yangi davr loti; eski davr loti yonadi (o'tkazilmaydi).
- **Upgrade** davr o'rtasida (masalan Creator → Pro): lot yangi ajratmagacha
  **qolgan vaqtga mutanosib** to'ldiriladi — oxirgi kuni upgrade qilib bir oylik
  kreditni tiyinlarga olish mumkin emas.
- Idempotent: bir xil Paddle hodisasi / tranzaksiyasi ikki marta kelsa ham kredit
  bir marta qo'shiladi (`payment_events`, ledger'dagi `external_id`, lotning
  `(subscription, period_end)` kaliti).
- Refund: paket yoki obuna to'lovi qaytarilsa, kreditlar **avval o'sha lotdan**
  olinadi (0021 qoidasi: faqat mavjud qismi, yetmagani `shortfall`).
- Yonish: har bir pul funksiyasi (hold, charge, refund …) boshida tashkilotning
  muddati o'tgan lotlarini yondiradi; worker har 10 daqiqada `expire_credit_lots()`
  ni chaqiradi; `pg_cron` yoqilgan bo'lsa soatda bir marta ham. Ledger'da har bir
  yongan lot — `expire` qatori.

## 3. Egasi uchun qadamlar

### 3.1. Migratsiyani qo'llash

1. Supabase → **SQL Editor** → `supabase/migrations/0034_plans_entitlements.sql`
   ni to'liq qo'ying → **Run**. (0033 undan oldin qo'llangan bo'lishi kerak.)
   Fayl bitta tranzaksiya: hozirgi balanslar muddatsiz `adjustment` lotiga
   ko'chiriladi, ochiq hold'lar unga bog'lanadi.
2. Fayl oxiridagi **Verify** so'rovini ishga tushiring — hamma ustun `true`.
3. `NEXT_PUBLIC_CREDITS_EXPIRY_MONTHS=12` ni Command Center env'iga qo'ying va
   qayta build qiling — shartlar (Terms 8.5) va `/pricing` paket kreditlari
   **12 oyda yonishini** aytsin (baza aynan shuni qiladi:
   `credit_lot_policies.pack = 12`). 0034 dan oldin sotib olingan kreditlar
   yonmaydi.
4. (Ixtiyoriy) Supabase → Database → Extensions → **pg_cron** yoqilgan bo'lsa,
   0034 ni qayta ishga tushiring — soatlik yondirish jadvali qo'shiladi.

> Diqqat: 0034 dan keyin **Free tarif bir vaqtda 1 ta video** ishlatadi (ilgari
> cheklov yo'q edi). Paket sotib olgan, lekin obunasi yo'q mijozlar ham Free
> hisoblanadi. Istasangiz Free uchun kattaroq qiling:
> `update plan_entitlements set value = '2' where plan_id = 'free' and key = 'concurrency';`

### 3.2. Paddle'da mahsulot va narxlar (avval sandbox)

Paddle → **Catalog → Products → New product**, har bir tarif uchun:

| Product | Tax category | Price | Billing cycle |
| :-- | :-- | :-- | :-- |
| Nightshift Creator | Standard digital goods / SaaS | 19 USD | **Monthly** |
| Nightshift Pro | Standard digital goods / SaaS | 49 USD | **Monthly** |
| Nightshift Studio | Standard digital goods / SaaS | 129 USD | **Monthly** |

Har bir narxning `pri_…` id'sini ko'chirib oling. Trial qo'ymang (trial'da kredit
berilmaydi — kreditlar faqat to'langan tranzaksiyadan keladi). Paket narxlari
(one-time) o'zgarishsiz qoladi.

### 3.3. Webhook (Edge Function) secret'lari

```bash
supabase secrets set \
  PADDLE_PLAN_CREATOR=pri_... \
  PADDLE_PLAN_PRO=pri_... \
  PADDLE_PLAN_STUDIO=pri_...
supabase functions deploy paddle-webhook --no-verify-jwt
```

- Nom qoidasi: `PADDLE_PLAN_<TARIF ID KATTA HARFDA>` — `plans.id` bilan bir xil
  (`creator` → `PADDLE_PLAN_CREATOR`). Yangi tarif qo'shsangiz (masalan
  `business`), faqat `plans` ga qator va `PADDLE_PLAN_BUSINESS` secret — kod
  o'zgarmaydi.
- Bitta price id ham paket, ham tarif bo'lishi mumkin emas (webhook uni tarif
  sifatida e'tiborsiz qoldiradi).

**Chegirmalar (discount).** Kredit **to'langan summaga** qarab beriladi, ro'yxat
narxiga emas: Paddle `details.totals` dagi `subtotal − discount` ulushi. 50%
chegirma — yarim kredit, 100% chegirma — **kredit berilmaydi** (`rejected`,
odam ko'radi). Bu paketlarga, tarif davrlariga va API top-up'ga birdek
tegishli. Agar biror chegirmani ataylab "bepul kredit" sifatida bermoqchi
bo'lsangiz (masalan, hamkor uchun kupon), uning `dsc_…` id'sini ruxsat
ro'yxatiga qo'ying — u to'liq kredit beradi:

```bash
supabase secrets set PADDLE_PROMO_DISCOUNT_IDS=dsc_...,dsc_...
```

### 3.4. Paddle notification destination — yoqiladigan hodisalar

Paddle → **Developer tools → Notifications** → mavjud webhook manzili → quyidagi
hodisalarni belgilang (avvalgilari qoladi):

- `transaction.completed` *(bor edi)*
- `adjustment.created`, `adjustment.updated` *(bor edi)*
- **yangi:** `subscription.created`, `subscription.updated`,
  `subscription.activated`, `subscription.canceled`, `subscription.past_due`,
  `subscription.paused`, `subscription.resumed`, `subscription.trialing`

### 3.5. Command Center env

```
NEXT_PUBLIC_PADDLE_PLAN_CREATOR=pri_...
NEXT_PUBLIC_PADDLE_PLAN_PRO=pri_...
NEXT_PUBLIC_PADDLE_PLAN_STUDIO=pri_...
NEXT_PUBLIC_PLAN_DISPLAY_CREATOR=19 USD
NEXT_PUBLIC_PLAN_DISPLAY_PRO=49 USD
NEXT_PUBLIC_PLAN_DISPLAY_STUDIO=129 USD
```

- Qayerga qo'yiladi: Vercel → Project → Settings → Environment Variables;
  o'z serverimizda (`deploy_web.yml`) — GitHub → Settings → Secrets and
  variables → **Variables** (xuddi shu nomlar). O'zgartirgandan keyin qayta
  build/deploy qiling (NEXT_PUBLIC_* build paytida kiritiladi).
- Ko'rsatiladigan narxda **`$` belgisini ishlatmang** — deploy uni rad etadi;
  `19 USD` deb yozing. Paddle ishlayotganda sahifa baribir Paddle'ning o'z
  (mahalliy valyuta va soliq bilan) narxini ko'rsatadi; env — zaxira.
- **Manage subscription** tugmasi Paddle **customer portal** sessiyasini ochadi
  (`POST /customers/{ctm_…}/portal-sessions`). Buning uchun server env'da
  `PADDLE_API_KEY` bo'lishi kerak (API top-up uchun allaqachon bor). Kalit
  cheklangan bo'lsa, unga **customer portal session write** ruxsatini bering.
  Portalda mijoz kartani yangilaydi, bekor qiladi, cheklarni yuklab oladi.

### 3.6. Sandbox'da sinash

1. Paddle sandbox'da test karta bilan Creator'ga obuna bo'ling (yoki
   **Developer tools → Simulations** → "Subscription created" stsenariysi).
2. Tekshiring:

```sql
select plan_id, status, current_period_end, cancel_at_period_end
  from subscriptions order by updated_at desc limit 5;
select org_id, source, amount, remaining, held, expires_at
  from credit_lots order by id desc limit 10;
select event_type, status, detail from payment_events order by received_at desc limit 10;
```

   `credit_lots` da `source = subscription`, `amount = 2000`,
   `expires_at` = davr oxiri bo'lishi kerak.
3. Simulyatorda "Subscription renewed" — yangi lot, eskisi `expire` bo'ladi.
4. Bir xil hodisani **Replay** qiling — kredit ikkinchi marta qo'shilmaydi
   (`payment_events.status = duplicate`).
5. Refund (Paddle → Transactions → Refund) — kreditlar o'sha lotdan olinadi.

### 3.7. Production

Sandbox'dagi 3.2–3.5 ni **live** akkauntda takrorlang (price id'lar boshqa!),
`NEXT_PUBLIC_PADDLE_ENV=production`, live token, live secret'lar.

## 4. Sozlash (SQL, platforma owner/admin)

```sql
-- Oylik kredit miqdori
update plans set monthly_credits = 2500 where id = 'creator';
-- Parallel ishlar
update plan_entitlements set value = '3' where plan_id = 'pro' and key = 'concurrency';
-- Paket amal qilish muddati (faqat yangi paketlarga ta'sir qiladi)
update credit_lot_policies set valid_months = 12 where source = 'pack';
-- Tarifni sahifadan yashirish (mavjud obunachilar qoladi)
update plans set is_public = false where id = 'studio';
```

`plan_entitlements.value` turi `entitlement_keys.value_type` ga mos bo'lishi
shart (`bool` → `true`/`false`, `int` → butun son, `tier` →
`"none"|"basic"|"premium"|"all"`); noto'g'ri tur — baza rad etadi.

## 5. Kuzatish

```sql
-- Hisob va lotlar mosligi (0 qator bo'lishi kerak)
select a.org_id, a.balance, a.reserved, sum(l.remaining), sum(l.held)
  from credit_accounts a left join credit_lots l on l.org_id = a.org_id
 group by a.org_id, a.balance, a.reserved
having a.balance <> coalesce(sum(l.remaining), 0) or a.reserved <> coalesce(sum(l.held), 0);

-- Rad etilgan tarif hodisalari (odam ko'rishi kerak)
select received_at, event_type, detail from payment_events
 where status = 'rejected' and (event_type like 'subscription.%' or detail like '%plan%')
 order by received_at desc;

-- Bu oy yongan kreditlar
select org_id, sum(-amount) from credit_transactions
 where kind = 'expire' and created_at > date_trunc('month', now()) group by org_id;
```

## 6. Cheklovlar (hozircha)

- **Tarifni almashtirish** (Creator → Pro) Paddle customer portal'da yo'q. Hozir:
  bekor qilib, davr oxirida yangisiga obuna bo'lish, yoki Paddle dashboard'dan
  operator o'zgartiradi (proration `prorated_immediately` → mutanosib kredit
  avtomatik qo'shiladi).
- Bitta tranzaksiyada ikki xil tarif yoki tarif + paket — `rejected` (odam hal
  qiladi).
- Trial davri kredit bermaydi (faqat to'langan tranzaksiya kredit beradi).
- `planned` imkoniyatlar sahifada ko'rsatilmaydi, hech narsani cheklamaydi.
