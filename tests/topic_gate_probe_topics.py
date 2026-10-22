"""Probe tables for tests/test_topic_gate.py: real-looking topics, each with the
answer a person would give. Data only (this file has no tests).

LEGIT   topics a history channel should be able to make. Any of them REJECTED by
        the gate is a false rejection; the table test allows none, because a
        wrongly rejected history topic is the cost the gate must not impose.
OFF     topics outside a history channel that the words alone must reject, from
        any source.
HELD    topics a person must decide (sensitive); rejected from any source.
ASKED   topics the words cannot place but that must NOT be waved through from a
        trend: the gate asks the model (or sets them aside), it never accepts them.
"""

LEGIT = [
    # English
    "Mary Celeste", "The Mary Celeste: what happened to the crew", "The Lost Colony of Roanoke",
    "Pompeii: the last day", "Why Rome fell", "The Antikythera Mechanism", "The Dyatlov Pass Incident",
    "The Hindenburg disaster of 1937", "The Sinking of the Titanic: Why It Really Went Down",
    "The Library of Alexandria: who burned it", "Stonehenge: who raised it", "The Voynich Manuscript Mystery",
    "The Bermuda Triangle: what the records show",
    "Jack the Ripper: the murders and the killer nobody could name",
    "The Hinterkaifeck Murders: a farm, six victims and a killer who stayed for days",
    "Challenger: what NASA knew", "The Zodiac Killer cipher", "The Black Dahlia: the murder nobody solved",
    "The Mystery of Amelia Earhart's Last Flight", "The Princes in the Tower", "The Great Fire of London",
    "The Tunguska Event", "The Salem Witch Trials of 1692", "The Children's Crusade of 1212",
    "The Missing Children of Hamelin", "The arrest of Joan of Arc in 1430", "Nuremberg trials explained",
    "The Nazca Lines: who drew them", "Gobekli Tepe: the oldest temple",
    "The Bronze Age Collapse: latest theories", "The Earthquake That Destroyed Pompeii: Latest Research",
    "The Collapse of the Bronze Age: What we know today", "Chernobyl 1986: the hours before the explosion",
    "The Assassination of Archduke Franz Ferdinand", "The Lost Treasure of the Knights Templar",
    "The Real Dracula: Vlad the Impaler", "The Death of Cleopatra: murder or suicide",
    "The Murder of Julius Caesar", "The Disappearance of the Roanoke Colonists",
    "The Mystery of the Flannan Isles Lighthouse", "The Oak Island Money Pit", "The Cottingley Fairies Hoax",
    "The Mongol Invasion of Europe", "How the Black Death changed Europe",
    "The Rosetta Stone and the race to decode it", "The Year Without a Summer, 1816",
    "The Apollo 13 Oxygen Tank Explosion", "The Tay Bridge Disaster of 1879", "Napoleon's exile on Elba",
    "Genghis Khan's tomb", "Alexander the Great and Babylon", "Cleopatra and Caesar",
    # Russian
    "Загадка Марии Селесты: что случилось с экипажем", "Помпеи: последний день города",
    "Исчезновение колонии Роанок", "Тайна древних пирамид", "Убийство Распутина: что скрывают архивы",
    "Убийство Кирова", "Чёрная Далия: убийство, которое не раскрыли", "Убийство Романовых: судьба Анастасии",
    "Смерть Мэрилин Монро: убийство или самоубийство", "Перевал Дятлова: что на самом деле случилось",
    "Тунгусский метеорит: взрыв над тайгой", "Падение Константинополя в 1453 году",
    "Таинственная гибель экспедиции Франклина", "Куликовская битва: правда и мифы",
    "Чернобыль 1986: часы перед взрывом", "Золото Колчака: куда исчезло", "Дело Тухачевского 1937",
    "Загадка Бермудского треугольника", "Тайна Атлантиды",
    # Uzbek
    "Pompeya shahri qanday halok bo'lgan", "Qadimgi Rim imperiyasi nega qulagan",
    "Amir Temur va Temuriylar saltanati", "Mary Celeste kemasining sirli yo'qolishi",
    "Roanoke koloniyasi qayerga yoʻqolgan", "Misr piramidalari sirlari", "Buyuk ipak yo'li tarixi",
    "Samarqand Registoni qurilishi tarixi", "Chingizxon imperiyasi qanday vujudga kelgan",
    "Merilin Monro o'limi: qotillikmi yoki o'z joniga qasd?", "Atlantida: yo'qolgan qit'a afsonasi",
    "Tutanxamon qabri la'nati", "Bermud uchburchagi sirlari", "Titanik halokati sabablari",
    "Xorazm xonligi tarixi",
]

OFF = [
    "RANABAALI Teaser - The Savage's Oath | Vijay Deverakonda | Rashmika Mandanna | Rahul Sankrityan",
    "RANABAALI Teaser 1080p", "Ranabaali Teаser", "Ranabaali Tea​ser",
    "Pushpa 2 Teaser | Allu Arjun | Rashmika Mandanna | Sukumar",
    "Dune Part Two trailer reaction", "Taylor Swift new album teaser", "Bollywood box office report",
    "Shah Rukh Khan net worth", "Top 10 celebrity feuds", "Movie trailer breakdown", "Red carpet looks",
    "IPL 2026 final highlights", "Bitcoin price prediction", "iPhone 18 review and unboxing",
    "Premier League transfer news", "Fortnite gameplay walkthrough", "Easy pasta recipe in 10 minutes",
    "Elections: what the prime minister said", "Stock market investing for beginners",
    "Тизер сериала: смотреть онлайн", "Трейлер нового фильма с участием знаменитостей",
    "Курс биткоина и крипты", "Футбол: обзор матча чемпионата", "Новости Болливуда",
    "Aktyor haqida yangi treyler", "Futbol chempionati sharhi", "Kripto va bitkoin narxi",
]

HELD = [
    "Roman Abramovich accused of fraud", "Roman Reigns arrested", "Minnesota Vikings coach sued for assault",
    "Salem police arrest teen", "Athens police arrest teenager", "Rome: 12-year-old missing, police say",
    "Mark Zuckerberg accused of fraud 1200", "Famous actor arrested after scandal",
    "Singer accused of fraud and her lawsuit", "Miracle cure for diabetes that doctors hide",
    "Earthquake today: death toll rises", "Flood in 2026 leaves thousands homeless",
    "The 14-year-old who vanished from school", "Mashhur aktyor hibsga olindi",
    "Известный человек обвинен в скандале", "Пропавший ребенок: что известно",
    "Does this vaccine cause cancer",
]

ASKED = [
    "Kim Kardashian visits Pompeii", "The dark history of Taylor Swift's 1989 album",
    "Dark History Behind Vijay Deverakonda's Ranabaali", "Vijay Deverakonda", "Taylor Swift",
    "The strange silence of the old lighthouse keepers",
]
