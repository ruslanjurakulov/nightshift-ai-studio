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
  reported: "{n}%",
  reportedSpoken: "{n}% bajarildi — model maʼlumotiga koʻra.",
  seconds: "{n} s",
  minutes: "{m} daq {s} s",
  elapsedSpoken: "Boshlanganiga {n} soniya boʻldi. Taxmin yoʻq: bu modelning shu yerda tugagan ishlari 3 tadan kam.",
  waitingSpoken: "{n} soniyadan beri navbatda.",
};
