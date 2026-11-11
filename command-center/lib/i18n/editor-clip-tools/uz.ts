import type { ClipToolsDictionary } from "./en";

/**
 * Tahrirchidagi klip vositalari: eksport kadr tezligi, klip ovozining balandligi, «ovozni ajratish»,
 * klipni nusxalash, koʻchirish va qoʻyish. Manba — ./en.ts.
 * QORALAMA: ona tili egasi koʻrib chiqishi kerak.
 */
export const clipToolsUz: ClipToolsDictionary = {
  fps: {
    legend: "Kadr tezligi",
    value: "{fps} kadr/s",
    hint: "Butun videoning sekundiga kadrlar soni. 60 tez harakatda silliqroq, eksport esa taxminan ikki baravar uzoq davom etadi; 24 va 25 kino va televideniyega oʻxshaydi.",
    other: "Loyiha sekundiga {fps} kadrda, bu tezlik roʻyxatda yoʻq. Baribir shu tezlikda eksport qilinadi.",
  },
  volume: {
    label: "Ovoz balandligi",
    value: "{pct}%",
    hint: "0% — jimlik, 100% — yozilgandek ovoz, 200% — taxminan ikki baravar baland. Klip ovozini oʻchirish uchun yuqoridagi «ovoz» belgisini olib tashlang.",
  },
  detach: {
    button: "Ovozni ajratish",
    done: "Klip ovozi endi alohida ovoz. Uni istalgan ovoz kabi siljiting, qirqing yoki oʻchiring; video klip ovozsiz.",
    no_sound: "Avval klip ovozini yoqing.",
    not_video: "Rasmda ajratiladigan ovoz yoʻq.",
    retimed: "Faqat oddiy tezlikda, oldinga oʻynaydigan klip ovozini ajratish mumkin: ovozning tezligi va yoʻnalishi yoʻq.",
    sounds_full: "Loyihada allaqachon {max} ta ovoz bor. Buni ajratish uchun bittasini oʻchiring.",
  },
  clipboard: {
    group: "Bu klip nusxasi",
    duplicate: "Takrorlash",
    copy: "Nusxa olish",
    paste: "Shu klipdan keyin qoʻyish",
    copied: "Klipdan nusxa olindi. Klipni tanlang va nusxani undan keyin qoʻying.",
    full: "Videoda allaqachon {max} ta klip bor.",
    hint: "Nusxa klipning barcha sozlamalarini saqlaydi va oldingi klipdan keyin oddiy kesish bilan keladi.",
    scDuplicate: "Tanlangan klipni takrorlash",
    scCopy: "Tanlangan klipdan nusxa olish",
    scPaste: "Nusxalangan klipni tanlangandan keyin qoʻyish",
  },
};
