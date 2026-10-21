import type { AiLabelDictionary } from "./en";

export const aiLabelUz: AiLabelDictionary = {
  title: "Sunʼiy intellekt kontenti belgisi",
  intro:
    "Har bir video YouTube, Instagram va TikTokʼga “oʻzgartirilgan yoki sunʼiy kontent” belgisi bilan yuboriladimi. Avtomatik rejimda har bir video uchun qaror uning mazmuniga qarab chiqariladi.",
  modeLabel: "Yuklashdagi belgi",
  modeOptions: {
    auto: "Avtomatik (tavsiya etiladi)",
    always: "Doim belgilansin",
    never: "Hech qachon belgilanmasin",
  },
  modeHint: "Avtomatik rejimda sunʼiy intellekt yaratgan real koʻrinishdagi video, rasm yoki boshlovchi bor videolar hamda kelib chiqishi nomaʼlum videolar belgilanadi.",
  voiceLabel: "Diktor ovozi",
  voiceOptions: {
    generic: "Oddiy matndan nutq ovozi",
    own_clone: "Oʻzimning klonlangan ovozim",
    real_person: "Boshqa real odamning ovozi (klon yoki oʻxshash)",
  },
  voiceHint: "Tizim ovozni eshita olmaydi, shuning uchun shu sozlamaga tayanadi. Haqiqatda ishlatilayotgan ovozni tanlang.",
  locked: "Yopiq",
  lockedNote:
    "“Hech qachon belgilanmasin” va “Oʻzimning klonlangan ovozim” platformalarga aytiladigan maʼlumotni kamaytiradi, shuning uchun ularni faqat platforma jamoasi belgilay oladi. Birini oʻzgartirish uchun platforma jamoasiga murojaat qiling.",
  currentLocked: "Bu kanalda faqat platforma jamoasi oʻzgartira oladigan sozlama bor. Uni boshqa variantga almashtirishingiz mumkin.",
  noAccess: "Buni oʻzgartirishga ruxsatingiz yoʻq.",
  saving: "Saqlanmoqda…",
  saved: "Saqlandi.",
  saveFailed: "Bu sozlamani saqlab boʻlmadi.",
  lockRefused: "Bu variantni platforma jamoasi belgilaydi, shuning uchun saqlanmadi. Qolgan sozlamalaringiz oʻzgarmadi.",
};
