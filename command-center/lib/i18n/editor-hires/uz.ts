import type { ExportHiresDictionary } from "./en";

/** 1440p va 4K eksporti kreditlar evaziga. Manba: ./en.ts. QORALAMA: ona tilida soʻzlashuvchi koʻrib chiqishi kerak. */
export const exportHiresUz: ExportHiresDictionary = {
  names: {
    youtube_1440p: "YouTube keng 16:9, 1440p",
    vertical_1440p: "Vertikal 9:16, 1440p",
    youtube_2160p: "YouTube keng 16:9, 4K",
    vertical_2160p: "Vertikal 9:16, 4K",
  },
  paidTag: "pullik",
  intro: "1080p gacha har qanday eksport bepul. 1440p va 4K ni server bir necha baravar uzoqroq render qiladi, shuning uchun ular videoning har bir boshlangan daqiqasi uchun kredit turadi. 1440p video {max1440} gacha, 4K video {max2160} gacha boʻlishi mumkin.",
  loading: "Narx olinmoqda: {name}…",
  line: "{name}: {minutes} daq × {perMinute} kredit = {credits} kredit",
  exemptLine: "{name}: bu ish maydonida hech narsa band qilinmaydi.",
  available: "Bu ish maydonida mavjud: {available} kredit.",
  total: "Bu eksport hozir {credits} kreditni band qiladi. Ular video tayyor boʻlganda yechiladi va eksport muvaffaqiyatsiz boʻlsa qaytariladi.",
  confirm: "Bu eksportga {credits} kreditgacha sarflash",
  tooFast: "{name} soniyasiga koʻpi bilan {max} kadr, bu loyiha esa {fps}. “Eksport formati” da kadr tezligini {max} yoki undan past qiling yoki 1440p ni tanlang.",
  notOnSale: "{name} hali sotuvda emas.",
  tooLong: "{name} koʻpi bilan {max} boʻlishi mumkin, bu video esa {length}. Bu oʻlchamda eksport qilish uchun uni qisqartiring.",
  notAllowed: "{name}: ish maydonining kreditlarini faqat muharrir, administrator yoki egasi sarflay oladi.",
  short: "{name} uchun {credits} kredit kerak, bu ish maydonida esa {available}. Kredit qoʻshing yoki kichikroq oʻlchamni tanlang.",
  failed: "{name} narxini olib boʻlmadi.",
  retry: "Narxni qayta olish",
  saveFirst: "Avval saqlang: narx saqlangan versiya uchun hisoblanadi.",
};
