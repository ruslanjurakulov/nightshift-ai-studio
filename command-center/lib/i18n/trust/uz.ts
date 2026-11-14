import type { TrustDictionary } from "./en";

/** /trust sahifasi “Ishonch va xavfsizlik” (en.ts bilan bir xil kalitlar, id va {oʻrinbosarlar}; faktlar manbalari oʻsha yerda). */
export const trustUz: TrustDictionary = {
  meta: {
    title: "Ishonch va xavfsizlik · Nightshift",
    description: "Nightshift YouTube kanalingizda nima qila oladi, kalitlar qanday saqlanadi, nima qachon ommaviy boʻladi va muammo haqida qanday xabar berish mumkin.",
  },
  footer: "Ishonch va xavfsizlik",
  title: "Ishonch va xavfsizlik",
  lead: "Nightshift kanalingiz, kalitlaringiz va pulingiz bilan nima qila oladi va nima qila olmaydi — oddiy soʻzlar bilan. Har bir satr mahsulot bugun qanday ishlashini tasvirlaydi.",
  reviewed: "Oxirgi tekshiruv: {date}",
  toc: "Shu sahifada",
  nav: {
    youtube: "YouTube’ga kirish",
    keys: "Kalitlaringiz",
    publishing: "Nashr",
    "ai-label": "Sunʼiy intellekt belgisi",
    "no-fallback": "Jimgina almashtirish yoʻq",
    payments: "Toʻlov va qaytarish",
    report: "Muammo haqida xabar",
    real: "Bu haqiqatan bizmi?",
  },
  youtube: {
    title: "YouTube’ga kirish",
    lead: "Kanalni ulaganingizda Google sizdan aynan quyidagi ruxsatlarni berishni soʻraydi. Nightshift YouTube’dan boshqa hech qanday ruxsat soʻramaydi, ulardan birortasi belgilanmasa, hech narsa saqlanmaydi va kanal ulanmaydi.",
    caption: "Nightshift Google’dan soʻraydigan ruxsatlar",
    cols: { google: "Google taʼrifi", why: "Nightshift’ga nima uchun kerak" },
    scopes: [
      {
        id: "youtube.upload",
        google: "YouTube videolaringizni boshqarish",
        why: "Har bir tayyor videoni kanalingizga yuklash uchun.",
      },
      {
        id: "youtube.readonly",
        google: "YouTube akkauntingizni koʻrish",
        why: "Biror narsa saqlashdan oldin qaysi kanalni ulaganingizni tekshirish hamda kanal va uning videolarini oʻqish uchun.",
      },
      {
        id: "youtube.force-ssl",
        google: "YouTube’dagi videolar, baholar, izohlar va subtitrlaringizni koʻrish, tahrirlash va butunlay oʻchirish",
        why: "Google subtitr yoʻlagini qoʻshish yoki videoni pleylistga qoʻyish uchun aynan shu ruxsatni soʻraydi. Nightshift undan yana yuklangan video ostiga kanalning birinchi izohini yozish (buni kanal sozlamalarida oʻchirib qoʻyish mumkin), javobni faqat inson aynan shu matnni tasdiqlagandan keyin yozish va — faqat tasdiqlangach nashr qilish yoqilgan kanalda — tasdiqlangan videoni ommaviy qilish uchun foydalanadi. Nightshift’da video, izoh yoki subtitrni oʻchiradigan kod yoʻq.",
      },
      {
        id: "yt-analytics.readonly",
        google: "YouTube kontentingiz boʻyicha YouTube Analytics hisobotlarini koʻrish",
        why: "Videolaringiz qanday ketayotganini koʻrsatish uchun: koʻrishlar, tomosha vaqti va ushlab qolish. Moliyaviy hisobotlarni koʻrsatadigan alohida ruxsatni Nightshift soʻramaydi.",
      },
    ],
    privateTitle: "Yuklashlar sukut boʻyicha yopiq",
    privateBody: "Nightshift har bir videoni YouTube’ga yopiq (private) holatda yuklaydi. Nightshift buni faqat quyidagi “Nashr” boʻlimida yozilgan almashtirgichlar orqali oʻzgartiradi, ularning har biri sukut boʻyicha oʻchiq.",
    revokeTitle: "Ruxsatni qanday olib tashlash mumkin",
    revoke: [
      "Nightshift’da “Kanallar”ni oching va kanaldagi “Uzish” tugmasini bosing. Saqlangan kirish darhol yoʻq qilinadi va yuklashlar toʻxtaydi.",
      "Google’da {link} sahifasini oching, Nightshift’ni tanlang va uning ruxsatini olib tashlang.",
    ],
    revokeBoth: "Ikkalasini ham bajaring: Nightshift’da uzish Google’dagi ruxsatni olib tashlamaydi, Google’da olib tashlangach esa Nightshift’da foydalanadigan hech narsa qolmaydi.",
  },
  keys: {
    title: "Kalitlaringiz va kirishlaringiz",
    lead: "Kalit yoki kirish hech qachon chop etilmaydi, jurnalga yozilmaydi va qayta koʻrsatilmaydi — hatto bir qismi ham.",
    items: [
      {
        id: "setup",
        title: "Sozlashda kiritilgan kalitlar",
        body: "Konveyerni ishga tushirish uchun Nightshift sozlamasiga kiritilgan kalit serverimizda uni ishga tushiradigan repozitoriyning ochiq kaliti bilan muhrlanadi, shu repozitoriyning GitHub Actions maxfiy qiymatlariga yoziladi va unutiladi. U hech qachon maʼlumotlar bazamizga, hodisaga yoki jurnal satriga yozilmaydi. Faqat tekshirish uchun joylangan kalit tekshiriladi va unutiladi.",
      },
      {
        id: "channels",
        title: "Kanalingiz kirishi",
        body: "Kanal ulanganda Google qaytargan kirish Supabase Vault’da faqat yoza oladigan maʼlumotlar bazasi funksiyasi orqali shifrlanadi. Hech bir sahifa uni qayta oʻqiy olmaydi, hatto sizniki ham; undan faqat konveyerning oʻz ishchisi kanalingiz ustida ishlayotganda foydalanadi. Instagram va TikTok ulanishlari ham xuddi shunday saqlanadi.",
      },
      {
        id: "api",
        title: "Nightshift API kalitlari",
        body: "API kalit faqat bir marta — yaratilganda koʻrsatiladi. Nightshift kalitning oʻzini yoki bir qismini emas, faqat uning izini (SHA-256 xeshini) saqlaydi. Yoʻqolgan kalitni qayta koʻrsatib boʻlmaydi: uni bekor qiling va “Dasturchilar” → “API kalitlari”da yangisini yarating.",
      },
      {
        id: "assistants",
        title: "Sunʼiy intellekt yordamchilari",
        body: "Ulanadigan yordamchi sizni chat ichida emas, {domain} saytining oʻzida kirishga yuboradi. Unga nima mumkinligini va oylik sarf limitini oʻzingiz tanlaysiz hamda istalgan vaqtda “Dasturchilar” → “Ulangan ilovalar”da uzib qoʻyishingiz mumkin.",
      },
    ],
  },
  publishing: {
    title: "Nashr: insonsiz hech narsa ommaviy boʻlmaydi",
    lead: "Nightshift hech qachon oʻz-oʻzidan hech narsani ommaviy nashr qilmagan, buning sababi quyidagi qoidalar.",
    items: [
      "YouTube’ga har bir yuklash sukut boʻyicha yopiq — jadval boʻyicha ishga tushganda ham, qoʻlda ishga tushganda ham.",
      "Nashr tekshiruvi har bir yuklashdan oldin ishlaydi. U yuklashni toʻxtata oladi, lekin hech qachon yuklashga sabab boʻlmaydi.",
      "Avtonashr — har bir kanaldagi alohida almashtirgich, sukut boʻyicha oʻchiq. Faqat kimdir uni yoqib qoʻygan paytdagina shu kanalning ishga tushirishlari videoni yopiqdan boshqa holatda yuklay oladi.",
      "“Tasdiqlash” kim qaysi aniq variantni tasdiqlaganini 24 soatga yozib qoʻyadi. Oʻzi videoning kirish holatini oʻzgartirmaydi.",
      "“Tasdiqlangach nashr qilish” — har bir kanaldagi ikkinchi almashtirgich, u ham sukut boʻyicha oʻchiq. Uni faqat kanal tegishli ish maydoniga kirgan inson yoqa oladi — hech qachon botning oʻzi emas — va har bir oʻzgarish yozib qoʻyiladi. Bunday kanalda inson allaqachon yuklangan yopiq videoning bitta aniq variantini tasdiqlagach, Nightshift YouTube’dan shu videoni ommaviy qilishni bir marta soʻrashi mumkin. Soʻrashdan oldin u variant, nashr tekshiruvi, tasdiq va almashtirgich hali ham kuchda ekanini yana tekshiradi. Video faqat YouTube’ning oʻzi uni ommaviy deb xabar berganda nashr qilingan deb koʻrsatiladi.",
      "Tayyor video Instagram, TikTok yoki boshqa YouTube kanalingizga faqat inson soʻraganda va faqat nashr tekshiruvidan oʻtib, tasdiqlangandan keyin yuboriladi. YouTube’ga kross-post yopiq holda yuklanadi, TikTok’dagi post faqat sizga koʻrinadi, Instagram’dagi post esa akkauntning oʻz maxfiylik sozlamasiga boʻysunadi.",
    ],
  },
  aiLabel: {
    title: "Sunʼiy intellekt kontenti haqida belgi",
    body: [
      "YouTube mualliflardan sunʼiy intellekt yordamida yaratilgan yoki oʻzgartirilgan realistik kontentni belgilashni soʻraydi. Har bir yuklashdan oldin bitta qoida videoga shunday belgi kerakmi-yoʻqmi hal qiladi: videoda sunʼiy intellekt yaratgan kliplar yoki rasmlar, sunʼiy intellekt boshlovchi yoki haqiqiy odamnikiga oʻxshash ovoz boʻlsa, belgi qoʻyiladi. Videoga nima kirganini Nightshift aniqlay olmasa, belgi qoʻyadi.",
      "Belgilangan video YouTube’ning “oʻzgartirilgan yoki sintetik kontent” sozlamasi bilan va sukut boʻyicha tavsifdagi bir satr bilan yuboriladi. Instagram va TikTok shu video uchun oʻz sunʼiy intellekt belgisini oladi. Oddiy sintetik diktorning oʻzi belgi talab qilmaydi, chunki YouTube sahifasi buni soʻramaydi; kanal har bir videoni belgilashni tanlashi mumkin. Kanal uchun belgini faqat Nightshift’ning oʻz xodimlari oʻchira oladi.",
      "Belgi — platformaga berilgan bayonot. U hech qachon videoni ommaviy qilmaydi.",
    ],
  },
  fallback: {
    title: "Jimgina almashtirish yoʻq",
    body: "Kanal maʼlum ovoz, model yoki manbaga sozlangan boʻlsa-yu, u mavjud boʻlmasa, ishga tushirish toʻxtaydi va nimani tuzatish kerakligini aytadi. U jimgina yomonrogʻini qoʻymaydi. Notoʻgʻri ovozdagi videodan koʻra videosiz qolgan maʼqul.",
  },
  payments: {
    title: "Toʻlov va qaytarish",
    body: [
      "Ishga tushirishdan oldin uning narxi band qilinadi. Ishga tushirish muvaffaqiyatsiz boʻlsa yoki tugamasa, butun band qilingan summa qaytadi va hech narsa yechilmaydi; tugasa, faqat sarflangani yechiladi va hech qachon band qilingandan koʻp emas.",
      "Har bir band qilish, yechish va qaytarish tashkilotingizning kredit tarixiga yoziladi.",
    ],
    link: "Pulni qaytarish siyosati",
  },
  report: {
    title: "Qoidabuzarlik yoki xavfsizlik muammosi haqida xabar bering",
    body: [
      "Nightshift’da yaratilgan va qonun yoki kimningdir huquqini buzadigan video, soxta akkaunt, oʻzini biz deb koʻrsatadigan sayt yoki xabar: bizga yozing va uni qayerda koʻrganingizni ayting.",
      "Xavfsizlik muammosi: mavzuga “Security” deb yozing va nima qilganingiz hamda nimani koʻrganingizni tasvirlang. Iltimos, faqat oʻz akkauntingizda sinab koʻring va hech qachon boshqalarning maʼlumotlarini ochmang.",
    ],
    write: "Manzil",
    noEmail: "Shartlarimizdagi aloqa maʼlumotlaridan foydalaning.",
    noEmailLink: "Aloqa maʼlumotlari",
  },
  real: {
    title: "Bu haqiqatan Nightshift ekanini qanday bilish mumkin",
    items: [
      "Saytimiz faqat {domain} manzilida. Kirish, kanalni ulash va toʻlov oʻsha yerdan boshlanadi.",
      "Google orqali kirganingizda bir zumga Google’ning oʻz sahifalari va kirish xizmatimizning supabase.co domenidagi manzilidan oʻtasiz, soʻng {domain} saytiga qaytasiz.",
      "Nightshift hech qachon parolingizni, API kalitni yoki kirish kodini chatda, Telegram xabarida yoki elektron xatda soʻramaydi. Kalitlar faqat {domain} dagi ilovaga kiritiladi.",
      "Bizning nomimizdan foydalanadigan boshqa har qanday narsa biz emasmiz. Iltimos, bu haqda yuqoridagi manzilga xabar bering.",
    ],
    accounts: "Boshqa joylardagi akkauntlarimiz",
  },
};
