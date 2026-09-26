# Command Center'ni o'z serverimizda ishga tushirish (Hetzner AX42)

Bu qo'llanma Nightshift Command Center'ni (`command-center/`) Vercel o'rniga
o'zimizning Hetzner AX42 serverimizda (8 yadro, 64 GB RAM, 2×512 GB NVMe RAID1,
Ubuntu 24.04) ishga tushirishni qadamma-qadam tushuntiradi. Sabab: Vercel Hobby
tarifi tijoriy foydalanishni taqiqlaydi, server esa baribir pipeline worker uchun
olinadi (qarang: `docs/ROADMAP_SAAS.md`).

Tuzilishi:

```
Brauzer ──HTTPS──> Cloudflare (proxy, DNS) ──HTTPS──> Caddy :443 ──> web :3000 (Next.js)
                                                     (sertifikat,          (faqat ichki
                                                      headerlar, gzip)      Docker tarmog'ida)
Supabase (Postgres + Auth + Realtime) o'zgarmaydi — brauzer unga to'g'ridan-to'g'ri ulanadi.
```

Fayllar:

| Fayl | Nima uchun |
|---|---|
| `command-center/Dockerfile` | Next.js `standalone` image, root bo'lmagan foydalanuvchi, healthcheck |
| `deploy/docker-compose.yml` | `web` + `caddy` servislari (worker uchun joy keyin qo'shiladi) |
| `deploy/Caddyfile` | Avtomatik HTTPS, reverse proxy, xavfsizlik headerlari, gzip/zstd |
| `deploy/bootstrap.sh` | Yangi serverni bir marta sozlash va himoyalash |
| `deploy/.env.web.example` | Muhit o'zgaruvchilari shabloni (faqat nomlar, haqiqiy qiymat yo'q) |

> **Qoida:** hech qanday kalit, token yoki parolni git'ga, chatga, issue'ga
> yoki skrinshotga qo'ymang. Haqiqiy qiymatlar faqat serverdagi
> `/opt/nightshift/.env.web` faylida (`chmod 600`) va parol menejeringizda turadi.
> Command Center faqat Supabase **anon** kalitini ishlatadi — **service key hech
> qachon** bu yerga yozilmaydi.

---

## 0. Oldindan tayyorlab qo'ying

1. **SSH kalit** (kompyuteringizda). Agar yo'q bo'lsa:
   ```bash
   ssh-keygen -t ed25519 -C "sizning-email@example.com"
   ```
   Parol (passphrase) qo'ying. Ikkita fayl hosil bo'ladi: `~/.ssh/id_ed25519`
   (**maxfiy**, hech kimga bermang) va `~/.ssh/id_ed25519.pub` (ochiq — shuni
   Hetzner'ga beramiz). Ochiq kalitni ko'rish: `cat ~/.ssh/id_ed25519.pub`.
2. **Domen** Cloudflare'da ro'yxatdan o'tgan bo'lsin (Cloudflare Registrar —
   DNS avtomatik Cloudflare'da bo'ladi).
3. Hozirgi **Vercel loyihasidagi environment variable'lar ro'yxati** — qiymatlarni
   ko'chirish uchun kerak bo'ladi (Vercel → Project → Settings → Environment
   Variables). Vercel loyihasini **o'chirmang** — orqaga qaytish (11-bo'lim) uchun
   kerak.

---

## 1. AX42'ni Hetzner Robot'da buyurtma qilish

1. <https://www.hetzner.com/dedicated-rootserver/ax42> → **Order**.
2. **Location**: Germaniya (FSN1 yoki NBG1) — Supabase va foydalanuvchilarga yaqin.
3. **Operating system**: `Ubuntu 24.04 LTS` ni tanlang.
4. **SSH key**: `id_ed25519.pub` faylining **butun** matnini joylashtiring
   (`ssh-ed25519 AAAA... email` ko'rinishida). Shunda root paroli kerak bo'lmaydi.
5. Buyurtmani tasdiqlang. Server tayyor bo'lgach, Hetzner email yuboradi:
   unda serverning **IPv4 manzili** bo'ladi (masalan `203.0.113.10`). Uni yozib
   qo'ying — quyida `SERVER_IP` deb ataladi.

### Agar server "rescue" rejimida kelsa yoki qayta o'rnatish kerak bo'lsa

1. <https://robot.hetzner.com> → **Server** → serveringiz → **Rescue** tab.
2. Operating system: `linux`, **SSH key**: o'z kalitingizni tanlang → **Activate rescue system**.
3. **Reset** tab → **Execute an automatic hardware reset** → **Send**.
4. 1–2 daqiqadan so'ng: `ssh root@SERVER_IP` (rescue tizimi).
5. `installimage` buyrug'ini ishga tushiring:
   - ro'yxatdan **Ubuntu** → **Ubuntu-2404-noble-amd64-base** ni tanlang;
   - ochilgan konfiguratsiyada tekshiring:
     ```
     SWRAID 1
     SWRAIDLEVEL 1
     HOSTNAME nightshift
     PART swap  swap  8G
     PART /boot ext3  1024M
     PART /     ext4  all
     ```
     (`SWRAID 1` — ikki disk bir-birini ko'zgulaydi; bitta disk buzilsa ham
     server ishlayveradi. Bu **backup emas**, 12-bo'limga qarang.)
   - **F10** → saqlash → tasdiqlash. O'rnatish tugagach: `reboot`.
6. Rescue tizimidagi SSH kalit odatda yangi tizimning root foydalanuvchisiga
   ko'chiriladi.

---

## 2. Birinchi SSH kirish

Kompyuteringizdan:

```bash
ssh root@SERVER_IP
```

Birinchi marta "Are you sure you want to continue connecting?" deb so'raydi —
`yes`. Agar "REMOTE HOST IDENTIFICATION HAS CHANGED" chiqsa (server qayta
o'rnatilgan bo'lsa): `ssh-keygen -R SERVER_IP` va qayta urinib ko'ring.

---

## 3. `bootstrap.sh` — serverni himoyalash va sozlash

Hali root sifatida serverda:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/ruslanjurakulov/nightshift-ai-studio.git /root/nightshift-bootstrap
bash /root/nightshift-bootstrap/deploy/bootstrap.sh nightshift
```

> Repozitoriy private bo'lsa, `git clone` ishlamaydi. U holda skriptni
> kompyuteringizdan yuboring:
> `scp deploy/bootstrap.sh root@SERVER_IP:/root/` va serverda
> `bash /root/bootstrap.sh nightshift`.

Skript nima qiladi (qayta ishga tushirish xavfsiz — bajarilgan qadamlar o'tkazib yuboriladi):

1. Paketlarni yangilaydi.
2. `nightshift` foydalanuvchisini yaratadi (sudo + docker huquqi bilan) va
   root'ning SSH kalitini unga ko'chiradi. **Sudo paroli so'raladi** — yangi,
   kuchli parol o'ylab toping va parol menejeriga saqlang (SSH kirish baribir
   faqat kalit bilan bo'ladi; parol faqat `sudo` uchun).
3. **ufw** firewall: faqat 22 (SSH), 80, 443 portlar ochiq.
4. **fail2ban**: SSH'ga ko'p marta noto'g'ri urinishlarni bloklaydi.
5. **unattended-upgrades**: xavfsizlik yangilanishlari avtomatik o'rnatiladi
   (qayta yuklash avtomatik emas — pastga qarang).
6. **Docker Engine + compose plugin** — Docker'ning rasmiy apt repozitoriyasidan.
7. Swap va vaqt sinxronizatsiyasini tekshiradi.
8. **Eng oxirida** SSH'ni faqat kalit bilan kirishga o'tkazadi va root kirishini
   o'chiradi. **Himoya:** agar `nightshift` foydalanuvchisida haqiqiy SSH kalit
   bo'lmasa yoki u `sudo` qila olmasa, bu qadam **o'tkazib yuboriladi** va skript
   nima yetishmayotganini aytadi — shunda serverdan qulflanib qolmaysiz.

**Muhim:** skript tugagach, **joriy oynani yopmang**. Yangi terminal oynasida:

```bash
ssh nightshift@SERVER_IP
sudo -v          # sudo parolini so'raydi — ishlasa, hammasi joyida
docker ps        # xato bermasligi kerak (bo'sh ro'yxat)
```

Ikkalasi ishlagandan keyingina root oynasini yoping. Bundan buyon faqat
`ssh nightshift@SERVER_IP` orqali kiring.

> Agar `docker ps` "permission denied" desa — bir marta chiqib qayta kiring
> (docker guruhi yangi sessiyada kuchga kiradi).

Yadro (kernel) yangilanishidan so'ng skript yoki kirish xabari
"reboot required" desa, render ishlamayotgan vaqtda `sudo reboot` qiling.
Konteynerlar o'zi qayta ko'tariladi.

---

## 4. Repozitoriyni serverga olish

`nightshift` foydalanuvchisi sifatida. Repozitoriy private bo'lsa, faqat o'qish
huquqli **deploy key** ishlatamiz (shaxsiy tokeningiz serverda turmasin):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/nightshift_deploy -N "" -C "nightshift-server"
cat ~/.ssh/nightshift_deploy.pub
```

GitHub → repozitoriy → **Settings → Deploy keys → Add deploy key** → chiqqan
`.pub` matnini joylashtiring, **Allow write access** belgilanmagan bo'lsin.

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/nightshift_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
git clone git@github.com:ruslanjurakulov/nightshift-ai-studio.git /opt/nightshift/app
```

Qulaylik uchun qisqa buyruq (`dc`) qo'shamiz — keyingi barcha qadamlar shuni ishlatadi:

```bash
echo "alias dc='docker compose --env-file /opt/nightshift/.env.web -f /opt/nightshift/app/deploy/docker-compose.yml'" >> ~/.bashrc
source ~/.bashrc
```

---

## 5. Cloudflare DNS

Quyidagi misollarda domen — `nightshift-ai.studio` (hozir Vercel'da). Hamma
joyda u faqat `DOMAIN` orqali o'qiladi, boshqa domen bilan ham xuddi shunday
ishlaydi.

**Avval:** Cloudflare → `nightshift-ai.studio` → **DNS → Records** dagi hozirgi
Vercel yozuvlarini (odatda `@` uchun `A 76.76.21.21` yoki `CNAME
cname.vercel-dns.com`) **skrinshot qilib saqlang** — 11-bo'limda orqaga qaytish
uchun kerak.

> **Tavsiya — mashq:** sayt Vercel'da ishlab turganda uzilishsiz sinash uchun
> avval test subdomen bilan boshlang: `DOMAIN=new.nightshift-ai.studio`, DNS'da
> `new` nomli `A` yozuv. Hammasi ishlagach, `DOMAIN=nightshift-ai.studio` qilib
> `dc up -d` va asosiy yozuvni pastdagidek o'zgartiring.

1. `@` (ya'ni `nightshift-ai.studio` ning o'zi) yozuvini **Edit** qiling
   (Vercel'ning `CNAME` yozuvi bo'lsa — o'chirib, yangisini qo'shing):
   - **Type:** `A`
   - **Name:** `@`
   - **IPv4 address:** `SERVER_IP`
   - **Proxy status:** avval **DNS only** (kulrang bulut). Sabab: Caddy birinchi
     sertifikatni to'g'ridan-to'g'ri olsin; 8-qadamda Proxied'ga o'tkazamiz.

   Shu paytdan boshlab trafik serverga keladi — shuning uchun bu qadamni 6–7
   qadamlar tayyor bo'lganda (yoki darhol ketma-ket) bajaring; Caddy
   sertifikatni odatda bir daqiqada oladi.
   `www.nightshift-ai.studio` kerak bo'lsa, Cloudflare **Rules → Redirect
   Rules** orqali asosiy domenga yo'naltiring (Caddy faqat `DOMAIN` ni xizmat qiladi).
2. **SSL/TLS → Overview** → rejim: **Full (strict)**.
   - *Flexible* ni **tanlamang**: Cloudflare serverga oddiy HTTP bilan ulanadi,
     Caddy esa HTTPS'ga yo'naltiradi — cheksiz redirect bo'ladi.
   - *Full (strict)* Caddy'ning haqiqiy Let's Encrypt sertifikatini tekshiradi.
3. **SSL/TLS → Edge Certificates** → **Always Use HTTPS**: **Off**. HTTPS'ga
   yo'naltirishni Caddy o'zi qiladi va sertifikat yangilash uchun kerakli
   `/.well-known/acme-challenge/` yo'lini ochiq qoldiradi.

---

## 6. `/opt/nightshift/.env.web` faylini yaratish

```bash
install -m 600 /opt/nightshift/app/deploy/.env.web.example /opt/nightshift/.env.web
nano /opt/nightshift/.env.web
```

Har bir qatorni to'ldiring (qiymatlarni Vercel'dagi bilan bir xil qiling).
Saqlash: `Ctrl+O`, `Enter`, chiqish: `Ctrl+X`. Fayl git repozitoriyasidan
**tashqarida** turadi — `git pull` uni hech qachon o'zgartirmaydi va commit
qilib bo'lmaydi.

Command Center kodda o'qiydigan **barcha** o'zgaruvchilar (kod bilan mosligini
`tests/test_deploy_self_host.py` tekshirib turadi):

| O'zgaruvchi | Turi | Majburiymi | Qayerdan olinadi / nima qiladi |
|---|---|---|---|
| `DOMAIN` | compose | ha | Sayt nomi, masalan `nightshift-ai.studio` (`https://` va `/` siz). Caddy sertifikatni shu nomga oladi |
| `ACME_EMAIL` | compose | ha | Let's Encrypt ogohlantirishlari uchun email |
| `NEXT_PUBLIC_SUPABASE_URL` | **public** (build vaqtida) | ha | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **public** (build vaqtida) | ha | Supabase → Settings → API → `anon` `public` kalit. **service_role emas!** |
| `GITHUB_SECRETS_TOKEN` | server-only | yo'q | Fine-grained token, faqat bot repozitoriyasiga: Secrets, Variables, Actions → Read and write. Bo'sh = kalitlar qo'lda qo'shiladi |
| `GITHUB_SECRETS_REPO` | server-only | yo'q | Bot repozitoriyasi, `owner/repo` (Vercel'dagi qiymat) |
| `GITHUB_SECRETS_REF` | server-only | yo'q | "Run now" ishga tushiradigan branch. Bo'sh = `main` |
| `GOOGLE_OAUTH_CLIENT_ID` | server-only | yo'q | Google Cloud → Credentials → OAuth client (Web application) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | server-only | yo'q | O'sha OAuth client'ning secret'i |
| `SLACK_WEBHOOK_URL` | server-only | yo'q | Slack incoming webhook ("Send test" tugmasi uchun) |
| `APP_ORIGIN` | avtomatik | — | **Yozmang.** compose uni `https://${DOMAIN}` dan o'zi yasaydi. YouTube OAuth redirect manzili shundan quriladi |

- **public** — brauzerga yuboriladigan JavaScript ichiga *build vaqtida* yoziladi.
  Bu xavfsiz (anon kalit ochiq bo'lishi uchun mo'ljallangan, ma'lumotni RLS va
  login himoya qiladi), lekin qiymatni o'zgartirsangiz **qayta build** kerak
  (`dc up -d --build`).
- **server-only** — faqat server ichida, ishga tushganda o'qiladi; brauzerga
  hech qachon chiqmaydi, image'ga yozilmaydi. O'zgartirgandan keyin
  `dc up -d` kifoya.
- Qiymatlarda `$` belgisi bo'lmasin (compose uni o'zgaruvchi deb tushunadi);
  zarur bo'lsa `$$` deb yozing.

---

## 7. Ishga tushirish

```bash
cd /opt/nightshift/app
dc up -d --build
```

Birinchi build 3–5 daqiqa oladi. Holatni tekshirish:

```bash
dc ps                 # web: "healthy", caddy: "Up"
dc logs -f caddy      # "certificate obtained successfully" ni kuting, Ctrl+C
dc logs -f web
```

Brauzerda `https://nightshift-ai.studio` ni oching — login sahifasi chiqishi kerak.

---

## 8. Cloudflare proxy'ni yoqish

HTTPS ishlaganiga ishonch hosil qilgach:

1. Cloudflare → DNS → `@` yozuvi → **Edit** → Proxy status: **Proxied**
   (to'q sariq bulut) → Save.
2. SSL/TLS rejimi **Full (strict)** ekanini yana bir bor tekshiring.
3. Saytni qayta oching. Xato 526 chiqsa — SSL rejimi yoki Caddy sertifikati
   muammosi: `dc logs caddy` ni ko'ring.

Sertifikat yangilanishi (har ~60 kunda) Cloudflare orqali avtomatik ishlaydi,
agar **Always Use HTTPS** o'chiq bo'lsa (5-bo'lim).

---

## 9. Supabase va Google OAuth manzillarini tekshirish

Domen Vercel'dagi bilan bir xil (`nightshift-ai.studio`) bo'lsa, bu manzillar
odatda **allaqachon to'g'ri** — faqat tekshiring. Domen o'zgargan bo'lsa
(masalan, 5-bo'limdagi `new.` mashqida), yangisini **qo'shing**, eskisini
o'tish davrida qoldiring.

**Supabase** → Authentication → **URL Configuration**:

- **Site URL:** `https://nightshift-ai.studio`
- **Redirect URLs** ichida: `https://nightshift-ai.studio/**`

(Kirish email+parol bilan, lekin taklif va parolni tiklash xatlaridagi havolalar
Site URL'ga olib boradi.)

**Google Cloud Console** → APIs & Services → **Credentials** → Command Center
ishlatadigan OAuth 2.0 Client (Web application) → **Authorized redirect URIs**
ichida aynan shu bo'lsin:

```
https://nightshift-ai.studio/api/oauth/youtube/callback
```

Tekshirish: Command Center → Providers → **Connect YouTube** — Google rozilik
oynasi chiqib, qaytgach "connected" ko'rinishi kerak. (Serverda bu manzil
`APP_ORIGIN` dan quriladi; u `DOMAIN` dan avtomatik olinadi.)

---

## 10. Yangilash (yangi versiyani chiqarish)

```bash
cd /opt/nightshift/app
git pull --ff-only
dc up -d --build
docker image prune -f        # eski image'larni tozalash
```

Yangi image build bo'lguncha eski konteyner ishlab turadi; almashish bir necha
soniya oladi.

**Server ichida oldingi versiyaga qaytish:**

```bash
cd /opt/nightshift/app
git log --oneline -5                 # qaytmoqchi bo'lgan commit'ni toping
git checkout <commit>
dc up -d --build
# tuzatish main'ga tushgach:  git checkout main && git pull --ff-only && dc up -d --build
```

---

## 11. Vercel'ga qaytish (favqulodda holat)

Vercel loyihasi o'chirilmagan bo'lsa, u hali ham `*.vercel.app` manzilida
ishlaydi. Esda tuting: Hobby tarifi tijoriy foydalanishga ruxsat bermaydi —
bu faqat vaqtinchalik chora.

1. Vercel → Project → Settings → **Domains** da `nightshift-ai.studio` hali
   turganini tekshiring (o'chirilgan bo'lsa — qayta qo'shing). Cloudflare'da `@`
   yozuvini 5-bo'limda saqlagan Vercel qiymatiga qaytaring (Vercel ko'rsatgan
   yozuv, apex uchun odatda `A 76.76.21.21`), Proxy status: **DNS only**.
2. Vercel'dagi Environment Variables hali ham to'g'ri ekanini tekshiring
   (`APP_ORIGIN` Vercel'da **kerak emas** — u yerda so'rovning o'z manzili ishlatiladi).
3. Supabase Redirect URLs va Google redirect URI'da Vercel manzili borligini tekshiring.
4. Serverda: `dc down` (ixtiyoriy — worker ishlayotgan bo'lsa, faqat `dc stop web caddy`).

---

## 12. Backup — nimani saqlash kerak

| Nima | Qayerda | Qanday |
|---|---|---|
| Ma'lumotlar bazasi, Auth, Storage | Supabase (managed) | Supabase o'zi boshqaradi. Bepul tarifda avtomatik backup cheklangan — Supabase → Database → Backups'da tarifingizni tekshiring; muhim bo'lsa kompyuteringizdan davriy `supabase db dump` qiling |
| `/opt/nightshift/.env.web` | Server | Nusxasini **parol menejeriga** saqlang (shifrlangan). Git'ga, oddiy bulutga, chatga — **yo'q** |
| Caddy sertifikatlari (`nightshift_caddy_data` volume) | Server | Pastdagi buyruq. Yo'qolsa Caddy qayta oladi, lekin tez-tez qayta olish Let's Encrypt limitiga uriladi |
| Kod | GitHub | Allaqachon saqlangan |

Caddy volume backup:

```bash
mkdir -p /opt/nightshift/backup
docker run --rm -v nightshift_caddy_data:/data:ro -v /opt/nightshift/backup:/backup \
  caddy:2 tar czf /backup/caddy_data-$(date +%F).tar.gz -C /data .
```

Tiklash (yangi serverda, `dc up` dan oldin):

```bash
docker volume create nightshift_caddy_data
docker run --rm -v nightshift_caddy_data:/data -v /opt/nightshift/backup:/backup \
  caddy:2 tar xzf /backup/caddy_data-YYYY-MM-DD.tar.gz -C /data
```

RAID1 disk buzilishidan himoya qiladi, lekin o'chirib yuborilgan fayl yoki
buzilgan serverdan emas — backup'ni serverdan **tashqarida** ham saqlang
(masalan, Hetzner Storage Box yoki o'z kompyuteringiz).

---

## 13. Tez-tez uchraydigan muammolar

| Belgisi | Sababi / yechimi |
|---|---|
| `dc up` "set DOMAIN in the env file" deydi | `.env.web` da `DOMAIN` (yoki boshqa majburiy qiymat) bo'sh |
| Sayt "NOT CONFIGURED" ko'rsatadi | `NEXT_PUBLIC_SUPABASE_*` bo'sh bo'lgan holda build qilingan. To'ldiring va `dc up -d --build` |
| Cloudflare 526 | SSL rejimi Full (strict), lekin Caddy hali sertifikat olmagan: proxy'ni vaqtincha DNS only qiling, `dc logs caddy` |
| Cheksiz redirect | Cloudflare SSL rejimi *Flexible* — *Full (strict)* ga o'zgartiring |
| Google "redirect_uri_mismatch" | 9-bo'limdagi URI aniq shu ko'rinishda qo'shilmagan (`https://`, oxirida `/` yo'q) |
| SSH "Permission denied (publickey)" | Kalit noto'g'ri yoki boshqa foydalanuvchi: `ssh nightshift@SERVER_IP`. Qulflanib qolsangiz: Robot → Rescue → reset, disk'ni mount qilib `authorized_keys` ni tuzating |
| web "unhealthy" | `dc logs web` — odatda env xatosi |

Port 3000 tashqariga **ochilmagan** — bu ataylab: Docker ochgan portlar ufw'ni
chetlab o'tadi, shuning uchun faqat Caddy (80/443) internetga qaraydi.
