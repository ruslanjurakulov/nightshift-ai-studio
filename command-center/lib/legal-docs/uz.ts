import type { LegalTexts } from "./types";

/** Uzbek translation of ./en.ts. The English text governs; keep this in step with it. */
export const uz: LegalTexts = {
  privacy: {
    title: "Maxfiylik siyosati",
    summary:
      "Nightshift qanday maʼlumot toʻplaydi, Google va YouTube maʼlumotlaringiz bilan nima qiladi, ularni kim qayta ishlaydi, qancha saqlanadi va qanday oʻchiriladi.",
    sections: [
      {
        id: "who-we-are",
        heading: "1. Biz kimmiz",
        body: [
          "Nightshift («Xizmat») — videoni avtomatik ishlab chiqarish vositasi: shu domendagi veb-panel va foydalanuvchilar ulagan YouTube kanallari uchun mavzuni oʻrganadigan, ssenariy yozadigan, ovozlashtiradigan, render qiladigan va yuklaydigan konveyer. Xizmat operatori — {legalName} («biz»), {country}. Aloqa: {contactEmail}.",
          "Ushbu siyosat Xizmat qanday maʼlumot toʻplashi, undan qanday foydalanishi va kimga uzatishi hamda sizda qanday tanlov borligini tushuntiradi. U shu sayt va siz nomingizdan ishlaydigan avtomatik konveyerga taalluqli.",
        ],
      },
      {
        id: "information-we-collect",
        heading: "2. Biz toʻplaydigan maʼlumotlar",
        body: [
          {
            list: [
              "Akkaunt maʼlumotlari: elektron pochta manzilingiz va parolingiz — ularni autentifikatsiya provayderimiz (Supabase Auth) boshqaradi. Biz parolingizni hech qachon ochiq koʻrinishda koʻrmaymiz va saqlamaymiz.",
              "Siz kiritgan sozlamalar: kanal nomlari, nisha, til, ovoz va uslub tanlovi, jadvallar, seriyalar, shuningdek tekshiruvdagi qarorlaringiz (masalan, videoni tasdiqlash) — ular foydalanuvchi identifikatoringiz bilan audit jurnaliga yoziladi.",
              "Siz kiritgan uchinchi tomon xizmatlarining API kalitlari: ular serverimizga kelgan zahoti shifrlanadi, konveyerning shifrlangan sirlar omboriga (GitHub Actions secrets) yoziladi va tashlab yuboriladi. Ular hech qachon maʼlumotlar bazamizda saqlanmaydi, sizga qayta koʻrsatilmaydi va jurnallarga yozilmaydi.",
              "Siz ruxsat bergan Google foydalanuvchi maʼlumotlari — 3-boʻlimga qarang.",
              "Texnik maʼlumotlar: hosting va maʼlumotlar bazasi provayderlarimiz Xizmatni ishlatish va himoya qilish uchun standart soʻrov jurnallarini (IP manzil, brauzer turi, soʻrov vaqti) yuritadi. Biz analitika, reklama yoki kuzatuv vositalaridan foydalanmaymiz.",
            ],
          },
        ],
      },
      {
        id: "google-user-data",
        heading: "3. Qaysi Google maʼlumotlariga kiramiz",
        body: [
          "YouTube kanalini ulaganingizda Google’ning oʻz rozilik oynasiga oʻtasiz: u yerda Google akkauntini tanlaysiz va aynan nima soʻralayotganini koʻrasiz. Biz quyidagi OAuth ruxsat doiralarini (scope) soʻraymiz va har biridan faqat koʻrsatilgan maqsadda foydalanamiz:",
          {
            table: {
              head: ["Ruxsat doirasi", "Nightshift u bilan nima qiladi"],
              rows: [
                [
                  "`youtube.upload`",
                  "Nightshift kanalingiz uchun tayyorlagan videolarni yuklaydi va ularning muqovasini (thumbnail) oʻrnatadi. Agar shu kanal uchun boshqacha tanlamagan boʻlsangiz — masalan, sukut boʻyicha oʻchiq avto-nashrni yoqmagan boʻlsangiz — yuklangan videolar yopiq (private) boʻladi.",
                ],
                [
                  "`youtube.readonly`",
                  "Qaysi kanalni ulaganingizni tasdiqlash uchun kanal identifikatsiyasini (ID va nom) oʻqiydi; bir video ikki marta yuklanmasligi uchun kanalning soʻnggi yuklamalari roʻyxatini (ID va nomlar) oladi; panel uchun videolaringizning asosiy maʼlumotlari va ochiq statistikasini oʻqiydi.",
                ],
                [
                  "`youtube.force-ssl`",
                  "Nightshift yuklagan videolarga subtitr yoʻlagini qoʻshadi; nashr qilingan videoni seriya pleylistiga qoʻshadi; Nightshift nashr qilgan video ostida kanal nomidan bitta izoh (tomoshabinlarga savol) qoldiradi; auditoriya soʻrayotgan mavzularni topish uchun kanal videolaridagi izohlarni oʻqiydi. Texnik jihatdan bu ruxsat videolarni tahrirlash va oʻchirishga ham imkon beradi — Nightshift hech narsani oʻchirmaydi va mavjud videolaringiz, pleylistlaringiz yoki izohlaringizni tahrirlamaydi; u faqat shu yerda sanab oʻtilganlarni qoʻshadi.",
                ],
                [
                  "`yt-analytics.readonly`",
                  "Kanalingiz videolari boʻyicha YouTube Analytics hisobotlarini oʻqiydi: koʻrishlar, tomosha vaqti, oʻrtacha koʻrish davomiyligi va foizi, layklar, izohlar, ulashishlar, qoʻshilgan va ketgan obunachilar, koʻrsatilishlar, CTR va auditoriyani ushlab qolish. Bu koʻrsatkichlar panelingizda koʻrsatiladi va keyingi videolar uchun yaxshiroq mavzu tanlashda ishlatiladi.",
                ],
                [
                  "`yt-analytics-monetary.readonly` (ixtiyoriy)",
                  "Faqat operator daromad hisobini aniq yoqqan boʻlsa soʻraladi. Panel uchun videolaringizning taxminiy daromadini oʻqiydi. Aks holda soʻralmaydi.",
                ],
              ],
            },
          },
          "Biz Gmail, Google Drive, kontaktlar yoki boshqa Google xizmatlariga ruxsat soʻramaymiz va YouTube’dagi koʻrish tarixingiz, obunalaringiz yoki shaxsiy xabarlaringizni oʻqimaymiz.",
        ],
      },
      {
        id: "how-we-use-google-data",
        heading: "4. Google maʼlumotlaridan qanday foydalanamiz",
        body: [
          "Google foydalanuvchi maʼlumotlari faqat Xizmatda siz koʻradigan funksiyalarni taqdim etish va yaxshilash uchun ishlatiladi: videolaringizni yuklash va subtitrlash, ularni pleylistlarga qoʻshish, jalb qiluvchi izohni joylash, takroriy yuklashning oldini olish, kanal natijalarini panelda koʻrsatish va nima yaxshi ishlagani hamda auditoriya nimani soʻrayotganiga qarab keyingi mavzularni tanlash.",
          "Bu xulosalar uchun videolaringizdagi izohlar matni va video koʻrsatkichlari kanalingiz uchun tasniflash va umumlashtirish maqsadida matn uchun sunʼiy intellekt provayderimizga (Google Gemini API) yuborilishi mumkin. Biz izoh matnini emas, natijani saqlaymiz — masalan, auditoriya soʻragan mavzu va u necha marta soʻralgani.",
        ],
      },
      {
        id: "limited-use",
        heading: "5. Cheklangan foydalanish (Limited Use)",
        body: [
          "Nightshift’ning Google API’dan olingan maʼlumotlardan foydalanishi va ularni boshqa ilovaga uzatishi [Google API xizmatlari foydalanuvchi maʼlumotlari siyosati](https://developers.google.com/terms/api-services-user-data-policy)ga, jumladan Cheklangan foydalanish (Limited Use) talablariga amal qiladi. Xususan:",
          {
            list: [
              "Google foydalanuvchi maʼlumotlaridan faqat yuqorida tavsiflangan, foydalanuvchiga koʻrinadigan funksiyalarni taqdim etish yoki yaxshilash uchun foydalanamiz;",
              "ularni boshqalarga faqat shu funksiyalar uchun zarur hajmda (7-boʻlimdagi qayta ishlovchilarga), qonunga rioya qilish uchun yoki sizni xabardor qilgan holda qoʻshilish, sotib olinish yoki aktivlar sotilishi doirasida uzatamiz;",
              "ulardan reklama, jumladan shaxsiylashtirilgan yoki retargeting reklamasi koʻrsatish uchun foydalanmaymiz va uzatmaymiz;",
              "ularni sotmaymiz va kreditga layoqatni aniqlash yoki kredit berish uchun ishlatmaymiz;",
              "odamlarga ularni oʻqishga ruxsat bermaymiz — faqat siz aniq maʼlumotlar uchun ochiq rozilik bergan boʻlsangiz, xavfsizlik uchun (masalan, suiisteʼmolni tekshirish) zarur boʻlsa, qonunga rioya qilish uchun kerak boʻlsa yoki maʼlumotlar ichki ishlar uchun jamlangan va anonimlashtirilgan boʻlsa bundan mustasno;",
              "ulardan umumiy maqsadli sunʼiy intellekt yoki mashinaviy oʻqitish modellarini ishlab chiqish, yaxshilash yoki oʻqitish uchun foydalanmaymiz.",
            ],
          },
        ],
      },
      {
        id: "tokens",
        heading: "6. Google’ga kirish huquqingiz qanday saqlanadi",
        body: [
          "Siz rozilik berganingizdan soʻng Google serverimizga kirish tokeni va yangilash tokenini qaytaradi. Ular qayerda saqlanishi kanal kimniki ekaniga bogʻliq:",
          {
            list: [
              "Biz boshqaradigan kanallar (oʻz tashkilotimiz): token darhol shifrlanadi (konveyer repozitoriysining ochiq kaliti bilan muhrlanadi) va faqat konveyer ishga tushganda oʻqiy oladigan shifrlangan GitHub Actions siri sifatida saqlanadi.",
              "Tashkilotingiz ulagan kanallar: faqat yangilash tokeni saqlanadi, Supabase Vault’da shifrlangan holda. Boshqaruv paneli uni saqlashi yoki oʻchirishi mumkin, lekin hech qachon qayta oʻqiy olmaydi — na siz uchun, na tashkilotingizdagi boshqa birov uchun; uni faqat bizning konveyerimiz, faqat serverdagi kalit bilan, shu kanal uchun ishga tushirish davomida oʻqiydi va xotirada yoki faqat konveyer oʻqiy oladigan, ishga tushirish tugashi bilan oʻchiriladigan faylda saqlaydi. Kanalni uzganingizda saqlangan token yoʻq qilinadi.",
            ],
          },
          "Har ikki holatda ham tokenlar hech qachon brauzeringizga yuborilmaydi va jurnalga yozilmaydi. Panel faqat maxfiy boʻlmagan ulanish maʼlumotlarini koʻrsatadi: qaysi YouTube kanali ulangan, qachon va kim tomonidan, qanday ruxsatlar berilgan. OAuth mijozimizning hisob maʼlumotlari faqat server konfiguratsiyasida saqlanadi.",
          "Ulanish vaqtida qisqa muddatli http-only cookie (10 daqiqa) jarayonni saytlararo soʻrovni qalbakilashtirishdan himoya qiladi.",
        ],
      },
      {
        id: "processors",
        heading: "7. Xizmat koʻrsatuvchilar",
        body: [
          "Xizmatni ishlatish uchun quyidagi provayderlardan foydalanamiz. Har biri faqat oʻz vazifasi uchun kerakli narsani oladi.",
          {
            table: {
              head: ["Provayder", "Maqsad", "Qanday maʼlumot oladi"],
              rows: [
                ["Supabase", "Maʼlumotlar bazasi, kirish va fayl saqlash", "Akkaunt maʼlumotlari, sozlamalar, video yozuvlari (YouTube video ID, nom, maxfiylik), koʻrsatkichlar, tekshiruv uchun video nusxalari; tashkilotingiz ulagan kanallar uchun shifrlangan Google yangilash tokeni (Supabase Vault)"],
                ["Vercel", "Ushbu saytni hosting qilish (Yevropa Ittifoqi mintaqasi)", "Veb-soʻrovlar va soʻrov jurnallari"],
                ["GitHub (Actions)", "Video konveyerini ishga tushirish; shifrlangan sirlar ombori", "Shifrlangan Google tokenlari va API kalitlari; konveyer jurnallari va natija fayllari"],
                ["Google — YouTube Data va Analytics API", "3-boʻlimda tavsiflangan kanalingiz bilan amallar", "Videolaringiz, subtitrlar, muqovalar va yuqorida tavsiflangan soʻrovlar"],
                ["Google — Gemini API", "Tadqiqot, ssenariy yozish, faktlarni tekshirish, izohlar va koʻrsatkichlarni tahlil qilish", "Mavzular, ssenariylar, izohlar matni va videolaringiz koʻrsatkichlari"],
                ["ElevenLabs; Microsoft Edge nutq sintezi", "Ovozlashtirish — kanal sozlamasiga qarab", "Ssenariy matni"],
                ["Pexels, Pixabay", "Stok video va rasmlar", "Ssenariydan olingan qidiruv soʻzlari"],
                ["Ixtiyoriy media generatorlari, faqat operator yoqqan boʻlsa: Google Veo, Google Gemini (rasm), OpenAI (GPT Image), Black Forest Labs (FLUX), Ideogram, fal.ai, Leonardo.Ai, Higgsfield, Kling, MiniMax, Seedance (ByteDance), Wan (Alibaba Cloud)", "Rasm va video kliplar generatsiyasi", "Ssenariydan olingan promptlar"],
                ["vidIQ (ixtiyoriy)", "Kalit soʻz va sarlavha tadqiqoti", "Mavzu kalit soʻzlari va sarlavha qoralamalari"],
                ["Telegram, Slack (ixtiyoriy)", "Operatorga bildirishnomalar", "Ishga tushirish holati, video nomlari va havolalari"],
                ["Google Fonts, Amazon CloudFront", "Ushbu sahifalardagi shriftlar va fon mediasi", "Har qanday veb-soʻrovdagi kabi IP manzilingiz va brauzer maʼlumotlari"],
                ["Paddle (Paddle.com)", "Kredit xaridlari boʻyicha onlayn qayta sotuvchimiz va sotuvchi (Merchant of Record): toʻlov oynasi, toʻlovni qayta ishlash, soliq, cheklar va qaytarish", "Paddle toʻlov oynasiga kiritadigan toʻlov va hisob-kitob maʼlumotlaringiz — ularni Paddle oʻzi qayta ishlaydi; bizdan — toʻlov oynasini toʻldirish uchun akkauntingiz emaili hamda tashkilotingiz va akkauntingiz identifikatorlari"],
              ],
            },
          },
          "Google foydalanuvchi maʼlumotlarini faqat ushbu roʻyxatdagi Supabase, GitHub, Google va bildirishnoma xizmatlari oladi va faqat yuqoridagi maqsadlarda. Biz shaxsiy maʼlumotlarni hech kimga sotmaymiz.",
          "Toʻlovlar. Kreditlar onlayn qayta sotuvchimiz va sotuvchi (Merchant of Record) boʻlgan Paddle orqali sotiladi: kredit sotib olayotganda toʻlov va hisob-kitob maʼlumotlaringizni Paddle’ning oʻz toʻlov oynasiga kiritasiz va Paddle ularni sotuvchi sifatida [Paddle maxfiylik bildirishnomasi](https://www.paddle.com/legal/privacy) asosida qayta ishlaydi. Biz karta maʼlumotlaringizni yoki hisob-kitob manzilingizni hech qachon olmaymiz va saqlamaymiz. Paddle bizga faqat xaridni hisobga qoʻshish va qaytarishda uni bekor qilish uchun kerakli narsani yuboradi: tranzaksiya va qaytarish identifikatorlari, toʻlangan summa va valyuta, sotib olingan kreditlar hamda xarid qaysi tashkilot (va maʼlum boʻlsa, qaysi foydalanuvchi) uchun qilingani. Bu yozuvlarni tashkilotingizning kredit tarixi bilan birga uning akkaunti mavjud ekan saqlaymiz yoki soliq yoxud buxgalteriya qonunchiligi talab qilsa, undan uzoqroq.",
        ],
      },
      {
        id: "retention",
        heading: "8. Saqlash va oʻchirish",
        body: [
          {
            list: [
              "Google tokenlari kanalingiz ulangan ekan saqlanadi. Ruxsatni bekor qilgan zahotingiz ular ishlamay qoladi, kanalni uzsangiz yoki soʻrasangiz, biz ularni oʻchiramiz.",
              "Omborimizdagi tekshiruv uchun video nusxalari har bir kanal uchun oxirgi beshta bilan cheklangan; eskilari avtomatik oʻchiriladi.",
              "Konveyer natijalari (tayyor video, muqovalar va ishga tushirish jurnali) GitHub Actions’da 7 kun saqlanadi, soʻng avtomatik oʻchiriladi.",
              "Akkaunt maʼlumotlari, sozlamalar, video yozuvlari va koʻrsatkichlar akkauntingiz faol ekan saqlanadi va tasdiqlangan oʻchirish soʻrovidan keyin 30 kun ichida oʻchiriladi.",
              "Tasdiqlashlar va boshqa qarorlar boʻyicha audit yozuvlari akkaunt mavjud ekan saqlanadi, chunki ular kanal bilan bogʻliq amalga kim ruxsat berganini qayd etadi.",
            ],
          },
          "Nightshift’ning Google akkauntingizga kirish huquqini istalgan vaqtda [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions) sahifasida bekor qilishingiz mumkin. Akkauntingizni va bizdagi maʼlumotlarni oʻchirish uchun {contactEmail} manziliga yozing.",
        ],
      },
      {
        id: "cookies",
        heading: "9. Cookie va mahalliy xotira",
        body: [
          "Biz faqat Xizmat ishlashi uchun kerakli narsalardan foydalanamiz: kirish seansi cookieʼlari (Supabase), tanlangan tilni eslab qoluvchi cookie, oxirgi koʻrilgan kanalni eslab qoluvchi cookie, YouTube ulanayotganda ishlatiladigan 10 daqiqalik cookie va brauzeringizning mahalliy xotirasidagi mavzu (tema) tanlovi. Reklama yoki analitika cookieʼlaridan foydalanmaymiz.",
        ],
      },
      {
        id: "security",
        heading: "10. Xavfsizlik",
        body: [
          "Trafik uzatishda shifrlanadi (HTTPS). Maʼlumotlar bazasiga kirish har bir foydalanuvchi uchun qator darajasidagi xavfsizlik (RLS) bilan cheklangan, sayt faqat cheklangan ochiq kalitdan foydalanadi, sirlar esa saqlashdan oldin shifrlanadi. Hech bir tizim mutlaqo xavfsiz emas; maʼlumotlaringizga tegishli sizib chiqish haqida bilsak, qonun talab qilganidek sizni xabardor qilamiz.",
        ],
      },
      {
        id: "your-rights",
        heading: "11. Tanlovingiz va huquqlaringiz",
        body: [
          "Kanalni uzishingiz, Google ruxsatini bekor qilishingiz hamda {contactEmail} manziliga yozib, shaxsiy maʼlumotlaringizga kirish, ularni tuzatish, eksport qilish yoki oʻchirishni soʻrashingiz mumkin. Yashash joyingizga qarab mahalliy qonun boʻyicha qoʻshimcha huquqlaringiz, jumladan maʼlumotlarni himoya qilish organiga shikoyat qilish huquqingiz boʻlishi mumkin.",
        ],
      },
      {
        id: "transfers",
        heading: "12. Xalqaro uzatish",
        body: [
          "Provayderlarimiz Yevropa Ittifoqi, AQSh va boshqa mamlakatlarda ishlaydi, shuning uchun maʼlumotlaringiz mamlakatingizdan tashqarida qayta ishlanishi mumkin. Qonun talab qilgan joyda biz provayderlarning standart shartnomaviy kafolatlariga tayanamiz.",
        ],
      },
      {
        id: "children",
        heading: "13. Bolalar",
        body: [
          "Xizmat bolalarga moʻljallanmagan va undan 13 yoshdan kichiklar yoki oʻz mamlakatida YouTube kanalni boshqarish uchun talab qiladigan eng kam yoshga yetmaganlar foydalana olmaydi.",
        ],
      },
      {
        id: "google-and-youtube",
        heading: "14. YouTube va Google",
        body: [
          "Nightshift YouTube API xizmatlaridan foydalanadi. YouTube kanalini ulash orqali siz [YouTube foydalanish shartlari](https://www.youtube.com/t/terms)ga rioya qilishga rozilik bildirasiz. Google maʼlumotlaringizni qanday qayta ishlashi [Google maxfiylik siyosati](https://policies.google.com/privacy) bilan tartibga solinadi.",
        ],
      },
      {
        id: "changes",
        heading: "15. Siyosatdagi oʻzgarishlar",
        body: [
          "Har qanday oʻzgarishni shu sahifada eʼlon qilamiz va kuchga kirish sanasini ({effectiveDate}) yangilaymiz. Agar oʻzgarish Google maʼlumotlaridan foydalanishimizga jiddiy taʼsir qilsa, Xizmatda xabar beramiz va kerak boʻlsa, qayta rozilik soʻraymiz.",
        ],
      },
      {
        id: "contact",
        heading: "16. Aloqa",
        body: ["{legalName}, {country}. Elektron pochta: {contactEmail}."],
      },
    ],
  },
  terms: {
    title: "Foydalanish shartlari",
    summary:
      "Nightshift’dan foydalanish qoidalari: kanal va kontent uchun javobgarligingiz, nimalar taqiqlangan, oldindan toʻlangan kreditlar, toʻlov va qaytarish qanday ishlashi hamda javobgarligimiz chegaralari.",
    sections: [
      {
        id: "agreement",
        heading: "1. Kelishuv",
        body: [
          "Ushbu Shartlar siz bilan {legalName} («biz»), {country} oʻrtasidagi kelishuv boʻlib, Nightshift’dan («Xizmat») foydalanishingizni tartibga soladi. Xizmatga kirish yoki undan foydalanish orqali siz ularni qabul qilasiz. Agar Xizmatdan tashkilot nomidan foydalansangiz, uni ushbu Shartlar bilan majburlash huquqingiz borligini tasdiqlaysiz. [Maxfiylik siyosati](/privacy)miz maʼlumotlaringiz bilan qanday ishlashimizni tushuntiradi.",
        ],
      },
      {
        id: "service",
        heading: "2. Xizmat",
        body: [
          "Nightshift siz boshqaradigan YouTube kanallari uchun video tayyorlashga yordam beradi: mavzularni oʻrganadi, ssenariy yozadi va tekshiradi, ovozlashtiradi, render qiladi, videolarni kanalingizga yuklaydi va ularning natijalarini koʻrsatadi. Funksiyalar oʻzgarishi mumkin, Xizmatning ayrim qismlari sinov versiyasi sifatida taqdim etilishi mumkin.",
        ],
      },
      {
        id: "accounts",
        heading: "3. Akkauntlar",
        body: [
          "Hozircha kirish taklif orqali beriladi. Kirish maʼlumotlaringizni xavfsiz saqlang va ruxsatsiz foydalanishdan shubhalansangiz, darhol {contactEmail} manziliga xabar bering. Akkauntingizdagi harakatlar uchun siz javobgarsiz.",
        ],
      },
      {
        id: "youtube",
        heading: "4. YouTube kanalingiz va Google akkauntingiz",
        body: [
          "Faqat oʻzingizga tegishli yoki boshqarishga vakolatingiz bor kanallarni ulashingiz mumkin. Kanalni ulash orqali siz Nightshift’ga Maxfiylik siyosatida tavsiflanganidek, Google rozilik oynasida bergan ruxsatlaringiz doirasida u bilan ishlashga ruxsat berasiz. Kanalingiz uchun javobgarlik oʻzingizda qoladi va siz [YouTube foydalanish shartlari](https://www.youtube.com/t/terms) hamda YouTube’ning [Hamjamiyat qoidalari](https://www.youtube.com/howyoutubeworks/policies/community-guidelines/)ga rioya qilishingiz shart. Google maʼlumotlaringizni qanday qayta ishlashi [Google maxfiylik siyosati](https://policies.google.com/privacy) bilan tartibga solinadi.",
          "Ruxsatni istalgan vaqtda [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions) sahifasida bekor qilishingiz mumkin; shundan soʻng Xizmat oʻsha kanal bilan ishlashni toʻxtatadi.",
        ],
      },
      {
        id: "content",
        heading: "5. Kontentingiz va javobgarligingiz",
        body: [
          "Kanalingiz uchun yaratilgan kontent sizga tegishli va u uchun siz javobgarsiz — akkauntingizdan yuklangan hamma narsa, uni oʻzingiz tekshirganmisiz yoki siz tanlagan sozlamalar boʻyicha Xizmatga nashr qilishga ruxsat berganmisiz, bundan qatʼi nazar. Xususan, siz quyidagilar uchun javobgarsiz:",
          {
            list: [
              "videolaringizdagi mavzular, ssenariylar, ovozlar, videomateriallar, musiqa, logotiplar va boshqa materiallarga huquqingiz borligi;",
              "faktlarni tekshirish: generatsiya qilingan ssenariy va xulosalarda xato boʻlishi mumkin, faktlarni tekshirish bu xavfni kamaytiradi, lekin yoʻqotmaydi;",
              "YouTube yoki qonun talab qilgan joyda oʻzgartirilgan yoki sintetik kontentni belgilash;",
              "kanalingizning YouTube’dagi holati, jumladan ogohlantirishlar (strike), monetizatsiya qarorlari va bloklanishlar.",
            ],
          },
          "Siz bizga kontentingizni faqat siz uchun Xizmatni ishlatish maqsadida qayta ishlash boʻyicha cheklangan litsenziya berasiz.",
        ],
      },
      {
        id: "acceptable-use",
        heading: "6. Maqbul foydalanish",
        body: [
          "Xizmatdan quyidagilar uchun foydalanish taqiqlanadi:",
          {
            list: [
              "spam yoki asosan YouTube tizimlarini aldash uchun yaratilgan ommaviy, takroriy yoki past qiymatli kontentni, yoxud YouTube’ning [spam, aldov va firibgarlik qoidalari](https://support.google.com/youtube/answer/2801973)ni buzadigan har qanday narsani nashr qilish;",
              "tomoshabinlarni chalgʻitish — jumladan videoni notoʻgʻri aks ettiruvchi klikbeyt sarlavha yoki muqovalar, oʻzgani oʻzini koʻrsatish yoki fakt sifatida taqdim etilgan toʻqima daʼvolar;",
              "noqonuniy, boshqalarning huquqini buzadigan, taʼqib qiladigan yoki nafratga undaydigan, voyaga yetmaganlarni jinsiylashtiradigan yoki YouTube Hamjamiyat qoidalarini buzadigan kontentni nashr qilish;",
              "boshqarishga vakolatingiz boʻlmagan kanallarni boshqarish yoki YouTube cheklovi yoxud bloklanishini chetlab oʻtish uchun kanal yaratish va yuritish;",
              "YouTube API kvotalari yoki cheklovlarini chetlab oʻtish, boshqa foydalanuvchilar maʼlumotlariga kirish, Xizmatni tekshirib koʻrish yoki ishini buzish, qonun ruxsat bergan holatlardan tashqari uni teskari muhandislik qilish;",
              "yozma ruxsatimizsiz Xizmatga kirish huquqini qayta sotish yoki boshqalarga berish.",
            ],
          },
        ],
      },
      {
        id: "third-parties",
        heading: "7. Uchinchi tomon xizmatlari",
        body: [
          "Xizmat Maxfiylik siyosatida sanab oʻtilgan uchinchi tomon provayderlariga tayanadi. Oʻz API kalitlaringizni bersangiz, bu provayderlardan foydalanishingiz ularning shartlari va tariflariga boʻysunadi, ularning mavjudligi yoki natijalari uchun biz javobgar emasmiz.",
        ],
      },
      {
        id: "credits",
        heading: "8. Oldindan toʻlangan kreditlar, toʻlov va qaytarish",
        body: [
          {
            note: "Bu boʻlim oldindan toʻlangan kreditlar Xizmatda hozir qanday ishlashini tavsiflaydi. U malakali yurist koʻrib chiqishini kutmoqda; har qanday oʻzgarish shu sahifada yangi kuchga kirish sanasi bilan eʼlon qilinadi.",
          },
          "8.1. Nima sotib olasiz. Xizmatdan foydalanishning bir qismi oldindan toʻlangan kreditlar bilan toʻlanadi. Ular [Narxlar](/pricing) sahifasida koʻrsatilgan narxlarda, yakuniy koʻrinishda esa toʻlashdan oldin toʻlov oynasida koʻrsatilgan narxda ikki xil sotiladi: (a) oylik tariflar — siz bekor qilmaguningizcha har oy avtomatik yangilanadigan obuna; u har bir toʻlangan davr uchun belgilangan miqdorda kredit beradi; bu kreditlar faqat shu davr ichida ishlatiladi va uning oxirida yonadi, keyingi davrga oʻtmaydi; obunani istalgan vaqtda bekor qilish mumkin, shundan keyin tarif allaqachon toʻlangan davr oxirigacha qoʻshimcha toʻlovsiz amal qiladi; va (b) kredit paketlari — yangilanmaydigan bir martalik toʻlovlar. Kreditlar siz ular uchun sotib olgan tashkilot balansiga qoʻshiladi va faqat Xizmatda, faqat shu tashkilot tomonidan ishlatilishi mumkin. Tarif kreditlari paket kreditlaridan oldin, muddati tezroq tugaydiganlari esa birinchi sarflanadi.",
          "8.2. Kimdan sotib olasiz. Buyurtma jarayonini bizning onlayn qayta sotuvchimiz (reseller) Paddle.com («Paddle») amalga oshiradi. Paddle barcha buyurtmalarimiz boʻyicha sotuvchi (Merchant of Record) hisoblanadi: kreditlarni siz Paddle’dan [Paddle xaridorlar shartlari](https://www.paddle.com/legal/checkout-buyer-terms) asosida sotib olasiz. Paddle toʻlovni qayta ishlaydi, amaldagi soliqlarni (QQS yoki savdo soligʻi) hisoblaydi va undiradi, chek yoki hisob-faktura beradi hamda toʻlov boʻyicha savollar va qaytarish soʻrovlarini koʻrib chiqadi. Toʻlov maʼlumotlaringizni Paddle [Paddle maxfiylik bildirishnomasi](https://www.paddle.com/legal/privacy) asosida qayta ishlaydi; biz karta maʼlumotlaringizni hech qachon olmaymiz va saqlamaymiz.",
          "8.3. Kreditlar qanday sarflanadi. Kreditlar Xizmat tashkilotingiz kanallaridan biri uchun video tayyorlaganda sarflanadi:",
          {
            list: [
              "Ishga tushirishdan oldin taxminiy miqdordagi kredit band qilinadi. Taxmin — soʻralgan video uzunligining amaldagi daqiqalik stavkaga koʻpaytmasi, daqiqalik stavka qoʻllanilmasa — kanalingizning soʻnggi ishga tushirishlari narxiga asoslangan hisob; u hech qachon bitta ishga tushirish uchun belgilangan minimumdan kam boʻlmaydi. Taxmin ishga tushirishdan oldin Xizmatda koʻrsatiladi va mavjud kreditlaringiz (balans minus allaqachon band qilinganlar) uni qoplamasa, ishga tushirish boshlanmaydi.",
              "Ishga tushirish tugagach, u haqiqatda ishlatgan resurslar uchun kreditlar amaldagi stavkalar boʻyicha yechiladi — lekin hech qachon banddan koʻp emas. Bandning ishlatilmagan qismi shu zahoti mavjud kreditlaringizga qaytariladi. Ishga tushirish ishlatgan resurslarning hammasini oʻlchab va narxlab boʻlmasa, band toʻliq yechiladi.",
              "Ishga tushirish muvaffaqiyatsiz tugasa yoki oxiriga yetmasa, band toʻliq qaytariladi va hech narsa yechilmaydi. Hech qachon boshlanmagan yoki natijasini xabar qilmagan ishga tushirishning bandi avtomatik qaytariladi.",
              "Har bir band, yechish va qaytarish Xizmatdagi tashkilotingizning kredit tarixiga yoziladi.",
            ],
          },
          "8.4. Kreditlarning tabiati. Kreditlar — Xizmatdan foydalanish uchun oldindan toʻlangan huquq, pul yoki depozit emas: ularning pul qiymati yoʻq, ularga foiz hisoblanmaydi, ularni pulga almashtirib (8.6-boʻlimdagi qaytarishdan tashqari), boshqa tashkilotga oʻtkazib yoki qayta sotib boʻlmaydi.",
          {
            creditExpiry: {
              never: "8.5. Amal qilish muddati. Kreditlarning muddati tugamaydi.",
              after: "8.5. Amal qilish muddati. Ishlatilmagan kreditlarning muddati sotib olingan kundan boshlab {months} oy oʻtgach tugaydi.",
              unknown: "8.5. Amal qilish muddati. Toʻldirish kreditlari uchun sotib olish paytida paketlarga belgilangan muddat amal qiladi. Hozir uni bu sahifada koʻrsatib boʻlmadi; joriy muddatni bilish uchun bizga {contactEmail} manziliga yozing.",
            },
          },
          "8.6. Qaytarish. Sotuvchi Paddle boʻlgani uchun qaytarishni Paddle [Paddle xaridorlar shartlari](https://www.paddle.com/legal/checkout-buyer-terms) va amaldagi qonunchilik asosida amalga oshiradi, jumladan yashash joyingizda isteʼmolchi sifatida xariddan voz kechish huquqingiz boʻlsa, shu huquq asosida ham. Qaytarishni soʻrash uchun Paddle chekidagi havoladan foydalaning yoki {contactEmail} manziliga yozing — yordam beramiz.",
          "8.7. Qaytarish va chargeback kreditlarni olib qoʻyadi. Xarid qaytarilsa yoki bank orqali eʼtiroz qilinsa (chargeback), u qoʻshgan kreditlar tashkilot balansidan olinadi: toʻliq qaytarishda — hammasi, qisman qaytarishda — qaytarilgan summaga mutanosib qismi. Faqat mavjud kreditlarni olish mumkin: allaqachon sarflangan yoki ishlab turgan ishga tushirish uchun band qilinganlarini olib boʻlmaydi. Chargeback’dan keyin sarflangan, lekin toʻlanmagan kreditlar qolsa, tashkilotning pullik funksiyalardan foydalanishini toʻxtatib turishimiz mumkin.",
          "8.8. Narxlarning oʻzgarishi. Kredit paketlari narxlarini va kreditlar sarflanish stavkalarini oʻzgartirishimiz mumkin. Oʻzgarish balansingizdagi kreditlarni hech qachon kamaytirmaydi va ishga tushirish uchun u boshlanganda qoʻyilgan banddan koʻp hech qachon yechilmaydi.",
        ],
      },
      {
        id: "ip",
        heading: "9. Bizning intellektual mulkimiz",
        body: [
          "Xizmat, uning dasturiy taʼminoti va brendi bizga yoki litsenziarlarimizga tegishli. Ushbu Shartlar akkauntingiz faol ekan Xizmatdan foydalanish uchun sizga shaxsiy, eksklyuziv boʻlmagan va boshqaga oʻtkazilmaydigan huquq beradi. Bizga fikr-mulohaza yuborsangiz, undan sizning oldingizda majburiyatsiz foydalanishimiz mumkin.",
        ],
      },
      {
        id: "disclaimers",
        heading: "10. Kafolatlardan voz kechish",
        body: [
          "Xizmat «boricha» va «mavjud boʻlganicha» taqdim etiladi. Qonun ruxsat bergan darajada biz barcha nazarda tutilgan kafolatlardan voz kechamiz. Biz koʻrishlar, obunachilar, daromad, monetizatsiya tasdiqlanishi yoki YouTube biror video yoki kanalni cheklamasligi, monetizatsiyadan chiqarmasligi yoxud oʻchirmasligini kafolatlamaymiz.",
        ],
      },
      {
        id: "liability",
        heading: "11. Javobgarlikni cheklash",
        body: [
          "Qonun ruxsat bergan darajada biz bilvosita, tasodifiy, maxsus, oqibatli yoki jarima tarzidagi zararlar, shuningdek boy berilgan foyda, daromad, maʼlumotlar, obroʻ yoki kanal holati uchun javobgar emasmiz. Xizmat bilan bogʻliq har qanday daʼvo boʻyicha umumiy javobgarligimiz daʼvoga asos boʻlgan hodisadan oldingi oʻn ikki oy ichida Xizmat uchun bizga toʻlagan summangiz bilan cheklanadi. Ushbu Shartlardagi hech narsa qonun boʻyicha cheklab boʻlmaydigan javobgarlikni cheklamaydi.",
        ],
      },
      {
        id: "indemnity",
        heading: "12. Zararni qoplash",
        body: [
          "Kontentingiz, kanalingiz yoki ushbu Shartlar yoxud qonunni buzganingiz sababli uchinchi shaxslar qoʻygan daʼvolar boʻyicha zararni siz qoplaysiz.",
        ],
      },
      {
        id: "termination",
        heading: "13. Toʻxtatib turish va tugatish",
        body: [
          "Xizmatdan foydalanishni istalgan vaqtda toʻxtatishingiz, kanallaringizni uzishingiz va Google ruxsatini bekor qilishingiz mumkin. Agar siz ushbu Shartlarni buzsangiz, foydalanishingiz YouTube yoki Google qoidalariga (jumladan bizning ularga rioya qilishimizga) xavf tugʻdirsa yoki qonun talab qilsa, kirishingizni toʻxtatib turishimiz yoki tugatishimiz mumkin; oqilona boʻlsa, oldindan xabar beramiz. Kirish tugagach, Xizmat kanallaringiz bilan ishlashni toʻxtatadi, saqlangan Google tokenlaringiz oʻchiriladi, maʼlumotlaringiz esa Maxfiylik siyosatida tavsiflanganidek oʻchiriladi. 5, 9, 10, 11, 12 va 15-boʻlimlar tugatishdan keyin ham amal qiladi.",
        ],
      },
      {
        id: "changes",
        heading: "14. Shartlardagi oʻzgarishlar",
        body: [
          "Ushbu Shartlarni yangilashimiz mumkin. Yangi versiyani shu sahifada yangi kuchga kirish sanasi ({effectiveDate}) bilan eʼlon qilamiz va jiddiy oʻzgarishlar haqida Xizmatda xabar beramiz. Oʻzgarish kuchga kirgandan keyin Xizmatdan foydalanishda davom etsangiz, uni qabul qilgan boʻlasiz.",
        ],
      },
      {
        id: "law",
        heading: "15. Amaldagi huquq",
        body: [
          "Ushbu Shartlar {country} qonunchiligi bilan tartibga solinadi; bu yashash joyingizdagi isteʼmolchilar huquqlarining majburiy himoyasiga taʼsir qilmaydi.",
        ],
      },
      {
        id: "contact",
        heading: "16. Aloqa",
        body: ["{legalName}, {country}. Elektron pochta: {contactEmail}."],
      },
    ],
  },
};
