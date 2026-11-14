import type { RightsAckDictionary } from "./en";

/**
 * Huquqni tasdiqlash oynasi (0174-migratsiya). Manba — ./en.ts. `kinds.*` — versiyali matn: maʼnosini oʻzgartirish yangi matn
 * versiyasi (yangi migratsiya) boʻladi, joyida tahrir emas. Egasining ohangi: oddiy va toʻgʻridan-toʻgʻri. Mashina qoralamasi:
 * ona tilida soʻzlashuvchi oʻqib chiqishi kerak.
 */
export const rightsAckUz: RightsAckDictionary = {
  title: "Yaratishdan oldin",
  intro: "Faylingiz yuborilishidan oldin bu model ishlab chiqaruvchisi va bizning Shartlarimiz tasdiqlashingizni talab qiladi.",
  kinds: {
    likeness_photo: {
      question: "Bu odamning yuzidan foydalanish uchun javobgarlikni oʻz zimmangizga olasizmi?",
      statement: "Rasmda yoki videoda koʻringan har bir insonning yuzi va qiyofasidan bu yerda foydalanishga roziligi borligini tasdiqlayman.",
    },
    voice_clone: {
      question: "Bu odamning ovozidan foydalanish uchun javobgarlikni oʻz zimmangizga olasizmi?",
      statement: "Bu oʻzimning ovozim ekanini yoki ovoz egasi undan bu yerda foydalanishga menga aniq rozilik berganini tasdiqlayman.",
    },
    third_party_content: {
      question: "Bu materialdan foydalanish uchun javobgarlikni oʻz zimmangizga olasizmi?",
      statement: "Bu material meniki ekanini yoki undan bu yerda foydalanish uchun litsenziyam borligini tasdiqlayman.",
    },
  },
  subjectsLabel: "Qaysi faylga tegishli",
  subjects: {
    source_asset_id: "Siz biriktirgan rasm",
    end_asset_id: "Oxirgi kadr rasmi",
    other: "Biriktirilgan fayl",
  },
  checkbox: "Javobgarlikni oʻz zimmamga olaman",
  termsLink: "Shartlarimiz, 6.2-boʻlim",
  version: "Matn versiyasi {version}",
  recordNote: "Tasdiqlashingiz akkauntingiz, shu fayl va vaqt bilan birga saqlanadi. Boshqa fayl uchun va bu matn oʻzgarganda yana soʻraladi.",
  confirm: "Tasdiqlash va yaratish",
  confirming: "Tasdiqlash saqlanmoqda…",
  cancel: "Bekor qilish",
  close: "Yopish",
  checking: "Bu modelga nima kerakligi tekshirilmoqda…",
  retry: "Qayta urinish",
  problems: {
    version_changed: "Sahifa ochilgandan keyin bu tasdiqlash matni oʻzgardi. Joriy matnni oʻqish uchun sahifani yangilang. Hech narsa boshlanmadi va hisobdan yechilmadi.",
    stale: "Bu sahifada tasdiqlashning joriy matni yoʻq. Uni oʻqish uchun sahifani yangilang. Hech narsa boshlanmadi va hisobdan yechilmadi.",
    source_unavailable: "Bu fayl endi tashkilotingiz kutubxonasida yoʻq. Uni qayta tanlang. Hech narsa boshlanmadi va hisobdan yechilmadi.",
    unavailable: "Bu tasdiqlash hozircha bu serverda mavjud emas, shuning uchun bu modelni faylingiz bilan ishlatib boʻlmaydi. Hech narsa boshlanmadi va hisobdan yechilmadi.",
    forbidden: "Bu ish maydoni uchun tasdiqlay olmaysiz. Hech narsa boshlanmadi va hisobdan yechilmadi.",
    failed: "Tasdiqlashingizni saqlab boʻlmadi. Hech narsa boshlanmadi va hisobdan yechilmadi.",
  },
};
