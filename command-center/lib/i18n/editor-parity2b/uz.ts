import type { Parity2bDictionary } from "./en";

/**
 * Muharrirning 2b toʻplami: effektlar, klipning paydo boʻlish va yoʻqolish animatsiyalari, «barcha kesimlarga» va
 * bit belgilari. Manba — ./en.ts. TARJIMA QORALAMASI: ona tili egasi oʻqib chiqishi kerak.
 */
export const parity2bUz: Parity2bDictionary = {
  fx: {
    title: "Effektlar",
    names: { glitch: "Glitch", shake: "Silkinish", rgb_split: "RGB ajratish", flash: "Chaqnash" },
    value: "{v}",
    hint: "Har bir effekt 0 (oʻchiq) dan 100 gacha. Glitch qisqa portlashlarda miltillaydi, chaqnash yorqinroq urib turadi, silkinish tasvirni kadr ichida siljitadi.",
    previewNote: "Oldindan koʻrish bu effektlarni chizmaydi; eksport chizadi.",
    largeXfade: "1440p dan katta kadrda oʻtishli klipda bitta effekt boʻladi (koʻprogʻiga eksport xotirasi yetmaydi).",
  },
  anim: {
    title: "Animatsiya",
    inLegend: "Paydo boʻlish",
    outLegend: "Yoʻqolish",
    none: "Yoʻq",
    names: {
      fade: "Soʻnish",
      "slide-up": "Yuqoriga siljish",
      "slide-down": "Pastga siljish",
      "slide-left": "Chapga siljish",
      "slide-right": "Oʻngga siljish",
      zoom: "Kattalashtirish",
    },
    length: "Davomiyligi",
    value: "{v} s",
    hint: "Siljish butun tasvirni kadr chetidan qora fonda olib kiradi (yoki olib chiqadi); kattalashtirish uni 60 % dan oʻstiradi (yoki kichraytiradi). Har biri klipning yarmidan oshmaydi.",
    fadeSide: "Bu tomonda allaqachon soʻnish bor. Animatsiya uchun uni 0 ga qoʻying.",
    tooShort: "Bu klip animatsiya uchun juda qisqa (kamida 0,2 s kerak).",
    previewNote: "Oldindan koʻrish animatsiyani chizmaydi; eksport chizadi.",
  },
  budget: "Effektlar va animatsiyalar bilan eksport taxminan {work} s davom etardi, lekin {length} s videoga {allowed} s ruxsat berilgan. Oʻzgarish kiritilmadi.",
  transitionAll: {
    button: "Bu oʻtishni barcha kesimlarga qoʻllash",
    done: { one: "{n} ta kesim endi xuddi shunday oʻtadi.", few: "{n} ta kesim endi xuddi shunday oʻtadi.", many: "{n} ta kesim endi xuddi shunday oʻtadi." },
    none: "Boshqa hech bir kesimda bunday oʻtish uchun joy yoʻq.",
  },
  beats: {
    title: "Bitlar",
    find: "Bitlarni topish",
    working: "Bitlar tinglanmoqda…",
    found: { one: "{n} ta bit topildi. U vaqt chizigʻida belgilangan, klip chetlari unga yopishadi.", few: "{n} ta bit topildi. Ular vaqt chizigʻida belgilangan, klip chetlari ularga yopishadi.", many: "{n} ta bit topildi. Ular vaqt chizigʻida belgilangan, klip chetlari ularga yopishadi." },
    none: "Bu tovushda aniq bit yoʻq.",
    hide: "Bitlarni yashirish",
    hint: "Bu tovushni brauzeringizda tinglaydi va bitlar qayerga tushishini belgilaydi. Loyiha bilan hech narsa saqlanmaydi.",
    too_large: "Bu fayl brauzerda tinglash uchun juda uzun yoki katta.",
    unavailable: "Brauzer bu faylning ovozini oʻqiy olmadi. Keyinroq urinib koʻring.",
    busy: "Boshqa fayl tinglanmoqda yoki hozirgina juda koʻp fayl tinglandi. Bir daqiqadan keyin urinib koʻring.",
    no_sound: "Bu faylda ovoz yoʻq.",
    marker: "Bit",
  },
  settledFx: "Klip {n} faqat eng kuchli effektini saqlaydi: 1440p dan katta kadrda oʻtishli klipda bitta effekt boʻladi.",
};
