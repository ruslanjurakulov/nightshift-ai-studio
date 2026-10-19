import type { ConfirmSheetsDictionary } from "./en";

/** Egasining bir bosishda ishlab ketadigan amallari uchun tasdiqlash oynalari. Manba — ./en.ts. */
export const confirmSheetsUz: ConfirmSheetsDictionary = {
  dChannel: "Kanal",
  dNow: "Hozir",
  dAfter: "Keyin",
  dVideo: "Video",
  dRequestedBy: "Soʻragan",
  dAccount: "Akkaunt",
  dRole: "Rol",
  dKey: "API kaliti",
  dEffect: "Nima oʻzgaradi",
  dAutoPublish: "Avto nashr",
  dExtraBalance: "Hisobdagi qoʻshimcha kreditlar",

  autoOnTitle: "«{name}» uchun avto nashr yoqilsinmi?",
  autoOnBody:
    "Videolar sizdan soʻramasdan nashr qilinadi. Video nashr darvozasidan oʻtishi bilan oʻzi ommaviy boʻladi va uni hech kim oldindan tasdiqlamaydi. Darvoza ishlashda davom etadi, lekin u yagona qolgan toʻsiq.",
  autoOnConfirm: "Avto nashrni yoqish",
  autoOnWord: "NASHR",
  autoModeAsk: "Avval sizdan soʻraydi",
  autoModeSelf: "Oʻzi nashr qiladi",

  pauseTitle: "«{name}» pauzaga qoʻyilsinmi?",
  pauseBody: "Rejalashtiruvchi bu kanalni davom ettirmaguningizcha oʻtkazib yuboradi, shuning uchun yangi videolar yaratilmaydi. Videolar va tarix saqlanadi.",
  pauseConfirm: "Pauzaga qoʻyish",
  resumeTitle: "«{name}» davom ettirilsinmi?",
  resumeBody:
    "Rejalashtiruvchi bu kanal uchun jadvali boʻyicha yana video yarata boshlaydi. Har bir ishga tushirish kreditlar yoki provayder limitlarini sarflaydi.",
  resumeConfirm: "Kanalni davom ettirish",
  resumeAutoOn: "Bu kanalda avto nashr yoqilgan, shuning uchun u yaratgan narsa sizdan soʻramasdan ommaviy boʻlishi mumkin.",

  reviewOffTitle: "«{name}» uchun storyboard tekshiruvi oʻchirilsinmi?",
  reviewOffBody:
    "Ishga tushirishlar rejadan toʻgʻri renderga oʻtadi. Render uchun toʻlanishidan oldin narxni tasdiqlash endi sizdan soʻralmaydi.",
  reviewOffConfirm: "Tekshiruvni oʻchirish",

  extraOnTitle: "Qoʻshimcha kreditlar sarflansinmi?",
  extraOnBody:
    "Tarif kreditlari tugaganda yangi ishga tushirishlar rad etilmasdan, siz sotib olgan kreditlar hisobidan davom etadi. Bu siz toʻlagan kreditlarni sarflaydi.",
  extraOnConfirm: "Qoʻshimcha kreditlarni yoqish",
  extraOnWord: "SARFLASH",

  approveTitle: "«{video}» tasdiqlansinmi?",
  approveBody: "Bu videoning ommaviy boʻlishiga ruxsat beradi. Nashr darvozasi baribir uning oldida ishlaydi.",
  approveConfirm: "Tasdiqlash",
  rejectTitle: "«{video}» rad etilsinmi?",
  rejectBody:
    "Video ommaviy boʻlishga tasdiqlanmadi. Soʻrov rad etilgan sifatida yopiladi, qayta soʻrash uchun yangi soʻrov kerak.",
  rejectConfirm: "Rad etish",

  rvApproveTitle: "«{title}» tasdiqlansinmi?",
  rvApproveBody:
    "Bu videoning aynan shu versiyasini tasdiqlaganingizni yozib qoʻyadi. Video bundan ommaviy boʻlmaydi: u shaxsiy holda yuklangan va siz uni YouTube’da ommaviy qilmaguningizcha shaxsiy qoladi. Tasdiq 24 soat amal qiladi va video qayta renderlansa yoki tuzatilsa, tugaydi.",
  rvApproveAck: "Huquqlar va sunʼiy intellekt kontenti belgilarini tekshirdim.",
  rvApprovePublishBody: "Bu videoning aynan shu versiyasini tasdiqlaganingizni yozib qoʻyadi, bu kanalda esa “Tasdiqdan keyin nashr qilish” yoqilgan. Shundan keyin ishchi dastur hamma narsani yana tekshiradi va YouTube’dan videoni ommaviy qilishni soʻraydi, 24 soat ichida. YouTube uni baribir shaxsiy qoldirishi mumkin, bu sahifa esa YouTube xabar qilgan holatni koʻrsatadi. Video qayta renderlansa yoki tuzatilsa, tasdiq tugaydi. Bu sozlamani kanal uchun istalgan payt oʻchirib qoʻyish mumkin.",
  rvApprovePublishEffect: "Videoni ommaviy qilish soʻrovini navbatga qoʻyadi",
  publishOnTitle: "“{name}” uchun “Tasdiqdan keyin nashr qilish” yoqilsinmi?",
  publishOnBody: "Siz yoki jamoadoshingiz bu kanaldagi videoni tasdiqlaganda, ishchi dastur uni yana tekshiradi va YouTube’dan shu videoni ommaviy qilishni soʻraydi — qoʻshimcha qadamsiz. Tasdiq baribir aynan koʻrilgan versiyaga bogʻlanadi va 24 soat amal qiladi; nashr darvozasi va boshqa tekshiruvlar baribir oʻtishi kerak. YouTube videoni baribir shaxsiy qoldirishi mumkin, har bir video sahifasi esa YouTube xabar qilgan holatni koʻrsatadi. Standart boʻyicha oʻchiq va uni istalgan payt oʻchirib qoʻyish mumkin.",
  publishOnConfirm: "Yoqish",
  publishOnWord: "NASHR",
  publishOnModeRecord: "Faqat qaroringizni yozib qoʻyadi",
  publishOnModePublish: "Videoni nashr uchun navbatga qoʻyadi",
  dVersion: "Versiya",
  staleSheet: "Savol ochiq turganda bu oʻzgardi, shuning uchun hech narsa yuborilmadi. Uni qayta oching va tekshiring.",

  apiActivateTitle: "API yoqilsinmi?",
  apiActivateBody:
    "Shundan keyin API kalitlarini yaratish mumkin. Kalitli dastur siz belgilagan limitlar doirasida oldindan toʻlangan API balansini sarflay oladi. Siz API shartlarini qabul qilasiz.",
  apiActivateConfirm: "API yoqish",
  limitOrgTitle: "Oylik API limiti oʻzgartirilsinmi?",
  limitKeyTitle: "«{name}» kalitining oylik limiti oʻzgartirilsinmi?",
  limitBody: "Oy davomidagi API xarajati yangi limitga yetganda API chaqiruvlari rad etiladi.",
  limitConfirm: "Limitni oʻzgartirish",
  limitNone: "Limitsiz",
  limitPlanCeiling: "Belgilanmagan, tarifning {cap} chegarasi amal qiladi",
  limitUp: "Yuqoriroq: API orqali oyiga koʻproq sarflash mumkin.",
  limitDown: "Pastroq: chaqiruvlar tezroq rad etiladi.",
  limitSame: "Hozirgidek: hech narsa oʻzgarmaydi.",
  limitOrgBlocked: "$0 limit bu akkauntdan barcha API chaqiruvlarini siz uni oshirmaguningizcha bloklaydi.",
  limitKeyRemoved: "Limit olib tashlanadi: bu kalitni faqat akkaunt limitlari cheklaydi.",
  limitKeySet: "Limit qoʻshiladi: kalit unga yetganda toʻxtaydi.",
  limitKeyBlocked: "$0 limit bu kalit bilan qilingan barcha chaqiruvlarni siz uni oshirmaguningizcha bloklaydi.",
  limitCeilingBinds: "Siz {entered} kiritdingiz, lekin tarifingiz chegarasi {cap}, shuning uchun {cap} amal qiladi.",

  claimTitle: "Oʻzingizni egasi qilasizmi?",
  claimBody:
    "Siz bu ish maydonining egasi boʻlasiz: kalitlar, provayderlar, kreditlar va jamoaga toʻliq kirish huquqi bilan. Oʻz rolingizni keyin bu yerdan oʻzgartirib boʻlmaydi: buni faqat boshqa ega qila oladi.",
  claimConfirm: "Ega boʻlish",
};
