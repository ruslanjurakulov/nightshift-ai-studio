import type { StudioHomeDictionary } from "./en";

/** /create — kompozitor birinchi oʻrinda turgan Studiya. Manba — ./en.ts. */
export const studioHomeUz: StudioHomeDictionary = {
  title: "Bugun nima yaratamiz?",
  lead: "Nima kerakligini yozing. Narx hech narsa boshlanmasdan oldin tugmada koʻrinadi.",
  modesLabel: "Nima yaratamiz",
  modes: { image: "Rasm", video: "Video", voice: "Ovoz", enhance: "Kuchaytirish", youtube: "YouTube video" },
  attach: {
    image: "Rasm qoʻshish",
    video: "Rasmdan boshlash",
    voice: "Yozuv qoʻshish",
    enhance: "Fayl tanlash",
  },
  attachRemove: "Biriktirmani olib tashlash",
  settings: "Sozlamalar",
  settingsFor: "Sozlamalar: {summary}",
  settingsClose: "Sozlamalarni yopish",
  modelButton: "Model: {name}. Modelni almashtirish",
  modelNone: "Model yoʻq",
  enterHint: "Enter — yuborish · Shift+Enter — yangi qator",
  composerLabel: "Yozish maydoni",
  plan: {
    toggle: "Reja",
    toggleLabel: "Reja tuzish: bitta maqsad, bir nechta ish, bitta umumiy narx",
    goalLabel: "Maqsadingiz",
    send: "Reja tuzish",
    note: "Reja tuzishda faqat narxlar soʻraladi. Umumiy narxni tasdiqlamaguningizcha hech narsa boshlanmaydi.",
  },
  youtube: {
    label: "Video mavzusi",
    placeholder: "Video nima haqida? Masalan: Xivada ipak gilam qanday toʻqiladi",
    send: "Davom etish",
    note: "Keyingi sahifa narxni koʻrsatadi va video boshlanishidan oldin sizdan soʻraydi.",
  },
  examples: {
    title: "Misoldan boshlang",
    lead: "Karta yuqoridagi maydonni toʻldiradi: turi, modeli va matni. Yuborishni bosmaguningizcha hech narsa boshlanmaydi.",
    use: "Shu misolni ishlatish: {prompt}",
    listLabel: "Misollar",
  },
  recent: {
    title: "Soʻnggi ishlaringiz",
    emptyTitle: "Ishlaringiz shu yerda chiqadi",
    emptyBody: "Yuqoriga biror narsa yozing yoki misoldan boshlang.",
    emptyAction: "Misol tanlash",
    all: "Kutubxonani ochish",
  },
  advanced: {
    title: "Kengaytirilgan",
    lead: "Har bir ish turi uchun barcha imkoniyatlari ochiq turgan toʻliq sahifa, kreditlaringiz va montaj loyihalaringiz.",
    pages: {
      image: "Rasm sahifasi",
      video: "Video sahifasi",
      voice: "Ovoz sahifasi",
      enhance: "Kuchaytirish sahifasi",
      youtube: "YouTube video sahifasi",
    },
    presets: "Tayyor andozalar",
  },
  actions: {
    animate: "Bu rasmdan video qilish",
    enhance: "Bu rasmni kuchaytirish",
    download: "Yuklab olish",
    downloadFailed: "Faylni tayyorlab boʻlmadi. Qaytadan urinib koʻring.",
  },
};
