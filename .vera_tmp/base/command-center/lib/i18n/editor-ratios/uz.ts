import type { ExportRatiosDictionary } from "./en";

/** Bitta montajni bir nechta kadr oʻlchamida eksport qilish. Manba — ./en.ts. QORALAMA: ona tili egasi koʻrib chiqishi kerak. */
export const exportRatiosUz: ExportRatiosDictionary = {
  legend: "Eksport oʻlchamlari",
  summaryOwn: "Eksport oʻlchamlari: shu loyihaning oʻlchami",
  summaryCount: "Eksport oʻlchamlari: {count}",
  own: "Shu loyihaning oʻlchami",
  size: "{w} × {h}",
  hint: "Har bir oʻlcham alohida eksport va mediatekangizdagi alohida video boʻladi, har biri kunlik limitga hisoblanadi. Bir vaqtda {max} tagacha boshlash mumkin. Faqat kadr oʻlchami oʻzgaradi. Shakli boshqa klip oʻzi uchun tanlangan joylashuvni saqlaydi: kadrni toʻldirish yoki xira fonni tanlamagan boʻlsangiz, chetlarida chiziqlar qoladi.",
  atLimit: "{max} ta oʻlcham tanlandi, bir vaqtda bundan koʻp boshlab boʻlmaydi. Boshqasini tanlash uchun bittasidan belgini olib tashlang.",
  none: "Eksport uchun kamida bitta oʻlchamni tanlang.",
  blocked: "{name}: bu montajni hozirgi holida shu oʻlchamda eksport qilib boʻlmaydi. Effektlardan biri oʻz chegarasidan oshadi. Nima oʻzgarishini koʻrish uchun shu oʻlchamni “Eksport formati” boʻlimida tanlang.",
  longFor: "{name}: video {length} davom etadi, bu oʻlcham esa {max} gacha eng yaxshi ishlaydi. Baribir eksport qilish mumkin.",
  refused: "{name} boshlanmadi: {reason}",
  notAvailable: "Boshqa oʻlchamlar bu serverda hali mavjud emas. Loyiha oʻlchamida eksport qilish avvalgidek ishlaydi.",
  panelFor: "Oxirgi eksport: {name}",
  mismatch: "Bu video {w} × {h} oʻlchamda, soʻralgan {fw} × {fh} emas. Server uni loyiha oʻlchamida render qildi. Shu oʻlchamni keyinroq qayta eksport qiling.",
};
