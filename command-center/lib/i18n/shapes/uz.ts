import type { shapesEn } from "./en";

/** Tahrirchidagi shakllar va stikerlar (strelka, doira, toʻrtburchak, yulduz, yorliq, chiziq, jarayon chizigʻi). Manba — ./en.ts. */
export const shapesUz: typeof shapesEn = {
  add: "Shakl qoʻshish",
  addTitle: "Video ustiga shakl yoki stiker qoʻshish",
  addConfirm: "Videoga qoʻshish",
  kindLegend: "Shakl",
  kinds: {
    arrow: "Strelka",
    circle: "Doira",
    rect: "Toʻrtburchak",
    star: "Yulduz",
    pill: "Yorliq",
    line: "Chiziq",
    progress: "Jarayon chizigʻi",
  },
  heading: "Shakl {n}: {kind}",
  start: "Koʻrsatish boshi (soniya)",
  end: "Koʻrsatish oxiri (soniya)",
  toPlayhead: "Belgidan boshlash",
  wholeVideo: "Butun video uchun",
  atClip: "Belgidagi klip uchun",
  colorLegend: "Rang",
  colorPicker: "Rang tanlash",
  colorCode: "Rang kodi, masalan #FFD60A",
  colorBad: "# dan keyin oltita raqam yoki A–F harflaridan iborat kod kiriting, masalan #FFD60A.",
  swatches: {
    yellow: "Sariq",
    red: "Qizil",
    green: "Yashil",
    blue: "Koʻk",
    white: "Oq",
    black: "Qora",
  },
  x: "Gorizontal joylashuv",
  y: "Vertikal joylashuv",
  size: "Oʻlcham (video kengligining ulushi)",
  opacity: "Shaffofmaslik",
  percent: "{v}%",
  numberLabel: "{name}, foiz",
  outline: "Kontur qalinligi (0 — toʻldirilgan)",
  aspect: "Kenglik va balandlik nisbati",
  aspectValue: "{v} dan 1 ga",
  dirLegend: "Yoʻnalishi",
  dirs: { right: "Oʻngga", left: "Chapga", up: "Yuqoriga", down: "Pastga" },
  thick: "Qalinlik (video balandligining ulushi)",
  text: "Yorliq matni",
  textHint:
    "{max} belgigacha: lotin va kirill harflari, raqamlar va oddiy tinish belgilari. Emoji va boshqa yozuvlarni eksport qilingan videoda chizib boʻlmaydi, shuning uchun qabul qilinmaydi.",
  textDropped: "Eksport qilingan videoda chizib boʻlmaydigan belgilar (emoji, boshqa yozuvlar) tashlab yuborildi.",
  textEmpty: "Yorliqda kamida bitta belgi boʻlishi kerak, shuning uchun oxirgi matn saqlandi.",
  readyLegend: "Tayyor yorliqlar",
  labels: {
    subscribe: "Obuna boʻling",
    new: "Yangi",
    link: "Havola pastda",
    part2: "2-qism",
  },
  edgeLegend: "Video chekkasi",
  edges: { bottom: "Pastda", top: "Tepada" },
  progressNote:
    "Chiziq video kengligicha va koʻrsatilish vaqti davomida chapdan oʻngga toʻlib boradi: birinchi kadrda boʻsh, oxirgisida toʻliq. U faqat ravon paydo boʻlishi yoki yoʻqolishi mumkin va harakatlanmaydi.",
  pillNote:
    "Oldindan koʻrishda yorliq kengligi taxminiy; eksport qilingan faylda harflar aniq oʻlchanadi.",
  moveTitle: "Oxirgi joyga harakat",
  moveToggle: "Koʻrsatilayotganda harakatlansin",
  moveEndX: "Tugash joyi, chapdan oʻngga",
  moveEndY: "Tugash joyi, yuqoridan pastga",
  moveEndW: "Tugash oʻlchami",
  moveSame: "Boshidagidek",
  moveHint:
    "Shakl koʻrsatilish vaqti davomida yuqoridagi joy va oʻlchamdan shu qiymatlarga toʻgʻri chiziq boʻylab oʻtadi. Uni ravon paydo qilish yoki yoʻqotish uchun paydo boʻlish va yoʻqolishdan foydalaning.",
  layerHint: "Keyingi shakllar oldingilarning ustiga chiziladi.",
  delete: "Shaklni oʻchirish",
  reset: "Joylashuv, oʻlcham va shaffofmaslikni tiklash",
  track: "Shakllar",
  clipLabel: "Shakl {n}: {kind}, {from} dan {to} gacha",
  handle:
    "Shakl {n} oldindan koʻrishda. Strelkalar uni 1% ga, Shift + strelka 5% ga suradi.",
  keysHint:
    "Oldindan koʻrishda shakl ramkasini tanlang va strelkalar bilan suring yoki sudrang.",
  previewNote:
    "Shakllar rasmlar ustiga, matn ostiga chiziladi. Oldindan koʻrish eksportga yaqin; etalon — eksport qilingan fayl.",
  pastEnd: "Bu shakl video tugaganidan keyin boshlanadi, shuning uchun koʻrinmaydi.",
  cutEnd: "Bu shakl video oxiridan oshib ketadi; qolgani kesiladi.",
  invisible: "Shaffofmaslik 0, shuning uchun shakl koʻrinmaydi.",
  shapesFull: "Loyihada koʻpi bilan {max} ta shakl boʻlishi mumkin.",
  budgetMemory:
    "Bu shakl sigʻmaydi: eksport bu kadr oʻlchamida cheklangan miqdorni chiza oladi (taxminan {need} MB kerak, {max} MB bor). Boshqa shakllarni kichraytiring yoki bittasini oʻchiring.",
  budgetTime:
    "Bu shakl sigʻmaydi: eksport taxminan {work} s oladi, {length} s li video uchun esa {allowed} s ajratilgan. Kamroq yoki kichikroq shakllardan foydalaning yoki videoni uzunroq qiling.",
  budgetUse:
    "Shakllar eksport shu kadr oʻlchamida chiza oladigan hajmning {pct}% ini ishlatmoqda. Chegarada shakl kattalashmay qoladi.",
  settledNarrowed: "Eksport barcha shakllarni chiza olishi uchun {n}-shakl torroq qilindi.",
  settledRemoved:
    "Bu oʻlchamda eksport barcha shakllarni chiza olmasligi uchun {n}-shakl oʻchirildi. «Bekor qilish» uni qaytaradi.",
  layersFull:
    "Rasmlar va shakllar birgalikda koʻpi bilan {max} qatlam egallaydi, shuning uchun yana qoʻshib boʻlmaydi.",
};
