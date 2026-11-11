import type { ModelBudgetDictionary } from "./en";

/**
 * Egasining «Narxlar va byudjet» koʻrinishi (/{channel}/models?view=budget). Manba — ./en.ts.
 * TARJIMA QORALAMASI: matnni til sohibi yozmagan, til sohibi oʻqib chiqishi kerak.
 */
export const modelBudgetUz: ModelBudgetDictionary = {
  viewBudget: "Narxlar va byudjet",
  title: "Model narxlari va byudjet",
  subtitle:
    "Reestrdagi har bir model va uning yetkazib beruvchisi bizdan qancha olishi, hamda kalkulyator: dollarda summa yozing va unga taxminan nima olish mumkinligini koʻring. Bu sahifani faqat siz, platforma egasi koʻrasiz. Bu yerda hech narsa sarflanmaydi va oʻzgarmaydi.",
  notEnabled: "Modellar reestri hali bazada yoʻq (0035-migratsiya), koʻrsatadigan narsa yoʻq.",
  failed: "Reestrni oʻqib boʻlmadi, shuning uchun taxmin oʻrniga hech narsa koʻrsatilmadi. Qayta urinib koʻring.",
  empty: "Reestrda hali model yoʻq. Ularni schemas/model_registry.json dan tools/probe_models.py --sync bilan yuklang.",
  pricesUnread: "Narxlar roʻyxatini oʻqib boʻlmadi: mijoz narxlari bu yerda nomaʼlum, yoʻq degani emas.",
  rules: {
    title: "Kalkulyator qanday hisoblaydi",
    items: [
      "Narx — reestr faylidagi yetkazib beruvchining birlik uchun roʻyxat narxi (bitta rasm, bir soniya, bitta belgi). Bu biz toʻlaydigan narx, mijozniki emas.",
      "«Taxminiy» degani reestr bu narxni hisob-faktura bilan tasdiqlamagan.",
      "Video model chiqaradigan eng qisqa uzunlik va standart oʻlcham (yoki reestrning asosiy narxi) boʻyicha hisoblanadi; qayta hisoblash uchun boshqa variant yoki uzunlikni tanlang.",
      "Reestr minimal toʻlovni koʻrsatsa (har bir ish uchun kamida shuncha soniya), har bir ish kamida shuncha uzunlikda hisoblanadi.",
      "Barcha raqamlar pastga yaxlitlangan. Kiruvchi rasmlar, tokenlar, ovoz va muvaffaqiyatsiz ishlar haqiqiy hisobni oʻzgartirishi mumkin: haqiqat — yetkazib beruvchining hisob-fakturasi.",
    ],
  },
  kinds: { video: "Video", image: "Rasmlar", audio: "Ovoz va musiqa", other: "Boshqa (matn va transkripsiya)" },
  count: "Modellar: {n}",
  status: {
    hidden: "Yashirin",
    beta: "Beta",
    ga: "Sotuvda (GA)",
    disabled: "Oʻchirilgan",
    unknown: "Holati nomaʼlum",
    terms: "Yetkazib beruvchi shartlarini kutmoqda",
    pastShutdown: "Yetkazib beruvchi oʻchirgan ({date})",
    shutdown: "Yetkazib beruvchi {date} da oʻchiradi",
  },
  vendorCost: "Bizning narx",
  estimate: "taxminiy",
  asOf: "{date} da oʻqilgan",
  noPrice: "reestrda narx yoʻq",
  perUnit: { image: "har bir rasm uchun", second: "har soniya uchun", character: "har bir belgi uchun", request: "har bir soʻrov uchun" },
  customer: "Mijoz narxi",
  customerNone: "belgilanmagan",
  customerUnread: "nomaʼlum",
  credits: "{n} kredit {unit}",
  option: "Variant",
  optionBase: "Asosiy narx",
  optionBaseSame: "Asosiy narx ({keys} bilan bir xil)",
  variantWords: { silent: "ovozsiz", audio: "ovozli", low: "past", medium: "oʻrta", high: "yuqori" },
  length: "Uzunlik",
  seconds: "{n} s",
  budget: "Byudjet ($)",
  budgetPlaceholder: "masalan, 10",
  notAmount: "Bu summa emas. Dollarni 10 yoki 10,5 kabi, minglik ajratgichlarsiz yozing.",
  forAmount: "({amount} uchun)",
  startsOn: {
    default_resolution: "Standart oʻlcham boʻyicha hisoblandi.",
    base: "Reestrning asosiy narxi boʻyicha hisoblandi.",
    cheapest_variant: "Narxi bor eng arzon variant boʻyicha hisoblandi.",
  },
  shortest: "Model chiqaradigan eng qisqa uzunlik boʻyicha hisoblandi.",
  result: {
    videos: "{d} soniyalik video: ≈ {n} ta (jami ≈ {m} daqiqa)",
    billed: "har biri {b} s sifatida hisoblanadi",
    minutes: "≈ {m} daqiqa",
    clips: "{d} soniyalik parcha: ≈ {n} ta",
    floor: "yetkazib beruvchi har bir ish uchun kamida {f} s oladi",
    images: "Rasmlar: ≈ {n} ta",
    characters: "Ovozlashtirish belgilari: ≈ {n} ta",
    requests: "Soʻrovlar: ≈ {n} ta",
  },
  unpriced: "Reestrda narxi yoʻq: {keys}",
};
