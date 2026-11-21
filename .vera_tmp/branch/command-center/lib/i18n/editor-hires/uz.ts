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
  line: "{name}: {minutes} daq × {perMinute} = {credits}, render paytida {hold} band qilinadi",
  exemptLine: "{name}: bu ish maydonida hech narsa band qilinmaydi.",
  available: "Bu ish maydonida mavjud: {available}.",
  total: "Video tayyor boʻlganda {credits} yechiladi. Render paytida eksportga yetishi uchun {hold} band qilinadi; ishlatilmagani qaytadi, eksport muvaffaqiyatsiz boʻlsa esa hammasi qaytadi.",
  confirm: "Bu eksport uchun {credits} toʻlash",
  tooFast: "{name} soniyasiga koʻpi bilan {max} kadr, bu loyiha esa {fps}. “Eksport formati” da kadr tezligini {max} yoki undan past qiling yoki 1440p ni tanlang.",
  notOnSale: "{name} hali sotuvda emas.",
  tooLong: "{name} koʻpi bilan {max} boʻlishi mumkin, bu video esa {length}. Bu oʻlchamda eksport qilish uchun uni qisqartiring.",
  notAllowed: "{name}: ish maydonining kreditlarini faqat muharrir, administrator yoki egasi sarflay oladi.",
  short: "{name} render paytida {hold} band qiladi, bu ish maydonida esa {available}. Kredit qoʻshing yoki kichikroq oʻlchamni tanlang.",
  speedCurve: "{name} ni tezlik egri chizigʻi bor video uchun hozircha eksport qilib boʻlmaydi: uning uzunligini narxlab boʻlmaydi. Tezlik egri chizigʻini olib tashlang yoki 1080p yoki kichikroqni tanlang.",
  ownTooBig: "Bu loyiha 1080p dan katta, 1080p dan katta eksport esa pullik. “Eksport oʻlchamlari” da 1440p yoki 4K ni belgilang va narxni tasdiqlang yoki “Eksport formati” da loyihani 1080p yoki kichikroq qiling.",
  ownTooBigOff: "Bu loyiha 1080p dan katta, 1080p dan katta eksport esa pullik va bu yerda taklif qilinmaydi. Eksport qilish uchun “Eksport formati” da loyihani 1080p yoki kichikroq qiling.",
  failed: "{name} narxini olib boʻlmadi.",
  retry: "Narxni qayta olish",
  freeLine: "{name}: bepul",
  introSold: "Har qanday eksport videoning har bir boshlangan daqiqasi uchun kredit turadi: 1080p gacha, 1440p va 4K da, har bir oʻlcham oʻz narxida. 1440p video {max1440} gacha, 4K video {max2160} gacha boʻlishi mumkin.",
  soldNoQuote: "Endi eksport kredit turadi, bu sahifa esa hozircha narxni koʻrsata olmaydi. Keyinroq urinib koʻring.",
  saveFirst: "Avval saqlang: narx saqlangan versiya uchun hisoblanadi.",
};
