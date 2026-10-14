import type { ImproveDictionary } from "./en";

/** Fayl yonidagi «AI bilan yaxshilash»: menyu, har bir vosita nima qiladi, halol «hozircha mavjud emas», «Loyihaga qoʻshish». Manba — ./en.ts. */
export const improveUz: ImproveDictionary = {
  action: "AI bilan yaxshilash",
  actionFor: "AI bilan yaxshilash: {name}",
  title: "AI bilan yaxshilash",
  lead: "«{name}» bilan nima qilishni tanlang. Bu yerda hech narsa boshlanmaydi: keyingi sahifada avval narx koʻrsatiladi, ishga tushirishni oʻzingiz bosasiz.",
  close: "Yopish",
  unavailable: "Bu serverda hozircha mavjud emas",
  inEditor: "Muharrirda bajariladi",
  tools: {
    upscale: { label: "Kattalashtirish", hint: "Rasmni aniqroq va kattaroq qilish." },
    remove_bg: { label: "Kesib olish", hint: "Fonni olib tashlab, predmetni qoldirish." },
    edit: { label: "Taʼrif bilan tahrirlash", hint: "Rasmni nima kerakligini yozib oʻzgartirish." },
    i2v: { label: "Jonlantirish", hint: "Rasmni qisqa videoga aylantirish." },
    video_upscale: { label: "Video sifatini oshirish", hint: "Videoni aniqroq va kattaroq qilish." },
    captions: { label: "Subtitrlar", hint: "Aytilganlarni subtitr qilib yozish, soʻng ularni bezash." },
    voice_change: { label: "Ovozni almashtirish", hint: "Xuddi shu soʻzlar boshqa ovozda." },
    dub: { label: "Dublyaj", hint: "Boshqa tilda ovozlashtirish." },
  },
  fromProject: "Siz loyihadan keldingiz. Natija tayyor boʻlgach, uni «Loyihaga qoʻshish» tugmasi bilan qaytaring.",
  backToProject: "Loyihaga qaytish",
  addToProject: "Loyihaga qoʻshish",
  addToProjectFor: "Loyihaga qoʻshish: {name}",
  offerTitle: "«{name}» shu loyihaga qoʻshilsinmi?",
  offerBody: "U endi kutubxonangizda. Qoʻshsangiz, loyihaga tushadi; oʻzingiz qilmaguningizcha hech narsa saqlanmaydi va eksport qilinmaydi.",
  offerAdd: "Loyihaga qoʻshish",
  offerNotNow: "Hozir emas",
  offerAdded: "Loyihaga qoʻshildi. Saqlab qoʻying.",
  offerMissing: "Bu fayl muharrir qabul qiladigan kutubxona fayllari (rasm, video yoki tovush) orasida yoʻq.",
  offerFailed: "Qoʻshib boʻlmadi: loyiha toʻla.",
  unnamed: "bu fayl",
};
