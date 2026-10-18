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
  dPrivacy: "Hozirgi kirish",
  dGate: "Joylashdan oldingi tekshiruv",
  dAutoPublish: "Avto joylash",
  dExtraBalance: "Hisobdagi qoʻshimcha kreditlar",

  autoOnTitle: "«{name}» uchun avto joylash yoqilsinmi?",
  autoOnBody:
    "Videolar sizdan soʻramasdan joylanadi. Video joylashdan oldingi tekshiruvdan oʻtishi bilan oʻzi ommaviy boʻladi va uni hech kim oldindan tasdiqlamaydi. Tekshiruv ishlashda davom etadi, lekin u yagona qolgan toʻsiq.",
  autoOnConfirm: "Avto joylashni yoqish",
  autoOnWord: "NASHR",
  autoModeAsk: "Avval sizdan soʻraydi",
  autoModeSelf: "Oʻzi joylaydi",

  pauseTitle: "«{name}» pauzaga qoʻyilsinmi?",
  pauseBody: "Rejalashtiruvchi bu kanalni davom ettirmaguningizcha oʻtkazib yuboradi, shuning uchun yangi videolar yaratilmaydi. Videolar va tarix saqlanadi.",
  pauseConfirm: "Pauzaga qoʻyish",
  resumeTitle: "«{name}» davom ettirilsinmi?",
  resumeBody:
    "Rejalashtiruvchi bu kanal uchun jadvali boʻyicha yana video yarata boshlaydi. Har bir ishga tushirish kreditlar yoki provayder limitlarini sarflaydi.",
  resumeConfirm: "Kanalni davom ettirish",
  resumeAutoOn: "Bu kanalda avto joylash yoqilgan, shuning uchun u yaratgan narsa sizdan soʻramasdan ommaviy boʻlishi mumkin.",

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
  approveBody: "Bu videoning ommaviy boʻlishiga ruxsat beradi. Joylashdan oldingi tekshiruv baribir uning oldida ishlaydi.",
  approveConfirm: "Tasdiqlash",
  rejectTitle: "«{video}» rad etilsinmi?",
  rejectBody:
    "Video ommaviy boʻlishga tasdiqlanmadi. Soʻrov rad etilgan sifatida yopiladi, qayta soʻrash uchun yangi soʻrov kerak.",
  rejectConfirm: "Rad etish",

  rvApproveTitle: "«{title}» tasdiqlanib, joylansinmi?",
  rvApproveBody:
    "Siz konveyerdan videoni keyingi ishga tushirishda ommaviy qilishni soʻraysiz. Joylashdan oldingi tekshiruv birinchi ishlaydi, u toʻxtatgan video chiqmaydi.",
  rvApproveConfirm: "Tasdiqlash va joylash",
  rvRegenTitle: "«{title}» qaytadan renderlansinmi?",
  rvRegenBody: "Keyingi ishga tushirish bu videoni boshidan qayta renderlaydi. Bu yangi renderga tushadi.",
  rvRegenConfirm: "Qaytadan renderlash",
  rvScriptTitle: "«{title}» uchun yangi ssenariy yozilsinmi?",
  rvScriptBody:
    "Keyingi ishga tushirish yangi ssenariy yozadi va u boʻyicha yangi video renderlaydi. Bu yangi ssenariy va yangi renderga tushadi.",
  rvScriptConfirm: "Yangi ssenariy, yangi video",

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
  limitRemoved: "Limit olib tashlanadi: bu kalitni faqat akkaunt limitlari cheklaydi.",
  limitSet: "Limit qoʻshiladi: kalit unga yetganda toʻxtaydi.",

  claimTitle: "Oʻzingizni egasi qilasizmi?",
  claimBody:
    "Siz bu ish maydonining egasi boʻlasiz: kalitlar, provayderlar, kreditlar va jamoaga toʻliq kirish huquqi bilan. Oʻz rolingizni keyin bu yerdan oʻzgartirib boʻlmaydi: buni faqat boshqa ega qila oladi.",
  claimConfirm: "Ega boʻlish",
};
