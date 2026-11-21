import type { exportPresetEn } from "./en";

/** Tahrirchidagi eksport formati tanlovi. Platforma nomlari xos otlar, tarjima qilinmaydi. Manba — ./en.ts. */
export const exportPresetUz: typeof exportPresetEn = {
  legend: "Eksport formati",
  summary: "Eksport formati: {name}",
  summaryCustom: "Eksport formati: oʻz oʻlchami",
  hint: "Butun videoning kadr oʻlchami va kadr tezligini belgilaydi. Oʻzgarishlarni saqlang, keyin eksport qiling.",
  detail: "{w} × {h} px, sekundiga {fps} kadr",
  custom: "Loyihaning oʻz oʻlchami bor ({w} × {h} px, sekundiga {fps} kadr). Oʻzgartirish uchun formatni tanlang.",
  longForFormat: "Video {length} davom etadi. Bu format {max} gacha eng yaxshi ishlaydi. Baribir eksport qilish mumkin.",
  names: {
    youtube_1080p: "YouTube, keng 16:9, 1080p",
    youtube_720p: "Keng 16:9, 720p (fayl kichikroq)",
    vertical_1080p: "Shorts, Reels, TikTok 9:16",
    square_1080: "Kvadrat 1:1",
    feed_4x5_1080: "Lenta, portret 4:5",
  },
};
