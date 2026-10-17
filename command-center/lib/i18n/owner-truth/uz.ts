import type { OwnerTruthDictionary } from "./en";

/** Egasi ekranlari xato yoki nomaʼlum holatda nima deydi: sessiya tugadi, amal bajarilmadi, maʼlumot oʻqilmadi. Manba — ./en.ts. */
export const ownerTruthUz: OwnerTruthDictionary = {
  sessionEnded: "Sessiyangiz tugadi, shuning uchun hech narsa oʻzgarmadi. Qayta kiring va amalni takrorlang.",
  signInAgain: "Qayta kirish",
  mfaRequired: "Avval autentifikator kodini kiriting (buning uchun qayta kiring), keyin amalni takrorlang. Hech narsa oʻzgarmadi.",
  forbidden: "Bu hisobga bu amalga ruxsat yoʻq. Hech narsa oʻzgarmadi.",
  serverError: "Server buni bajara olmadi. Bir daqiqadan soʻng qayta urinib koʻring.",
  notRecorded: "Server saqlamadi. Qayta urinib koʻring.",
  offline: "Server bilan aloqa yoʻq. Internetni tekshirib, qayta urinib koʻring.",
  checkBeforeRetry: "Bajarilganiga ishonchingiz komil boʻlmasa, qayta urinishdan oldin tarixni tekshiring.",
  sessionBar: "Sessiyangiz tugadi. Davom etish uchun qayta kiring.",
  accessErrorTitle: "Maʼlumotlar bazasiga ulanib boʻlmadi",
  accessErrorBody: "Ruxsatingizni hozir tekshirib boʻlmadi. Hisobingiz joyida, hech narsa oʻzgarmadi. Qayta urinib koʻring.",
  accessErrorRetry: "Qayta urinish",
  accessErrorWorking: "Tekshirilmoqda…",
  signOutFailed: "Bu telefonda chiqib boʻlmadi. Brauzer oynasini yoping va qayta urinib koʻring.",
};
