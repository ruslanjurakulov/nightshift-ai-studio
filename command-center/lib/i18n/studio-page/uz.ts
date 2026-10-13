import type { StudioPageDictionary } from "./en";

/** Ommaviy /studio sahifasi («Nimalar yaratish va tahrirlash mumkin»). Manba — ./en.ts. */
export const studioPageUz: StudioPageDictionary = {
  meta: {
    title: "Nimalar yaratish va tahrirlash mumkin · Nightshift",
    description:
      "Video yaratilishidan oldin rejani oʻqing, oʻz videolaringizni muharrirda bepul tahrirlang, har bir yuklashni tasdiqlaguningizcha shaxsiy saqlang va har qanday sarfdan oldin narxni koʻring.",
  },
  hero: {
    label: "Studiya",
    title: "Nimalar yaratish va tahrirlash mumkin.",
    lead: "Nightshift mavzudan YouTube uchun video yaratadi, toʻlovdan oldin rejani oʻqishga imkon beradi va oʻz montajlaringiz uchun muharrir beradi. Bu sahifada mahsulotda bugun mavjud narsalar sanab oʻtilgan va qaysi vosita avval sozlanishi kerakligi aytilgan.",
    cta: "Bepul boshlash",
    secondary: "Narxlarni koʻrish",
    jumpLabel: "Shu sahifada",
    jump: [
      { id: "plan", label: "Reja" },
      { id: "editor", label: "Muharrir" },
      { id: "publish", label: "Nashr" },
      { id: "price", label: "Narx" },
      { id: "faq", label: "Savollar" },
    ],
  },
  example: "Namuna",
  plan: {
    label: "Avval reja",
    title: "Hech narsa yaratilishidan oldin rejani oʻqing.",
    lead: "Video mavzu va siz koʻrib turgan narxdan boshlanadi. Buni yoqqan kanalda ish ssenariy va sahnalar rejasidan keyin toʻxtab, sizni kutadi.",
    items: [
      { id: "price", title: "Narx — boshlanishidan oldin", body: "Video qancha turishini boshlanishdan oldin koʻrasiz va yana bir bor tasdiqlaysiz. Oraliqda narx oʻzgarsa, sizdan yana soʻraladi." },
      { id: "review", title: "Raskadrovkani koʻrib chiqish", body: "Uni kanal uchun yoqing — kanal ishlari «Raskadrovka tayyor» bosqichida toʻxtaydi. Siz tasdiqlamaguningizcha hech narsa renderlanmaydi va render uchun yechilmaydi." },
      { id: "edit", title: "Rejani oʻzgartirish", body: "Sahnaning diktor matnini yoki kadr tavsifini tahrirlang, sahnalarni surib qoʻying, bittasini oʻchiring yoki qoʻshing. Saqlang — narx yangilanadi." },
      { id: "no", title: "Rad etish bepul", body: "Raskadrovkani rad eting — hech narsa renderlanmaydi va yechilmaydi." },
    ],
    figure:
      "Koʻrib chiqishni kutayotgan raskadrovka tasviri: diktor matni va kadr tavsifi bilan uchta sahna hamda renderni tasdiqlaydigan va uning narxini koʻrsatadigan tugma. Koʻrsatilgan hamma narsa — namuna.",
    figureTitle: "Raskadrovka tayyor",
    scene: "{n}-sahna",
    narration: "Diktor matni",
    visual: "Kadr",
    scenes: [
      { narration: "Kech tushganda karvon maydonga yetib keladi.", visual: "Umumiy plan, iliq yorugʻlik" },
      { narration: "Nega barcha yoʻllar shu bitta shaharda tutashgan.", visual: "Bozor ustidan sekin panorama" },
      { narration: "Savdogarlar nima olib kelgan va nima qoldirgan.", visual: "Gazlama va ziravorlar yaqin planda" },
    ],
    approve: "Tasdiqlash va render",
    approveNote: "Narx tugmada",
    discard: "Rad etish",
  },
  editor: {
    label: "Muharrir",
    title: "Oʻz videolaringizni tahrirlang. Tahrirlash bepul.",
    lead: "Muharrir mediatekangizdagi videolar bilan ishlaydi. Tahrirlash va eksport kredit sarflamaydi, eksport mediatekaga saqlanadi va hech narsa nashr qilinmaydi.",
    items: [
      { id: "trim", title: "Qirqish va boʻlish", body: "Boshlanish va tugashni kiriting, belgini suring yoki strelka tugmalaridan foydalaning: bir kadrga, Shift bilan — bir soniyaga. Klipni kursor joyida boʻling." },
      { id: "speed", title: "Tezlik", body: "Klipni 0,5×, 0,75×, 1,25×, 1,5× yoki 2× tezlikda ijro eting." },
      { id: "crossfade", title: "Ravon oʻtish", body: "Bir klip keyingisiga 0,2 dan 2 soniyagacha ravon oʻtadi. Kliplar bir-birining ustiga tushadi, shuning uchun video shuncha qisqaradi." },
      { id: "text", title: "Ekrandagi matn", body: "Matn qoʻshing, oʻlchamini va joyini — tepada, oʻrtada yoki pastda — tanlang hamda qachon koʻrinishini belgilang." },
      { id: "sound", title: "Musiqa va tovush", body: "Mediatekadan musiqa va effektlar qoʻshing, ovoz balandligi va soʻnishni belgilang; nutq deb belgilagan tovushlaringiz va oʻz ovozi bor kliplar ostida musiqa aniq belgilangan miqdorga pasaytiriladi." },
      { id: "captions", title: "Subtitrlar", body: "Yozuvdan matn yarating, subtitrlarni tahrirlang, toʻrt koʻrinishdan birini tanlang — eksportda ular tasvirga oʻrnatiladi. .srt yoki .vtt faylini ham yuklab olish mumkin. Matnga oʻgirish — pullik bosqich: narxi boshlanishdan oldin koʻrinadi va u faqat nutqni matnga aylantirish sozlangan joyda taklif qilinadi." },
      { id: "frame", title: "Kadr shakli", body: "Butun video uchun vertikal 9:16, keng 16:9 yoki kvadrat 1:1. Vertikal shakl Shorts, Reels va TikTok uchun mos." },
      { id: "fit", title: "Sigʻdirish yoki toʻldirish — har bir klip uchun", body: "«Sigʻdirish» tasvirni butunlay koʻrsatadi va chiziqlar qoʻshadi; «Toʻldirish» chetlarini qirqadi, chiziq qolmaydi. Qirqish joyini hozircha surib boʻlmaydi." },
      { id: "drafts", title: "Qoralamalar", body: "Saqlanmagan oʻzgarishlar shu brauzerda qoralama sifatida saqlanadi va loyihani qayta ochganingizda sizga qaytariladi. Saqlash sizning tugmangiz boʻlib qoladi." },
    ],
    notes: [
      "Oldindan koʻrish taxminiy; eksport qilingan video aniq.",
      "Bitta eksport 30 daqiqagacha boʻlishi mumkin, bepul eksportlar uchun esa kunlik cheklov bor.",
    ],
    figure:
      "Muharrir tasviri: kliplari bilan uchta trek (video, matn va musiqa) hamda uchta kadr shakli — 9:16, 16:9 va 1:1. Koʻrsatilgan hamma narsa — namuna.",
    figureTitle: "Muharrir",
    tracks: { video: "Video", text: "Matn", music: "Musiqa" },
    clips: ["Boshlanish", "Bozor", "Karvon"],
    caption: "Samarqand, 1404",
    fade: "Soʻnish",
    frames: "Kadr shakli",
    crossfade: "Ravon oʻtish",
    save: "Saqlash",
    export: "Eksport",
  },
  publish: {
    label: "Nashr",
    title: "Siz aytmaguningizcha shaxsiy.",
    lead: "Nightshift siz ruxsat bermasangiz, videoni auditoriyangiz oldiga chiqarmaydi. Oxirgi qadam — sizniki.",
    items: [
      { id: "private", title: "YouTube’ga yuklamalar shaxsiy", body: "Tayyor video kanalingizga shaxsiy video sifatida yuboriladi: ommaviy boʻlguncha uni faqat siz va u bilan oʻrtoqlashgan kishilar koʻra oladi." },
      { id: "check", title: "Avval nashr tekshiruvi", body: "Har bir video tekshiruvdan oʻtadi, hukm esa video sahifasida koʻrinadi: oʻtdi yoki bloklandi va nima uchun." },
      { id: "approve", title: "Ommaviy qilish — sizning tugmangiz", body: "Siz videoni koʻrasiz va «Tasdiqlash va nashr qilish»ni bosasiz — bu keyingi ishga tushirish bajaradigan soʻrov yuboradi. Avtomatik nashr har bir kanalda alohida yoqiladi va siz yoqmaguningizcha oʻchiq turadi." },
      { id: "second", title: "Ikkinchi administrator — xohlasangiz", body: "Kanal biror narsa ommaviy boʻlishidan oldin ikkinchi administratorning tasdigʻini talab qilishi mumkin." },
    ],
    figure: "Ommaviy boʻlishdan oldingi video holati tasviri: shaxsiy holda yuklangan, nashr tekshiruvi oʻtgan, tasdigʻingizni kutmoqda. Koʻrsatilgan hamma narsa — namuna.",
    figureTitle: "Nashr pulti",
    lines: ["Shaxsiy holda yuklangan", "Nashr tekshiruvi oʻtdi", "Tasdigʻingizni kutmoqda"],
  },
  price: {
    label: "Narx",
    title: "Avval narx. Xato boʻlsa, hech narsa yechilmaydi.",
    lead: "Nightshift kreditlarda ishlaydi. Video, Studiyadagi yaratish va matnga oʻgirish — har biri narxini ishga tushirishdan oldin koʻrsatadi. Qirqish, boʻlish va muharrirning boshqa vositalari kredit sarflamaydi.",
    link: "Narx qanday hisoblanadi",
    ledgerLabel: "Narx qanday yechimga aylanadi",
  },
  faq: {
    label: "Savollar",
    title: "Boshlashdan oldin.",
    items: [
      {
        id: "pay",
        q: "Men nima uchun toʻlayman?",
        a: "Nightshift kreditlarda ishlaydi. Har bir video, Studiyadagi har bir yaratish va har bir matnga oʻgirish boshlanishdan oldin narxini kreditlarda koʻrsatadi. Kreditlar boshlanganda ushlab turiladi va tugaganda yechiladi — siz koʻrgan narxdan koʻp emas. Muharrirda tahrirlash va eksport kredit sarflamaydi.",
      },
      {
        id: "fails",
        q: "Ish xato bilan tugasa nima boʻladi?",
        a: "Uning uchun ushlab turilgan kreditlar oʻzi balansga qaytadi. Soʻrashingiz shart emas, kredit tarixida esa har bir ushlab turish, yechish va qaytarish koʻrinadi.",
      },
      {
        id: "publishes",
        q: "Mening oʻrnimga nashr qilasizmi?",
        a: "Faqat siz yoqsangiz. Tayyor videolar YouTube’ga shaxsiy holda yuklanadi va avval nashr tekshiruvidan oʻtadi. Avtomatik nashr kanal uchun siz yoqmaguningizcha oʻchiq; kanal ikkinchi administratorning tasdigʻini ham talab qilishi mumkin.",
      },
      {
        id: "languages",
        q: "U qaysi tillarda ishlaydi?",
        a: "Ilova oʻzbek, rus va ingliz tillarida. Har bir kanalga videolari uchun shu uchtadan biri belgilanadi, muharrirdagi subtitrlarni esa transkripsiya modeli qoʻllab-quvvatlaydigan tillarda yaratish mumkin.",
      },
      {
        id: "channel",
        q: "Oʻz kanalimdan foydalansam boʻladimi?",
        a: "Ha. Oʻz YouTube kanalingizni Google’ning rozilik oynasi orqali ulaysiz va Nightshift faqat siz ulagan kanalga yuklaydi. Uni istalgan vaqtda uzishingiz yoki Google akkauntingizda ruxsatni bekor qilishingiz mumkin.",
      },
      {
        id: "private",
        q: "Shaxsiy yuklash nima?",
        a: "YouTube’da shaxsiy videoni faqat siz va u bilan oʻrtoqlashgan kishilar koʻra oladi. Nightshift har bir tayyor videoni avval kanalingizga shunday yuboradi va u faqat siz tasdiqlaganingizdan keyin ommaviy boʻladi.",
      },
      {
        id: "data",
        q: "Maʼlumotlarim bilan nima boʻladi?",
        a: "Google maʼlumotlaringiz faqat siz ulagan kanalga yuklash va oʻsha kanal analitikasini sizga koʻrsatish uchun ishlatiladi — hech qachon reklama uchun emas. Kirish tokenlari shifrlangan va brauzerga chiqmaydi. Nightshift analitika, reklama yoki kuzatuv vositalaridan foydalanmaydi.",
      },
      {
        id: "drafts",
        q: "Qoralamalarim nima boʻladi?",
        a: "Muharrirda saqlanmagan oʻzgarishlar shu brauzerda 14 kungacha qoralama sifatida saqlanadi va loyihani qayta ochganingizda qaytariladi. Qoralama yaratilgandan keyin loyiha yana saqlangan boʻlsa, qoralama qoʻllanmaydi, akkauntdan chiqqaningizda esa u oʻchiriladi. Akkauntingizga faqat saqlaganingiz tushadi.",
      },
    ],
    links: { pay: "Narxlarni koʻrish", fails: "Shartlar: kreditlar va qaytarish", data: "Maxfiylik siyosatini oʻqish" },
  },
  caveat: "Baʼzi vositalarni avval shu oʻrnatmada sozlash kerak. Masalan, avto-subtitrlar faqat nutqni matnga aylantirish sozlangan va narxlangan joyda taklif qilinadi; u boʻlmasa, ilova buni aytadi.",
  final: {
    title: "Mavzudan boshlang.",
    lead: "Bepul boshlang. Har bir ishga tushirishdan oldin narxni koʻrasiz, har bir videoni ommaviy boʻlishidan oldin oʻzingiz tasdiqlaysiz.",
    cta: "Bepul boshlash",
  },
};
