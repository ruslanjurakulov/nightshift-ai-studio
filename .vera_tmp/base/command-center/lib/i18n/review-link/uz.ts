import type { ReviewLinkDictionary, ReviewPageDictionary } from "./en";

/** Oldindan koʻrish uchun shaxsiy havolalar: video muallifining paneli va havola ochadigan sahifa. Manba — ./en.ts. */
export const reviewLinkUz: ReviewLinkDictionary = {
  title: "Oldindan koʻrishni ulashish",
  intro:
    "Bu videoning koʻrib chiqish nusxasiga shaxsiy havola yarating. Havolasi bor har kim muddati tugamaguncha yoki siz uni oʻchirmaguningizcha videoni akkauntsiz koʻra oladi. Havola faqat shu oldindan koʻrishni ochadi: asl nusxani yuklab olib, tasdiqlab yoki joylab boʻlmaydi.",
  expiryLabel: "Havola amal qiladi",
  days: { d1: "1 kun", d3: "3 kun", d7: "7 kun", d14: "14 kun", d30: "30 kun" },
  create: "Havola yaratish",
  creating: "Yaratilmoqda…",
  newTitle: "Yangi havolangiz",
  newNote: "Hozir nusxalang: u faqat bir marta koʻrsatiladi. Yoʻqotsangiz, uni oʻchirib, yangisini yarating.",
  linkField: "Oldindan koʻrish havolasi",
  dismiss: "Tayyor",
  listTitle: "Bu video uchun havolalar",
  loading: "Havolalar yuklanmoqda…",
  empty: "Hozircha havola yoʻq.",
  loadFailed: "Havolalarni yuklab boʻlmadi.",
  retry: "Qayta urinish",
  state: { live: "Amalda", expired: "Muddati tugagan", revoked: "Oʻchirilgan" },
  made: "Yaratilgan: {when}",
  until: "amal qilish muddati: {when}",
  views: "Koʻrishlar: {n}",
  revoke: "Oʻchirish",
  revoking: "Oʻchirilmoqda…",
  revokeLabel: "{when} yaratilgan havolani oʻchirish",
  errors: {
    unauthorized: "Davom etish uchun qaytadan kiring.",
    forbidden: "Sahifa soʻrovni tasdiqlay olmadi. Sahifani yangilab, qayta urinib koʻring.",
    bad_request: "Soʻrov yaroqsiz.",
    not_found: "Bu videoni ulasha olmaysiz.",
    no_preview: "Bu videoning koʻrib chiqish nusxasi endi saqlanmaydi, shuning uchun ulashadigan narsa yoʻq.",
    limit_reached: "Bu videoda amaldagi havolalar soni allaqachon eng yuqori darajada. Avval bittasini oʻchiring.",
    rate_limited: "Juda koʻp soʻrov. Bir necha daqiqadan keyin qayta urinib koʻring.",
    not_available: "Oldindan koʻrishni ulashish hozircha mavjud emas.",
    failed: "Bajarilmadi. Qayta urinib koʻring.",
  },
};

export const reviewPageUz: ReviewPageDictionary = {
  badge: "Oldindan koʻrish",
  untitled: "Nomsiz video",
  videoLabel: "Videoni oldindan koʻrish",
  note: "Bu koʻrib chiqish uchun nusxa. U yakuniy fayl emas va sifati tayyor videodan pastroq boʻlishi mumkin.",
  viewOnly: "Faqat koʻrish: bu sahifada «tasdiqlash», «joylash» va «yuklab olish» tugmalari yoʻq.",
  until: "Havola {when} gacha amal qiladi.",
  goneTitle: "Bu havola mavjud emas",
  goneBody: "Uning muddati tugagan yoki oʻchirilgan boʻlishi mumkin. Havolani yuborgan kishidan yangisini soʻrang.",
  limitedTitle: "Hozir koʻrishlar juda koʻp",
  limitedBody: "Bir daqiqa kuting va sahifani yangilang.",
  unavailableTitle: "Hozir oldindan koʻrishni koʻrsatib boʻlmayapti",
  unavailableBody: "Birozdan keyin qayta urinib koʻring.",
};
