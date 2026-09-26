import type { LegalTexts } from "./types";

/** Uzbek translation of ./en.ts. The English text governs; keep this in step with it. */
export const uz: LegalTexts = {
  privacy: {
    title: "Maxfiylik siyosati",
    summary:
      "Nightshift qanday ma'lumot to'playdi, Google va YouTube ma'lumotlaringiz bilan nima qiladi, ularni kim qayta ishlaydi, qancha saqlanadi va qanday o'chiriladi.",
    sections: [
      {
        id: "who-we-are",
        heading: "1. Biz kimmiz",
        body: [
          "Nightshift («Xizmat») — videoni avtomatik ishlab chiqarish vositasi: shu domendagi veb-panel va foydalanuvchilar ulagan YouTube kanallari uchun mavzuni o'rganadigan, ssenariy yozadigan, ovozlashtiradigan, render qiladigan va yuklaydigan konveyer. Xizmat operatori — {legalName} («biz»), {country}. Aloqa: {contactEmail}.",
          "Ushbu siyosat Xizmat qanday ma'lumot to'plashi, undan qanday foydalanishi va kimga uzatishi hamda sizda qanday tanlov borligini tushuntiradi. U shu sayt va siz nomingizdan ishlaydigan avtomatik konveyerga taalluqli.",
        ],
      },
      {
        id: "information-we-collect",
        heading: "2. Biz to'playdigan ma'lumotlar",
        body: [
          {
            list: [
              "Akkaunt ma'lumotlari: elektron pochta manzilingiz va parolingiz — ularni autentifikatsiya provayderimiz (Supabase Auth) boshqaradi. Biz parolingizni hech qachon ochiq ko'rinishda ko'rmaymiz va saqlamaymiz.",
              "Siz kiritgan sozlamalar: kanal nomlari, nisha, til, ovoz va uslub tanlovi, jadvallar, seriyalar, jamoa a'zolari va rollar, shuningdek tekshiruvdagi qarorlaringiz (masalan, videoni tasdiqlash) — ular foydalanuvchi identifikatoringiz bilan audit jurnaliga yoziladi.",
              "Siz kiritgan uchinchi tomon xizmatlarining API kalitlari: ular serverimizga kelgan zahoti shifrlanadi, konveyerning shifrlangan sirlar omboriga (GitHub Actions secrets) yoziladi va tashlab yuboriladi. Ular hech qachon ma'lumotlar bazamizda saqlanmaydi, sizga qayta ko'rsatilmaydi va jurnallarga yozilmaydi.",
              "Siz ruxsat bergan Google foydalanuvchi ma'lumotlari — 3-bo'limga qarang.",
              "Texnik ma'lumotlar: hosting va ma'lumotlar bazasi provayderlarimiz Xizmatni ishlatish va himoya qilish uchun standart so'rov jurnallarini (IP manzil, brauzer turi, so'rov vaqti) yuritadi. Biz analitika, reklama yoki kuzatuv vositalaridan foydalanmaymiz.",
            ],
          },
        ],
      },
      {
        id: "google-user-data",
        heading: "3. Qaysi Google ma'lumotlariga kiramiz",
        body: [
          "YouTube kanalini ulaganingizda Google'ning o'z rozilik oynasiga o'tasiz: u yerda Google akkauntini tanlaysiz va aynan nima so'ralayotganini ko'rasiz. Biz quyidagi OAuth ruxsat doiralarini (scope) so'raymiz va har biridan faqat ko'rsatilgan maqsadda foydalanamiz:",
          {
            table: {
              head: ["Ruxsat doirasi", "Nightshift u bilan nima qiladi"],
              rows: [
                [
                  "`youtube.upload`",
                  "Nightshift kanalingiz uchun tayyorlagan videolarni yuklaydi va ularning muqovasini (thumbnail) o'rnatadi. Agar shu kanal uchun boshqacha tanlamagan bo'lsangiz — masalan, sukut bo'yicha o'chiq avto-nashrni yoqmagan bo'lsangiz — yuklangan videolar yopiq (private) bo'ladi.",
                ],
                [
                  "`youtube.readonly`",
                  "Qaysi kanalni ulaganingizni tasdiqlash uchun kanal identifikatsiyasini (ID va nom) o'qiydi; bir video ikki marta yuklanmasligi uchun kanalning so'nggi yuklamalari ro'yxatini (ID va nomlar) oladi; panel uchun videolaringizning asosiy ma'lumotlari va ochiq statistikasini o'qiydi.",
                ],
                [
                  "`youtube.force-ssl`",
                  "Nightshift yuklagan videolarga subtitr yo'lagini qo'shadi; nashr qilingan videoni seriya pleylistiga qo'shadi; Nightshift nashr qilgan video ostida kanal nomidan bitta izoh (tomoshabinlarga savol) qoldiradi; auditoriya so'rayotgan mavzularni topish uchun kanal videolaridagi izohlarni o'qiydi. Texnik jihatdan bu ruxsat videolarni tahrirlash va o'chirishga ham imkon beradi — Nightshift hech narsani o'chirmaydi va mavjud videolaringiz, pleylistlaringiz yoki izohlaringizni tahrirlamaydi; u faqat shu yerda sanab o'tilganlarni qo'shadi.",
                ],
                [
                  "`yt-analytics.readonly`",
                  "Kanalingiz videolari bo'yicha YouTube Analytics hisobotlarini o'qiydi: ko'rishlar, tomosha vaqti, o'rtacha ko'rish davomiyligi va foizi, layklar, izohlar, ulashishlar, qo'shilgan va ketgan obunachilar, ko'rsatilishlar, CTR va auditoriyani ushlab qolish. Bu ko'rsatkichlar panelingizda ko'rsatiladi va keyingi videolar uchun yaxshiroq mavzu tanlashda ishlatiladi.",
                ],
                [
                  "`yt-analytics-monetary.readonly` (ixtiyoriy)",
                  "Faqat operator daromad hisobini aniq yoqqan bo'lsa so'raladi. Panel uchun videolaringizning taxminiy daromadini o'qiydi. Aks holda so'ralmaydi.",
                ],
              ],
            },
          },
          "Biz Gmail, Google Drive, kontaktlar yoki boshqa Google xizmatlariga ruxsat so'ramaymiz va YouTube'dagi ko'rish tarixingiz, obunalaringiz yoki shaxsiy xabarlaringizni o'qimaymiz.",
        ],
      },
      {
        id: "how-we-use-google-data",
        heading: "4. Google ma'lumotlaridan qanday foydalanamiz",
        body: [
          "Google foydalanuvchi ma'lumotlari faqat Xizmatda siz ko'radigan funksiyalarni taqdim etish va yaxshilash uchun ishlatiladi: videolaringizni yuklash va subtitrlash, ularni pleylistlarga qo'shish, jalb qiluvchi izohni joylash, takroriy yuklashning oldini olish, kanal natijalarini panelda ko'rsatish va nima yaxshi ishlagani hamda auditoriya nimani so'rayotganiga qarab keyingi mavzularni tanlash.",
          "Bu xulosalar uchun videolaringizdagi izohlar matni va video ko'rsatkichlari kanalingiz uchun tasniflash va umumlashtirish maqsadida matn uchun sun'iy intellekt provayderimizga (Google Gemini API) yuborilishi mumkin. Biz izoh matnini emas, natijani saqlaymiz — masalan, auditoriya so'ragan mavzu va u necha marta so'ralgani.",
        ],
      },
      {
        id: "limited-use",
        heading: "5. Cheklangan foydalanish (Limited Use)",
        body: [
          "Nightshift'ning Google API'dan olingan ma'lumotlardan foydalanishi va ularni boshqa ilovaga uzatishi [Google API xizmatlari foydalanuvchi ma'lumotlari siyosati](https://developers.google.com/terms/api-services-user-data-policy)ga, jumladan Cheklangan foydalanish (Limited Use) talablariga amal qiladi. Xususan:",
          {
            list: [
              "Google foydalanuvchi ma'lumotlaridan faqat yuqorida tavsiflangan, foydalanuvchiga ko'rinadigan funksiyalarni taqdim etish yoki yaxshilash uchun foydalanamiz;",
              "ularni boshqalarga faqat shu funksiyalar uchun zarur hajmda (7-bo'limdagi qayta ishlovchilarga), qonunga rioya qilish uchun yoki sizni xabardor qilgan holda qo'shilish, sotib olinish yoki aktivlar sotilishi doirasida uzatamiz;",
              "ulardan reklama, jumladan shaxsiylashtirilgan yoki retargeting reklamasi ko'rsatish uchun foydalanmaymiz va uzatmaymiz;",
              "ularni sotmaymiz va kreditga layoqatni aniqlash yoki kredit berish uchun ishlatmaymiz;",
              "odamlarga ularni o'qishga ruxsat bermaymiz — faqat siz aniq ma'lumotlar uchun ochiq rozilik bergan bo'lsangiz, xavfsizlik uchun (masalan, suiiste'molni tekshirish) zarur bo'lsa, qonunga rioya qilish uchun kerak bo'lsa yoki ma'lumotlar ichki ishlar uchun jamlangan va anonimlashtirilgan bo'lsa bundan mustasno;",
              "ulardan umumiy maqsadli sun'iy intellekt yoki mashinaviy o'qitish modellarini ishlab chiqish, yaxshilash yoki o'qitish uchun foydalanmaymiz.",
            ],
          },
        ],
      },
      {
        id: "tokens",
        heading: "6. Google'ga kirish huquqingiz qanday saqlanadi",
        body: [
          "Siz rozilik berganingizdan so'ng Google serverimizga kirish tokeni va yangilash tokenini qaytaradi. Ular qayerda saqlanishi kanal kimniki ekaniga bog'liq:",
          {
            list: [
              "Biz boshqaradigan kanallar (o'z tashkilotimiz): token darhol shifrlanadi (konveyer repozitoriysining ochiq kaliti bilan muhrlanadi) va faqat konveyer ishga tushganda o'qiy oladigan shifrlangan GitHub Actions siri sifatida saqlanadi.",
              "Tashkilotingiz ulagan kanallar: faqat yangilash tokeni saqlanadi, Supabase Vault'da shifrlangan holda. Boshqaruv paneli uni saqlashi yoki o'chirishi mumkin, lekin hech qachon qayta o'qiy olmaydi — na siz uchun, na tashkilotingizdagi boshqa birov uchun; uni faqat bizning konveyerimiz, faqat serverdagi kalit bilan, shu kanal uchun ishga tushirish davomida o'qiydi va xotirada yoki faqat konveyer o'qiy oladigan, ishga tushirish tugashi bilan o'chiriladigan faylda saqlaydi. Kanalni uzganingizda saqlangan token yo'q qilinadi.",
            ],
          },
          "Har ikki holatda ham tokenlar hech qachon brauzeringizga yuborilmaydi va jurnalga yozilmaydi. Panel faqat maxfiy bo'lmagan ulanish ma'lumotlarini ko'rsatadi: qaysi YouTube kanali ulangan, qachon va kim tomonidan, qanday ruxsatlar berilgan. OAuth mijozimizning hisob ma'lumotlari faqat server konfiguratsiyasida saqlanadi.",
          "Ulanish vaqtida qisqa muddatli http-only cookie (10 daqiqa) jarayonni saytlararo so'rovni qalbakilashtirishdan himoya qiladi.",
        ],
      },
      {
        id: "processors",
        heading: "7. Xizmat ko'rsatuvchilar",
        body: [
          "Xizmatni ishlatish uchun quyidagi provayderlardan foydalanamiz. Har biri faqat o'z vazifasi uchun kerakli narsani oladi.",
          {
            table: {
              head: ["Provayder", "Maqsad", "Qanday ma'lumot oladi"],
              rows: [
                ["Supabase", "Ma'lumotlar bazasi, kirish va fayl saqlash", "Akkaunt ma'lumotlari, sozlamalar, video yozuvlari (YouTube video ID, nom, maxfiylik), ko'rsatkichlar, tekshiruv uchun video nusxalari; tashkilotingiz ulagan kanallar uchun shifrlangan Google yangilash tokeni (Supabase Vault)"],
                ["Vercel", "Ushbu saytni hosting qilish (Yevropa Ittifoqi mintaqasi)", "Veb-so'rovlar va so'rov jurnallari"],
                ["GitHub (Actions)", "Video konveyerini ishga tushirish; shifrlangan sirlar ombori", "Shifrlangan Google tokenlari va API kalitlari; konveyer jurnallari va natija fayllari"],
                ["Google — YouTube Data va Analytics API", "3-bo'limda tavsiflangan kanalingiz bilan amallar", "Videolaringiz, subtitrlar, muqovalar va yuqorida tavsiflangan so'rovlar"],
                ["Google — Gemini API", "Tadqiqot, ssenariy yozish, faktlarni tekshirish, izohlar va ko'rsatkichlarni tahlil qilish", "Mavzular, ssenariylar, izohlar matni va videolaringiz ko'rsatkichlari"],
                ["ElevenLabs; Microsoft Edge nutq sintezi", "Ovozlashtirish — kanal sozlamasiga qarab", "Ssenariy matni"],
                ["Pexels, Pixabay", "Stok video va rasmlar", "Ssenariydan olingan qidiruv so'zlari"],
                ["Ixtiyoriy media generatorlari, faqat operator yoqqan bo'lsa: Google Veo, Leonardo.Ai, Higgsfield, Kling, MiniMax, Seedance (ByteDance), Wan (Alibaba Cloud)", "Rasm va video kliplar generatsiyasi", "Ssenariydan olingan promptlar"],
                ["vidIQ (ixtiyoriy)", "Kalit so'z va sarlavha tadqiqoti", "Mavzu kalit so'zlari va sarlavha qoralamalari"],
                ["Telegram, Slack (ixtiyoriy)", "Operatorga bildirishnomalar", "Ishga tushirish holati, video nomlari va havolalari"],
                ["Google Fonts, Amazon CloudFront", "Ushbu sahifalardagi shriftlar va fon mediasi", "Har qanday veb-so'rovdagi kabi IP manzilingiz va brauzer ma'lumotlari"],
              ],
            },
          },
          "Google foydalanuvchi ma'lumotlarini faqat ushbu ro'yxatdagi Supabase, GitHub, Google va bildirishnoma xizmatlari oladi va faqat yuqoridagi maqsadlarda. Biz shaxsiy ma'lumotlarni hech kimga sotmaymiz.",
        ],
      },
      {
        id: "retention",
        heading: "8. Saqlash va o'chirish",
        body: [
          {
            list: [
              "Google tokenlari kanalingiz ulangan ekan saqlanadi. Ruxsatni bekor qilgan zahotingiz ular ishlamay qoladi, kanalni uzsangiz yoki so'rasangiz, biz ularni o'chiramiz.",
              "Omborimizdagi tekshiruv uchun video nusxalari har bir kanal uchun oxirgi beshta bilan cheklangan; eskilari avtomatik o'chiriladi.",
              "Konveyer natijalari (tayyor video, muqovalar va ishga tushirish jurnali) GitHub Actions'da 7 kun saqlanadi, so'ng avtomatik o'chiriladi.",
              "Akkaunt ma'lumotlari, sozlamalar, video yozuvlari va ko'rsatkichlar akkauntingiz faol ekan saqlanadi va tasdiqlangan o'chirish so'rovidan keyin 30 kun ichida o'chiriladi.",
              "Tasdiqlashlar va boshqa qarorlar bo'yicha audit yozuvlari akkaunt mavjud ekan saqlanadi, chunki ular kanal bilan bog'liq amalga kim ruxsat berganini qayd etadi.",
            ],
          },
          "Nightshift'ning Google akkauntingizga kirish huquqini istalgan vaqtda [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions) sahifasida bekor qilishingiz mumkin. Akkauntingizni va bizdagi ma'lumotlarni o'chirish uchun {contactEmail} manziliga yozing.",
        ],
      },
      {
        id: "cookies",
        heading: "9. Cookie va mahalliy xotira",
        body: [
          "Biz faqat Xizmat ishlashi uchun kerakli narsalardan foydalanamiz: kirish seansi cookie'lari (Supabase), tanlangan tilni eslab qoluvchi cookie, oxirgi ko'rilgan kanalni eslab qoluvchi cookie, YouTube ulanayotganda ishlatiladigan 10 daqiqalik cookie va brauzeringizning mahalliy xotirasidagi mavzu (tema) tanlovi. Reklama yoki analitika cookie'laridan foydalanmaymiz.",
        ],
      },
      {
        id: "security",
        heading: "10. Xavfsizlik",
        body: [
          "Trafik uzatishda shifrlanadi (HTTPS). Ma'lumotlar bazasiga kirish har bir foydalanuvchi uchun qator darajasidagi xavfsizlik (RLS) bilan cheklangan, sayt faqat cheklangan ochiq kalitdan foydalanadi, sirlar esa saqlashdan oldin shifrlanadi. Hech bir tizim mutlaqo xavfsiz emas; ma'lumotlaringizga tegishli sizib chiqish haqida bilsak, qonun talab qilganidek sizni xabardor qilamiz.",
        ],
      },
      {
        id: "your-rights",
        heading: "11. Tanlovingiz va huquqlaringiz",
        body: [
          "Kanalni uzishingiz, Google ruxsatini bekor qilishingiz hamda {contactEmail} manziliga yozib, shaxsiy ma'lumotlaringizga kirish, ularni tuzatish, eksport qilish yoki o'chirishni so'rashingiz mumkin. Yashash joyingizga qarab mahalliy qonun bo'yicha qo'shimcha huquqlaringiz, jumladan ma'lumotlarni himoya qilish organiga shikoyat qilish huquqingiz bo'lishi mumkin.",
        ],
      },
      {
        id: "transfers",
        heading: "12. Xalqaro uzatish",
        body: [
          "Provayderlarimiz Yevropa Ittifoqi, AQSh va boshqa mamlakatlarda ishlaydi, shuning uchun ma'lumotlaringiz mamlakatingizdan tashqarida qayta ishlanishi mumkin. Qonun talab qilgan joyda biz provayderlarning standart shartnomaviy kafolatlariga tayanamiz.",
        ],
      },
      {
        id: "children",
        heading: "13. Bolalar",
        body: [
          "Xizmat bolalarga mo'ljallanmagan va undan 13 yoshdan kichiklar yoki o'z mamlakatida YouTube kanalni boshqarish uchun talab qiladigan eng kam yoshga yetmaganlar foydalana olmaydi.",
        ],
      },
      {
        id: "google-and-youtube",
        heading: "14. YouTube va Google",
        body: [
          "Nightshift YouTube API xizmatlaridan foydalanadi. YouTube kanalini ulash orqali siz [YouTube foydalanish shartlari](https://www.youtube.com/t/terms)ga rioya qilishga rozilik bildirasiz. Google ma'lumotlaringizni qanday qayta ishlashi [Google maxfiylik siyosati](https://policies.google.com/privacy) bilan tartibga solinadi.",
        ],
      },
      {
        id: "changes",
        heading: "15. Siyosatdagi o'zgarishlar",
        body: [
          "Har qanday o'zgarishni shu sahifada e'lon qilamiz va kuchga kirish sanasini ({effectiveDate}) yangilaymiz. Agar o'zgarish Google ma'lumotlaridan foydalanishimizga jiddiy ta'sir qilsa, Xizmatda xabar beramiz va kerak bo'lsa, qayta rozilik so'raymiz.",
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
      "Nightshift'dan foydalanish qoidalari: kanal va kontent uchun javobgarligingiz, nimalar taqiqlangan va javobgarligimiz chegaralari.",
    sections: [
      {
        id: "agreement",
        heading: "1. Kelishuv",
        body: [
          "Ushbu Shartlar siz bilan {legalName} («biz»), {country} o'rtasidagi kelishuv bo'lib, Nightshift'dan («Xizmat») foydalanishingizni tartibga soladi. Xizmatga kirish yoki undan foydalanish orqali siz ularni qabul qilasiz. Agar Xizmatdan tashkilot nomidan foydalansangiz, uni ushbu Shartlar bilan majburlash huquqingiz borligini tasdiqlaysiz. [Maxfiylik siyosati](/privacy)miz ma'lumotlaringiz bilan qanday ishlashimizni tushuntiradi.",
        ],
      },
      {
        id: "service",
        heading: "2. Xizmat",
        body: [
          "Nightshift siz boshqaradigan YouTube kanallari uchun video tayyorlashga yordam beradi: mavzularni o'rganadi, ssenariy yozadi va tekshiradi, ovozlashtiradi, render qiladi, videolarni kanalingizga yuklaydi va ularning natijalarini ko'rsatadi. Funksiyalar o'zgarishi mumkin, Xizmatning ayrim qismlari sinov versiyasi sifatida taqdim etilishi mumkin.",
        ],
      },
      {
        id: "accounts",
        heading: "3. Akkauntlar",
        body: [
          "Hozircha kirish taklif orqali beriladi. Kirish ma'lumotlaringizni xavfsiz saqlang va ruxsatsiz foydalanishdan shubhalansangiz, darhol {contactEmail} manziliga xabar bering. Akkauntingizdagi harakatlar, jumladan siz taklif qilgan jamoa a'zolarining harakatlari uchun siz javobgarsiz.",
        ],
      },
      {
        id: "youtube",
        heading: "4. YouTube kanalingiz va Google akkauntingiz",
        body: [
          "Faqat o'zingizga tegishli yoki boshqarishga vakolatingiz bor kanallarni ulashingiz mumkin. Kanalni ulash orqali siz Nightshift'ga Maxfiylik siyosatida tavsiflanganidek, Google rozilik oynasida bergan ruxsatlaringiz doirasida u bilan ishlashga ruxsat berasiz. Kanalingiz uchun javobgarlik o'zingizda qoladi va siz [YouTube foydalanish shartlari](https://www.youtube.com/t/terms) hamda YouTube'ning [Hamjamiyat qoidalari](https://www.youtube.com/howyoutubeworks/policies/community-guidelines/)ga rioya qilishingiz shart. Google ma'lumotlaringizni qanday qayta ishlashi [Google maxfiylik siyosati](https://policies.google.com/privacy) bilan tartibga solinadi.",
          "Ruxsatni istalgan vaqtda [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions) sahifasida bekor qilishingiz mumkin; shundan so'ng Xizmat o'sha kanal bilan ishlashni to'xtatadi.",
        ],
      },
      {
        id: "content",
        heading: "5. Kontentingiz va javobgarligingiz",
        body: [
          "Kanalingiz uchun yaratilgan kontent sizga tegishli va u uchun siz javobgarsiz — akkauntingizdan yuklangan hamma narsa, uni o'zingiz tekshirganmisiz yoki siz tanlagan sozlamalar bo'yicha Xizmatga nashr qilishga ruxsat berganmisiz, bundan qat'i nazar. Xususan, siz quyidagilar uchun javobgarsiz:",
          {
            list: [
              "videolaringizdagi mavzular, ssenariylar, ovozlar, videomateriallar, musiqa, logotiplar va boshqa materiallarga huquqingiz borligi;",
              "faktlarni tekshirish: generatsiya qilingan ssenariy va xulosalarda xato bo'lishi mumkin, faktlarni tekshirish bu xavfni kamaytiradi, lekin yo'qotmaydi;",
              "YouTube yoki qonun talab qilgan joyda o'zgartirilgan yoki sintetik kontentni belgilash;",
              "kanalingizning YouTube'dagi holati, jumladan ogohlantirishlar (strike), monetizatsiya qarorlari va bloklanishlar.",
            ],
          },
          "Siz bizga kontentingizni faqat siz uchun Xizmatni ishlatish maqsadida qayta ishlash bo'yicha cheklangan litsenziya berasiz.",
        ],
      },
      {
        id: "acceptable-use",
        heading: "6. Maqbul foydalanish",
        body: [
          "Xizmatdan quyidagilar uchun foydalanish taqiqlanadi:",
          {
            list: [
              "spam yoki asosan YouTube tizimlarini aldash uchun yaratilgan ommaviy, takroriy yoki past qiymatli kontentni, yoxud YouTube'ning [spam, aldov va firibgarlik qoidalari](https://support.google.com/youtube/answer/2801973)ni buzadigan har qanday narsani nashr qilish;",
              "tomoshabinlarni chalg'itish — jumladan videoni noto'g'ri aks ettiruvchi klikbeyt sarlavha yoki muqovalar, o'zgani o'zini ko'rsatish yoki fakt sifatida taqdim etilgan to'qima da'volar;",
              "noqonuniy, boshqalarning huquqini buzadigan, ta'qib qiladigan yoki nafratga undaydigan, voyaga yetmaganlarni jinsiylashtiradigan yoki YouTube Hamjamiyat qoidalarini buzadigan kontentni nashr qilish;",
              "boshqarishga vakolatingiz bo'lmagan kanallarni boshqarish yoki YouTube cheklovi yoxud bloklanishini chetlab o'tish uchun kanal yaratish va yuritish;",
              "YouTube API kvotalari yoki cheklovlarini chetlab o'tish, boshqa foydalanuvchilar ma'lumotlariga kirish, Xizmatni tekshirib ko'rish yoki ishini buzish, qonun ruxsat bergan holatlardan tashqari uni teskari muhandislik qilish;",
              "yozma ruxsatimizsiz Xizmatga kirish huquqini qayta sotish yoki boshqalarga berish.",
            ],
          },
        ],
      },
      {
        id: "third-parties",
        heading: "7. Uchinchi tomon xizmatlari",
        body: [
          "Xizmat Maxfiylik siyosatida sanab o'tilgan uchinchi tomon provayderlariga tayanadi. O'z API kalitlaringizni bersangiz, bu provayderlardan foydalanishingiz ularning shartlari va tariflariga bo'ysunadi, ularning mavjudligi yoki natijalari uchun biz javobgar emasmiz.",
        ],
      },
      {
        id: "credits",
        heading: "8. Oldindan to'langan kreditlar",
        body: [
          {
            note: "SHABLON — KUCHDA EMAS. Bu bo'lim kelajakdagi pullik tarif uchun qoralama. Kreditlar sotilishidan oldin uni malakali yurist bilan ko'rib chiqish va kvadrat qavsdagi qiymatlarni to'ldirish shart.",
          },
          {
            list: [
              "Kreditlar oldindan sotib olinadi va Xizmat video tayyorlagani sari, ishga tushirishdan oldin Xizmatda ko'rsatilgan tariflar bo'yicha sarflanadi.",
              "Ishga tushirishdan oldin taxminiy narx ko'rsatiladi; aslida yechilgan kreditlar ishlatilgan resurslarni aks ettiradi va taxmindan [oshmaydi / ko'pi bilan [X]% oshadi].",
              "Kreditlarning pul qiymati yo'q, ular boshqaga o'tkazilmaydi va sotib olingandan [N oy] o'tgach muddati tugaydi.",
              "Xizmat aybi bilan muvaffaqiyatsiz tugagan ishga sarflangan kreditlar balansingizga qaytariladi.",
              "Ishlatilmagan kreditlar [sotib olingandan keyin N kun ichida / faqat qonun talab qilgan hollarda] qaytariladi.",
              "To'lovlarni sotuvchi (merchant of record) sifatida ishlaydigan [to'lov provayderi] qayta ishlaydi; biz karta ma'lumotlaringizni hech qachon olmaymiz va saqlamaymiz.",
              "Kredit narxini o'zgartirishimiz mumkin; o'zgarish allaqachon sotib olingan kreditlarga hech qachon ta'sir qilmaydi.",
            ],
          },
        ],
      },
      {
        id: "ip",
        heading: "9. Bizning intellektual mulkimiz",
        body: [
          "Xizmat, uning dasturiy ta'minoti va brendi bizga yoki litsenziarlarimizga tegishli. Ushbu Shartlar akkauntingiz faol ekan Xizmatdan foydalanish uchun sizga shaxsiy, eksklyuziv bo'lmagan va boshqaga o'tkazilmaydigan huquq beradi. Bizga fikr-mulohaza yuborsangiz, undan sizning oldingizda majburiyatsiz foydalanishimiz mumkin.",
        ],
      },
      {
        id: "disclaimers",
        heading: "10. Kafolatlardan voz kechish",
        body: [
          "Xizmat «boricha» va «mavjud bo'lganicha» taqdim etiladi. Qonun ruxsat bergan darajada biz barcha nazarda tutilgan kafolatlardan voz kechamiz. Biz ko'rishlar, obunachilar, daromad, monetizatsiya tasdiqlanishi yoki YouTube biror video yoki kanalni cheklamasligi, monetizatsiyadan chiqarmasligi yoxud o'chirmasligini kafolatlamaymiz.",
        ],
      },
      {
        id: "liability",
        heading: "11. Javobgarlikni cheklash",
        body: [
          "Qonun ruxsat bergan darajada biz bilvosita, tasodifiy, maxsus, oqibatli yoki jarima tarzidagi zararlar, shuningdek boy berilgan foyda, daromad, ma'lumotlar, obro' yoki kanal holati uchun javobgar emasmiz. Xizmat bilan bog'liq har qanday da'vo bo'yicha umumiy javobgarligimiz da'voga asos bo'lgan hodisadan oldingi o'n ikki oy ichida Xizmat uchun bizga to'lagan summangiz bilan cheklanadi. Ushbu Shartlardagi hech narsa qonun bo'yicha cheklab bo'lmaydigan javobgarlikni cheklamaydi.",
        ],
      },
      {
        id: "indemnity",
        heading: "12. Zararni qoplash",
        body: [
          "Kontentingiz, kanalingiz yoki ushbu Shartlar yoxud qonunni buzganingiz sababli uchinchi shaxslar qo'ygan da'volar bo'yicha zararni siz qoplaysiz.",
        ],
      },
      {
        id: "termination",
        heading: "13. To'xtatib turish va tugatish",
        body: [
          "Xizmatdan foydalanishni istalgan vaqtda to'xtatishingiz, kanallaringizni uzishingiz va Google ruxsatini bekor qilishingiz mumkin. Agar siz ushbu Shartlarni buzsangiz, foydalanishingiz YouTube yoki Google qoidalariga (jumladan bizning ularga rioya qilishimizga) xavf tug'dirsa yoki qonun talab qilsa, kirishingizni to'xtatib turishimiz yoki tugatishimiz mumkin; oqilona bo'lsa, oldindan xabar beramiz. Kirish tugagach, Xizmat kanallaringiz bilan ishlashni to'xtatadi, saqlangan Google tokenlaringiz o'chiriladi, ma'lumotlaringiz esa Maxfiylik siyosatida tavsiflanganidek o'chiriladi. 5, 9, 10, 11, 12 va 15-bo'limlar tugatishdan keyin ham amal qiladi.",
        ],
      },
      {
        id: "changes",
        heading: "14. Shartlardagi o'zgarishlar",
        body: [
          "Ushbu Shartlarni yangilashimiz mumkin. Yangi versiyani shu sahifada yangi kuchga kirish sanasi ({effectiveDate}) bilan e'lon qilamiz va jiddiy o'zgarishlar haqida Xizmatda xabar beramiz. O'zgarish kuchga kirgandan keyin Xizmatdan foydalanishda davom etsangiz, uni qabul qilgan bo'lasiz.",
        ],
      },
      {
        id: "law",
        heading: "15. Amaldagi huquq",
        body: [
          "Ushbu Shartlar {country} qonunchiligi bilan tartibga solinadi; bu yashash joyingizdagi iste'molchilar huquqlarining majburiy himoyasiga ta'sir qilmaydi.",
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
