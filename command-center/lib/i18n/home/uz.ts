import type { HomeDictionary } from "./en";

/** Ommaviy bosh sahifa «/». Manba — ./en.ts. */
export const homeUz: HomeDictionary = {
  hero: {
    eyebrow: "Nightshift Studio",
    title: "Gʻoyadan tayyor videogacha — bitta Studio",
    lead: "Gʻoyangizni yozing. Nightshift uni rasm, klip, ovoz va tayyor videoga aylantiradi, narx esa boshlanishidan oldin tugmada koʻrinadi.",
    primary: "Yaratishni boshlash",
    secondary: "Qanday ishlaydi",
    reelLabel: "Nightshift Studio’da yaratilgan",
    reelNote: "Bu yerdagi har bir klip oʻzimizning Studio’mizda yaratilgan.",
    ai: "Sunʼiy intellekt yaratgan",
  },
  how: {
    title: "Qanday ishlaydi",
    lead: "Uch qadam, bitta joyda.",
    steps: [
      { id: "idea", label: "Gʻoya", title: "Tasvirlang", body: "Nima kerakligini yozing yoki shablondan boshlang. Oʻzingizning rasm yoki ovozingiz boʻlsa, qoʻshing." },
      { id: "create", label: "Yaratish", title: "Yarating", body: "Sotuvdagi modellardan rasm, klip va ovoz; har birining narxi boshlanishidan oldin tugmasida." },
      { id: "export", label: "Eksport", title: "Oling", body: "Tayyor videoni yuklab oling yoki kanalingizga yuboring. Yuklangan videolar siz tasdiqlamaguningizcha yopiq qoladi." },
    ],
  },
  models: {
    title: "Bugun Studio’dagi modellar",
    lead: "Hozir foydalanish mumkin boʻlgan modellar, Studio’ning oʻzidan olinadi: model qoʻshilsa yoki olib tashlansa, roʻyxat ham oʻzgaradi.",
    kinds: { video: "Video", image: "Rasm", voice: "Ovoz" },
    listLabel: "Sotuvdagi modellar",
  },
  mcp: {
    tag: "MCP",
    titleLive: "Claude va ChatGPT ichida ishlaydi",
    bodyLive: "Nightshift’ni Claude, ChatGPT, Cursor yoki VS Code’ga ulang va oddiy soʻzlar bilan video soʻrang. Yordamchi kreditlarni faqat siz belgilagan oylik limit doirasida sarflaydi, nashr esa baribir sizni kutadi.",
    titleOff: "Sunʼiy intellekt yordamchingiz ichida ishlaydi",
    bodyOff: "Bugunoq Cursor yoki VS Code’ni API kaliti bilan ulang va oddiy soʻzlar bilan video soʻrang. Claude va ChatGPT uchun kirish tez orada.",
    cta: "Qanday ulash",
  },
  trust: {
    title: "Ishonch va xavfsizlik",
    lead: "Nightshift kanalingiz, kalitlaringiz va pulingiz bilan nima qiladi — «Ishonch va xavfsizlik» sahifamiz soʻzlari bilan.",
    more: "Toʻliq oʻqish",
  },
  final: {
    title: "Gʻoyadan boshlang",
    lead: "Roʻyxatdan oʻting, nima kerakligini yozing va biror narsa yaratilishidan oldin narxni koʻring.",
    cta: "Yaratishni boshlash",
    pricing: "Narxlarni koʻrish",
  },
};
