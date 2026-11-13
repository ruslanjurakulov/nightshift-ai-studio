import type { StudioProgressDictionary } from "./en";

/** Studiyadagi yaratish oʻrinbosari: ish nima qilyapti (uning qatoridan) va belgidagi raqam — taxmin, model maʼlumoti yoki soniyalar. Manba — ./en.ts. */
export const studioProgressUz: StudioProgressDictionary = {
  phase: {
    queued: "Navbatda",
    sending: "Modelga yuborilmoqda",
    making: "Model ishlamoqda",
    storing: "Kutubxonangizga saqlanmoqda",
    done: "Tayyor",
    failed: "Yakunlanmadi",
  },
  coming: "{kind}: tez orada",
  loadingResult: "Tayyor — natija yuklanmoqda",
  estimate: "~{n}%",
  estimateSpoken: "Taxminan {n}% bajarildi. Bu oʻlchov emas: shu yerdagi ushbu modelning oxirgi {count} ta ishi qancha vaqt olganiga qarab chiqarilgan taxmin.",
  seeded: "~{n}% · sinov",
  seededSpoken:
    "Taxminan {n}% bajarildi. Bu shu yerdagi ishlarga emas, ushbu modelning bitta sinov ishga tushirilishiga ({s} s, yuklab olish bilan birga) asoslangan taxmin, oʻlchov emas.",
  seededScaledSpoken:
    "Taxminan {n}% bajarildi. Bu ushbu modelning bitta sinov ishga tushirilishiga asoslangan taxmin: {probe} s lik klip uchun {s} s, vaqt klip uzunligiga qarab oʻsadi degan farazga koʻra {clip} s ga moslab hisoblangan. Shu yerdagi ishlarga asoslanmagan va oʻlchov emas.",
  reported: "{n}%",
  reportedSpoken: "{n}% bajarildi — model maʼlumotiga koʻra.",
  seconds: "{n} s",
  minutes: "{m} daq {s} s",
  elapsedSpoken: "Boshlanganiga {n} soniya boʻldi. Taxmin yoʻq: bu modelning shu yerda tugagan ishlari {min} tadan kam.",
  elapsedUnreadSpoken: "Boshlanganiga {n} soniya boʻldi. Taxmin yoʻq: bu modelning shu yerdagi oldingi ishlari oʻqilmadi.",
  elapsedNotAskedSpoken: "Boshlanganiga {n} soniya boʻldi. Taxmin yoʻq: bir vaqtda shuncha model ishlayotganda faqat {max} tasi tekshiriladi.",
  elapsedNoStartSpoken: "Soʻralganiga {n} soniya boʻldi. Taxmin yoʻq: ish boshlangan vaqt yozilmagan.",
  waitingSpoken: "{n} soniyadan beri navbatda.",
};
