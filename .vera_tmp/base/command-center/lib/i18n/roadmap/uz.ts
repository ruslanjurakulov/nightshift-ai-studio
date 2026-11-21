import type { RoadmapDictionary } from "./en";

/**
 * Ommaviy /roadmap sahifasi («Kutilayotgan yangiliklar»). BU — ASOSIY MATN: egasi tasdiqlagan (2026-11-11). en.ts va
 * ru.ts shu matnning tarjimasi. Tasdiqlangan matndan faqat ikki farq bor, ikkalasi ham repo testlari uchun
 * (tests/roadmap-page.test.tsx ularni sanab chiqadi): «Eng kuchli» → «Kuchli va zamonaviy» (taqiqlangan «eng kuchli» ustunlik
 * darajasi) va API dan keyingi qoʻshimcha oddiy apostrof oʻrniga U+2019 bilan yozildi.
 */
export const roadmapUz: RoadmapDictionary = {
  meta: {
    title: "Kutilayotgan yangiliklar · Nightshift",
    description:
      "Professional video muharrir, kuchli va zamonaviy video AI modellar, rasm, ovoz va musiqa, reklama fabrikasi va ijtimoiy tarmoqlarga joylash.",
  },
  title: "Kutilayotgan yangiliklar",
  items: [
    {
      id: "editor",
      title: "Professional video editor",
      body: "koʻp qatlamli vaqt chizigʻi, effektlar va animatsiyalar, ritmga moslash, rang va maskalar, jimlikni avtomatik kesish, subtitrlar, ovoz yozish, 4K eksport",
    },
    {
      id: "videoModels",
      title: "Kuchli va zamonaviy video AI modellar",
      body: "matndan va rasmdan video, videoni tahrirlash, qahramonni almashtirish, har biri oʻz yaratuvchisining API’si orqali",
    },
    { id: "create", title: "Rasm, ovoz va musiqa yaratish" },
    { id: "ads", title: "Reklama fabrikasi", body: "saytingizni skanerlab brendingizga mos reklama tayyorlash" },
    { id: "gallery", title: "Namunalar galereyasi", body: "har bir model natijasini koʻrib, bir tugma bilan sinab koʻrish" },
    {
      id: "social",
      title: "Ijtimoiy tarmoqlarga avtomatik joylash",
      body: "tayyor videoni studiyadan chiqmasdan YouTube, Instagram va boshqa ijtimoiy tarmoqlarga sizning roziligingiz bilan yuborish va vaqtini rejalashtirish.",
    },
  ],
  closing: {
    title: "Hammasi bitta studiyada.",
    body: "NIGHTSHIFT siz uchun hammasini bir joyga yigʻadi.",
    soon: "Tez orada.",
  },
  footer: "Kutilayotgan yangiliklar",
};
