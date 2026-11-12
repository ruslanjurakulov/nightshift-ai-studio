import type { Parity4Dictionary } from "./en";

/**
 * Muharrirning «gapiruvchi bosh» to'plami: toza ovoz, so'zlarni o'chirish yoki «pip» bilan yopish, matnning harflar
 * oralig'i, kursiv va qatorlarni tekislash. Manba — ./en.ts. TARJIMA QORALAMASI: ona tilida so'zlashuvchi tekshirishi kerak.
 */
export const parity4Uz: Parity4Dictionary = {
  settledVoiceClip: "{n}-klip: uning ovozidan toza ovoz olib tashlandi: u bilan videoni eksport qilish ruxsat etilganidan uzoqroq davom etardi.",
  settledVoiceSound: "{n}-ovoz: toza ovoz olib tashlandi: u bilan videoni eksport qilish ruxsat etilganidan uzoqroq davom etardi.",
  voice: {
    toggle: "Toza ovoz",
    hint: "Nutq uchun: g'uvillash va tarmoq shovqinini olib tashlaydi, fon shovqini va keskin «s» tovushlarini kamaytiradi, baland va past so'zlarni tenglaydi va balandlikni -16 LUFS ga keltiradi. U shovqinni kamaytirish va balandlikni tenglashni o'z ichiga oladi, shuning uchun ular o'chadi.",
    included: "Toza ovoz buni allaqachon o'z ichiga oladi.",
    previewNote: "Ko'rib chiqishda ovoz yozilganidek eshitiladi; toza ovoz eksportda qo'llanadi.",
    renderTime:
      "Hozir mavjud emas: u bilan eksport {length} s lik taymlayn uchun taxminan {work} s davom etadi, ruxsat esa {allowed} s. Avval boshqa narsani o'chiring.",
  },
  bleeps: {
    title: "So'zlarni o'chirish yoki «pip» bilan yopish",
    hint: "Eksport qilingan videoda so'zni o'chirish uchun uni bosing, qaytarish uchun yana bosing. So'zning vaqti — subtitr vaqti uning so'zlariga bo'lingan holda, shuning uchun «pip» subtitr vaqti qanchalik aniq bo'lsa, shunchalik aniq: o'tkazib yuborsa, subtitr boshi yoki oxirini suring.",
    modeLegend: "Yangilari",
    modes: { mute: "Jimlik", tone: "Pip" },
    wordAria: "{word}, {start} s",
    caption: "Subtitr {n}",
    more: "Yana subtitrlarni ko'rsatish",
    listHeading: "O'chirilgan: {max} tadan {n} ta",
    range: "{start}–{end} s",
    remove: "Olib tashlash",
    removeAria: "{start} s dagi «pip»ni olib tashlash",
    modeAria: "{start} s dagi «pip»",
    none: "Hozircha hech narsa o'chirilmagan.",
    full: "Bitta videoda ko'pi bilan {max} ta «pip».",
    noRoom: "Bu yerda joy yo'q: «pip» keyingisiga tegib ketadi.",
    previewNote: "Ko'rib chiqishda har bir «pip» ustida ovoz o'chadi; «pip»ning o'zi eksportda eshitiladi.",
  },
  text: {
    title: "Matn xususiyatlari",
    tracking: "Harflar oralig'i",
    trackingValue: "{v}",
    italic: "Kursiv",
    alignLegend: "Qatorlarni tekislash",
    alignAuto: "Joylashuvi bo'yicha",
    aligns: { left: "Chapga", center: "Markazga", right: "O'ngga" },
    alignHint: "Bir necha qatorli matnning qatorlari shunday tekislanadi. Bitta qator joylashgan joyida qoladi.",
    previewNote: "Ko'rib chiqishdagi oraliq eksportnikiga yaqin, lekin aniq emas.",
    emoji: "Emoji hali chizilmaydi: eksport shriftlarida ular yo'q.",
  },
};
