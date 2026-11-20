import type { AssetDownloadDictionary } from "./en";

export const assetDownloadUz: AssetDownloadDictionary = {
  original: "Asl faylni yuklab olish",
  originalSize: "Asl faylni yuklab olish · {w}×{h}",
  originalHint: "Toʻliq sifatli fayl, aynan yaratilgan holida.",
  preview: "Koʻrib chiqish",
  previewHint: "Tez koʻrish uchun yengil nusxa (videoda 480p). E’lon qilish uchun emas.",
  captions: "Subtitrlar (SRT)",
  checking: "Tayyorlanmoqda…",
  newTab: "(yangi oynada ochiladi)",
  retry: "Qayta urinish",
  errors: {
    unauthorized: "Siz hisobdan chiqib ketgansiz. Yuklab olish uchun qayta kiring.",
    not_found: "Bu fayl endi kutubxonangizda yoʻq.",
    gone: "Fayl xotiradan oʻchirilgan. Yangisini olish uchun videoni qayta eksport qiling.",
    media_unavailable: "Fayllarni Nightshift serveri beradi, bu manzildan esa unga ulanib boʻlmaydi.",
    no_captions: "Bu eksportda subtitr yoʻq.",
    no_preview: "Bu faylning hali koʻrib chiqish nusxasi yoʻq.",
    failed: "Yuklab olish boshlanmadi. Internetni tekshirib, qayta urinib koʻring.",
  },
};
