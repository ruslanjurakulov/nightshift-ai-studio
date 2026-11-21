# Nightshift: tezlik, o'z serverimiz va SaaS yo'l xaritasi

2026-09-25 holatiga ko'ra. Bu reja "Vercel'dan chiqish, credits, landing page" g'oyalarini
**mavjud kodni saqlagan holda**, bosqichma-bosqich amalga oshirish uchun.

## Hozirgi holat (o'lchangan)

| Render benchmark (3 daq 15 s video) | ffmpeg (#218, Ken Burns + so'z subtitr) | ffmpeg (#218 dan oldin) | MoviePy |
|---|---|---|---|
| Render | 589 s (≈3.0× realtime) | 427 s | 1364 s |
| Tizim xotirasi (eng ko'p) | 3.85 GB | 3.85 GB | 13.1 GB |
| Fayl hajmi | 215.5 MB | 50.2 MB | 212.8 MB |

- RAM muammo emas; vaqtning ≈80% render bosqichida.
- Sekinlikning katta qismi encode emas, **CPU filtrlar** (Ken Burns `zoompan`, ASS subtitr).
  GPU/NVENC faqat encode'ni tezlashtiradi, shuning uchun birinchi navbatda bo'sh CPU yadrolaridan
  foydalanamiz (segmentlarni parallel render).
- Render **GitHub Actions**'da ishlaydi, Vercel'da emas. Vercel faqat Command Center UI.
- Supabase allaqachon Postgres + Auth + Storage + RLS — uni saqlaymiz.

## SaaS'ga o'tishdagi asosiy to'siqlar

1. **YouTube OAuth verification.** Mijozlar kanaliga yuklash uchun Google `youtube.upload`
   scope'ini tekshiruvdan (va xavfsizlik auditidan) o'tkazish kerak. Bir necha hafta/oy davom etadi.
2. **YouTube monetizatsiya siyosati.** Ommaviy, takroriy AI kontent monetizatsiyadan chiqarilishi
   mumkin — mahsulot sifat va originallikka tayanishi shart (publish gate, originality, QC shu uchun).
3. **To'lov.** O'zbekistondan global SaaS uchun Merchant-of-Record (Paddle / Lemon Squeezy) yoki
   mahalliy Payme/Click. Karta ma'lumotini biz hech qachon saqlamaymiz.
4. **Multi-tenant xavfsizlik.** Hozir tizim bitta operator uchun; mijozlar ma'lumoti, API kalitlari
   va kanallari bir-biridan to'liq ajratilishi kerak.

## Bosqichlar

### A — Hozir, joriy arxitekturada
1. `CHRONOS_RENDER_BACKEND=ffmpeg` (GitHub Variables).
2. Render tezligi: bosqichma-bosqich vaqt o'lchovi, segmentlarni parallel render, bitta sifatli encode.
   Maqsad ≈1.5× realtime.
3. GitHub Actions'ni Node 24 versiyalariga ko'tarish.
4. Real narx jadvali: `video_costs` (cost ledger) + Billing sahifasidan "1 video = $X" — credits narxining asosi.

### B — Pipeline worker'ni VPS'ga ko'chirish (eng katta foyda)
- Bitta VPS (8 vCPU / 16–32 GB) + Docker, faqat pipeline worker.
- Navbat = Supabase jadvali (`render_jobs`, `select … for update skip locked`); Redis shart emas.
- Command Center "Run now" Actions o'rniga shu navbatga yozadi.
- Foyda: 6 soatlik Actions limiti yo'q, `output/` saqlanadi, 24/7 avtonom rejim.
- Vercel va Supabase qoladi. Vercel'dan chiqish (Next.js standalone Docker) — keyinroq, alohida qadam.

### C — SaaS poydevori
- `organizations` + har jadvalda RLS; har mijozning o'z YouTube OAuth'i.
- Credits: `credit_accounts`, `credit_transactions` (audit), narx = real cost × margin;
  generatsiyadan oldin taxminiy narx (pre-flight budget preview allaqachon bor).
- To'lov webhook'i → credits. Google OAuth verification arizasini erta boshlash.

### D — UX va marketing
- Public landing + pricing, onboarding, Studio wizard
  (Idea → Strategy → Script → Visuals → Voice → Captions → Render → Publish), credit balansi tepada.
- Mavjud sahifalar (Storyboard, Billing, Analytics, Autopilot) Studio ichida qayta ishlatiladi.

## Qaror kutilayotgan savollar
- SaaS (C) hozirmi yoki avval o'z kanallarida natija olgandan keyinmi?
- VPS provayderi va oylik byudjet.
