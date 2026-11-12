import type { Parity4Dictionary } from "./en";

/**
 * Muharrirning «gapiruvchi bosh» toʻplami: toza ovoz, soʻzlarni oʻchirish yoki «pip» bilan yopish, matnning harflar
 * oraligʻi, kursiv va qatorlarni tekislash. Manba — ./en.ts. TARJIMA QORALAMASI: ona tilida soʻzlashuvchi tekshirishi kerak.
 */
export const parity4Uz: Parity4Dictionary = {
  settledVoiceClip: "{n}-klip: uning ovozidan toza ovoz olib tashlandi: u bilan videoni eksport qilish ruxsat etilganidan uzoqroq davom etardi.",
  settledVoiceSound: "{n}-ovoz: toza ovoz olib tashlandi: u bilan videoni eksport qilish ruxsat etilganidan uzoqroq davom etardi.",
  voice: {
    toggle: "Toza ovoz",
    hint: "Nutq uchun: gʻuvillash va tarmoq shovqinini olib tashlaydi, fon shovqini va keskin «s» tovushlarini kamaytiradi, baland va past soʻzlarni tenglaydi va balandlikni -16 LUFS ga keltiradi. U shovqinni kamaytirish va balandlikni tenglashni oʻz ichiga oladi, shuning uchun ular oʻchadi.",
    included: "Toza ovoz buni allaqachon oʻz ichiga oladi.",
    previewNote: "Koʻrib chiqishda ovoz yozilganidek eshitiladi; toza ovoz eksportda qoʻllanadi.",
    renderTime:
      "Hozir mavjud emas: u bilan eksport {length} s lik taymlayn uchun taxminan {work} s davom etadi, ruxsat esa {allowed} s. Avval boshqa narsani oʻchiring.",
  },
  bleeps: {
    title: "Soʻzlarni oʻchirish yoki «pip» bilan yopish",
    hint: "Eksport qilingan videoda soʻzni oʻchirish uchun uni bosing, qaytarish uchun yana bosing. Soʻzning vaqti — subtitr vaqti uning soʻzlariga boʻlingan holda, shuning uchun «pip» subtitr vaqti qanchalik aniq boʻlsa, shunchalik aniq: oʻtkazib yuborsa, subtitr boshi yoki oxirini suring.",
    modeLegend: "Yangilari",
    modes: { mute: "Jimlik", tone: "Pip" },
    wordAria: "{word}, {start} s",
    caption: "Subtitr {n}",
    more: "Yana subtitrlarni koʻrsatish",
    listHeading: "Oʻchirilgan: {max} tadan {n} ta",
    range: "{start}–{end} s",
    remove: "Olib tashlash",
    removeAria: "{start} s dagi «pip»ni olib tashlash",
    modeAria: "{start} s dagi «pip»",
    none: "Hozircha hech narsa oʻchirilmagan.",
    full: "Bitta videoda koʻpi bilan {max} ta «pip».",
    noRoom: "Bu yerda joy yoʻq: «pip» keyingisiga tegib ketadi.",
    previewNote: "Koʻrib chiqishda har bir «pip» ustida ovoz oʻchadi; «pip»ning oʻzi eksportda eshitiladi.",
  },
  text: {
    title: "Matn xususiyatlari",
    tracking: "Harflar oraligʻi",
    trackingValue: "{v}",
    italic: "Kursiv",
    alignLegend: "Qatorlarni tekislash",
    alignAuto: "Joylashuvi boʻyicha",
    aligns: { left: "Chapga", center: "Markazga", right: "Oʻngga" },
    alignHint: "Bir necha qatorli matnning qatorlari shunday tekislanadi. Bitta qator joylashgan joyida qoladi.",
    previewNote: "Koʻrib chiqishdagi oraliq eksportnikiga yaqin, lekin aniq emas.",
    emoji: "Emoji hali chizilmaydi: eksport shriftlarida ular yoʻq.",
  },
};
