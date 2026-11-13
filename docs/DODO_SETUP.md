# Dodo Payments orqali sotish (Paddle o'rniga)

Egasining qarori (2026-11-12): to'lovlar **Dodo Payments** orqali olinadi — u ham
Merchant of Record (soliq, chek, qaytarish Dodo zimmasida). Paddle akkauntni rad etdi.

Bu PR integratsiyani **o'chirilgan holda** qo'shadi. `PAYMENTS_PROVIDER` o'zgaruvchisi
bo'sh (yoki `paddle`) ekan, sayt **aynan hozirgidek** Paddle orqali ishlaydi — bitta sahifa,
bitta tugma, bitta so'rov o'zgarmaydi (testlar shuni tekshiradi). Dodo faqat siz quyidagi
qadamlarni bajarib, `PAYMENTS_PROVIDER=dodo` qilganingizda yoqiladi.

Hamma fakt Dodo'ning rasmiy hujjatlaridan (docs.dodopayments.com, 2026-11-12 da o'qildi);
manzillar oxirgi bo'limda. Hujjatda yo'q narsa — "Ochiq savollar" bo'limida, taxmin qilinmagan.

## Qanday ishlaydi

```
Credits sahifasi (owner/admin)      Bizning server                    Dodo Payments              Supabase
───────────────────────────────     ──────────────                    ─────────────              ────────
"Sotib olish" (paket yoki tarif) ─► POST /api/billing/dodo/checkout
                                    1. PAYMENTS_PROVIDER = dodo?
                                    2. kirgan, owner/admin, operator emas
                                    3. bizning id ("starter", "pro")
                                       → Dodo product id (env'dan)
                                    4. POST /checkouts (API key faqat
                                       serverda), metadata {org_id,
                                       user_id}, chegirma va valyuta
                                       tanlash o'chiq, tarifda trial 0  ─► hosted checkout
brauzer Dodo sahifasiga o'tadi ◄──── checkout_url                        (karta faqat Dodo'da)
                                                                           │
                                                          payment.succeeded, subscription.*,
                                                          refund.succeeded, dispute.*  ──► Edge Function dodo-webhook
                                                          (webhook-id / -timestamp /         1. imzo (HMAC-SHA256, ±5 daqiqa)
                                                           -signature)                       2. webhook-id → bir marta
                                                                                             3. ruxsat ro'yxatidagi hodisa
                                                                                             4. mahsulot + summa + USD = katalog
                                                                                             5. Paddle'dagi AYNAN o'sha DB
                                                                                                funksiyalari (kredit / qaytarish)
Credits sahifasi ?dodo=return bilan qaytadi, balans o'sguncha har 3 soniyada yangilanadi ◄──────────┘
```

Qoidalar (Paddle'dagi bilan bir xil):

- **Karta ma'lumoti bizga kelmaydi** — Dodo'ning o'z sahifasida kiritiladi.
- **Miqdorni brauzer belgilamaydi.** Brauzer faqat bizning id'ni aytadi (`starter`, `pro`).
  Qaysi Dodo mahsuloti — serverdagi env; nechta kredit — koddagi katalog; to'langan summa
  katalog narxiga teng bo'lmasa (USD'da, soliqsiz yoki soliq ichida) — kredit **berilmaydi**,
  hodisa `rejected` bo'lib yoziladi (pul olingan — odam hal qiladi).
- **Kreditlar Paddle'dagi funksiyalar orqali**: paket — `add_purchased_credits`, tarif davri —
  `grant_subscription_credits_for('dodo', …)` (0144, 0034'ning o'sha tanasi), qaytarish va
  yutqazilgan nizo — `refund_purchased_credits`. Ledger, lotlar, yonish, idempotentlik — bir xil.
- **Service key Command Center'da yo'q.** Webhook Supabase Edge Function'da ishlaydi.
- **Dodo API key faqat serverda** (GitHub secret → serverning `.env.web`), brauzerga hech qachon.
- **"Kim to'layapti" imzolanadi.** Server checkout metadata'siga `{org_id, user_id, item}` ni
  `DODO_METADATA_SECRET` bilan imzolab qo'yadi (`ns_nonce`, `ns_sig` — HMAC-SHA256). Dodo'ning
  statik to'lov havolalari URL'dagi `metadata_*` ni qabul qiladi — ya'ni imzosiz metadata'ni
  istalgan odam yoza oladi. Webhook imzosi tekshirilmagan metadata bo'yicha hech qaysi tashkilotga
  kredit, tarif yoki portal bermaydi. Imzodagi `ns_nonce` ni baza har bir checkout uchun beradi
  (`dodo_checkout_nonces`, 0144) va webhook uni **bir marta** sarflaydi — bitta paket to'lovi yoki
  bitta yangi obuna uchun: imzolangan metadata statik havolada qayta ishlatilsa, `rejected`.
  Manage subscription portali faqat Dodo mijozining email'i kirgan foydalanuvchining email'iga
  teng bo'lsa ochiladi.
- **Test mode — faqat ruxsat ro'yxatidagi tashkilotlar.** Test karta (4242…) ochiq. Production
  bazasida test mode faqat `DODO_TEST_ORG_IDS` dagi test ish maydonlariga sotadi va kreditlaydi;
  boshqa hech bir mijoz test to'lov bilan kredit yoki tarif ololmaydi (checkout ham, webhook ham
  rad etadi).

### Katalog

Narx va kredit **kodda** (`supabase/functions/_shared/dodo.ts` va `command-center/lib/dodo.ts`;
test ikkalasi bir xilligini va Paddle paketlari bilan bir xilligini tekshiradi). Dodo'da
mahsulot narxini aynan shunday qo'ying — boshqa narxda to'langan xarid kredit olmaydi.

| Nima | Kredit | Narx (USD) | Turi | Dodo product id qayerga |
| :-- | --: | --: | :-- | :-- |
| Starter | 1 000 | 10 | One-time | `DODO_PRODUCT_STARTER` |
| Creator | 5 000 | 45 | One-time | `DODO_PRODUCT_CREATOR` |
| Studio | 20 000 | 160 | One-time | `DODO_PRODUCT_STUDIO` |
| Plus (`creator`) | 2 000 / oy | 19 / oy | Subscription, har 1 oy | `DODO_PLAN_CREATOR` |
| Pro (`pro`) | 6 000 / oy | 49 / oy | Subscription, har 1 oy | `DODO_PLAN_PRO` |
| Business (`studio`) | 18 000 / oy | 129 / oy | Subscription, har 1 oy | `DODO_PLAN_STUDIO` |

Tarif kreditlari bazadan (`plans.monthly_credits`), narxi koddan. Product id'lar **hech
qachon kodda emas** — har biri ikki joyda turadi va ikkalasida bir xil bo'lishi shart:
GitHub **variable** (sahifa va checkout uchun) va Supabase **secret** (webhook uchun).
Bo'sh qoldirilgan mahsulot sotilmaydi.

Narxni o'zgartirmoqchi bo'lsangiz: avval kod (ikkala katalog, PR), keyin Dodo'dagi narx.

---

## 0. Yoqishdan oldin (muhim)

1. **Huquqiy matn.** `/terms` (8-bo'lim), `/privacy` (provayderlar jadvali) va `/refund` hozir
   **Paddle**ni Merchant of Record deb ataydi. Bu PR ularni o'zgartirmaydi (yurist ko'radigan
   matn). `PAYMENTS_PROVIDER=dodo` qilishdan oldin ular Dodo'ni nomlashi kerak — alohida PR
   (#700, Terms 6, shu nomlashni ham ko'rib chiqmoqda).
   `/pricing`, landing FAQ va Credits sahifasi Dodo yoqilganda o'zi Dodo'ni nomlaydi.
2. **Marja hisoboti (0063) va operatorning Customers sahifasi (0138)** to'langan summani faqat
   Paddle qatorlaridan o'qiydi: Dodo to'lovi u yerda "noma'lum / hisoblanmagan" bo'lib turadi,
   keyingi migratsiyagacha. Kreditlar va ledger bunga bog'liq emas.
3. **API balansi (Developers → top-up)** — Paddle'ning ixtiyoriy summali tranzaksiyasi; Dodo'da
   hozircha muqobili yo'q. `PAYMENTS_PROVIDER=dodo` bo'lsa top-up "hali mavjud emas" deydi.
4. **Paddle obunachilari** (agar bo'lsa) Paddle'da qoladi: Manage subscription ularga Paddle
   portalini ochadi. Karta bir MoR'dan boshqasiga ko'chmaydi.
5. Avval hammasi **test mode**'da (pul yurmaydi), keyin live.

## 1. Bazani tayyorlash — 0144 migratsiyasi (bir marta)

0021 va 0034 qo'llangan bo'lishi kerak. Supabase → **SQL Editor** →
`supabase/migrations/0144_dodo_payments.sql` ning butun matni → **Run** (bitta tranzaksiya).
Qayta ishga tushirish xavfsiz. 0144 Paddle uchun hech narsani o'zgartirmaydi va hech qanday
qator yozmaydi.

Oldin va keyin tekshiruv (faqat o'qiydi):

```sql
select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
 where proname in ('upsert_subscription', 'grant_subscription_credits', 'upsert_subscription_for', 'grant_subscription_credits_for');
```

| Funksiya | Oldin (0034) | Keyin (0144) |
| :-- | :-- | :-- |
| `upsert_subscription` | `60ee6ad3764dbcf6762b178f8240d5a9` | `09185a96a8fb02f0c2641095d51461cc` |
| `grant_subscription_credits` | `7947d46697f1c35d12274ffbe22709ac` | `fd0c1c169a4d3b2d05c6d826c6fe10ff` |
| `upsert_subscription_for` | — | `9f9b399ce3ca3421d1ccb32c4075d6ea` |
| `grant_subscription_credits_for` | — | `5424905376fab9ff1b4c229c5dc0c0ce` |
| `dodo_issue_checkout_nonce` | — | `ddfe1dc46a18fe7df7823eb09ffbe88f` |
| `dodo_consume_checkout_nonce` | — | `08a15f9281430963565060ac12532b78` |

Faylning oxiridagi "Verify" so'rovi — hamma ustun `true`. Orqaga qaytarish:
`docs/sql/rollback_0144_dodo_payments.sql` (Dodo qatori bor ekan, rad etadi).

## 2. Dodo akkaunti: test mode

Dodo dashboard'ida chap paneldagi **Live Mode** kaliti o'chiq (test mode) bo'lsin. Test va live
mode'ning API key'lari, mahsulotlari va webhook'lari **alohida** — live'ga o'tganda hammasi
qaytadan (yoki "copy to live mode") qilinadi va id'lar boshqacha bo'ladi.

### Sozlamalar (Settings → Subscriptions)

- **Allow Cancellation at Next Billing Date** — yoqiq (mijoz bekor qilsa, to'langan davr oxirigacha
  tarif ishlaydi — Paddle'dagi kabi).
- **Allow Immediate Cancellation** — **o'chiring** (darhol bekor qilish tarifni davr o'rtasida
  to'xtatadi; davr kreditlari lot muddatigacha qoladi, lekin imkoniyatlar yo'qoladi).
- **Allow Subscription Updates** — ⚠️ **O'CHIQ BO'LISHI SHART** va tariflarni **Product
  Collection**'ga **qo'shmang**. Yoqilsa, mijoz portalda tarifni o'zi almashtiradi: Dodo pro-rata
  pul oladi, webhook esa bu `plan_change` to'lovini **kreditlamaydi** (`rejected`, qo'lda `grant`
  kerak bo'ladi) — har bir almashtirish odam ishi. Bu sozlamani yoqmang, avval kod o'zgarishi kerak.
- **Allow Subscription Pause** — o'chiq (standart).
- **Adaptive Currency** — **o'chiq**: webhook faqat USD to'lovni kreditlaydi; mahalliy valyutada
  to'langan xarid `rejected` bo'ladi.

### Mahsulotlar (Products → Create product)

Har biri uchun (6 ta, yuqoridagi katalog jadvali):

- Narx: **USD**, katalogdagi summa aniq (`10.00`, `45.00`, `160.00`, `19.00`, `49.00`, `129.00`).
- Paketlar: **One-Time**. Tariflar: **Subscription**, *Repeat every* **1 month**,
  *Trial days* **0**, *subscription period* **20 years** (Dodo tavsiyasi: davr = to'lov chastotasi
  bo'lsa obuna bitta to'lovdan keyin tugaydi).
- Soliq: Dodo'ning SaaS / raqamli mahsulot soliq toifasi. Narx soliq **ichida** (`inclusive`) yoki
  **ustida** (`exclusive`) — **bittasini** tanlang, hamma 6 mahsulotga bir xil qo'llang va o'shani
  Supabase secret `DODO_TAX_MODE` ga yozing (4-band). Webhook faqat shu shaklni qabul qiladi:
  `inclusive` — to'langan summa = narx; `exclusive` — summa − soliq = narx. Boshqasi `rejected`.
- Pay What You Want, chegirma, chegirma kodi — yo'q (checkout chegirma kodini o'chiradi; chegirma
  bilan kelgan to'lov `rejected`).
- Mahsulot sahifasidan `pdt_…` id'ni nusxalang.

## 3. API key (test mode)

**Developer → API Keys → Create New Key** (test mode'da, kalit `dodo_test_…` bilan boshlanadi).
Faqat keraklisini bering: checkout session yaratish va customer portal sessiyasi uchun
(Payments/Checkout **Write**, Customers **Write**; aniq ruxsat nomlari — ochiq savol, 3-band).
**IP Allowlist**'ga serveringiz IP'sini yozsangiz, kalit boshqa joydan ishlamaydi.

Kalitni chatga, git'ga, log'ga — hech qachon. Faqat GitHub secret'iga:

GitHub → Settings → Environments → **production**:

| Nomi | Turi | Qiymat |
| :-- | :-- | :-- |
| `DODO_PAYMENTS_API_KEY` | **Secret** | 3-banddagi kalit |
| `DODO_METADATA_SECRET` | **Secret** | 32+ belgili tasodifiy qator (masalan `openssl rand -hex 32`); **aynan shu qiymat** Supabase secret'iga ham (4-band) |
| `DODO_TEST_ORG_IDS` | Variable | test mode'da sotib olishi mumkin bo'lgan **sizning test** tashkilot(lar)ingiz uuid'lari, vergul bilan. Live'da e'tiborga olinmaydi |
| `DODO_PAYMENTS_ENV` | Variable | `test` (live'da `live`) |
| `DODO_PRODUCT_STARTER`, `DODO_PRODUCT_CREATOR`, `DODO_PRODUCT_STUDIO` | Variable | paketlarning `pdt_…` id'lari |
| `DODO_PLAN_CREATOR`, `DODO_PLAN_PRO`, `DODO_PLAN_STUDIO` | Variable | tariflarning `pdt_…` id'lari |
| `PAYMENTS_PROVIDER` | Variable | **hozircha qo'ymang** (6-band) |

Kalit rejimi `DODO_PAYMENTS_ENV` ga mos bo'lishi shart (`test` ↔ `dodo_test_…`, `live` ↔
`dodo_live_…`); mos kelmasa Dodo sotuvi o'chadi — yarim yo'lda qolgan live'ga o'tish noto'g'ri
checkout'ni ochmasligi uchun.

## 4. Webhook: Edge Function

```bash
cd nightshift-ai-studio
supabase login
supabase functions deploy dodo-webhook --no-verify-jwt --project-ref <REF>
```

`--no-verify-jwt` **majburiy**: Dodo Supabase JWT yubormaydi, o'z imzosini yuboradi (Standard
Webhooks), funksiya o'shani tekshiradi. Manzil:

```
https://<REF>.supabase.co/functions/v1/dodo-webhook
```

### Dodo'da webhook endpoint

**Developer → Webhooks → Add endpoint** (test mode'da):

- URL: yuqoridagi manzil.
- Hodisalar (faqat shular kerak; boshqasi kelsa ham zarari yo'q — 200 va `ignored`):
  - `payment.succeeded`
  - `refund.succeeded`
  - `dispute.accepted`, `dispute.lost`, `dispute.expired`
  - `subscription.active`, `subscription.updated`, `subscription.renewed`,
    `subscription.plan_changed`, `subscription.past_due`, `subscription.on_hold`,
    `subscription.paused`, `subscription.unpaused`, `subscription.cancelled`,
    `subscription.expired`
- Saqlagandan keyin endpoint'ning **Signing secret**'ini (`whsec_…`) oching.

### Secret'larni Supabase'ga qo'yish

Shell tarixida qolmasligi uchun fayl orqali:

```bash
cat > /tmp/dodo.env <<'EOF'
DODO_WEBHOOK_SECRET=whsec_...
DODO_METADATA_SECRET=<GitHub secret'idagi bilan aynan bir xil>
DODO_TAX_MODE=exclusive
DODO_WEBHOOK_MODE=test
DODO_TEST_ORG_IDS=<test tashkilot uuid>,<yana biri>
DODO_PRODUCT_STARTER=pdt_...
DODO_PRODUCT_CREATOR=pdt_...
DODO_PRODUCT_STUDIO=pdt_...
DODO_PLAN_CREATOR=pdt_...
DODO_PLAN_PRO=pdt_...
DODO_PLAN_STUDIO=pdt_...
EOF
supabase secrets set --env-file /tmp/dodo.env --project-ref <REF>
rm /tmp/dodo.env
supabase secrets list --project-ref <REF>    # faqat nomlar
```

- `DODO_TAX_MODE` — `inclusive` yoki `exclusive` (2-banddagi tanlov). Bo'sh bo'lsa webhook har bir
  so'rovga 500 qaytaradi (Dodo qayta yuboradi), hech narsa kreditlanmaydi.
- `DODO_METADATA_SECRET` — bo'sh yoki GitHub'dagidan farqli bo'lsa: 500 / `rejected`, kredit yo'q.
- `DODO_WEBHOOK_MODE` — aynan `live` bo'lmaguncha **test**: faqat `DODO_TEST_ORG_IDS` dagi
  tashkilotlar kreditlanadi. ⚠️ U **har doim** Command Center'dagi `DODO_PAYMENTS_ENV` ga mos
  bo'lsin (`test` ↔ `test`, `live` ↔ `live`): live checkout + test webhook = haqiqiy to'lovlar
  kreditlanmaydi; test checkout + live webhook = test karta haqiqiy kredit beradi.
- Bu ikki secret bo'lmasa ham refund, nizo va obunani bekor qilish ishlayveradi — faqat kredit
  yoki tarif **beradigan** hodisalar kutadi (500, Dodo qayta yuboradi).

`SUPABASE_URL` va `SUPABASE_SERVICE_ROLE_KEY` ni qo'ymang — Supabase o'zi beradi.
Product id'lar GitHub variable'laridagi bilan **bir xil** bo'lsin: webhook'da yo'q mahsulot
bilan to'langan xarid `rejected` bo'ladi.

Secret almashtirish: endpoint → **Rotate secret**; eski secret 24 soat ishlaydi, shu vaqt ichida
yangisini `supabase secrets set DODO_WEBHOOK_SECRET=…` qiling.

## 5. Webhook'ni tekshirish (hali yoqmasdan)

Dodo → endpoint → **Testing** → hodisani tanlang → **Send example**. Namuna begona id'lar
bilan keladi, shuning uchun kutilgan natija: Dodo'da **200**, bazada `rejected` yoki `ignored`
qatori (imzo va manzil to'g'ri ekanini ko'rsatadi):

```sql
select event_id, event_type, status, detail, received_at
  from public.payment_events where provider = 'dodo' order by received_at desc limit 20;
```

**401** — `DODO_WEBHOOK_SECRET` noto'g'ri yoki deploy `--no-verify-jwt` siz. **500 "webhook
not configured"** — secret `whsec_…` emas, yoki `DODO_METADATA_SECRET` / `DODO_TAX_MODE` qo'yilmagan.

## 6. Yoqish

GitHub → production → Variable **`PAYMENTS_PROVIDER` = `dodo`** → **Actions → Deploy web →
Run workflow**. (Faqat aynan `dodo` so'zi yoqadi; bo'sh, `paddle` yoki boshqa narsa — Paddle.)
Shundan keyin `/pricing`, landing, Credits va Usage sahifalari Dodo orqali sotadi, Paddle
checkout'i ko'rsatilmaydi. Test mode'da sahifada "Sandbox · test payments only" /
"Test mode · no real charges" belgisi turadi.

> ⚠️ **Production'da test mode faqat ruxsat ro'yxatidagi tashkilotlar uchun.** `DODO_PAYMENTS_ENV=test`
> ekan, Credits'da "Sotib olish" faqat `DODO_TEST_ORG_IDS` dagi tashkilotlarga ko'rinadi; qolgan
> mijozlarga hech narsa sotilmaydi (sahifa "test mode" deydi). Bu ro'yxatga faqat **o'zingizning**
> test ish maydonlaringizni yozing — hech qachon haqiqiy mijozni emas.

## 7. Sinov ro'yxati (test mode)

Test karta: `4242 4242 4242 4242`, muddati `06/32`, CVV `123` (rad etiladigan karta:
`4000 0000 0000 0002`). **`DODO_TEST_ORG_IDS` dagi** test tashkilotda, owner/admin sifatida:

- [ ] **Ro'yxatda yo'q tashkilot.** Boshqa (ro'yxatda yo'q) tashkilotda Credits'da Dodo paneli yo'q,
      "test mode" yozuvi bor.

- [ ] **Paket.** Credits → Starter → Buy → Dodo sahifasi → to'lov. Qaytgach "Payment received…",
      bir necha soniyada balans +1 000; `credit_transactions` da `purchase` qatori
      (`external_id` = `pay_…`), `payment_events` da `processed`. Qaytish `/api/billing/dodo/return`
      orqali o'tadi: manzil satrida `email` yo'q.
- [ ] **Soxta metadata.** Dodo dashboard'dagi statik to'lov havolasi bilan (metadata'siz yoki
      `metadata_org_id=…` bilan) to'lang — `payment_events` da `rejected` ("not this deployment's"),
      kredit yo'q. Refund qiling.
- [ ] **Takror.** Dodo → endpoint → xabarni **Replay** — kredit ikkinchi marta qo'shilmaydi
      (`duplicate`).
- [ ] **Rad etilgan karta** — "Checkout closed. Nothing was charged.", kredit yo'q.
- [ ] **Bekor qilish** (checkout'da orqaga) — xuddi shunday xabar, kredit yo'q.
- [ ] **To'liq refund** (Dodo → Payments → to'lov → Refund) — `refund.succeeded`, ledger'da
      manfiy `refund` qatori, sarflanmagan kredit olinadi.
- [ ] **Qisman refund** (masalan 50%) — kreditning 50% i olinadi.
- [ ] **Tarif.** Credits → Plus → Subscribe → to'lov. Tekshiring:
      `subscriptions` da `provider = 'dodo'`, `plan_id = 'creator'`, `status = 'active'`,
      `provider_customer_id` = `cus_…`; `credit_lots` da `source = 'subscription'`,
      `amount = 2000`, `expires_at` = davr oxiri. **Muhim**: `payment_events` da
      `subscription.active` `processed` bo'lsin (ya'ni obunada `metadata.org_id` keldi —
      ochiq savol 1). `payment.succeeded` birinchi kelsa, u bir marta `failed` (503) bo'lib,
      Dodo qayta yuborganda `processed` bo'ladi — bu kutilgan.
- [ ] **Manage subscription** — Dodo customer portal ochiladi, qaytish havolasi Credits'ga.
- [ ] **Bekor qilish (davr oxirida)** portalda — Credits "Ends {sana}" deydi, tarif davr
      oxirigacha ishlaydi; `cancel_at_period_end = true`.
- [ ] **Yangilanish (ixtiyoriy).** Dodo test mode'da yangilanishni tezlashtirish uchun
      `PATCH /subscriptions/{id}` bilan `next_billing_date` ni bir daqiqa keyinga qo'ying
      (testing-process sahifasi). Yangi davr loti (2 000) paydo bo'ladi, eskisi yonadi.
- [ ] **Monitoring so'rovi** (pastda) bo'sh yoki faqat tushunarli `rejected` qatorlar.

Test obunalarini oxirida bekor qiling (test mode'da ular o'zi yangilanib turadi).

## 8. Live'ga o'tish

0. **Test grant'larini olib tashlang.** Test mode'da berilgan kreditlar va tariflar haqiqiy
   bazada turibdi. Live'dan oldin:
   - Dodo test mode'da har bir test to'lovini **Refund** qiling va har bir test obunasini **bekor
     qiling** — webhook kreditni qaytarib oladi va obunani `canceled` qiladi.
   - Keyin tekshiring — ikkala so'rov ham **0 qator** qaytarishi kerak:

   ```sql
   -- Kreditlari hali olib qo'yilmagan Dodo test to'lovlari
   select t.org_id, t.kind, t.amount, t.external_id
     from public.credit_transactions t
    where t.external_id in (select transaction_id from public.payment_events where provider = 'dodo')
      and t.amount > 0
      and coalesce((select sum(r.taken) from public.credit_refunds r where r.purchase_external_id = t.external_id), 0) < t.amount;
   -- Hali tirik Dodo (test) obunalari
   select org_id, plan_id, status from public.subscriptions
    where provider = 'dodo' and status in ('active', 'trialing', 'past_due', 'paused');
   ```

   Biror qator qolsa: Dodo'da o'sha to'lovni refund qiling (yoki qo'lda `refund_purchased_credits`).
   Shundan keyin `DODO_TEST_ORG_IDS` ni ikkala joydan (GitHub variable va Supabase secret) o'chiring.
1. Dodo'da Live Mode; verifikatsiya va to'lov hisobi tayyor bo'lsin.
2. 2-banddagi sozlamalar va 6 ta mahsulot live'da (yoki test'dan "copy to live mode") — **yangi
   `pdt_…` id'lar**.
3. Live API key (`dodo_live_…`) → GitHub secret `DODO_PAYMENTS_API_KEY`; variable
   `DODO_PAYMENTS_ENV=live`; `DODO_PRODUCT_*` / `DODO_PLAN_*` live id'lar.
4. Live webhook endpoint (xuddi shu funksiya URL'i, shu hodisalar) → yangi `whsec_…` →
   `supabase secrets set` (`DODO_WEBHOOK_SECRET`, live product id'lar va **`DODO_WEBHOOK_MODE=live`**).
   Funksiyani qayta deploy qilish shart emas.
5. Deploy web'ni qayta ishga tushiring. Kichik haqiqiy xarid → ledger → refund.

Bitta funksiya bir vaqtda bitta rejimga xizmat qiladi — secret qaysi endpoint'niki bo'lsa,
o'sha rejimning imzosi o'tadi.

## 9. Orqaga qaytish (rollback)

1. **Sotishni to'xtatish:** GitHub variable `PAYMENTS_PROVIDER` ni o'chiring (yoki `paddle`) →
   Deploy web. Sahifalar darhol Paddle'ga qaytadi; yangi Dodo checkout ochilmaydi.
2. **Mavjud Dodo obunalari Dodo'da yangilanishda davom etadi.** Ular to'lab turgan ekan,
   `dodo-webhook` funksiyasini va endpoint'ni **o'chirmang** — aks holda to'langan davr kredit
   olmaydi. Kerak bo'lsa obunalarni Dodo'da bekor qiling (davr oxirida).
3. Kod: bu PR'ni revert qilish Paddle yo'liga tegmaydi.
4. Baza: `docs/sql/rollback_0144_dodo_payments.sql` — faqat birorta ham `provider = 'dodo'`
   qatori yo'q bo'lsa ishlaydi (aks holda rad etadi). Odatda kerak emas: 1-band yetarli.

## Kuzatish

```sql
-- Odam ko'rishi kerak: pul olingan, kredit berilmagan; yoki Dodo qayta urinyapti
select event_id, event_type, status, detail, org_id, transaction_id, amount_minor, currency, received_at
  from public.payment_events
 where provider = 'dodo' and status in ('rejected', 'failed')
 order by received_at desc;

-- Qaytarishda olib bo'lmagan (sarflangan) kreditlar
select refund_id, purchase_external_id, org_id, reason, requested, taken, shortfall, created_at
  from public.credit_refunds where left(refund_id, 5) = 'dodo_' and shortfall > 0 order by created_at desc;

-- Dodo obunalari
select org_id, plan_id, status, current_period_end, cancel_at_period_end, updated_at
  from public.subscriptions where provider = 'dodo' order by updated_at desc;
```

## Webhook nimani tekshiradi

| Qayerda | Qoida |
| :-- | :-- |
| Har bir so'rov | POST; tana ≤ 1 MB (Paddle bilan bir xil chegara, imzodan oldin o'qiladi); `webhook-id`, `webhook-timestamp`, `webhook-signature` bor; vaqt ±5 daqiqa ichida; `v1,` imzolardan biri `{id}.{timestamp}.{tana}` ning HMAC-SHA256 si (konstant vaqtda solishtiriladi). Aks holda 401, hech narsa yozilmaydi. |
| Takror | `webhook-id` bo'yicha (`payment_events`, provider `dodo`): qayta yuborilgan hodisa hech narsani o'zgartirmaydi. Bitta to'lov ikki xil `webhook-id` bilan kelsa ham — ledger'dagi `external_id` (`pay_…`) bir marta. |
| Ruxsat ro'yxati | Faqat 4-banddagi hodisalar; qolgani `ignored`. |
| Metadata | Tashkilot faqat bizning imzomiz (`ns_sig`, `DODO_METADATA_SECRET`, konstant vaqtda tekshiriladi) bo'lgan metadata'dan olinadi. Imzosiz yoki noto'g'ri imzoli metadata — `rejected`, hech qaysi tashkilot nomlanmaydi. |
| Test mode | `DODO_WEBHOOK_MODE` aynan `live` bo'lmasa, faqat `DODO_TEST_ORG_IDS` dagi tashkilotlarga kredit va tarif; qolgani `rejected`. Qaytarish (refund, nizo) cheklanmaydi. |
| Paket | `status = succeeded`; USD; chegirma yo'q; imzolangan tashkilot; aynan bitta qator, imzolangan paket, soni 1; `DODO_TAX_MODE=inclusive` bo'lsa `total_amount` = katalog narxi, `exclusive` bo'lsa `total_amount − tax` = katalog narxi. Tashkilot mavjud. |
| Tarif davri | Yuqoridagidek, plus: `charge_type` `new` yoki `renewal`; obuna bazada bor (yo'q bo'lsa 503 — Dodo qayta yuboradi), uning tashkiloti metadata'dagiga mos; obuna mahsuloti shu deployment'dagi tarif; summa o'sha tarif narxi; `service_periods` dagi davr. `plan_change` to'lovi — `rejected` (qo'lda). |
| Obuna holati | `active`, `past_due` → imkoniyatlar bor; `on_hold`, `paused` → `paused`; `cancelled`, `expired` → `canceled`; `cancel_at_next_billing_date` → davr oxirida tugaydi. Eskirgan hodisa (vaqt bo'yicha) hech narsani o'zgartirmaydi. |
| Refund | Faqat `succeeded`; to'liq — qolgan hammasi, qisman — pulga mutanosib; xariddan oldin kelsa 503 (qayta). Hech qachon kreditlanganidan ko'p emas (baza cheklaydi). |
| Nizo | `dispute.accepted` / `dispute.lost` — chargeback, summa bo'yicha mutanosib (oldingi qisman refund bilan birga hech qachon kreditlanganidan ko'p emas); Visa RDR (`is_resolved_by_rdr`) — `rejected`, qaytarilmaydi (pul refund sifatida qaytgan; refund hodisasini tekshiring); `dispute.expired` — `rejected` (natijani Dodo'da tekshirib, qo'lda). |

## Muammolar

| Belgi | Sabab | Yechim |
| :-- | :-- | :-- |
| Credits'da Dodo paneli yo'q, "not configured" yozuvi | `DODO_PAYMENTS_API_KEY` yo'q, rejimga mos emas yoki `DODO_PRODUCT_*` bo'sh | 3-band, Deploy web |
| Buy → "Couldn't open the checkout" | Dodo checkout session'ni rad etdi (kalit ruxsati, mahsulot id) | Server log'ida `[dodo-checkout] … HTTP <status>`; kalit va id'larni tekshiring |
| Webhook 401 | Secret noto'g'ri / `--no-verify-jwt` yo'q / server soati | 4-band |
| `rejected: … not a credit pack on this deployment` | Supabase'da `DODO_PRODUCT_*` yo'q yoki boshqa | `supabase secrets set …` |
| `rejected: paid … but the catalog price is …` | Dodo'dagi narx katalogga mos emas | Dodo'da narxni tuzating; bu xaridga qo'lda `grant` yoki refund |
| `rejected: … not in USD` | Adaptive Currency yoqilgan | O'chiring; qo'lda `grant` yoki refund |
| `rejected: … discount` | Chegirma qo'llangan | Qo'lda `grant` yoki refund |
| `failed: subscription not recorded yet` (qolib ketsa) | `subscription.active` kelmayapti yoki unda `metadata.org_id` yo'q | Endpoint hodisalarini tekshiring; ochiq savol 1 |
| `rejected: subscription … names no known organization` | Obuna metadata'sida tashkilot yo'q | Ochiq savol 1; qo'lda `grant` |
| `rejected: … metadata is not this deployment's` | Imzosiz/soxta metadata (statik havola) yoki ikki joydagi `DODO_METADATA_SECRET` farqli | Ikkala secret bir xilmi tekshiring; soxta bo'lsa — refund |
| `rejected: test mode: … not in DODO_TEST_ORG_IDS` | Test mode'da ro'yxatda yo'q tashkilot | Kutilgan himoya; test to'lovini refund qiling |
| Credits'da "test mode … only the test workspaces" | `DODO_PAYMENTS_ENV=test`, tashkilot ro'yxatda yo'q | Kutilgan; live'ga o'ting yoki test tashkilotni ro'yxatga qo'shing |
| `rejected: plan-change charge` | Tarif portal/dashboard orqali almashtirilgan | Mutanosib kreditni qo'lda `grant` qiling |

## Ochiq savollar (hujjatda yo'q — taxmin qilinmadi)

1. **Checkout session'ning `metadata`'si obunaga (`subscription.*` hodisalaridagi
   `data.metadata`) o'tadimi?** Hujjat to'lovga o'tishini aytadi (metadata sahifasi:
   "retrieve the resulting payment"), obuna haqida aytmaydi. O'tmasa, yangi obuna `rejected`
   bo'ladi va kredit berilmaydi (pul xavfsiz, lekin qo'lda ish). 7-banddagi tarif sinovi
   shuni tekshiradi.
2. **Return URL'ga parametr qanday qo'shiladi**, URL'da allaqachon `?` bo'lsa? Hujjat
   `payment_id`, `subscription_id`, `status`, `email` qo'shilishini aytadi, qo'shish usulini
   emas. Sahifa ikkala holatni ham o'qiydi va bu parametrlarni manzil satridan olib tashlaydi.
3. **API key'ning aniq ruxsatlari** (checkout session va customer portal uchun qaysi resurs
   Write bo'lishi kerak) hujjatda yozilmagan.
4. **Nizo `amount` birligi.** Hujjat uni "string" deydi, birligini aytmaydi. Faqat raqamlardan
   iborat qator eng kichik birlik (sent) deb o'qiladi; boshqasi `rejected` (qo'lda).
5. **Visa RDR**: `dispute.lost` + `is_resolved_by_rdr: true` "the refund was issued
   automatically". Webhook bunday nizoni qaytarmaydi (`rejected`), pul refund sifatida qaytgan deb
   hisoblaydi. Alohida `refund.succeeded` keladimi — hujjat aytmaydi: kelmasa, kreditni qo'lda
   oling (monitoring so'rovida ko'rinadi).
9. **Qaytish havolasi.** Dodo qaytishda URL'ga mijozning `email` ini qo'shadi. Sahifa avval
   `/api/billing/dodo/return` ga qaytadi, u faqat bizning parametrlar va `status` ni qoldirib
   Credits'ga yo'naltiradi — email sahifa URL'ida, tarixda va Referer'da qolmaydi. Lekin reverse
   proxy'ning (Caddy) access log'i shu bitta so'rovning query'sini ko'radi; uni yashirish uchun
   Caddyfile'ga `email` query'ni o'chiradigan log filtri kerak (bu PR Caddy'ga tegmaydi).
6. ~~Buyer Terms URL'i~~ — **javob berildi** (egasi, 2026-11-13): https://dodopayments.com/legal/buyer-terms,
   xaridor portali https://customer.dodopayments.com. `/pricing` Dodo yoqilganda shu havolani ko'rsatadi.
7. **Soliq rejimi**: to'lovda mahsulot narxi soliq ichidami yoki ustidami degan maydon yo'q.
   Endi deployment bitta rejimni `DODO_TAX_MODE` bilan qat'iy belgilaydi va webhook faqat o'shani
   qabul qiladi.
8. **Tarif almashtirish** (pro-rata) va **API balansi top-up** Dodo uchun avtomatlashtirilmagan.

## Manbalar (docs.dodopayments.com, 2026-11-12 da o'qildi)

- Webhooks (imzo, sarlavhalar, qayta urinish, idempotentlik, tartib):
  https://docs.dodopayments.com/developer-resources/webhooks
- Hodisalar ro'yxati: https://docs.dodopayments.com/developer-resources/webhooks/intents/webhook-events-guide
- Payload'lar: https://docs.dodopayments.com/developer-resources/webhooks/intents/payment ·
  …/intents/refund · …/intents/dispute · …/intents/subscription
- Checkout session (API): https://docs.dodopayments.com/api-reference/checkout-sessions/create
- Checkout session (qo'llanma, return URL parametrlari): https://docs.dodopayments.com/developer-resources/checkout-session
- Customer portal (API): https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session
- Customer portal (sozlamalar): https://docs.dodopayments.com/features/customer-portal
- Obunalar: https://docs.dodopayments.com/features/subscription
- Mahsulotlar: https://docs.dodopayments.com/features/products
- Refund: https://docs.dodopayments.com/features/transactions/refunds
- Nizolar: https://docs.dodopayments.com/features/transactions/disputes
- Test va live: https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode
- API kirish (kalitlar, hostlar): https://docs.dodopayments.com/api-reference/introduction
- Metadata: https://docs.dodopayments.com/api-reference/metadata
- Test kartalar: https://docs.dodopayments.com/miscellaneous/testing-process
