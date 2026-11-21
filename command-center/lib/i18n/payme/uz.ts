import type { PaymeDictionary } from "./en";

/** Payme orqali kredit sotib olish (Uzcard/Humo). Manba — ./en.ts. */
export const paymeUz: PaymeDictionary = {
  title: "Uzcard yoki Humo bilan to‘lash",
  lead: "Payme orqali to‘ldiring. Siz Payme sahifasida so‘mda to‘laysiz, karta ma’lumotlari faqat Payme’ga boradi. Kreditlar Payme to‘lovni tasdiqlaganda qo‘shiladi.",
  testMode: "Payme test rejimi · haqiqiy pul yechilmaydi",
  credits: "{credits} kredit",
  buy: "Payme orqali {price} to‘lash",
  opening: "Payme ochilmoqda…",
  returned: "Payme’dan qaytdingiz. To‘lov o‘tgan bo‘lsa, kreditlar bir daqiqa ichida shu yerda paydo bo‘ladi.",
  failed: "Payme’ni ochib bo‘lmadi. Qayta urinib ko‘ring.",
  tooMany: "Bugun juda ko‘p to‘lov ochildi. Ertaga qayta urinib ko‘ring.",
  notOnSale: "Bu paket hozir Payme orqali sotilmaydi.",
};
