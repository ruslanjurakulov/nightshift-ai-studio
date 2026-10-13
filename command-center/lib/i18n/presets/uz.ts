import type { PresetsDictionary } from "./en";

/** «Presetlar va uslublar» galereyasi. Manba — ./en.ts. */
export const presetsUz: PresetsDictionary = {
  title: "Presetlar va uslublar",
  subtitle: "Nightshiftda allaqachon mavjud tayyor boshlangʻich nuqtalar bir joyda. Birini tanlang — forma toʻldirilgan holda ochiladi.",
  note: "Bu sahifada hech narsa narxlanmaydi va ishga tushmaydi. U ochadigan forma narxni koʻrsatadi va tasdiqlashni soʻraydi.",
  searchLabel: "Presetlardan izlash",
  searchPlaceholder: "Izlash: hikoya, vertikal, ovoz…",
  filterLabel: "Koʻrsatish",
  kinds: { all: "Hammasi", format: "Formatlar", look: "Uslublar", starter: "Namunalar", voice: "Ovozlar" },
  cardKind: { format: "Video formati", look: "Uslub", starter: "Studiya namunasi", voice: "Ovoz" },
  sections: {
    format: {
      title: "Video formatlari",
      hint: "YouTube video formasini boshlangʻich mavzu, odatiy uzunlik va tilingiz bilan ochadi. [Qavslar]ni almashtiring.",
    },
    look: {
      title: "Uslublar",
      hint: "Studiya rasmlari uchun yozma badiiy yoʻnalishlar. Bu yerda uslubning oʻzi ochiladi va uni uslublaringizga qoʻshish mumkin. Bu modelga yoʻnalish, rasm qanday chiqishiga vaʼda emas.",
    },
    starter: {
      title: "Studiya namunalari",
      hint: "Studiya vositasini tayyor tavsif va shakl bilan ochadi. Namuna matni ataylab inglizcha; [qavslar]ni almashtiring.",
    },
    voice: {
      title: "Ovozlar",
      hint: "Ovozli ifodani tanlangan ovoz bilan ochadi. Matnni oʻsha yerda kiritasiz.",
    },
  },
  actions: { format: "Video formasini ochish", look: "Uslubni koʻrish", starter: "Formani toʻldirish", voice: "Bu ovozni tanlash" },
  open: "{action}: {title}",
  count: "{n} / {total}",
  clear: "Izlashni tozalash",
  noMatchTitle: "Hech narsa topilmadi",
  noMatch: "Boshqa soʻzni sinab koʻring yoki barcha presetlarni koʻrish uchun izlashni tozalang.",
  loading: "Presetlar yuklanmoqda",
  entryLink: "Presetlar va uslublar",
  homeLink: "Barcha presetlar va uslublar",
};
