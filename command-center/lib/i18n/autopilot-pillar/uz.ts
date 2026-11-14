import type { PillarDictionary } from "./en";

/** “YouTube uchun avtopilot” sahifasi. Manba — ./en.ts. oʻ va gʻ U+02BB bilan yoziladi (tests/site-copy.test.ts). */
export const pillarUz: PillarDictionary = {
  meta: {
    title: "YouTube uchun avtopilot, nazorat esa sizda",
    description:
      "Mavzudan YouTube’ga shaxsiy yuklashgacha: tadqiqot, ssenariy, faktlarni tekshirish, ovoz, tasvir va render. Videoni faqat inson ommaviy qiladi.",
  },
  hero: {
    kicker: "YouTube uchun avtopilot",
    title: "Kanalingiz avtopilotda. Sizsiz hech narsa ommaviy boʻlmaydi.",
    lead: "Mavzu bering. Nightshift uni oʻrganadi, ssenariy yozib tekshiradi, ovoz beradi, tasvirlarni topadi, videoni yigʻadi va kanalingizga shaxsiy holda yuklaydi. Siz uni koʻrib, aynan shu versiyani tasdiqlaysiz.",
  },
  composer: {
    label: "Mavzuingiz",
    genres: "Janrdan boshlang",
    items: [
      { id: "history", name: "Tarix", starter: "Iskandariya kutubxonasi aslida qanday yoʻqolgan" },
      { id: "mystery", name: "Sirli voqealar", starter: "Flannan orollaridagi mayoq siri" },
      { id: "explainer", name: "Tushuntirish", starter: "Osmon nega moviy: bitta oddiy tajriba bilan" },
      { id: "kids", name: "Bolalar uchun", starter: "Yordam soʻrashni oʻrganadigan kichkina toshbaqa haqida mehribon ertak" },
    ],
    go: "Chiqarilish shaklini ochish",
    empty: "Avval mavzuni yozing.",
    note: "Bu faqat chiqarilish shaklini toʻldiradi. U yerda narxni koʻrib “Boshlash”ni bosmaguningizcha hech narsa ishga tushmaydi va hech narsa yechilmaydi.",
    kidsTitle: "Bolalar uchun",
    kidsNote:
      "Bolalar uchun videolar YouTube’da “bolalar uchun” deb belgilanishi shart; bu qoida AQShning bolalar maʼlumotlarini himoya qilish qonunidan (COPPA) kelib chiqadi. Bu janr chiqarilish shaklini shu belgi yoqilgan holda ochadi, video tasdiqlanishidan oldin esa uni inson tasdiqlaydi. Bunday videoda izohlar va shaxsiylashtirilgan reklama oʻchadi: bu bizning emas, YouTube qoidasi.",
  },
  sample: {
    label: "Natija namunasi",
    tag: "Repozitoriyimizdagi namunaviy ssenariy",
    note: "Render testimiz ishlatadigan ssenariy, ssenariy bosqichi yozadigan formatda, qanday yozilgan boʻlsa shunday (ingliz tilida) koʻrsatilgan. Davomiyliklar ssenariy rejasi, oʻlchov emas.",
    topic: "Mavzu",
    titleA: "Sarlavha A",
    titleB: "Sarlavha B",
    hook: "Birinchi jumla",
    sections: "Boʻlimlar",
    seconds: "Reja boʻyicha {n} s",
    source: "Manba",
    more: "Har bir bosqich ortidagi fayl",
  },
  stages: {
    slug: "Chiqarilish qanday boradi",
    title: "Oʻn bir bosqich, bajariladigan tartibda.",
    lead: "Har bir bosqich nima qiladi va qancha turadi. Chiqarilishning butun video uchun bitta narxi bor, u boshlanishdan oldin koʻrinadi; bosqichlarning alohida narxi yoʻq.",
    price: "Butun chiqarilish: tayyor videoning har daqiqasi uchun {n} {unit}, boshlanganda band qilinadi.",
    minimum: "Har bir chiqarilish uchun kamida {n} {unit}.",
    priceUnknown: "Daqiqalik narx hali eʼlon qilinmagan. Chiqarilish shakli biror narsa boshlanishidan oldin narxni koʻrsatadi.",
    refund: "Chiqarilish muvaffaqiyatsiz boʻlsa, band qilingan kreditlar oʻzi toʻliq balansga qaytadi. Tayyor chiqarilish oʻlchanganini yechadi, hech qachon band qilingandan koʻp emas.",
    costLabel: "Narx",
    measures: "Chiqarilish xarajatlari yozuvida hisoblanadi: {what}.",
    ledger: {
      tokens: "til modeli tokenlari",
      narration: "ovozlashtirilgan belgilar",
      footage: "kadr qidiruvlari, bor boʻlsa yaratilgan kliplar yoki rasmlar",
      render: "render soniyalari",
      upload: "yuklangan baytlar",
    },
    inPrice: "Chiqarilishning yagona narxiga kiradi.",
    noCharge: "Kredit olinmaydi.",
    items: [
      {
        id: "topic",
        name: "Mavzu",
        does: "Siz yozgan mavzuni oladi yoki kanal rejasidan tanlaydi va kanalda allaqachon video boʻlgan mavzuni chetlab oʻtadi.",
      },
      {
        id: "research",
        name: "Tadqiqot",
        does: "Til modelidan mavzu haqida nimani bilishini, har bir faktga oʻz ishonchi bilan soʻraydi. Bu manbalar boʻyicha tadqiqot emas, model xotirasi, shuning uchun faktlar tekshiruvigacha tekshirilmagan hisoblanadi.",
      },
      {
        id: "script",
        name: "Ssenariy",
        does: "Ssenariyni boʻlimlarga ajratib, birinchi jumladan boshlab yozadi: solishtirish uchun ikkita sarlavha, tavsif va teglar bilan.",
      },
      {
        id: "factcheck",
        name: "Faktlarni tekshirish",
        does: "Ssenariydagi har bir daʼvoni tekshiradi, sukut boʻyicha inglizcha Vikipediyadan qarab. Tasdiqlab boʻlmagan daʼvo inson uchun belgilanadi; tekshiruv videoni toʻxtatadigan boʻlsa, chiqarilish shu yerda, ovoz uchun pul toʻlanishidan oldin toʻxtaydi.",
      },
      {
        id: "voice",
        name: "Ovoz",
        does: "Ssenariyni kanalning oʻz ovozida oʻqiydi va subtitrlar uchun har bir soʻzning vaqtini belgilaydi. Bu ovozga ulanib boʻlmasa, chiqarilish toʻxtaydi.",
      },
      {
        id: "visuals",
        name: "Tasvir",
        does: "Har bir boʻlim uchun qidiruv soʻzlari boʻyicha kadrlar topadi, kanal shunday sozlangan boʻlsa kliplar yoki rasmlar yaratadi va muqovani rejalaydi.",
      },
      {
        id: "render",
        name: "Render",
        does: "Video dvigateli har bir sahnani retsept boʻyicha yigʻadi va videoni subtitrlari bilan montaj qiladi.",
      },
      {
        id: "gate",
        name: "Nashr tekshiruvi",
        does: "Tayyor faylni yuklashdan oldin tekshiradi: faktlar tekshiruvi xulosasi, faylning oʻzi (oqimlari, ovozga nisbatan uzunligi, qora yoki ovozsiz qismlar) va sarlavha hamda tavsif chegaralari.",
      },
      {
        id: "upload",
        name: "Shaxsiy yuklash",
        does: "Ruxsat berilgan videoni kanalingizga shaxsiy holda yuklaydi: uni faqat siz va siz ulashgan odamlar koʻra oladi.",
      },
      {
        id: "approve",
        name: "Sizning tasdiqingiz",
        does: "Koʻrish nusxasini koʻrib, aynan bitta versiyani tasdiqlaysiz. Bu qaroringizning yozuvi; videoning maxfiylik holatini oʻzgartirmaydi.",
      },
      {
        id: "public",
        name: "Ommaviy",
        does: "Videoni YouTube’da oʻzingiz ommaviy qilasiz yoki ish maydonini boshqaradigan kishi “Tasdiqdan keyin nashr qilish”ni yoqqan kanalda tasdiqingiz buni YouTube’dan bir marta soʻraydi.",
      },
    ],
    more: "Bu bosqichlar ortidagi haqiqiy fayllar",
  },
  control: {
    slug: "Nazorat sizda",
    title: "Avval shaxsiy. Ommaviy esa faqat inson qarori bilan.",
    lead: "Koʻp avtopilot vositalari sukut boʻyicha oʻzi nashr qiladi, oldindan koʻrib chiqish esa ixtiyoriy. Bu yerda aksincha: har bir yuklash shaxsiy, shaxsiydan ommaviygacha boʻlgan har bir qadam esa quyida kod qanday bajarsa, shunday yozilgan.",
    diagram: "Tayyor videodan ommaviygacha",
    steps: [
      {
        id: "check",
        state: "Har qanday yuklashdan oldin",
        title: "Nashr tekshiruvi",
        body: "Tayyor fayl ustida oʻtkaziladi va har bir kanal uchun sukut boʻyicha yoqilgan. U toʻxtatgan video yuklanmaydi: koʻrib chiqishingiz uchun saqlab qoʻyiladi.",
      },
      {
        id: "private",
        state: "Shaxsiy",
        title: "Shaxsiy holda yuklangan",
        body: "Har bir yuklash YouTube’dan shaxsiy holatni soʻraydi. Kanalning avtomatik nashr kaliti yoqilgan boʻlsa ham (sukut boʻyicha oʻchiq), yangi video inson YouTube’ning “bu video bolalar uchunmi?” degan savoliga javob bermaguncha shaxsiy qoladi.",
      },
      {
        id: "approve",
        state: "Tasdiqlangan",
        title: "Siz aynan bitta versiyani tasdiqlaysiz",
        body: "Tasdiq kim tasdiqlaganini, qaysi versiyani (uning sha256 izini), qachongacha ({hours} soat) va nimaga rozi boʻlganini yozib qoʻyadi. Buning uchun videoga ruxsat beradigan saqlangan tekshiruv xulosasi kerak, videoning maxfiylik holati esa oʻzgarmaydi.",
      },
      {
        id: "public",
        state: "Ommaviy",
        title: "Ommaviy — sizning harakatingiz bilan",
        body: "Sukut boʻyicha tayyor boʻlganingizda videoni YouTube’da oʻzingiz ommaviy qilasiz.",
      },
    ],
    branch: {
      title: "Yoki “Tasdiqdan keyin nashr qilish” — faqat ish maydonini boshqaradigan kishi yoqqan boʻlsa",
      items: [
        "Har bir kanal uchun sukut boʻyicha oʻchiq. Uni faqat kanal ish maydonini boshqaradigan kishi, tekshiriladigan maʼlumotlar bazasi funksiyasi orqali yoqa oladi, bot hech qachon; bir bosishda oʻchiriladi.",
        "U yoqilganda tasdiqingiz navbatga bitta soʻrov qoʻyadi. Uni bajaradigan ishlovchining oʻzi server uni ishga tushirishga sozlanmaguncha oʻchiq turadi.",
        "Harakatdan oldin ishlovchi maʼlumotlar bazasidan yana soʻraydi: hali ham tasdiqlangan versiyami, tasdiq muddati oʻtmaganmi, tekshiruv xulosasi saqlangan va ruxsat beradimi, kalit hali ham yoqilganmi.",
        "U YouTube’dan videoni ommaviy qilishni bir marta soʻraydi, soʻng videoni qayta oʻqiydi. Ilova “Nashr qilindi” deb faqat YouTube video ommaviy ekanini aytganda yozadi. YouTube’ga murojaat qilinishidan oldin biror narsa ishlamasa, video shaxsiy qoladi.",
      ],
    },
    fallback: {
      title: "Jim almashtirish yoʻq",
      body: "Ovozi tanlangan kanal oʻsha ovozni oladi yoki video umuman chiqmaydi. Hech narsaga pul sarflanishidan oldin chiqarilish kanal diktori haqiqatan gapira olishini, kanal sozlangan rasm va klip modellarini ham xuddi shunday tekshiradi. Ulardan biri ishlamasa, chiqarilish toʻxtaydi va sababini aytadi. U hech qachon boshqa, arzonroq ovozda oʻqimaydi: notoʻgʻri ovozdagi video umuman yoʻqligidan yomonroq.",
    },
    unknown: {
      title: "Nomaʼlum — nomaʼlumligicha qoladi",
      items: [
        "Saqlangan tekshiruv xulosasi boʻlmagan video “oʻtdi” emas, “nomaʼlum” deb koʻrsatiladi va uni tasdiqlab boʻlmaydi.",
        "Oʻtkazilmagan faktlar tekshiruvi hech qachon oʻtgan deb hisoblanmaydi: sukut boʻyicha u videoni ushlab turadi.",
        "Tekshiruv tasdiqlay olmagan daʼvo inson uchun belgilanadi va hech qachon haqiqat deb oʻtkazilmaydi.",
        "Hech kim eʼlon qilmagan narx “eʼlon qilinmagan” deb koʻrsatiladi, xuddi shu sahifadagidek.",
      ],
    },
  },
  faq: {
    slug: "Savollar",
    title: "Boshlashdan oldin",
    sources: "YouTube’ning oʻz sahifalari",
    items: [
      {
        id: "publish",
        q: "U qachondir videoni oʻzi nashr qiladimi?",
        a: "Yoʻq. Har bir yuklash shaxsiy. Video inson uni YouTube’da ommaviy qilganda yoki ish maydonini boshqaradigan kishi “Tasdiqdan keyin nashr qilish”ni yoqqan kanalda inson uni tasdiqlaganda ommaviy boʻladi. Buni oʻzgartirishi mumkin boʻlgan kalitlar har bir kanal uchun alohida va sukut boʻyicha oʻchiq.",
      },
      {
        id: "monetize",
        q: "Shunday qilingan kanal pul topa oladimi?",
        a: "Biz monetizatsiya yoki biror daromadni vaʼda qila olmaymiz, buni halol vaʼda qila oladigan hech kim yoʻq. Kanal YouTube hamkorlik dasturiga qabul qilinadimi va unda qoladimi, buni YouTube oʻz qoidalari asosida hal qiladi. 2026-yil 14-noyabrda tekshirildi: YouTube monetizatsiya qoidalari ommaviy ishlab chiqarilgan yoki bir xil takrorlanadigan kontentni chiqarib tashlaydi, yaʼni deyarli farqsiz shablon asosida qilingandek koʻrinadigan yoki koʻp nusxada osongina takrorlanadigan videolarni. YouTube buni “noautentik kontent” deydi; 2025-yil iyuligacha u “takroriy kontent” deb atalgan. Har bir videoni oʻz-oʻzidan koʻrishga arziydigan qiling va YouTube sahifalarini oʻzingiz oʻqing, chunki ular oʻzgarib turadi.",
      },
      {
        id: "disclosure",
        q: "Video sunʼiy intellekt bilan qilinganini YouTube bilishi kerakmi?",
        a: "Baʼzan, va buni chiqarilish aslida nima qilganiga qarab hal qiladi. YouTube mualliflardan realistik oʻzgartirilgan yoki sintetik kontentni belgilashni soʻraydi. Sukut boʻyicha videoda sunʼiy intellekt yaratgan kliplar yoki rasmlar, sunʼiy intellekt boshlovchisi yoki haqiqiy inson ovozi deb belgilangan ovoz boʻlsa yoxud chiqarilish buni aniqlay olmasa, video belgilanadi; belgi yuklash bilan birga YouTube’ga yuboriladi, tavsifga esa bir qator qoʻshiladi. Oddiy diktorli stok kadrlardan iborat video sukut boʻyicha belgilanmaydi, chunki YouTube sahifasida matnni ovozga aylantirish tilga olinmagan. Kanal har bir videoni belgilashni tanlashi mumkin.",
      },
      {
        id: "fails",
        q: "Bosqich muvaffaqiyatsiz boʻlsa nima boʻladi?",
        a: "Chiqarilish toʻxtaydi va siz uning uchun pul toʻlamaysiz. Kreditlar chiqarilish boshlanishidan oldin, sizga koʻrsatilgan narx boʻyicha band qilinadi. U istalgan bosqichda muvaffaqiyatsiz boʻlsa yoki faktlar tekshiruvi videoni toʻxtatadigani uchun renderdan oldin toʻxtasa, band qilingan kreditlar oʻzi toʻliq balansga qaytadi. Kredit faqat chiqarilish tayyor video haqida xabar berganda yechiladi, shunda ham oʻlchangani, hech qachon band qilingandan koʻp emas; biror qismini narxlab boʻlmasa, taxmin emas, band qilingan miqdor yechiladi.",
      },
      {
        id: "kids",
        q: "Bolalar uchun videolar-chi?",
        a: "YouTube bolalar uchun qilingan videolarni “bolalar uchun” deb belgilashni talab qiladi; bu qoida AQShning bolalar maʼlumotlarini himoya qilish qonunidan (COPPA) kelib chiqadi. Bolalar uchun chiqarilish bolalar kontenti deb aniqlanadi va uning shaxsiy yuklashi “bolalar uchun” deb belgilanadi. Video tasdiqlanishidan oldin inson uning koʻrib chiqish sahifasida “bu video bolalar uchunmi?” degan savolga javob beradi. Bu belgi videoda izohlar, shaxsiylashtirilgan reklama va bildirishnomalarni oʻchiradi: bu bizning emas, YouTube qoidasi.",
      },
    ],
    links: {
      monetization: "Kanal monetizatsiyasi qoidalari",
      disclosure: "Oʻzgartirilgan yoki sintetik kontentni belgilash",
      terms: "Shartlarimizdagi kreditlar boʻlimi",
    },
  },
};
