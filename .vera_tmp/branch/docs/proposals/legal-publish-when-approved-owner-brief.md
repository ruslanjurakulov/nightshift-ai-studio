# "Tasdiqdan keyin nashr qilish": huquqiy matnlar, egasi uchun qisqa xat

**Bu PR (`claude/legal-publish-when-approved`) hozircha BIRLASHTIRILMAYDI.** Funksiya chiqarilmaguncha
(release) qolsin. PR qoralama (draft) holatida turadi.

## 1. Gap nima haqida

Funksiya (PR #543): inson bitta aniq videoni tasdiqlaydi, kanal esa ish maydoni administratori
"Tasdiqdan keyin nashr qilish"ni yoqqan kanal bo'lsa, ishchi dastur YouTube'dan **shu bitta
yopiq (private) videoni ommaviy (public) qilishni** bir marta so'raydi va faqat YouTube
qaytargan javobni yozib qo'yadi. Sarlavha, tavsif, teg, muqova o'zgarmaydi. Hech narsa
o'chirilmaydi. Yangi scope kerak emas (`youtube.force-ssl` allaqachon bor). Hamma joyda
standart holat: **o'chiq**.

Muammo: bizning saytdagi matnlar va Google'ga yozilgan asoslash "Nightshift mavjud
videolarni hech qachon tahrirlamaydi" va "ommaviy qilish faqat YouTube'da bajariladi"
deydi. Funksiya chiqqach bu gaplar **yolg'on** bo'lib qoladi. Google foydalanuvchi
ma'lumotlari siyosati va foydalanuvchining o'zi ham haqiqatni bilishi shart: siyosat ilova
nima qilishini aniq aytishi kerak, Google siyosatni ilova xatti-harakati bilan solishtiradi.

"Sizsiz hech narsa ommaviy bo'lmaydi" degan va'da **haqiqat bo'lib qoladi** (inson
tasdiqlaydi, administrator yoqgan). Faqat so'zlar aniqroq bo'ldi.

## 2. Nima o'zgardi (oldin / hozir)

| # | Qayerda | Oldin (inglizcha asl) | Hozir (o'zbekcha ma'nosi) |
| :-- | :-- | :-- | :-- |
| 1 | Maxfiylik siyosati, 3-bo'lim, `youtube.force-ssl` qatori | "Nightshift never deletes anything and never edits your existing videos, playlists or comments; it only adds the items listed here." | Hech narsani o'chirmaydi. Mavjud video, pleylist, izohni tahrirlamaydi, **faqat bitta istisno**: administrator kanal uchun "Publish when approved"ni yoqqan va inson shu videoni tasdiqlagan bo'lsa, shu bitta videoni private'dan public'ga o'tkazadi va qayta o'qib tekshiradi. Nom, tavsif, teg, muqovaga tegmaydi. |
| 2 | Maxfiylik siyosati, `youtube.upload` qatori | "Uploads are private unless you choose otherwise for that channel — for example, by turning on auto-publish, which is off by default." | Shu gap qoladi, ustiga: tasdiqlangan yopiq yuklamani ommaviy qilish ham mumkin, lekin faqat shu kanalda sozlama yoqilgan bo'lsa (sukut bo'yicha o'chiq). |
| 3 | Maxfiylik siyosati, 4-bo'lim "How we use Google user data" | Funksiyalar ro'yxatida ommaviy qilish yo'q edi. | Ro'yxatga "faqat siz yoqqan joyda, tasdiqlagan videoni ommaviy qilish" qo'shildi va alohida paragraf: kim yoqadi (administrator, so'z yozib), qanday o'chiriladi (Channels sahifasi), 24 soatlik tasdiq, YouTube'ga bir marta so'rov, YouTube baribir private qoldirishi mumkin, boshqa hech narsa o'zgarmaydi. |
| 4 | Foydalanish shartlari, 4-bo'lim | (bu mavzu yo'q edi) | Yangi paragraf: sozlama yoqilgan kanalda aniq versiyani tasdiqlash videoni private'dan public'ga o'tkazishni so'raydi; sozlama o'chiq bo'lsa hech narsa bo'lmaydi; shu usulda chiqqan video "siz tanlagan sozlamalar bo'yicha nashr qilingan kontent" va 5-bo'lim (javobgarlik) unga ham tegishli. 8-bo'lim (kredit, qaytarish) o'zgarmadi: bu funksiya kredit sarflamaydi, YouTube kvotasini sarflaydi. |
| 5 | `docs/GOOGLE_OAUTH_VERIFICATION.md`, 4-bo'lim, `youtube.force-ssl` asoslash matni (Google'ga ingliz tilida yoziladi) | "Required by three write calls ... Nightshift never deletes or edits existing videos, playlists or comments." | "Required by four write calls ..." va to'rtinchisi `videos.update`: faqat ikki shart birga bo'lganda (administrator kanal uchun yoqqan + inson shu aniq versiyani tasdiqlagan). Sarlavha, tavsif, teg, muqova o'zgarmaydi. Nega aynan shu scope: `videos.update` faqat `youtube`, `youtube.force-ssl`, `youtubepartner`ni qabul qiladi, `youtube.upload` yetmaydi. |
| 6 | Sayt, bosh sahifa va "Solutions" kartochkasi | "Going public is your decision, made on YouTube. Auto-publish is a per-channel switch, and it stays off until you turn it on." | Ommaviy qilish insonning qarori: yoki YouTube'da o'zingiz, yoki ish maydonini boshqaradigan kishi "Publish when approved"ni yoqqan kanalda ilovada aynan shu videoni tasdiqlaysiz. Ikkala sozlama ham kanal bo'yicha va yoqmaguningizcha o'chiq. |
| 7 | Sayt, "Publish desk" kartochkasi | "It goes public only when you make it public on YouTube." | Faqat siz YouTube'da ommaviy qilsangiz yoki "Publish when approved" yoqilgan kanalda tasdiqlasangiz ommaviy bo'ladi. |
| 8 | Studio sahifasi, FAQ "Do you publish for me?" | "Auto-publish is off for a channel until you turn it on." | Shu gap qoladi, ustiga: "Publish when approved" ham o'chiq; ish maydonini boshqaradigan kishi kanal uchun yoqsa, aniq videoni tasdiqlash YouTube'dan uni ommaviy qilishni so'raydi. |
| 9 | Bosh sahifa (ilova ichida), kanal ulanmagan holat va kanal kartochkasi | "Making one public is done on YouTube." | Uni YouTube'da ommaviy qilasiz yoki, sozlama yoqilgan kanalda, tasdiqlaysiz. |
| 10 | Hisoblar sahifasidagi eslatma | "Every upload is private until a human turns that channel's Auto publish on." | Har bir yuklama yaratilganda private. Ommaviy bo'ladi: inson ommaviy qilsa, kanalda Auto publish yoqilgan bo'lsa yoki inson "Publish when approved" yoqilgan kanalda tasdiqlasa. |

Matnlarda hamma joyda 4 narsa bor: YouTube'da nima o'zgaradi (private -> public), kim
harakat qilishi kerak (administrator yoqadi, inson aniq videoni tasdiqlaydi), sukut bo'yicha
o'chiq, boshqa hech narsa tahrirlanmaydi/o'chirilmaydi. Mijozlarga ko'rinadigan sayt
matnlarida "administrator" so'zi yo'q ("ish maydonini boshqaradigan kishi"): loyihada
mijoz matnida rol nomi yozilmaydi (test shuni tekshiradi). Huquqiy sahifalarda "administrator"
deyilgan, chunki u yerda aniqlik muhim.

## 3. Qo'llanmagan narsalar

- "Awaiting review by a qualified lawyer" izohi (Shartlar 8-bo'lim) joyida. Yurist hali
  ko'rmagan. Yangi paragraflarni ham yurist ko'rishi kerak; men huquqiy da'vo, yurisdiksiya
  yoki kompaniya haqida hech narsa o'ylab topmadim.
- Kuchga kirish sanasi avvalgidek `NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE` o'zgaruvchisidan
  keladi (kodda sana yo'q). **Release kuni shu o'zgaruvchini yangi sanaga o'zgartiring**, chunki
  siyosat Google ma'lumotlaridan foydalanishga ta'sir qiladi (siyosatning 15-bo'limi:
  jiddiy o'zgarishda foydalanuvchiga xabar beramiz, kerak bo'lsa qayta rozilik so'raymiz).
- CLAUDE.md 2 va 3-qoida va README: bular sizniki, men tegmadim. #543 dagi
  `docs/proposals/claude-md-rules-2-3-phase-1b.patch`ni siz tasdiqlaysiz.
- Rus va o'zbek matnlar: men yozdim, lekin ona tili darajasida kafolat yo'q. **Rus va o'zbek
  tilini ona tilida biladigan odam o'qib chiqishi kerak**, ayniqsa huquqiy sahifalarni.

## 4. Nega Google va foydalanuvchiga aytish shart

- Google OAuth tekshiruvida "Data access" asoslash matni, demo video va `/privacy` ilova
  qiladigan ishga mos kelishi kerak. Eski matn "tahrirlamaydi" desa, lekin ilova
  `videos.update` chaqirsa, bu nomuvofiqlik. Tekshiruvda yoki keyin rad etilishiga olib kelishi mumkin.
- Google yordam sahifasi ham aytadi: maxfiylik siyosati va ilova ichidagi xabarlar
  Google ma'lumotlaridan foydalanish haqida **yangilab turilishi** kerak.
- Foydalanuvchi uchun: kanali ommaviy bo'lishi katta ish. U bilishi kerak: kim yoqdi, qachon,
  qanday o'chiriladi.

## 5. Google bilan nima aniq, nima noma'lum (halol)

**Aniq (Google yordam sahifalaridan o'qidim):**

- Yangi scope qo'shish uchun tekshiruv kerak. Biz yangi scope qo'shmadik, shuning uchun bu
  holat bizga tegishli emas.
- Scope'lar o'zgarmasa, consent screen o'zgarganda qo'shimcha asoslash so'ralmaydi
  (support.google.com/cloud/answer/13464018).
- App nomi, logo, redirect URI, bosh sahifa yoki maxfiylik **havolasi** o'zgarsa, brend
  tekshiruvi qayta o'tadi. Biz havolalarni o'zgartirmadik, faqat matnni.

**Noma'lum, tekshirish sizning ishingiz (men Cloud console'ga kira olmayman):**

1. **Allaqachon tasdiqlangan scope'ning ishlatilish tavsifi o'zgarsa, Google qayta
   topshirishni yoki xabar berishni talab qiladimi?** Men buni hech bir rasmiy sahifada
   aniq yozilgan holda topa olmadim. Nima qilish:
   - Google Cloud console -> Google Auth Platform -> **Verification Center** -> holatni
     ko'ring. Ilova hali "Testing"da bo'lsa, hech narsa topshirilmaydi: yangi matn birinchi
     topshirishga kiradi.
   - Ilova allaqachon tasdiqlangan bo'lsa: **Data access**da `youtube.force-ssl` asoslash
     maydonini yangilashga urinib ko'ring. Console "Submit for verification" taklif
     qilsa, yangi asoslash va yangi demo video bilan topshiring.
   - Shubha qolsa: Verification Center'dagi yozishuv orqali Google'dan so'rang va javobni
     `docs/GOOGLE_OAUTH_VERIFICATION.md`ga yozib qo'ying.
2. **YouTube API Services audit / kvota kengaytmasi.** #543 hujjatiga ko'ra
   (`docs/APPROVE_PUBLISH_1B.md`): tekshiruvdan o'tmagan loyihaning `videos.update` bilan qilingan videolarini YouTube
   private bilan cheklashi mumkin. Rasmiy `videos.insert` sahifasi va eski 2020 e'loni bir-biriga
   zid. Bu faqat jonli sinovda ma'lum bo'ladi (kod `platform_kept_private` yozadi). Shunda
   audit kerak bo'lsa, shu funksiyani audit o'tmaguncha hech kimga yoqmang. Audit
   o'tgandan keyin API ishlatilishi o'zgarsa audit formasini yangilash kerakmi, shuni ham
   Google'dan so'rang.
3. Demo video eski bo'lsa (u "hech narsani tahrirlamaydi"ni ko'rsatadi), yangisini yozish
   kerak bo'ladi (6-band).

## 6. Demo video (ingliz tilida, faqat sinov kanalida, jonli sinovdan KEYIN)

`docs/GOOGLE_OAUTH_VERIFICATION.md` 5-bo'lim, 6-qadam. Tartib:

1. Channels sahifasi: kanal sozlamasi **Off** (standart).
2. Administrator **On** qiladi: tasdiq oynasi matni va yozilgan so'z ko'rinsin.
3. Video sahifasida aynan shu versiyani tasdiqlash.
4. "Queued" holati.
5. YouTube Studio'da video *Private*dan *Public*ga o'tdi; nom, tavsif, teg, muqova o'zgarmadi.
6. Video sahifasida "Published" (YouTube xabar qilgan holat).
7. Sozlamani yana **Off** qilish.

Brauzer manzil satri ko'rinib tursin (eski talab o'z kuchida).

## 7. Tartib (muhim)

1. CLAUDE.md 2/3-qoida o'zgarishini (#543 patch) siz tasdiqlaysiz.
2. **#543 ni "dark" birlashtirish**: kod bor, hammasi o'chiq (sozlama, ishchi dastur, web bayrog'i).
3. **Chronos kanalida jonli sinov** (`docs/APPROVE_PUBLISH_1B.md`, "Manual live test"); uch noma'lum
   javobni yozib qo'ying: (a) video haqiqatan public bo'ldimi, (b) boshqa sozlamalar
   o'zgarmadimi, (c) kvota sarfi.
4. Demo videoni yozing. Google'ga yuboriladigan asoslash matnini (shu PR dagi matn) tayyorlang
   va yuqoridagi 5-bo'limdagi noma'lumlarni console'da tekshiring.
5. **Shu PR ni birlashtirish** (draft'dan chiqarib) va `NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE` ni yangilash
   hamda web'ni qayta deploy qilish.
6. Release bayroqlari: ishchi dastur `NIGHTSHIFT_VISIBILITY_PUBLISH=on`, keyin web
   `PUBLISH_ON_APPROVE_RELEASED=on`.
7. Faqat shundan keyin mijozlarga ayting. Har bir kanal administratori o'zi yoqadi.

Nega bu tartib: matnlar funksiya mijozga ko'rinmasdan oldin chiqib qolmasin (ular
"Publish when approved" haqida gapiradi). Funksiya esa matnsiz chiqib qolmasin (siyosat
yolg'on bo'lib qolmasin).

## 8. Tekshiruvlar

Testlar (`tests/legal-publish-when-approved.test.ts`) uch tilda: eski gaplar yo'qligini, yangi
paragraflarda kerakli 4 narsa borligini, Limited Use bo'limi o'zgarmaganini, kredit bo'limi
va yurist izohi joyida ekanini, demo skript va asoslash matnida `videos.update` borligini
tekshiradi. #543 bilan birlashtirib ham sinab ko'rildi: ziddiyat yo'q, testlar o'tadi.

## 9. O'zgartirilmadi, lekin tekshirib ko'ring

- Maxfiylik siyosatidagi `youtube.force-ssl` qatori "bitta izoh (tomoshabinlarga savol)" deydi,
  lekin kodda izohlarga javob berish (comment inbox, migratsiya 0081) ham bor. Bu #543 dan
  oldingi nomuvofiqlik: shu funksiya yoqilishidan oldin matnni tekshiring.
