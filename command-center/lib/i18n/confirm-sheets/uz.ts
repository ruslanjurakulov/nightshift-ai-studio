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

  rvApproveTitle: "«{title}» uchun tasdigʻingiz yozib qoʻyilsinmi?",
  rvApproveBody:
    "Bu videoni tasdiqlaganingizni yozib qoʻyadi. U nashr qilinmaydi: video shaxsiy holda yuklangan va siz uni YouTube’da ommaviy qilmaguningizcha shaxsiy qoladi. Hozircha hech narsa avtomatik bajarilmaydi.",
  rvRegenTitle: "«{title}» qaytadan renderlansinmi?",
  rvRegenBody:
    "Bu videoni qayta renderlash soʻrovingizni yozib qoʻyadi. Hozircha hech narsa renderlanmaydi: hech bir ishga tushirish bu soʻrovni olmaydi, shuning uchun hech narsa sarflanmaydi va video oʻz holicha qoladi.",
  rvScriptTitle: "«{title}» uchun yangi ssenariy yozilsinmi?",
  rvScriptBody:
    "Bu yangi ssenariy va yangi video soʻrovingizni yozib qoʻyadi. Hozircha hech narsa yozilmaydi va renderlanmaydi: hech bir ishga tushirish bu soʻrovni olmaydi, shuning uchun hech narsa sarflanmaydi va video oʻz holicha qoladi.",
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
