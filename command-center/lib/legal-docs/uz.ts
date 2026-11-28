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
              "Siz kiritgan sozlamalar: kanal nomlari, nisha, til, ovoz va uslub tanlovi, jadvallar, seriyalar, shuningdek tekshiruvdagi qarorlaringiz (masalan, videoni tasdiqlash va, kanal uchun “Tasdiqdan keyin nashr qilish” yoqilgan boʻlsa, undan keyingi soʻrov hamda YouTube xabar qilgan natija) — ular foydalanuvchi identifikatoringiz bilan audit jurnaliga yoziladi.",
              "Siz kiritgan uchinchi tomon xizmatlarining API kalitlari: ular serverimizga kelgan zahoti shifrlanadi, konveyerning shifrlangan sirlar omboriga (GitHub Actions secrets) yoziladi va tashlab yuboriladi. Ular hech qachon maʼlumotlar bazamizda saqlanmaydi, sizga qayta koʻrsatilmaydi va jurnallarga yozilmaydi.",
              "Telegram bildirishnomalari, faqat chatni ulagan boʻlsangiz: Telegram chatining identifikatori va Telegram u uchun bizga beradigan ism yoki @username, xabarlar uchun tanlagan tilingiz, qaysi bildirishnomalarni yoqqaningiz va oxirgi xabar qachon yetkazilgani. Chatni Sozlamalarda istalgan payt toʻxtatish yoki uzish mumkin; uzilganda bu maʼlumotlar oʻchiriladi.",
              "Siz ruxsat bergan Google foydalanuvchi maʼlumotlari — 3-boʻlimga qarang.",
              "Xat sozlamalari: video tayyor boʻlganda xat olishni va haftalik xulosani xohlaysizmi, hamda ilovadan qaysi tilda foydalanishingiz, xatlar shu tilda yozilishi uchun. «Video tayyor» xatlari siz boshlagan ish haqidagi xizmat xabarlari: ular sozlamalarda yoki ulardan istalganidagi havola orqali oʻchirmaguningizcha yoqilgan. Haftalik xulosa oʻzingiz yoqmaguningizcha oʻchirilgan. Reklama xatlarini yubormaymiz.",
              "Texnik maʼlumotlar: hosting va maʼlumotlar bazasi provayderlarimiz Xizmatni ishlatish va himoya qilish uchun standart soʻrov jurnallarini (IP manzil, brauzer turi, soʻrov vaqti) yuritadi. Biz analitika, reklama yoki kuzatuv vositalaridan foydalanmaymiz.",
              "Soʻrov kelgan mamlakat, faqat ayrim modellar uchun: model yetkazib beruvchisi undan ayrim mamlakatlarda foydalanishga ruxsat bermasa, serverimiz sizga shu modelni taklif qilish yoki qilmaslikni hal etish uchun soʻrovingiz kelgan IP manzil boʻyicha mamlakatni aniqlaydi. Aniqlash oʻz serverimizda, unda saqlanadigan DB-IP bazasining nusxasi boʻyicha bajariladi ([IP Geolocation by DB-IP](https://db-ip.com)); buning uchun manzilingiz hech kimga yuborilmaydi va bu tekshiruv manzilni ham, mamlakatni ham saqlamaydi. Ulanish qaysi manzildan kelgan boʻlsa, oʻsha manzil tekshiriladi, shuning uchun VPN yoki proksi ishlatilganda oʻsha xizmatning mamlakati aniqlanadi.",
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
                  "Nightshift kanalingiz uchun tayyorlagan videolarni yuklaydi va ularning muqovasini (thumbnail) oʻrnatadi. Agar shu kanal uchun boshqacha tanlamagan boʻlsangiz — masalan, sukut boʻyicha oʻchiq avto-nashrni yoqmagan boʻlsangiz — yuklangan videolar yopiq (private) boʻladi. Yopiq yuklangan videoni sizning tasdigʻingizdan keyin ommaviy qilish ham mumkin, lekin faqat shu kanal uchun “Tasdiqdan keyin nashr qilish” yoqilgan boʻlsa (sukut boʻyicha oʻchiq; 4-boʻlimga qarang).",
                ],
                [
                  "`youtube.readonly`",
                  "Qaysi kanalni ulaganingizni tasdiqlash uchun kanal identifikatsiyasini (ID va nom) oʻqiydi; bir video ikki marta yuklanmasligi uchun kanalning soʻnggi yuklamalari roʻyxatini (ID va nomlar) oladi; panel uchun videolaringizning asosiy maʼlumotlari va ochiq statistikasini oʻqiydi.",
                ],
                [
                  "`youtube.force-ssl`",
                  "Nightshift yuklagan videolarga subtitr yoʻlagini qoʻshadi; nashr qilingan videoni seriya pleylistiga qoʻshadi; Nightshift nashr qilgan video ostida kanal nomidan bitta izoh (tomoshabinlarga savol) qoldiradi; auditoriya soʻrayotgan mavzularni topish uchun kanal videolaridagi izohlarni oʻqiydi; hamda faqat ish maydoningiz administratori shu kanal uchun “Tasdiqdan keyin nashr qilish”ni (sukut boʻyicha oʻchiq) yoqqan va inson aynan shu videoni tasdiqlagan boʻlsagina, shu bitta videoning koʻrinish sozlamasini (visibility) yopiqdan ommaviyga oʻzgartiradi va tasdiqlash uchun videoni qayta oʻqiydi (4-boʻlimga qarang). Texnik jihatdan bu ruxsat videolarni tahrirlash va oʻchirishga ham imkon beradi. Nightshift hech narsani oʻchirmaydi va mavjud videolaringiz, pleylistlaringiz yoki izohlaringizni tahrirlamaydi — faqat siz tasdiqlagan videoning shu bitta koʻrinish oʻzgarishi bundan mustasno: bu oʻzgarish videoning nomi, tavsifi, teglari va muqovasiga tegmaydi, undan tashqari Nightshift faqat shu yerda sanab oʻtilganlarni qoʻshadi.",
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
          "Google foydalanuvchi maʼlumotlari faqat Xizmatda siz koʻradigan funksiyalarni taqdim etish va yaxshilash uchun ishlatiladi: videolaringizni yuklash va subtitrlash, ularni pleylistlarga qoʻshish, jalb qiluvchi izohni joylash, takroriy yuklashning oldini olish, kanal natijalarini panelda koʻrsatish va nima yaxshi ishlagani hamda auditoriya nimani soʻrayotganiga qarab keyingi mavzularni tanlash hamda — faqat siz yoqqan joyda — siz tasdiqlagan videoni ommaviy qilish.",
          "“Tasdiqdan keyin nashr qilish”. Bu Nightshift YouTube’da allaqachon turgan videoni oʻzgartiradigan yagona holat. U har bir kanal uchun sukut boʻyicha oʻchiq. Ish maydoningiz administratori uni bitta kanal uchun yoqishi mumkin (buning uchun tasdiq soʻzini yozish kerak) va istalgan payt “Kanallar” sahifasida oʻchirib qoʻyishi mumkin. U yoqilgan boʻlsa va inson Nightshift allaqachon yopiq holda yuklagan videoning aynan bitta versiyasini tasdiqlasa, ishchi dastur tasdiq hali kuchdaligini yana tekshiradi (u 24 soat amal qiladi va video qayta renderlansa yoki tuzatilsa tugaydi) va YouTube’dan shu videoning koʻrinish sozlamasini yopiqdan ommaviyga oʻzgartirishni bir marta soʻraydi. Soʻrovga videoning statusdagi boshqa sozlamalari YouTube qaytargan holida kiritiladi, shunda ular avvalgidek qoladi. Keyin Nightshift videoni qayta oʻqiydi va faqat YouTube xabar qilganini yozib qoʻyadi; YouTube videoni baribir yopiq qoldirishi mumkin. Nightshift videoning nomi, tavsifi, teglari va muqovasini oʻzgartirmaydi, hech narsani oʻchirmaydi va boshqa video, pleylist yoki izohni tahrirlamaydi.",
          "Bu xulosalar uchun videolaringizdagi izohlar matni va video koʻrsatkichlari kanalingiz uchun tasniflash va umumlashtirish maqsadida matn uchun sunʼiy intellekt provayderimizga (Google Gemini API) yuborilishi mumkin. Biz izoh matnini emas, natijani saqlaymiz — masalan, auditoriya soʻragan mavzu va u necha marta soʻralgani.",
          "Gemini API Google foydalanuvchi maʼlumotlari ishtirok etmaydigan ishlar uchun ham ishlatiladi: konveyerdagi tadqiqot, ssenariy yozish va faktlarni tekshirish hamda — Studioda Google modelini tanlaganingizda — rasm yoki videoni yaratish yoki tahrirlash, yoxud rasmni tavsiflash. Har biri uchun u nimani olishi 7-boʻlimda sanab oʻtilgan.",
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
                ["Studioda oʻzingiz tanlagan rasm va video modellari: Ideogram, MiniMax", "Siz soʻragan rasm yoki video klipni yaratish", "Soʻrovingiz (prompt) va birinchi yoki oxirgi kadr sifatida bergan rasmingiz (Ideogram faqat soʻrovni oladi). MiniMax oʻz shartlariga koʻra olgan va yaratgan narsalaridan oʻz xizmatlari va modellarini yaxshilash uchun foydalanishi mumkin"],
                ["Google — Gemini API, Studioda oʻzingiz tanlagan Google modellari uchun (masalan, Nano Banana kabi Gemini rasm modellari va Gemini Omni video)", "Siz soʻragan rasm yoki videoni yaratish yoki tahrirlash, yoxud siz bergan rasmni tavsiflash", "Soʻrovingiz (prompt) va shu soʻrov uchun yuklagan har qanday rasm yoki videongiz; Google yaratilgan rasm, video yoki tavsifni qaytaradi"],
                ["vidIQ (ixtiyoriy)", "Kalit soʻz va sarlavha tadqiqoti", "Mavzu kalit soʻzlari va sarlavha qoralamalari"],
                ["Telegram (faqat chatni ulagan boʻlsangiz)", "Siz tanlagan qisqa bildirishnomalarni ulangan Telegram chatiga yetkazish: bitta gap va ilovaga qaytish havolasi", "Telegram chatingiz identifikatori hamda har bir xabarning gapi va havolasi; hech qachon stsenariy, soʻrov, fayl nomi yoki video nomi emas"],
                ["Telegram, Slack (ixtiyoriy)", "Operatorga bildirishnomalar", "Ishga tushirish holati, video nomlari va havolalari"],
                ["Xat yetkazish xizmati (ixtiyoriy, operator tanlaydi)", "Xizmat xatlari: tayyor video haqida va yoqsangiz haftalik xulosa", "Elektron pochta manzilingiz, kanal nomi, videolar soni va qolgan kreditlar; hech qachon stsenariy, soʻrov yoki video nomi emas"],
                ["Google Fonts, Amazon CloudFront", "Ushbu sahifalardagi shriftlar va fon mediasi", "Har qanday veb-soʻrovdagi kabi IP manzilingiz va brauzer maʼlumotlari"],
                ["Dodo Payments (dodopayments.com)", "Kredit va tarif xaridlari boʻyicha sotuvchimiz (Merchant of Record) va toʻlov provayderimiz: toʻlov sahifasi, toʻlovni qayta ishlash, soliq, cheklar, qaytarish va chargeback", "Dodo toʻlov sahifasiga kiritadigan toʻlov va hisob-kitob maʼlumotlaringiz — ularni Dodo oʻz maxfiylik siyosati asosida oʻzi qayta ishlaydi; bizdan — toʻlov oynasini toʻldirish uchun akkauntingiz emaili, tashkilotingiz va akkauntingiz identifikatorlari hamda nima sotib olayotganingiz"],
                ["Paddle (Paddle.com), faqat sinov toʻlovi", "Dodo orqali toʻlov yoqilguncha koʻrsatiladigan sinov toʻlov oynasi (sandbox); u haqiqiy toʻlov qabul qilmaydi va olib tashlanadi", "Sinov toʻlov oynasiga kiritgan maʼlumotlaringiz; bizdan — akkauntingiz emaili hamda tashkilotingiz va akkauntingiz identifikatorlari"],
              ],
            },
          },
          "Google’ning Gemini API xizmati. Gemini API’dan pullik xizmat sifatida foydalanamiz — konveyer uchun va Studioda siz tanlagan Google modellari uchun. Google’ning sahifalarida (2026-yil 22-noyabrda oʻqilgan) aytilishicha, pullik xizmatda Google soʻrovlar va javoblardan oʻz mahsulotlarini yaxshilash uchun foydalanmaydi; soʻrovlar va javoblarni faqat oʻzining [Generativ sunʼiy intellektdan taqiqlangan foydalanish siyosati](https://policies.google.com/terms/generative-ai/use-policy) buzilishlarini aniqlash va oldini olish uchun cheklangan muddatga jurnalga yozadi; [foydalanish qoidalarida](https://aistudio.google.com/docs/usage-policies) esa ularni shu suiisteʼmolni kuzatish uchun ellik besh (55) kun saqlashi aytilgan. Google, shuningdek, bu maʼlumotlar Google yoki uning agentlari obyektlarga ega boʻlgan istalgan mamlakatda vaqtincha saqlanishi yoki keshlanishi mumkinligini aytadi. Google modellari yaratgan rasm va videolarda Google’ning SynthID suv belgisi boʻladi. Bu foydalanishga [Gemini API qoʻshimcha shartlari](https://ai.google.dev/gemini-api/terms) tatbiq etiladi.",
          // S6 (2026-11-27) LEGAL TEXT FOR OWNER REVIEW, Lyria 3.5 music (docs/research/lyria-3-5.md; Google APIs Terms 3(d)): what is sent
          // to Google, store=false and the 55-day abuse retention of Google (BR-L-210: no stored path exists, so no deletion is promised),
          // and the SynthID disclosure. Written conditionally because the feature is not
          // offered: the registry entry is registry-only and terms-gated. The owner signs this off before the gate is lifted.
          "Google’ning Lyria modeli bilan yaratilgan musiqa. Agar Studioda sizga Google’ning Lyria modeli bilan musiqa yaratish taklif qilinsa, videongiz uchun musiqani tasvirlab yozgan soʻzlaringiz, jumladan ularga yozgan har qanday qoʻshiq matni, Google’ning Gemini API xizmatiga yuboriladi; u audio hamda qoʻshiq matni yoki tuzilishini matn sifatida qaytaradi. Biz Google’dan soʻrovni keyinroq olish uchun saqlamaslikni soʻraymiz (bu saqlanadigan emas, balki bir martalik, darhol bajariladigan soʻrov); yuqorida tavsiflangan suiisteʼmolni kuzatish uchun ellik besh (55) kunlik saqlash unga baribir tatbiq etiladi. Lyria yaratgan har bir musiqada Google’ning SynthID audio suv belgisi boʻladi; u eshitilmaydi va uni oʻchirib boʻlmaydi.",
          "Google foydalanuvchi maʼlumotlarini faqat ushbu roʻyxatdagi Supabase, GitHub, Google va bildirishnoma xizmatlari oladi va faqat yuqoridagi maqsadlarda. Biz shaxsiy maʼlumotlarni hech kimga sotmaymiz.",
          "Toʻlovlar. Kreditlar va tariflar sotuvchimiz (Merchant of Record) va toʻlov provayderimiz Dodo Payments («Dodo») orqali sotiladi: xarid qilayotganda toʻlov va hisob-kitob maʼlumotlaringizni Dodo’ning oʻz toʻlov sahifasiga kiritasiz va Dodo ularni sotuvchi sifatida [Dodo Payments maxfiylik siyosati](https://dodopayments.com/legal/privacy-policy) asosida qayta ishlaydi. Biz karta maʼlumotlaringizni yoki hisob-kitob manzilingizni hech qachon olmaymiz va saqlamaymiz. Dodo’dan faqat xaridni hisobga qoʻshish va qaytarish yoki chargeback holatida uni bekor qilish uchun kerakli narsani saqlaymiz: toʻlov va qaytarish identifikatorlari, toʻlangan summa va valyuta, nima sotib olingani hamda xarid qaysi tashkilot (va maʼlum boʻlsa, qaysi foydalanuvchi) uchun qilingani. Bu yozuvlarni tashkilotingizning kredit tarixi bilan birga uning akkaunti mavjud ekan saqlaymiz yoki soliq yoxud buxgalteriya qonunchiligi talab qilsa, undan uzoqroq. Dodo orqali toʻlovni ulash hali yakunlanmagan: u yoqilguncha Xizmatda koʻrsatiladigan har qanday toʻlov oynasi Paddle’ning sinov oynasi (sandbox) boʻlib, haqiqiy toʻlov qabul qilmaydi.",
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
          "Nightshift’ga ulangan Instagram akkaunti haqida — Meta’da kirish huquqimizni qanday bekor qilish va nimani oʻchirishimiz — [Maʼlumotlarni oʻchirish](/data-deletion) sahifasiga qarang.",
        ],
      },
      {
        id: "cookies",
        heading: "9. Cookie va mahalliy xotira",
        body: [
          "Nightshift faqat ishlashi uchun zarur narsalardan foydalanadi. Biz reklama, kuzatuv va analitika cookieʼlarini oʻrnatmaymiz, uchinchi tomon analitikasini ulamaymiz va cookie bannerini koʻrsatmaymiz: quyidagilarning hammasi siz soʻragan narsa uchun qatʼiy zarur (tizimga kirish, saqlangan tanlov yoki kirish yoxud ulanish jarayonini himoya qilish).",
          {
            table: {
              head: ["Nima", "Nima uchun", "Qancha muddat"],
              rows: [
                ["Kirish seansi cookieʼlari (ularni kirish xizmatimiz, Supabase, oʻrnatadi)", "Sizni tizimda saqlaydi va akkauntingiz maʼlumotlarini boshqalardan yashiradi.", "Chiqquningizcha yoki seans tugaguncha; Xizmatdan foydalanayotganingizda yangilanadi"],
                ["`chronos_locale`", "Siz tanlagan tilni eslab qoladi.", "1 yil"],
                ["`ns_view`", "Mobil yoki kompyuter koʻrinishidan qaysi birini tanlaganingizni eslab qoladi.", "1 yil"],
                ["`chronos_channel`, `nightshift_org`, `ns_sidebar` (kirgandan keyin)", "Oxirgi marta qaysi kanal va tashkilotni koʻrganingizni hamda yon menyu kengligini eslab qoladi.", "1 yil"],
                ["`ns_owner_mode` (faqat platforma egasi)", "Platforma egasi ega boʻlimlarini yoki mijoz koʻrinishini koʻrishini eslab qoladi. Boshqa barcha akkauntlar uchun eʼtiborga olinmaydi.", "1 yil"],
                ["`ns_oa_present` (faqat platforma egasi)", "Egasi taqdimot rejimini yoqqanini eslab qoladi; bu rejim analitika ekranlarida toʻlov identifikatorlarini yashiradi.", "12 soat"],
                ["`ns_auth_pending`, `ns_recovery`, `ns_invite`", "Xatdagi havola orqali kirishni, parolni tiklashni yoki siz ochgan taklifni yakunlaydi. Ularni faqat kerak boʻlgan sahifalar oʻqiy oladi.", "10 daqiqa, 15 daqiqa va 24 soat"],
                ["`__Host-yt_oauth_nonce`, `ig_oauth_nonce`, `tt_oauth_nonce`, `tt_oauth_pkce` (akkaunt ulanayotganda)", "Rozilik ekranida turganingizda YouTube (yoki boshqa) akkauntingizni ulashni saytlararo soxta soʻrovdan himoya qiladi.", "10 daqiqa"],
                ["`__Host-ns_connect_pending` (qaysi akkauntni ulashni tanlayotganda)", "Google, Instagram yoki TikTok orqali kirishning identifikatorini siz ulanadigan akkauntni tanlayotganingizda saqlaydi. U shu qadam uchun qatʼiy zarur, uni faqat server oʻqiy oladi va unda hech qachon akkaunt nomi yoki token boʻlmaydi.", "10 daqiqagacha yoki foydalanilgunga qadar"],
                ["Mahalliy xotira: `chronos_theme`", "Yorugʻ yoki qorongʻi mavzuni eslab qoladi.", "Siz tozalamaguningizcha"],
                ["Mahalliy xotira: `ns_email_locale`", "Xatlaringiz uchun serverga qaysi til oxirgi marta yuborilganini eslab qoladi, ilova buni har kirishda takrorlamasligi uchun.", "Siz tozalamaguningizcha"],
                ["Mahalliy xotira: tugallanmagan muharrir qoralamalari, yon menyu va panel joylashuvi tanlovlari, oʻqilgan bildirishnoma belgilari, tugallanmagan yordamchi rejasi, yashirilgan topshiriqlar", "Ekran sozlamalaringiz va tugallanmagan ishingizni qurilmangizda saqlaydi. Ular bizga yuborilmaydi. Muharrir qoralamalari tizimdan chiqqaningizda oʻchiriladi.", "Siz tozalamaguningizcha (qaytilmagan qoralama avtomatik oʻchiriladi)"],
                ["Seans xotirasi (faqat shu brauzer varagʻi)", "Shu varaqda oʻtgan sahifalaringizni, tugallanmagan yaratish shaklini, bir martalik xabarni va animatsiyani pauzaga qoʻyganingizni eslab qoladi.", "Varaqni yopmaguningizcha"],
              ],
            },
          },
          "Uchinchi tomonlar. 7-boʻlimda tasvirlangan Paddle sinov toʻlov oynasi amal qilayotgan paytda Narxlar sahifasi va kredit sotib olinadigan sahifalar narxlarni koʻrsatish va shu sinov oynasini ochish uchun Paddle skriptini (Paddle.js) yuklaydi. Skript va u yoki Paddle’ning kontent tarmogʻi oʻrnatadigan har qanday cookie (masalan, botlardan himoya cookieʼsi) Paddle’ga tegishli; [Paddle maxfiylik bildirishnomasi](https://www.paddle.com/legal/privacy) bilan tanishing. Uning oʻrnini egallaydigan Dodo toʻlovi Dodo’ning oʻz saytidagi sahifada amalga oshadi: biz sahifalarimizga Dodo skriptlarini yuklamaymiz, Dodo sahifasida oʻrnatiladigan cookie’lar esa Dodo’ga tegishli va [Dodo Payments cookie siyosati](https://dodopayments.com/legal/cookie-policy) bilan tartibga solinadi. YouTube akkauntingizni ulaganingizda siz Google’ga yoʻnaltirilasiz. Boshqa uchinchi tomon skriptlarini yuklamaymiz.",
          "Sahifa statistikasi. Qaysi ochiq sahifalar oʻqilishini bilish uchun biz koʻrishlarni oʻz serverlarimizda oʻzimiz sanaymiz: har bir ochiq sahifa va har bir kun uchun — nechta koʻrish, qaysi saytdan kelingan (faqat uning nomi), telefon oʻlchamidagi yoki kattaroq ekranda va qaysi tilda. Bunda cookie ham, mahalliy xotira ham ishlatilmaydi, IP manzil, user agent va hech qanday identifikator saqlanmaydi, shuning uchun statistikani siz yoki boshqa tashriflaringiz bilan bogʻlab boʻlmaydi. Brauzeringiz Do Not Track yoki Global Privacy Control yuborsa, hech narsa sanalmaydi. Hech qanday maʼlumot analitika provayderiga ketmaydi.",
          "Cookie va mahalliy xotirani brauzer sozlamalarida istalgan vaqtda oʻchirishingiz mumkin. Shunda Xizmat tilingizni, mavzuingizni va koʻrinish tanlovingizni unutadi, siz esa tizimdan chiqasiz.",
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
          "Xizmat bolalarga va 18 yoshga toʻlmaganlarga moʻljallanmagan. Undan faqat 18 yoshga toʻlganlar foydalanishi mumkin; agar oʻz mamlakatida YouTube kanalni boshqarish uchun talab qiladigan eng kam yosh bundan yuqori boʻlsa, oʻsha yoshga yetganlar. Akkaunt yaratayotganda, email manzili yoki Google orqali, siz 18 yoshga toʻlganingizni tasdiqlaysiz. Xizmatdan 18 yoshga toʻlmagan kishi foydalanayotgan deb hisoblasangiz, {contactEmail} manziliga yozing.",
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
          "Nightshift siz boshqaradigan YouTube kanallari uchun video tayyorlashga yordam beradi: mavzularni oʻrganadi, ssenariy yozadi va tekshiradi, ovozlashtiradi, render qiladi, videolarni kanalingizga yuklaydi va ularning natijalarini koʻrsatadi. Shuningdek, Xizmat sunʼiy intellekt modellari yordamida rasm, videoklip va audio yaratish hamda tahrirlash (Studiya) va videolarni videomuharrirda montaj qilish imkonini beradi. Funksiyalar oʻzgarishi mumkin, Xizmatning ayrim qismlari sinov versiyasi sifatida taqdim etilishi mumkin.",
        ],
      },
      {
        id: "accounts",
        heading: "3. Akkauntlar",
        body: [
          "Akkaunt yaratish yoki Xizmatdan foydalanish uchun kamida 18 yoshda boʻlishingiz kerak; akkaunt yaratib, email manzili yoki Google orqali, buni tasdiqlaysiz. Xizmat 18 yoshga toʻlmaganlarga moʻljallanmagan.",
          "Hozircha kirish taklif orqali beriladi. Kirish maʼlumotlaringizni xavfsiz saqlang va ruxsatsiz foydalanishdan shubhalansangiz, darhol {contactEmail} manziliga xabar bering. Akkauntingizdagi harakatlar uchun siz javobgarsiz.",
        ],
      },
      {
        id: "youtube",
        heading: "4. YouTube kanalingiz va Google akkauntingiz",
        body: [
          "Faqat oʻzingizga tegishli yoki boshqarishga vakolatingiz bor kanallarni ulashingiz mumkin. Kanalni ulash orqali siz Nightshift’ga Maxfiylik siyosatida tavsiflanganidek, Google rozilik oynasida bergan ruxsatlaringiz doirasida u bilan ishlashga ruxsat berasiz. Kanalingiz uchun javobgarlik oʻzingizda qoladi va siz [YouTube foydalanish shartlari](https://www.youtube.com/t/terms) hamda YouTube’ning [Hamjamiyat qoidalari](https://www.youtube.com/howyoutubeworks/policies/community-guidelines/)ga rioya qilishingiz shart. Google maʼlumotlaringizni qanday qayta ishlashi [Google maxfiylik siyosati](https://policies.google.com/privacy) bilan tartibga solinadi.",
          "Tasdiqlangan videoni ommaviy qilish. Nightshift videolarni yopiq holda yuklaydi. Ish maydoningiz administratori kanal uchun “Tasdiqdan keyin nashr qilish”ni yoqqan joyda (sukut boʻyicha oʻchiq, istalgan payt oʻchirib qoʻyish mumkin) shu kanaldagi videoning aynan bitta versiyasini tasdiqlash YouTube’dan shu videoni yopiqdan ommaviyga oʻzgartirishni soʻraydi. Bu usulda hech narsa ommaviy boʻlmaydi — faqat shu sozlama yoqilgan va inson aynan shu versiyani tasdiqlagan boʻlsa; tasdiq 24 soatdan keyin yoki video qayta renderlansa yoxud tuzatilsa tugaydi. YouTube videoni baribir yopiq qoldirishi mumkin. Shu usulda ommaviy boʻlgan video siz tanlagan sozlamalar boʻyicha nashr qilingan kontent hisoblanadi va unga 5-boʻlim tatbiq etiladi. Bu oʻzgarish videoning nomi, tavsifi, teglari va muqovasiga tegmaydi va hech narsani oʻchirmaydi.",
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
          "6.1. Har qanday foydalanish. Xizmatdan quyidagilar uchun foydalanish taqiqlanadi:",
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
          "6.2. Generatsiya qilingan rasm, video va ovoz. Xizmat boshqa kompaniyalar yaratgan sunʼiy intellekt modellari («model ishlab chiqaruvchilari») yordamida matn, rasm, video, ovoz va boshqa audio yaratish hamda tahrirlash imkonini beradi. Bu qoidalar Xizmatda yaratgan yoki tahrirlagan hamma narsangizga, uni nashr qilasizmi-yoʻqmi, bundan qatʼi nazar, tegishli. Xizmat yordamida quyidagilarni yaratish, tahrirlash yoki tarqatish taqiqlanadi:",
          {
            list: [
              "har qanday turdagi jinsiy yoki jinsiy ishorali kontent, jumladan yalangʻochlik, shuningdek voyaga yetmaganlarni jinsiylashtiradigan yoki ekspluatatsiya qiladigan har qanday kontent;",
              "real, tanib boʻladigan insonning uning aniq roziligisiz yaratilgan realistik rasmi, videosi yoki ovozi — jumladan yuz almashtirish, dipfeyklar, ovozni klonlash va birovning ovoziga taqlid qilish;",
              "biror shaxs yoki tashkilot sifatida oʻzini koʻrsatadigan, yoxud aldash maqsadida real voqealarning haqiqiy tasvirga olinishi, haqiqiy surati yoki haqiqiy yozuvi sifatida taqdim etiladigan kontent;",
              "mualliflik huquqi, tovar belgilari yoki boshqa huquqlarni buzadigan kontent, jumladan modeldan boshqa muallifning himoyalangan asarini koʻchirishni soʻrab yaratilgan kontent;",
              "kimnidir taʼqib qiladigan yoki unga tahdid qiladigan, nafratga undaydigan, zoʻravonlikni targʻib qiladigan, oʻziga zarar yetkazish yoki oʻz joniga qasd qilishni targʻib qiladigan yoxud boshqacha tarzda noqonuniy kontent;",
              "modelning xavfsizlik filtrlarini chetlab oʻtib yoki chetlab oʻtishga urinib olingan har qanday narsa — masalan, rad etilgan soʻrovni uning mazmunini yashirish uchun boshqa soʻzlar bilan qayta yozish orqali.",
            ],
          },
          "Xizmat yuz almashtirish yoki ovozni klonlash funksiyalarini taklif qilmaydi.",
          "6.3. Belgilar va kelib chiqish maʼlumotlari. Baʼzi model ishlab chiqaruvchilari oʻz modellari yaratgan kontentga koʻrinadigan suv belgisi yoki yorliq, yoxud kelib chiqish metamaʼlumotlarini qoʻshadi. Bunday suv belgisi yoki yorliqni olib tashlash, yashirish yoki oʻzgartirish, shuningdek kontent generatsiya qilinganini yashirish uchun bu metamaʼlumotlarni oʻchirish yoki oʻzgartirish taqiqlanadi. Qonun yoki siz nashr qiladigan platforma kontent generatsiya qilingani yoki oʻzgartirilganini bildirishni talab qilgan joyda generatsiya qilingan kontentni inson yaratgan deb koʻrsatish taqiqlanadi; 5-boʻlim ham qoʻllaniladi.",
          "6.4. Xavfsizlik filtrlari. Model ishlab chiqaruvchilari oʻz xavfsizlik filtrlarini qoʻllaydi va soʻrovni rad etishi mumkin. Model rad etgan soʻrov uchun haq olinmaydi: u uchun band qilingan kreditlar har qanday muvaffaqiyatsiz ishga tushirishdagidek qaytariladi (8.3-boʻlim).",
          "6.5. Qoidabuzarlik haqida xabar berish. Xizmat yordamida yaratilgan va bu qoidalarni buzadigan kontent haqida — jumladan, roziligingizsiz sizni koʻrsatadigan yoki ovozingizdan foydalanadigan kontent haqida — xabar berish uchun {contactEmail} manziliga yozing va uni qayerda topganingizni ayting. Biz bu qoidalarni buzadigan kontentni olib tashlashimiz hamda uni yaratgan akkauntning kirishini 13-boʻlimda aytilganidek toʻxtatib turishimiz yoki tugatishimiz mumkin. Bolalarga nisbatan jinsiy zoʻravonlik materiallariga hech qanday holatda yoʻl qoʻyilmaydi: biz ularni olib tashlaymiz, ularni yaratgan akkauntning kirishini tugatamiz va ular haqida vakolatli organlarga, jumladan tegishli hollarda AQShning Bedarak yoʻqolgan va ekspluatatsiya qilingan bolalar milliy markaziga (NCMEC) xabar beramiz.",
          "6.6. Mualliflik huquqi buzilishi haqida bildirishnomalar. Agar Xizmat yordamida yaratilgan kontent mualliflik huquqingizni yoki boshqa huquqingizni buzadi deb hisoblasangiz, {contactEmail} manziliga yozing. Bildirishnomada koʻrsatilgan kontentni olib tashlashimiz yoki unga kirishni yopishimiz mumkin. Bildirishnomada quyidagilar boʻlishi kerak:",
          {
            list: [
              "sizningcha buzilgan asar yoki huquq;",
              "kontent qayerda joylashgani — masalan, uni topa olishimiz uchun havola;",
              "ismingiz va aloqa maʼlumotlaringiz, jumladan elektron pochta manzili;",
              "bunday foydalanishga huquq egasi, uning vakili yoki qonun ruxsat bermagan deb vijdonan hisoblashingiz, bildirishnomadagi maʼlumotlar toʻgʻri ekani hamda siz huquq egasi ekaningiz yoki uning nomidan harakat qilishga vakolatingiz borligi haqidagi bayonot.",
            ],
          },
        ],
      },
      {
        id: "third-parties",
        heading: "7. Uchinchi tomon xizmatlari",
        body: [
          "Xizmat Maxfiylik siyosatida sanab oʻtilgan uchinchi tomon provayderlariga tayanadi. Oʻz API kalitlaringizni bersangiz, bu provayderlardan foydalanishingiz ularning shartlari va tariflariga boʻysunadi, ularning mavjudligi yoki natijalari uchun biz javobgar emasmiz.",
          "Google modellari. Xizmatdagi baʼzi modellar Google’niki (masalan, Nano Banana kabi Gemini rasm modellari va Gemini Omni video) boʻlib, Google’ning Gemini API xizmati orqali ishlaydi. Ulardan birini ishlatsangiz, quyidagilarga rioya qilishga rozilik bildirasiz: amaldagi qonunchilik, [Gemini API qoʻshimcha shartlari](https://ai.google.dev/gemini-api/terms) va Google’ning [Generativ sunʼiy intellektdan taqiqlangan foydalanish siyosati](https://policies.google.com/terms/generative-ai/use-policy). Xususan:",
          {
            list: [
              "kamida 18 yoshda boʻlishingiz kerak (3-boʻlim);",
              "Google modeli yaratgan kontentni aldash maqsadida faqat inson tomonidan yaratilgan deb daʼvo qilmasligingiz kerak;",
              "Google oʻz modellari yaratgan narsaga qoʻyadigan suv belgisini olib tashlamasligingiz, yashirmasligingiz yoki oʻzgartirmasligingiz kerak (6.3-boʻlimga ham qarang);",
              "Google modellari faqat Google Gemini API uchun [mavjud hududlar](https://ai.google.dev/gemini-api/docs/available-regions) deb koʻrsatgan mamlakat va hududlarda foydalanish uchun taklif qilinadi, ulardan boshqa joydan foydalanmasligingiz kerak.",
            ],
          },
          // S6 (2026-11-27) LEGAL TEXT FOR OWNER REVIEW, Lyria 3.5 music: the Prohibited Use Policy of Google passed on (the two kinds
          // its music filter blocks) and the SynthID disclosure. Here in section 7, since section 6 names no model maker, and after the
          // list, whose four items tests/legal-google-gemini.test.ts pins for every Google model.
          "Google’ning Lyria modeli bilan yaratilgan musiqa. Google’ning Lyria modeli bilan musiqa yaratsangiz, undan muayyan ijrochining ovoziga taqlid qilishni yoki mavjud qoʻshiq matnini takrorlashni soʻramasligingiz kerak. U yaratgan har bir musiqada Google’ning SynthID audio suv belgisi boʻladi, u eshitilmaydi; uni olib tashlamasligingiz yoki olib tashlashga urinmasligingiz kerak.",
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
          "8.2. Kimdan sotib olasiz. Buyurtma jarayonini sotuvchimiz (Merchant of Record) va toʻlov provayderimiz Dodo Payments («Dodo») amalga oshiradi. Dodo kreditlarimiz va tariflarimizning vakolatli qayta sotuvchisi (reseller): ularni siz Dodo’dan [Dodo xaridorlar shartlari](https://dodopayments.com/legal/buyer-terms) asosida sotib olasiz, Xizmatni esa sizga biz taqdim etamiz. Dodo toʻlovni oʻzining toʻlov sahifasida qayta ishlaydi, amaldagi soliqlarni (QQS yoki savdo soligʻi) hisoblaydi va undiradi, buyurtma tasdigʻi va chekni elektron pochta orqali yuboradi hamda toʻlov boʻyicha savollar, qaytarish soʻrovlari va chargeback (toʻlovni bank orqali eʼtiroz qilish) holatlarini koʻrib chiqadi. Toʻlov maʼlumotlaringizni Dodo [Dodo Payments maxfiylik siyosati](https://dodopayments.com/legal/privacy-policy) asosida qayta ishlaydi; biz karta maʼlumotlaringizni hech qachon olmaymiz va saqlamaymiz. Dodo orqali toʻlovni ulash hali yakunlanmagan: u yoqilguncha Xizmatda koʻrsatiladigan har qanday toʻlov oynasi Paddle’ning sinov oynasi (sandbox) boʻlib, haqiqiy toʻlov qabul qilmaydi.",
          "8.3. Kreditlar qanday sarflanadi. Kreditlar Xizmat tashkilotingiz kanallaridan biri uchun video tayyorlaganda («ishga tushirish»), Studiyada siz uchun rasm, videoklip yoki audio yaratganda yoxud tahrirlaganda («generatsiya»), shuningdek narxi boshlanishidan oldin Xizmatda koʻrsatiladigan boshqa pullik ishlar uchun sarflanadi. Ishga tushirish uchun:",
          {
            list: [
              "Ishga tushirishdan oldin taxminiy miqdordagi kredit band qilinadi. Taxmin — soʻralgan video uzunligining amaldagi daqiqalik stavkaga koʻpaytmasi, daqiqalik stavka qoʻllanilmasa — kanalingizning soʻnggi ishga tushirishlari narxiga asoslangan hisob; u hech qachon bitta ishga tushirish uchun belgilangan minimumdan kam boʻlmaydi. Taxmin ishga tushirishdan oldin Xizmatda koʻrsatiladi va mavjud kreditlaringiz (balans minus allaqachon band qilinganlar) uni qoplamasa, ishga tushirish boshlanmaydi.",
              "Ishga tushirish tugagach, u haqiqatda ishlatgan resurslar uchun kreditlar amaldagi stavkalar boʻyicha yechiladi — lekin hech qachon banddan koʻp emas. Bandning ishlatilmagan qismi shu zahoti mavjud kreditlaringizga qaytariladi. Ishga tushirish ishlatgan resurslarning hammasini oʻlchab va narxlab boʻlmasa, band toʻliq yechiladi.",
              "Ishga tushirish muvaffaqiyatsiz tugasa yoki oxiriga yetmasa, band toʻliq qaytariladi va hech narsa yechilmaydi. Hech qachon boshlanmagan yoki natijasini xabar qilmagan ishga tushirishning bandi avtomatik qaytariladi.",
            ],
          },
          "Generatsiya uchun:",
          {
            list: [
              "Boshlanishidan oldin Xizmat uning narxini koʻrsatadi va siz uni tasdiqlaysiz. Shu narx band qilinadi va mavjud kreditlaringiz uni qoplamasa, generatsiya boshlanmaydi.",
              "Generatsiya tugagach, uning narxi yechiladi — hech qachon banddan koʻp emas — va bandning qolgan qismi qaytariladi. Agar modelni tanlashni Xizmatga topshirgan boʻlsangiz va birinchi model soʻrovni qabul qila olmasa, generatsiyani xuddi shu turdagi boshqa model bajarishi mumkin; bu holda shu model narxidan koʻp yechilmaydi.",
              "Bitta rasmning bir nechta belgilangan sohasini tahrirlash faqat haqiqatda qoʻllangan sohalar uchun toʻlanadi: qoʻllangan sohalar uchun bandning ulushi, kreditning yuzdan bir qismigacha yuqoriga yaxlitlangan holda. Birorta ham soha qoʻllanmasa, hech narsa yechilmaydi.",
              "Generatsiya muvaffaqiyatsiz tugasa, model uni rad etsa, u bekor qilinsa yoki oʻz vaqtida tugallanmasa, band toʻliq qaytariladi va hech narsa yechilmaydi.",
            ],
          },
          "Boshqa har qanday pullik ish ham shu qoidaga boʻysunadi: boshlanishidan oldin kreditlar band qilinadi, tugagach banddan koʻp yechilmaydi, muvaffaqiyatsiz boʻlsa band toʻliq qaytariladi. Har bir band, yechish va qaytarish Xizmatdagi tashkilotingizning kredit tarixiga yoziladi.",
          "8.4. Kreditlarning tabiati. Kreditlar — Xizmatdan foydalanish uchun oldindan toʻlangan huquq, pul yoki depozit emas: ularning pul qiymati yoʻq, ularga foiz hisoblanmaydi, ularni pulga almashtirib (8.6-boʻlimdagi qaytarishdan tashqari), boshqa tashkilotga oʻtkazib yoki qayta sotib boʻlmaydi.",
          {
            creditExpiry: {
              never: "8.5. Amal qilish muddati. Kreditlarning muddati tugamaydi.",
              after: "8.5. Amal qilish muddati. Ishlatilmagan kreditlarning muddati sotib olingan kundan boshlab {months} oy oʻtgach tugaydi.",
              unknown: "8.5. Amal qilish muddati. Toʻldirish kreditlari uchun sotib olish paytida paketlarga belgilangan muddat amal qiladi. Hozir uni bu sahifada koʻrsatib boʻlmadi; joriy muddatni bilish uchun bizga {contactEmail} manziliga yozing.",
            },
          },
          "8.6. Qaytarish. Sotuvchi Dodo boʻlgani uchun qaytarish haqidagi qarorni Dodo [Dodo xaridorlar shartlari](https://dodopayments.com/legal/buyer-terms) va amaldagi qonunchilik asosida qabul qiladi, jumladan yashash joyingizda isteʼmolchi sifatida xariddan voz kechish huquqingiz boʻlsa, shu huquq asosida ham. Qaytarishni soʻrash uchun {contactEmail} manziliga yozing — soʻrovni Dodo’ga yetkazamiz — yoki bevosita Dodo’ga murojaat qiling: xaridingizni Dodo’ning [customer.dodopayments.com](https://customer.dodopayments.com) mijozlar portalida toping va qaytarishni soʻrang. [Qaytarish siyosati](/refund) bu qoidalarni bitta sahifada jamlaydi.",
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
  dataDeletion: {
    title: "Maʼlumotlarni oʻchirish",
    summary:
      "Ulangan Instagram akkauntiga Nightshift kirishini qanday olib tashlash, uni Nightshift’da qanday uzish va bizdagi maʼlumotlarni oʻchirishni qanday soʻrash.",
    sections: [
      {
        id: "remove-in-meta",
        heading: "1. Nightshift’ni Meta’da olib tashlang",
        body: [
          "Instagram akkaunti Nightshift’ga Meta biznes portfeli orqali ulanadi. Meta tomonida kirish huquqimizni olib tashlash uchun:",
          {
            list: [
              "Meta Business Settings’da ([business.facebook.com/settings](https://business.facebook.com/settings)) «Integrations» → «Connected apps»ni oching, Nightshift’ni tanlang va olib tashlang.",
            ],
          },
          "Shu daqiqadan Nightshift akkaunt uchun saqlagan token ishlamay qoladi va Nightshift unga endi joylay olmaydi ham, uni oʻqiy olmaydi ham.",
        ],
      },
      {
        id: "disconnect-in-nightshift",
        heading: "2. Uni Nightshift’da uzing",
        body: [
          "“Kanallar” sahifasida, “Ulangan akkauntlar” boʻlimida akkaunt yonidagi “Uzish” tugmasini bosing (buni ish maydonining egasi, administratori yoki muharriri qila oladi). Saqlangan token shifrlangan omborimizda (Supabase Vault) darhol yoʻq qilinadi va akkauntga boshqa hech narsa joylanmaydi. Buni 1-qadam bilan birga qiling: ularning har biri alohida ham Nightshift’ning akkaunt nomidan ishlashini toʻxtatadi.",
        ],
      },
      {
        id: "request",
        heading: "3. Maʼlumotlaringizni oʻchirishni soʻrang",
        body: [
          "{contactEmail} manziliga yozing va qaysi Instagram akkaunti qaysi Nightshift akkaunti yoki ish maydoniga ulanganini ayting. Boshqa hech kim maʼlumotlaringizni oʻchirtira olmasligi uchun soʻrovni oʻsha Nightshift akkauntining elektron pochtasidan tasdiqlashingizni soʻrashimiz mumkin.",
        ],
      },
      {
        id: "what-we-delete",
        heading: "4. Nimani va qachon oʻchiramiz",
        body: [
          {
            list: [
              "Faqat Supabase Vault’da saqlanadigan akkaunt kirish tokeni: uzganingizda darhol, agar hali boʻlsa, oʻchirish soʻrovi bilan ham yoʻq qilinadi.",
              "Ulangan akkaunt yozuvi: Instagram akkauntining identifikatori, foydalanuvchi nomi, ismi va rasmi, uni kim va qachon ulagani hamda u ulangan Meta biznes portfeli va konfiguratsiya identifikatorlari.",
              "Nightshift akkauntga yuborgan postlar yozuvi (nima yuborilgani, qachon va Instagram qaytargan post identifikatori yoki xato).",
              "Hozir Nightshift Instagram statistikasi va xabarlarini oʻqimaydi, shuning uchun akkaunt uchun ular saqlanmaydi.",
            ],
          },
          "Bularning barchasi tasdiqlangan oʻchirish soʻrovidan keyin 30 kun ichida oʻchiriladi — [Maxfiylik siyosatimiz](/privacy) akkaunt maʼlumotlari haqida shunday deydi. Akkauntni kim ulagani yoki uzgani haqidagi audit yozuvlari Maxfiylik siyosatining 8-boʻlimida aytilganidek, Nightshift akkaunti mavjud ekan saqlanadi, chunki ular amalga kim ruxsat berganini qayd etadi.",
        ],
      },
    ],
  },
  refund: {
    title: "Qaytarish siyosati",
    summary:
      "Nightshift kreditlari va tariflari uchun qaytarish qanday ishlaydi: uni qanday soʻrash, kreditlaringiz nima boʻladi va oylik tarifni qanday bekor qilish.",
    sections: [
      {
        id: "seller",
        heading: "1. Qaytarishni kim amalga oshiradi",
        body: [
          {
            note: "Ushbu siyosat [Foydalanish shartlari](/terms#credits) 8-boʻlimining mazmunini bir joyda bayon qiladi. U boʻlim malakali yurist koʻrib chiqishini kutmoqda; har qanday oʻzgarish ikkala sahifada yangi kuchga kirish sanasi bilan eʼlon qilinadi. Agar matnlar bir-biridan farq qilsa, Foydalanish shartlari amal qiladi.",
          },
          "Buyurtma jarayonini sotuvchimiz (Merchant of Record) va toʻlov provayderimiz Dodo Payments («Dodo») amalga oshiradi: kreditlar va tariflarni siz Dodo’dan [Dodo xaridorlar shartlari](https://dodopayments.com/legal/buyer-terms) asosida sotib olasiz, Dodo esa toʻlovni qayta ishlaydi, chek yuboradi hamda qaytarish soʻrovlari va chargeback holatlarini koʻrib chiqadi. Dodo orqali toʻlovni ulash hali yakunlanmagan: u yoqilguncha Xizmatda koʻrsatiladigan har qanday toʻlov oynasi Paddle’ning sinov oynasi (sandbox) boʻlib, haqiqiy toʻlov qabul qilmaydi, shuning uchun u boʻyicha qaytariladigan narsa yoʻq.",
        ],
      },
      {
        id: "how-to-ask",
        heading: "2. Qaytarishni qanday soʻrash mumkin",
        body: [
          "Qaytarishni quyidagi usullardan biri bilan soʻrashingiz mumkin:",
          {
            list: [
              "bizga {contactEmail} manziliga yozing — soʻrovni Dodo’ga yetkazamiz;",
              "chekdagi buyurtma raqami va xaridda foydalangan elektron pochta manzilingizni koʻrsatib, bevosita Dodo Payments’ga murojaat qiling: xaridingizni Dodo’ning [customer.dodopayments.com](https://customer.dodopayments.com) mijozlar portalida toping va qaytarishni soʻrang.",
            ],
          },
        ],
      },
      {
        id: "when",
        heading: "3. Qaytarish qachon beriladi",
        body: [
          "Qaytarish haqidagi qarorni Dodo [Dodo xaridorlar shartlari](https://dodopayments.com/legal/buyer-terms) va amaldagi qonunchilik asosida qabul qiladi, jumladan yashash joyingizda isteʼmolchi sifatida xariddan voz kechish huquqingiz boʻlsa, shu huquq asosida ham. Biz qaytarish uchun alohida muddat belgilamaymiz.",
          "Ushbu siyosatdagi hech narsa qonun bilan berilgan isteʼmolchi huquqlaringizni cheklamaydi.",
        ],
      },
      {
        id: "credits",
        heading: "4. Kreditlaringiz nima boʻladi",
        body: [
          "Xarid qaytarilsa yoki bank orqali eʼtiroz qilinsa (chargeback), u qoʻshgan kreditlar tashkilot balansidan olinadi: toʻliq qaytarishda — hammasi, qisman qaytarishda — qaytarilgan summaga mutanosib qismi.",
          "Faqat mavjud kreditlarni olish mumkin: allaqachon sarflangan yoki ishlab turgan ishga tushirish uchun band qilinganlarini olib boʻlmaydi. Chargeback’dan keyin sarflangan, lekin toʻlanmagan kreditlar qolsa, tashkilotning pullik funksiyalardan foydalanishini toʻxtatib turishimiz mumkin.",
          "Kreditlarning pul qiymati yoʻq va ularni bu yerda tavsiflangan qaytarishdan tashqari pulga almashtirib boʻlmaydi.",
        ],
      },
      {
        id: "failed-runs",
        heading: "5. Muvaffaqiyatsiz generatsiyalar",
        body: [
          "Generatsiya muvaffaqiyatsiz tugasa, hech narsa soʻrashingiz shart emas. Ishga tushirishdan oldin uning taxminiy narxi band qilinadi. Ishga tushirish muvaffaqiyatsiz tugasa yoki oxiriga yetmasa, band toʻliq qaytariladi va hech narsa yechilmaydi; hech qachon boshlanmagan yoki natijasini xabar qilmagan ishga tushirishning bandi avtomatik qaytariladi. Ishga tushirish tugagach, faqat u haqiqatda ishlatgan resurslar uchun yechiladi — hech qachon banddan koʻp emas. Studiyadagi generatsiyaga ham shu qoida tegishli: u muvaffaqiyatsiz tugasa yoki model uni rad etsa, uning bandi toʻliq qaytariladi (Shartlarning 8.3-boʻlimi).",
          "Har bir band, yechish va qaytarish Xizmatdagi tashkilotingizning kredit tarixiga yoziladi.",
        ],
      },
      {
        id: "subscriptions",
        heading: "6. Oylik tarifni bekor qilish",
        body: [
          "Oylik tarifni istalgan vaqtda bekor qilishingiz mumkin — Xizmatdagi Kreditlar sahifasidagi «Obunani boshqarish» orqali. Shundan keyin tarif allaqachon toʻlangan davr oxirigacha qoʻshimcha toʻlovsiz amal qiladi va yangilanmaydi. Tarif bilan berilgan kreditlar faqat ular berilgan davr ichida ishlatiladi va uning oxirida yonadi.",
          "Bekor qilish keyingi yangilanishlarni toʻxtatadi. Allaqachon amalga oshirilgan toʻlovni qaytarishni soʻrash uchun 2-boʻlimga qarang.",
        ],
      },
      {
        id: "contact",
        heading: "7. Aloqa",
        body: ["{legalName}, {country}. Elektron pochta: {contactEmail}. Shuningdek, [Foydalanish shartlari](/terms) va [Maxfiylik siyosati](/privacy) bilan tanishing."],
      },
    ],
  },
};
