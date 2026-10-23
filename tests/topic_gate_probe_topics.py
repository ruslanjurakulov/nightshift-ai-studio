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


# ---------------------------------------------------------------------------
# Added with the medical-claim / live-case rules (GATE_VERSION 2026-10-22.3).
#
# MUST_PASS    the topics the rules were told never to touch: a history channel makes
#              all of these. A hold on any of them is a wrong hold.
# LEGIT_MORE   further legitimate history / mystery / archaeology / medical-history /
#              famous-trial topics, written BEFORE the rules, deliberately full of the
#              words the rules key on (trial, suspect, cure, vaccine, cancer, health,
#              engagement, diagnosis, a Capitalised name pair). Same bar as LEGIT.
# HELD_MEDICAL_LIVE   the gaps this change closes: held from EVERY source, "ai" included.
# PRE_EXISTING_WRONG_HOLDS   legitimate topics in LEGIT_MORE that the gate already held BEFORE this
#              change (measured on origin/main) and this change does not touch. Not a goal:
#              recorded so the bar is "no NEW wrong hold", exactly.
# SKIPPED_BY_DESIGN   legitimate-looking topics the new rules DO hold: a skipped topic is
#              the cost of a rule that cannot tell a dead name from a live one by words.
#              Pinned so the cost stays visible and does not grow unseen.
# ---------------------------------------------------------------------------

MUST_PASS = [
    "Roanoke", "Stonehenge", "Voynich manuscript decoded", "Jack the Ripper suspects", "Zodiac killer cipher",
    "Tutankhamun's curse", "Ancient Aliens debunked", "Salem witch trials 1692",
    "Joan of Arc accused of heresy 1431", "The trial of Socrates", "Ancient Egyptian medicine and mummification",
    "Hippocrates and the origins of medicine", "The Plague of Athens", "The Black Death in 1348",
    "Roman surgery tools found at Pompeii", "Spanish flu 1918", "Madeleine of Valois",
    "The Lindbergh kidnapping trial 1935", "Lizzie Borden",
]

HELD_MEDICAL_LIVE = [
    # A: a medical claim dressed as ancient history
    "Ancient remedy for COVID-19", "Cure for cancer found in ancient herb", "Miracle cure from ancient Egypt",
    "Vaccines cause autism ancient proof",
    # B: current cases about living people or an event still unfolding
    "Lori Vallow trial", "Luigi Mangione trial", "Kanye West antisemitism", "King Charles cancer diagnosis",
    "Joe Biden health secrets", "Taylor Swift Travis Kelce engagement", "Today's crash of a Boeing plane",
    "Charlie Kirk shooting suspect", "Madeleine McCann new suspect",
]

PRE_EXISTING_WRONG_HOLDS = [
    "The Kidnapping of the Lindbergh Baby",                 # minor: "baby" + "kidnapping"
    "The Cure for Scurvy: James Lind's Experiment",         # "cure for" with no era word or year
    "The Cure for Scurvy in the Age of Sail",
    "The Miracle Cure of Lourdes in 1858",                  # "Miracle Cure" reads as a name, so the year does not anchor it
    "Snake Oil: the history of miracle cures",
    "The Radium Craze: miracle cures of 1925",
    "Prime Minister Neville Chamberlain and Munich 1938",   # off_niche: politics words, no history term
]

SKIPPED_BY_DESIGN = [
    # a name pair beside trial / suspect / diagnosis / health secrets, no year, no old-case sign
    "Alger Hiss trial", "Ted Bundy trial", "Frida Kahlo health secrets", "Harold Shipman suspect list",
    # a strong claim word beside a medical term in an era-anchored topic, no history-of-medicine frame
    "Medieval cure for cancer", "Medieval cancer cure that actually worked",
]

# Second round (GATE_VERSION 2026-10-22.4), from an independent review of the first.
# Every one of these was newly held by the first round and must pass.
REVIEW_PASS_TODAY = [
    "Lisbon 1755 earthquake: what today's science says",
    "Today's seismologists on the earthquake that destroyed Lisbon in 1755",
    "Pompeii: today's volcanologists on the eruption and tsunami",
    "Today's engineers on the Tay Bridge collapse of 1879",
    "Halifax explosion 1917: what today's records show",
    "What today's archaeologists found at the Roman massacre site",
    "This morning in history: the Hindenburg crash",
]
REVIEW_PASS_NAMES = [
    "Tokyo Trials", "Marie Antoinette trial", "King Louis XVI trial and execution", "King Charles I trial and execution",
    "Pope Formosus trial", "Cadaver Synod: the trial of a dead pope", "Madeleine Smith trial", "Florence Maybrick trial",
    "Ned Kelly trial", "Wyatt Earp trial", "Boston Massacre trial", "Boston Massacre shooting", "Wounded Knee shooting",
    "Typhoid Mary trial", "Radium Girls trial", "Triangle Shirtwaist fire trial", "James Lind scurvy trial",
    "Harem Conspiracy trial of Ramesses III", "Guy Fawkes trial", "Gunpowder Plot suspect", "Thomas More trial",
    "Giordano Bruno trial", "Catherine Howard trial", "Lady Jane Grey trial", "Walter Raleigh trial", "King John trial",
    "Thomas Becket trial", "King Richard III trial", "Queen Boudica's trial", "William Rufus shooting",
    "Saint Valentine's Day massacre suspect", "Akhenaten Marfan syndrome diagnosis", "King George III porphyria diagnosis",
    "Mary Tudor false pregnancy", "Queen Anne health and the seventeen pregnancies", "Hitler's Parkinson's diagnosis",
    "Charles Darwin illness diagnosis", "Van Gogh's shooting", "Jane Austen's diagnosis",
]
REVIEW_PASS_MEDICAL = [
    "Ancient Egyptian cancer treatment", "Ancient Roman diabetes treatment", "Ancient Greek remedy for depression",
    "Ancient Egyptian remedy for tumors", "Bronze Age cancer treatment", "Medieval treatment of heart disease",
    "Renaissance cancer treatment", "Ancient diabetes treatment by Sushruta", "Medieval diabetes treatment by Avicenna",
    "The cause of cancer in ancient Egypt", "Pharaohs and the cause of cancer", "Ancient treatment for depression",
]
# Names a living person shares with an old case: the old-case entry is the SAME name in full, so these stay held.
REVIEW_HOLD_COLLISIONS = [
    "Victoria Beckham trial", "Deontay Wilder trial", "Gene Wilder trial", "Reed Hastings trial",
    "Victoria Justice engagement",
]
# The reviewer's bad set, plus the live cases: must stay held.
REVIEW_HOLD_BAD = [
    "Ancient cure for COVID that doctors hide", "Pharaohs knew the cancer cure", "Roman herb cures diabetes",
    "Vaccines were invented by ancient Egyptians and cause autism", "Luigi Mangione trial", "Lori Vallow trial",
    "Joe Biden health secrets", "King Charles cancer diagnosis", "Kate Middleton cancer diagnosis",
    "King Charles III cancer diagnosis", "Dr. Harold Shipman trial", "Sir Keir Starmer trial", "Charlie Kirk shooting",
    "Yesterday's plane crash near the airport", "Lori Vallow conspiracy trial",
]

LEGIT_MORE = [  # includes PRE_EXISTING_WRONG_HOLDS
    # famous trials and cases, mostly with the exact words the live-case rule keys on
    "The Scopes Monkey Trial", "Lizzie Borden trial", "The Lizzie Borden axe murders",
    "The Lindbergh Kidnapping Trial", "Sacco and Vanzetti trial", "The Trial of Galileo",
    "Oscar Wilde trial 1895", "The Nuremberg Trials", "The Dreyfus Affair", "The Tokyo Trials",
    "The trial of Charles I in 1649", "The Boston Massacre trial of 1770", "The trial of Mary Queen of Scots",
    "The Trial of Joan of Arc", "The Pendle witch trials of 1612", "The Salem Witch Trials", "The Witch Trials of Würzburg",
    "The trial of Warren Hastings 1788", "The Trial of the Templars", "The Trial of Jesus", "The Moscow Trials of 1936",
    "The Trial of Anne Boleyn", "Marie Antoinette trial 1793", "The Trial of Louis XVI", "The trial of Socrates: what the sources say",
    "The Cadaver Synod: the trial of a dead pope", "The Rosenberg trial 1951", "The Mary Surratt trial 1865",
    "Al Capone trial 1931", "Machiavelli on trial", "The trial of Billy the Kid", "The Gunfight at the OK Corral inquest",
    "The Tichborne Claimant trial", "The Great Train Robbery of 1963", "The Trial of William Wallace 1305",
    # suspects and cold cases from before and after 1945
    "Jack the Ripper suspect Aaron Kosminski", "Jack the Ripper: the Whitechapel suspects", "The Zodiac Killer suspects",
    "Zodiac Killer suspect Arthur Leigh Allen", "The Black Dahlia suspect George Hodel",
    "The Black Dahlia Murder", "The Cleveland Torso Murders", "The Axeman of New Orleans", "H. H. Holmes and the Murder Castle",
    "The Mad Gasser of Mattoon", "The Boston Strangler", "The Lord Lucan Disappearance", "D. B. Cooper hijacking 1971",
    "The Disappearance of Jimmy Hoffa", "The Murder of Elizabeth Short", "The Tylenol Murders",
    "The Somerton Man mystery", "The Taman Shud case", "The Isdal Woman", "The Man from Taured", "The Dyatlov Pass suspects",
    "Who Killed the Princes in the Tower", "The suspects in the murder of Archduke Franz Ferdinand",
    "The Hope Diamond curse", "The Piltdown Man hoax", "The Cardiff Giant", "The Shroud of Turin: what the tests found",
    "The Man in the Iron Mask", "The Lost Dauphin", "The Anastasia Mystery", "The Mystery of Kaspar Hauser",
    "The Mystery of the Mary Rose", "The Mystery of the Sodder Children", "The Disappearance of Percy Fawcett",
    "The Disappearance of the Eilean Mor Lighthouse Keepers", "The Vanishing of Flight 19",
    "The Disappearance of Glenn Miller 1944", "The Mystery of Ambrose Bierce", "The Disappearance of Agatha Christie 1926",
    "The Kidnapping of the Lindbergh Baby", "The Hindenburg Disaster", "The Tay Bridge Disaster", "The Halifax Explosion 1917",
    "The St. Francis Dam collapse of 1928", "The Great Molasses Flood of 1919", "The Eruption of Krakatoa in 1883",
    "The Johnstown Flood of 1889", "The Great Chicago Fire of 1871", "The Lisbon Earthquake of 1755",
    "The Crash of the Hindenburg", "The Wall Street Crash of 1929", "The Tunguska Explosion of 1908", "The Titanic Inquiry",
    "The Lusitania Sinking", "The Empress of Ireland Sinking", "The Collapse of the Tacoma Narrows Bridge 1940",
    # medicine and disease as a SUBJECT of history
    "Ancient Egyptian Medicine and the Ebers Papyrus", "Ancient Roman Surgery", "Medieval Medicine: Doctors, Barbers and Leeches",
    "Edward Jenner and the Smallpox Vaccine", "The History of the Smallpox Vaccine", "The Discovery of Penicillin",
    "Louis Pasteur and the Rabies Vaccine 1885", "John Snow and the Broad Street Cholera Pump", "Ignaz Semmelweis and Handwashing",
    "The Cure for Scurvy: James Lind's Experiment", "The Cure for Scurvy in the Age of Sail", "Cancer in Ancient Egyptian Mummies",
    "Tuberculosis in Ancient Egypt", "Leprosy in Medieval Europe", "The Cure for the Plague in 1348: what doctors tried",
    "The Miracle Cure of Lourdes in 1858", "Snake Oil: the history of miracle cures", "Quack Doctors of the Victorian Era",
    "Radium Girls and the radium cures of the 1920s", "The Radium Craze: miracle cures of 1925", "Mercury cures for syphilis in the 1500s",
    "How Hippocrates Treated Epilepsy", "Galen and the Antonine Plague", "The Antonine Plague", "The Plague of Justinian",
    "The Great Plague of London 1665", "The Black Death in Florence 1348", "The Spanish Flu of 1918", "The Dancing Plague of 1518",
    "The Sweating Sickness of Tudor England", "The Smallpox Epidemic of 1721", "The Cholera Epidemic of 1854",
    "Did the Black Death Cause the Renaissance", "What Caused the Plague of Athens", "What Caused the Fall of Rome",
    "What Caused the Bronze Age Collapse", "What Caused the Great Fire of London", "Did Lead Poisoning Cause the Fall of Rome",
    "Did a Vaccine Save Napoleon's Army", "Napoleon's Stomach Cancer: what the autopsy showed", "Napoleon's Health at Waterloo",
    "Julius Caesar's Epilepsy: fact or myth", "King Tut's Death: malaria or a broken leg", "King Tutankhamun's DNA Tests",
    "Richard III's Skeleton Found in a Car Park", "The Death of Alexander the Great: poison or typhoid", "How Did Cleopatra Die",
    "Beethoven's Hair and Lead Poisoning", "The Death of Mozart: new theories", "The Madness of King George III",
    "The Illness of Abraham Lincoln", "The Insanity of Caligula", "The Poisoning of Napoleon on Saint Helena",
    "Paracelsus and the Birth of Modern Medicine", "The Edwin Smith Papyrus", "Surgery Without Anaesthetic in the 1800s",
    "The Discovery of Anaesthesia: ether in 1846", "The First Heart Surgery 1896", "Florence Nightingale and the Crimean War hospitals",
    # engagement, health, diagnosis, antisemitism and shooting as HISTORY words
    "The Engagement of Napoleon and Josephine", "Henry VIII's Engagement to Anne of Cleves", "The Royal Engagement of 1840",
    "Queen Victoria's Engagement to Albert", "The Battle of Trafalgar: the engagement in detail", "The naval engagement at Jutland 1916",
    "The Assassination of Abraham Lincoln: the shooting at Ford's Theatre", "The Shooting of Archduke Franz Ferdinand",
    "The Dreyfus Affair and French antisemitism in 1894", "Antisemitism in Medieval England: the expulsion of 1290",
    "Henry VIII's health: the jousting accident of 1536", "The King's Evil: royal healing in Medieval England",
    "King Charles I and the English Civil War", "King Charles II and the Great Fire of London", "King Henry VIII's Tudor Court",
    "Queen Elizabeth I and the Spanish Armada", "Prince Rupert and the Cavaliers", "Pope Gregory and the Cadaver Synod",
    "Prime Minister Neville Chamberlain and Munich 1938", "President Lincoln and the Civil War",
    # archaeology, ancient mysteries, lost places, objects
    "The Antikythera Shipwreck", "The Sutton Hoo Treasure", "The Terracotta Army of Qin Shi Huang", "Gobekli Tepe and the first temple",
    "The Dead Sea Scrolls", "The Lewis Chessmen", "The Staffordshire Hoard", "The Nazca Lines", "Easter Island and the Moai",
    "Machu Picchu: the lost city of the Incas", "The Lost City of Z", "The Lost Library of Alexandria", "The Ark of the Covenant",
    "The Holy Grail legend", "The Spear of Destiny", "The Lost Legion of Carrhae", "The Lost Roman Ninth Legion",
    "The Mystery of the Sea Peoples", "The Hanging Gardens of Babylon", "The Tomb of Qin Shi Huang", "The Tomb of Genghis Khan",
    "The Tomb of Alexander the Great", "The Curse of the Pharaohs", "The Valley of the Kings", "The Bog Bodies of Northern Europe",
    "Otzi the Iceman", "The Mystery of the Indus Valley Script", "Linear A: the undeciphered script", "The Phaistos Disc",
    "The Rongorongo Script", "The Codex Gigas", "The Beale Ciphers", "The Kensington Runestone", "The Piri Reis Map",
    "The Vinland Map", "The Dighton Rock", "The Burrows Cave hoax", "The Mystery of Great Zimbabwe", "The Mystery of Angkor Wat",
    "The Terror of the Sea Peoples", "Skara Brae: the Neolithic village", "Newgrange and the winter solstice", "The Hypogeum of Malta",
    "Derinkuyu: the underground city", "Petra and the Nabataeans", "Pompeii and Herculaneum", "The Eruption of Vesuvius in AD 79",
    "The Minoan Eruption of Thera", "The Fall of Constantinople", "The Siege of Masada", "The Siege of Troy: myth or fact",
    "The Battle of Thermopylae", "The Charge of the Light Brigade", "The Battle of Hastings 1066", "The Lost Colony of Roanoke",
    "The Mystery of Cahokia", "The Mystery of Chaco Canyon", "The Anasazi Disappearance", "The Mystery of the Mayan Collapse",
    "The Mary Celeste Mystery", "The Octavia Ghost Ship", "The Flying Dutchman legend", "The Kingdom of Prester John",
    "The Mystery of the Princes in the Tower", "The Death of Edward II", "The Murder of Thomas Becket", "The Gunpowder Plot",
    "The Mystery of the Man in the Iron Mask", "The Affair of the Poisons", "The Diamond Necklace Affair",
    # russian / uzbek sprinkles
    "Дело Дрейфуса: суд 1894 года", "Суд над Сократом", "Чума в Лондоне 1665 года", "Эпидемия испанки 1918 года",
    "Лекарство от чумы в Средние века", "Расстрел царской семьи: что известно", "Тайна гибели Пушкина", "Суд над Жанной д'Арк",
    "Qadimgi Misr tabobati", "Qora o'lim: 1348 yilgi vabo", "Sokrat sudi", "Ispan grippi 1918 yil", "Jeanna d'Ark sudi 1431 yil",
]

# Written AFTER the second round's tables were fixed, from nobody's list: legitimate old
# "<Name> trial / diagnosis / shooting / pregnancy" topics with no year and no era word, to
# measure what the tables do NOT cover. Many are held (a name beside a case word, nothing
# to say it is old). The test pins the count so it cannot grow unseen; it is the measured
# cost of a rule that cannot tell a dead name from a live one by words.
HELD_OUT_OLD_CASES = [
    "Anne Hutchinson trial", "Nathan Hale trial", "Aaron Burr trial", "John Brown trial", "Nat Turner trial",
    "Dred Scott trial", "Susan B. Anthony trial", "Emile Zola trial", "Jacques de Molay trial", "Gilles de Rais trial",
    "William Wallace trial", "Anne Askew trial", "Thomas Cromwell trial", "Mata Hari trial", "Roger Casement trial",
    "Edith Cavell trial", "Eugene Debs trial", "Emma Goldman trial", "Leopold Loeb trial", "Harry Thaw trial",
    "Roscoe Arbuckle trial", "Leo Frank trial", "Bruno Hauptmann trial", "Sophie Scholl trial", "Anne Frank diagnosis",
    "Abraham Lincoln Marfan diagnosis", "Isaac Newton mercury poisoning diagnosis", "Nikola Tesla OCD diagnosis",
    "Ludwig Beethoven deafness diagnosis", "Wolfgang Mozart kidney diagnosis", "Friedrich Nietzsche madness diagnosis",
    "Elizabeth Woodville pregnancy", "Catherine Parr pregnancy", "Anne Neville pregnancy", "Jane Seymour pregnancy",
    "Abraham Lincoln shooting", "James Garfield shooting", "Alexander Hamilton shooting", "Andrew Jackson shooting",
    "William McKinley shooting", "Jesse James shooting", "Billy Kid shooting", "Doc Holliday shooting",
    "Harry Houdini trial", "Marcus Garvey trial", "Joe Hill trial", "Tom Mooney trial", "Mary Surratt suspect",
    "Lee Oswald suspect", "Sirhan Sirhan trial", "Jack Ruby trial", "James Earl Ray suspect", "Charles Manson trial",
]
