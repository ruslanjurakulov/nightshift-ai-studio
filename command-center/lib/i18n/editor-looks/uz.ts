import type { looksEn } from "./en";

/** Tahrirchidagi oʻtish uslublari va matn koʻrinishi. Manba — ./en.ts. */
export const looksUz: typeof looksEn = {
  styleLegend: "Oʻtish uslubi",
  styleHint:
    "Oldingi klip bunga qanday aylanadi. Koʻrib chiqishda klipler birma-bir chiqadi va oʻtish ijro etilmaydi; tayyor videoda u bor.",
  styleChosen: "Oʻtish uslubi: {name}.",
  styles: {
    fade: "Silliq soʻnish",
    dissolve: "Donador erish",
    fadeblack: "Qora orqali",
    fadewhite: "Oq orqali",
    wipeleft: "Chapga parda",
    wiperight: "Oʻngga parda",
    slideleft: "Chapga surilish",
    slideright: "Oʻngga surilish",
    slideup: "Yuqoriga surilish",
    slidedown: "Pastga surilish",
    circleopen: "Doira ochiladi",
    circleclose: "Doira yopiladi",
    radial: "Aylana parda",
    zoomin: "Yaqinlashish",
  },
  lookLegend: "Matn koʻrinishi",
  lookHint:
    "Koʻrinish shu matnning shrifti, oʻlchami, rangi, konturi, soyasi, fon qutisi va joyini bir qadamda belgilaydi. Keyin istalganini oʻzgartirish mumkin. Kontur, soya va quti tayyor videoda chiziladi; koʻrib chiqishda ular taxminan koʻrsatiladi.",
  lookSample: "Aa",
  looks: {
    title: "Sarlavha",
    lower_third: "Pastki lavha",
    caption: "Qalin izoh",
    subtitle: "Subtitr",
    outline: "Konturli",
    shadow: "Soyali",
    label: "Yorliq",
    highlight: "Ajratilgan",
  },
  lookNone: "Oʻzimniki",
  lookCurrent: "Hozir: {name}.",
};
