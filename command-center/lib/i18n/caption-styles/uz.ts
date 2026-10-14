import type { captionStylesEn } from "./en";

/** Subtitrlarning animatsiyali uslublari. Manba — ./en.ts. */
export const captionStylesUz: typeof captionStylesEn = {
  heading: "Animatsiyali uslub",
  hint: "Barcha subtitrlar uchun tayyor uslubni tanlang. Ranglar, oʻlcham va joyni oʻzgartirish mumkin. Bu bepul.",
  previewNote:
    "Koʻrib chiqishda animatsiya taxminan koʻrsatiladi. Tayyor videoda uslub aynan belgilanganidek koʻrinadi.",
  needCues: "Avval subtitr qoʻshing. Uslub mavjud subtitrlarga qoʻllanadi.",
  plain: "Oddiy",
  plainNote: "Animatsiyasiz",
  sample: "Aa",
  current: "Uslub: {name}",
  reset: "Uslubning oʻz koʻrinishiga qaytarish",
  tweaks: {
    color: "Matn rangi",
    highlight_color: "Ajratish rangi",
    size: "Oʻlcham",
    y: "Joylashuv",
    yValue: "Yuqoridan {n}%",
  },
  styles: {
    karaoke: "Soʻzma-soʻz",
    pop_in: "Sakrab chiqish",
    boxed: "Qutichada",
    big_centre: "Markazda yirik",
    lower_third: "Pastki plashka",
    outlined: "Kontur bilan",
    neon: "Neon yorugʻi",
    typewriter: "Yozuv mashinkasi",
    line_slide: "Pastdan siljish",
    clean: "Toza",
  },
  notes: {
    karaoke: "Har bir soʻz aytilayotganda ajratish rangi bilan toʻladi",
    pop_in: "Har bir subtitr yengil sakrab chiqadi",
    boxed: "Qora plashka, joriy soʻz rangli plashkada",
    big_centre: "Oʻrtada yirik matn, bir vaqtda bitta soʻz ajratiladi",
    lower_third: "Pastki chapda rangli plashka siljib kiradi",
    outlined: "Qalin harflar, rangli yoʻgʻon kontur",
    neon: "Yumshoq yonib turuvchi harflar",
    typewriter: "Harflar birin-ketin paydo boʻladi",
    line_slide: "Har bir subtitr pastdan siljib, sekin paydo boʻladi",
    clean: "Ingichka, oq matn va yumshoq soya",
  },
};
