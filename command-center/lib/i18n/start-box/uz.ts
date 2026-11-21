import type { StartBoxDictionary } from "./en";

/** Ilovaning boshlash maydoni (components/prompt/StartBox.tsx). Matn manbasi — ./en.ts. */
export const startBoxUz: StartBoxDictionary = {
  tabsLabel: "Nima qilamiz",
  tabs: { create: "Video yaratish", edit: "AI tahrir" },
  label: { create: "Gʻoyangiz", edit: "Nimani oʻzgartirish kerak" },
  placeholder: {
    film: "Shishadagi maktubni topib olgan mayoq qorovuli haqida qisqa film",
    ad: "Toshkentdagi oilaviy novvoyxona uchun 30 soniyalik reklama, iliq tonggi yorugʻlik",
    channel: "Kanalingizning keyingi videosi mavzusi",
    agent: "Videoni tasvirlab bering. Nightshift AI yetishmagan narsalarni soʻraydi",
    edit: "Tunga aylantir, yengil yomgʻir qoʻsh, yuzlarni oʻzgartirma",
  },
  submit: { create: "Davom etish", agent: "Nightshift AI’da ochish", channel: "Ishga tushirish formasini ochish", connect: "Kanal ulash", edit: "Tahrirni ochish" },
  note: {
    create: "Bu yerda hech narsa ishga tushmaydi. «Yaratish» soʻzlaringiz bilan ochiladi va yuborishdan oldin narxni koʻrsatadi.",
    agent: "Nightshift AI bir nechta savol beradi va videoning qoralamasini tuzadi. U yerda «Yaratish»ni bosib, narxni koʻrmaguningizcha hech narsa yechilmaydi.",
    channel: "«{channel}» uchun ishga tushirish formasi shu mavzu bilan ochiladi. U narxni koʻrsatadi va ishga tushirishdan oldin soʻraydi.",
    connect: "Kanal videosi ulangan YouTube kanali uchun tayyorlanadi. Avval kanal ulang.",
    edit: "«Yaxshilash» boʻlimi soʻzlaringiz bilan ochiladi. U yerda klipni tanlang; narx ishga tushirishdan oldin koʻrsatiladi.",
  },
  empty: "Avval bir-ikki soʻz yozing.",
  count: "{n} / {max}",
  topicCut: "Kanal videosi mavzusi koʻpi bilan {max} belgi: formaga faqat birinchi {max} belgi oʻtadi.",
  storageRefused: "Bu brauzer soʻzlaringizni saqlamadi, shuning uchun ularni olib oʻtib boʻlmaydi. Nightshift uchun sayt maʼlumotlariga ruxsat bering yoki avval matnni nusxalab oling.",
  agent: {
    label: "Agent",
    hint: "Nightshift AI videoni siz bilan birga rejalaydi",
    closed: "Bu ish maydoni uchun hali ochilmagan",
  },
  formatLabel: "Format",
  formats: { film: "AI film", ad: "Reklama", channel: "Kanal videosi" },
  library: {
    title: "Shablondan boshlash",
    lead: "Shablon faqat yuqoridagi maydonni toʻldiradi. {qavs} ichidagi soʻzlarni oʻzingiznikiga almashtiring.",
    all: "Barcha shablonlar",
    purposes: { storytelling: "Hikoyalar", marketing: "Marketing", brand: "Brend materiallari" },
    loading: "Shablonlar yuklanmoqda…",
    error: "Shablonlarni yuklab boʻlmadi.",
    retry: "Qayta urinish",
    empty: "Hozircha shablon yoʻq.",
    notEnabled: "Bu yerda shablonlar hali yoqilmagan.",
    signedOut: "Seans tugadi. Shablonlarni koʻrish uchun qayta kiring.",
    use: "«{title}»ni maydonga qoʻyish",
    filled: "«{title}» maydonda. Qavs ichidagi soʻzlarni almashtiring va davom eting.",
    kind: { video: "Video", image: "Rasm" },
  },
};
