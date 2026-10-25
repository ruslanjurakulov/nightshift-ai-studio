import type { ModelKeysDictionary } from "./en";

/** «Model API kalitlari» sahifasi (/{channel}/model-keys): egasi yetkazib beruvchining API kalitini qoʻyadi, server uni yetkazib beruvchida tekshiradi va UNUTADI. Manba — ./en.ts. */
export const modelKeysUz: ModelKeysDictionary = {
  title: "Model API kalitlari",
  subtitle: "Yetkazib beruvchi kalitni qabul qilishini koʻrish uchun uning API kalitini qoʻying. Kalit tekshiriladi va darhol unutiladi: hech narsa saqlanmaydi.",
  nothingStored: "Hech narsa saqlanmaydi. Kalit yetkazib beruvchida tekshiriladi va tashlab yuboriladi: u saqlanmaydi, jurnalga yozilmaydi va qayta koʻrsatilmaydi.",
  off: {
    title: "Model API kalitlari oʻchirilgan",
    body: "NIGHTSHIFT_MODEL_KEYS server kaliti “on” emas, shuning uchun bu sahifa hech narsa oʻqimaydi va kalitni tekshirib boʻlmaydi. Hech narsa oʻzgarmadi.",
  },

  status: {
    not_checked: "Tekshirilmagan",
    checking: "Tekshirilmoqda…",
    verified: "API tasdiqlandi",
    rejected: "Yetkazib beruvchi rad etdi",
    format_only: "Faqat format",
    could_not_reach: "Yetkazib beruvchiga ulanib boʻlmadi — qayta urining",
  },

  card: {
    getKey: "Kalit olish",
    getKeyHint: "Yetkazib beruvchining oʻz sahifasini yangi oynada ochadi.",
    linkUnverified: "Kalit sahifasi havolasi tasdiqlanmagan — uni yetkazib beruvchining oʻz konsolidan toping.",
    docs: "Yetkazib beruvchi hujjatlari",
    howHttp: "Hech narsa yaratmaydigan bitta bepul soʻrov bilan tekshiriladi: {host} manzilida GET {path}.",
    howFormat: "Bu yetkazib beruvchi uchun bepul tekshiruv maʼlum emas. Kalit bu yerdan yetkazib beruvchiga yuborilmaydi; faqat uning koʻrinishi tekshiriladi.",
    formatOnlyNote: "Kalit formati toʻgʻri koʻrinadi; pullik chaqiruvsiz tekshirib boʻlmaydi.",
    pairedHint: "Bu yetkazib beruvchi soʻrovlarni ikki qism bilan imzolaydi. Ularni access_key:secret_key koʻrinishida qoʻying.",
    keyLabel: "API kalit",
    verify: "Tekshirish",
    useIt: "Hech narsa saqlanmaydi. Tekshirilgan kalitdan foydalanish uchun uni GitHub Actions sirlariga va ishchi muhitiga {names} nomi bilan qoʻshing.",
  },

  verdict: {
    verified: "API soat {time} da tasdiqlandi. Kalit saqlanmadi.",
    format_only: "Faqat format, soat {time} da. Yetkazib beruvchi bu kalitni tekshirmadi va u saqlanmadi.",
    rejected: "Yetkazib beruvchi bu kalitni qabul qilmadi (soat {time} da). Kalit saqlanmadi.",
    rejectedScoped: "Faqat baʼzi usullarga cheklangan kalitni bu tekshiruv ham rad etishi mumkin.",
    rejectedRegion: "Tekshiruv yetkazib beruvchining Singapur manzilida oʻtadi; boshqa mintaqaning haqiqiy kaliti u yerda rad etiladi.",
    couldNotReach: "Yetkazib beruvchini tekshirib boʻlmadi (soat {time} da). Kalit saqlanmadi. Bir ozdan keyin qayta urinib koʻring.",
  },
  reason: {
    timeout: "Yetkazib beruvchi oʻz vaqtida javob bermadi.",
    network: "Yetkazib beruvchi bilan aloqa oʻrnatilmadi.",
    rate_limited: "Yetkazib beruvchi soʻrovlar juda koʻpligini aytmoqda.",
    vendor_error: "Yetkazib beruvchida oʻz tomonidan xato yuz berdi.",
    redirect: "Yetkazib beruvchi yoʻnaltirish bilan javob berdi, unga hech qachon ergashilmaydi.",
    unexpected_response: "Yetkazib beruvchining javobi hujjatida taʼriflanganidek emas, shuning uchun xulosa qilinmadi.",
  },

  source: {
    label: "Ishga tushirishlar oladigan kalit",
    env: "{names} GitHub siri oʻrnatilgan. Ishga tushirishlar shu kalitdan foydalanadi.",
    none: "{names} GitHub siri oʻrnatilmagan. Bu yetkazib beruvchi kerak boʻlgan ishga tushirishlar hech narsa sarflamasdan toʻxtaydi.",
    unknown: "GitHub sirlari nomlarini oʻqib boʻlmadi (GitHub sozlanmagan yoki javob bermadi), shuning uchun sahifa hech narsa daʼvo qilmaydi.",
  },

  err: {
    unauthorized: "Seans tugadi. Qaytadan kiring.",
    forbidden: "Bu yerda yetkazib beruvchi kalitini faqat platforma egasi tekshira oladi.",
    mfa_required: "Autentifikator kodini yana tasdiqlang (kiring va kodni kiriting), soʻng qayta urining.",
    mfa_recent_required: "Autentifikator kodini yana kiriting (chiqib, qayta kiring), soʻng qayta urining.",
    mfa_enrol_required: "Avval Xavfsizlik sahifasida autentifikator qoʻshing.",
    rate_limited: "Urinishlar juda koʻp. Bir necha daqiqa kuting va qayta urining.",
    not_found: "Bu funksiya serverda oʻchirilgan.",
    bad_request: "Soʻrov tushunilmadi.",
    unknown_provider: "Bunday yetkazib beruvchi roʻyxatda yoʻq.",
    bad_key: "Bu sahifa bunday koʻrinishdagi kalitni tekshirmaydi.",
    verify_failed: "Tekshiruvni bajarib boʻlmadi. Kalit saqlanmadi.",
    network: "Server javob bermayapti. Ulanishni tekshiring.",
    server: "Server buni bajara olmadi. Qayta urinib koʻring.",
    session: "Seans tugadi. Qaytadan kiring.",
  },
  keyReason: {
    empty: "Avval kalitni qoʻying.",
    too_short: "API kalit uchun bu juda qisqa.",
    too_long: "API kalit uchun bu juda uzun.",
    bad_shape: "Kalit — harf, raqam va belgilardan iborat bitta boʻlak: boʻshliqsiz va $ ` \" ' \\ belgilarisiz.",
    bad_pair: "Ikkala qismni access_key:secret_key koʻrinishida qoʻying.",
  },
};
