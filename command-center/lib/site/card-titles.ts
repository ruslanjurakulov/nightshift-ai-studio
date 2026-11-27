/**
 * Each model sample's card title, by job id, in every language of the site: a short noun phrase (at most CARD_TITLE_MAX
 * characters) naming what the picture or clip shows, written by hand from the sample's prompt and its poster, never more than the
 * media holds. It is the bold line of the card's caption (components/site/media-card.css) when the sample shows no format.
 *
 * Why by hand and not cut from the prompt: a cut prompt read as half an English sentence on every card, on the Russian and Uzbek
 * pages too (Pixel, 22 Nov). The prompt's first sentence stays under it as the grey line, marked lang="en", because it is the
 * real prompt. tests/site-media-cards.test.tsx fails when a sample in lib/site/showcase.json has no title here in all three
 * languages, when one is too long, or when one names a model or a maker (owner decision 22 Nov: no model name on public cards).
 * Uzbek uses ʻ (U+02BB) in oʻ / gʻ and ʼ (U+02BC) for the tutuq belgisi.
 */
import type { Locale } from "@/lib/i18n/core";

export const CARD_TITLE_MAX = 32;

export const CARD_TITLES: Readonly<Record<string, Readonly<Record<Locale, string>>>> = {
  "495ebf91-84df-4c76-a6c4-a3ca6e4eb82d": { en: "Portrait in a sunflower field", ru: "Портрет в поле подсолнухов", uz: "Kungaboqar dalasidagi portret" },
  "a04d5d55-27ef-4cae-95a2-25488503829e": { en: "Giant sneaker on a wet crosswalk", ru: "Гигантский кед на переходе", uz: "Yomgʻirli yoʻlda ulkan krossovka" },
  "f00c9666-0906-40cc-90d2-dd69680d5077": { en: "Ancient harbour market at dawn", ru: "Древний рынок в гавани", uz: "Qadimiy bandargoh bozori" },
  "bf349995-6836-47fe-9481-a433b4fccb04": { en: "Knife slicing a ruby glass cake", ru: "Нож режет торт из стекла", uz: "Shisha tortni kesayotgan pichoq" },
  "826322ba-3ac9-4030-bc19-367b5ae1277a": { en: "Raccoons on a backyard slide", ru: "Еноты катаются с горки", uz: "Sirpanchiqdagi yenotlar" },
  "0e7b89cb-282b-43b8-8777-55001b398f67": { en: "Lemon and avocado in the fridge", ru: "Лимон и авокадо в холодильнике", uz: "Muzlatkichdagi limon va avokado" },
  "5778bf5a-f751-472b-bbc0-c59b10567d32": { en: "Tiny chefs cooking breakfast", ru: "Крошечные повара на сковороде", uz: "Tovadagi mitti oshpazlar" },
  "de53f364-eaf7-4cd1-8d44-7b56b21b03b6": { en: "Whale gliding over a city", ru: "Кит плывёт над городом", uz: "Shahar uzra suzayotgan kit" },
  "f92a89ed-2145-4342-acd5-f24b8805a0f9": { en: "Sneaker bursting into neon paint", ru: "Кроссовок взрывается краской", uz: "Neon boʻyoqqa aylangan krossovka" },
  "01c9f1f0-d54b-4fd3-a88f-ddf459aece73": { en: "Neon city inside a snow globe", ru: "Неоновый город в снежном шаре", uz: "Qor sharidagi neon shahar" },
  "b72e18cd-d9e5-4535-9fea-f24fbd8c3fd9": { en: "Giant golden retriever in town", ru: "Гигантский ретривер в городе", uz: "Shahardagi ulkan retriver" },
  "a6768488-04c6-4325-9465-62d61f888a70": { en: "Molten chocolate becomes a rose", ru: "Шоколадная роза распускается", uz: "Shokoladdan ochilgan atirgul" },
  "9a52ebf1-bbe3-473c-b77c-7553bc18e0d8": { en: "Flight over a sea of clouds", ru: "Полёт над морем облаков", uz: "Bulutlar dengizi uzra parvoz" },
  "ab0bcba2-8374-465d-b505-8dac19977948": { en: "Camper van on a cliff road", ru: "Фургон на прибрежной дороге", uz: "Qirgʻoq yoʻlidagi furgon" },
  "fc1fad12-16de-4cd5-9cd9-e77ed245f469": { en: "Perfume in a spiral of water", ru: "Флакон духов в спирали воды", uz: "Suv girdobidagi atir shishasi" },
  "ab7cc0e2-8040-4643-8e14-74219fc1d8e2": { en: "Storm waves at a lighthouse", ru: "Шторм у маяка", uz: "Mayoq yonidagi boʻron" },
  "e3da9148-f2f8-443e-95b1-8ed36ef3dea4": { en: "Amber perfume on wet stone", ru: "Янтарный флакон на мокром камне", uz: "Hoʻl toshdagi qahrabo atir" },
  "28f164dc-809f-49a3-b2e2-ef0bdf88519b": { en: "Retro robot with a clapperboard", ru: "Ретро-робот с хлопушкой", uz: "Xlopushka tutgan retro robot" },
  "f17146fd-054c-4970-9dac-f7a0dc929bd6": { en: "Lighthouse and a breaking wave", ru: "Маяк и разбивающаяся волна", uz: "Mayoq va urilayotgan toʻlqin" },
  "1b3d5f4b-f4f2-4e92-84db-77908a36df2a": { en: "Evening street market", ru: "Вечерний уличный рынок", uz: "Kechki koʻcha bozori" },
  "639bbde5-dc70-4954-b71d-54db6a5b3ea9": { en: "Misty hills at sunrise", ru: "Холмы в тумане на рассвете", uz: "Tongdagi tumanli tepaliklar" },
  "1504b313-3a3c-4e78-bfda-5bca3ef7f3da": { en: "Neon city in the rain at night", ru: "Неоновый город под дождём", uz: "Yomgʻirli tungi neon shahar" },
  "64a7c2b8-a6c1-4359-9961-a1a2760f1cbf": { en: "Full moon behind a lone tree", ru: "Луна за одиноким деревом", uz: "Yolgʻiz daraxt ortidagi oy" },
  "38c427b0-c41b-4d16-86ca-14dc2e69ec27": { en: "Sand dunes at golden hour", ru: "Барханы в золотом свете", uz: "Oltin nurdagi qum barxanlari" },
  "9699e7fd-74a6-4d9e-8dcd-9dc88deec1d9": { en: "Doodle dragon flies off the page", ru: "Нарисованный дракон оживает", uz: "Daftardan uchib chiqqan ajdarcha" },
  "c7f8bb97-4725-4878-87a0-17d0b27027a6": { en: "Pink sports car melting", ru: "Розовый спорткар тает", uz: "Erib ketayotgan pushti avtomobil" },
  "d91578df-1084-4d2e-9273-bf52bd966118": { en: "Soda can bursting out of ice", ru: "Банка газировки во льду", uz: "Muzdan chiqqan ichimlik bankasi" },
  "c2733488-980e-4a20-9a58-28401bbee8c4": { en: "Cat DJ at a rooftop party", ru: "Кот-диджей на вечеринке", uz: "Tomdagi bazmda DJ mushuk" },
  "fcdba478-1a92-497d-adbb-1d2c9701e806": { en: "A city folding out of paper", ru: "Город, сложенный из бумаги", uz: "Qogʻozdan yasalgan shahar" },
  "f3583fdc-25c4-42cb-96ce-1d92d80cbf68": { en: "Tiny workers fixing a phone", ru: "Крошечные рабочие чинят экран", uz: "Ekran tuzatayotgan mitti ustalar" },
  "c62d40e7-b1b5-4ba4-8bc9-487f9ef7382e": { en: "Thunderstorm in a glass jar", ru: "Гроза в стеклянной банке", uz: "Shisha bankadagi momaqaldiroq" },
  "7ee6f783-7c3c-4265-ade8-88c64b674127": { en: "Headphones assembling in mid-air", ru: "Наушники собираются в воздухе", uz: "Havodagi quloqchin" },
  "4e85c7e4-fd1a-4771-97ee-66c1fb853367": { en: "From orbit to a street stall", ru: "Из космоса к уличной лавке", uz: "Koinotdan koʻcha rastasigacha" },
  "3069ec2f-2f68-40a8-bcbe-fc4c5f9111bc": { en: "Cold-brew coffee ad", ru: "Реклама холодного кофе", uz: "Sovuq qahva reklamasi" },
  "ced854a6-ba49-4668-b9dd-91ca46b72f6d": { en: "Explorer and a giant stone face", ru: "Путешественник и каменный лик", uz: "Sayyoh va ulkan tosh yuz" },
  "dcb96246-9379-4c3a-aa33-a8ee6bb7f846": { en: "Rain over a neon city", ru: "Дождь над неоновым городом", uz: "Neon shahar uzra yomgʻir" },
  "ec9a7c43-0304-4da7-943a-134a259e4f90": { en: "Giant ginger cat in the city", ru: "Огромный рыжий кот в городе", uz: "Shahardagi ulkan malla mushuk" },
  "dd553f69-beb4-4f89-9722-91ad95a9d2cc": { en: "Volcano inside a snow globe", ru: "Вулкан в снежном шаре", uz: "Qor sharidagi vulqon" },
  "9b0f23e8-e22b-4a27-b957-3aade8572fbd": { en: "Pink clay shaping itself", ru: "Розовая глина сама лепится", uz: "Oʻz-oʻzidan shakllanayotgan loy" },
  "6a94865b-ac2f-4b1f-b273-fd4b10c8c477": { en: "From orbit to an old town street", ru: "Из космоса в старый город", uz: "Koinotdan eski shahar koʻchasiga" },
  "9930ee16-a09b-4d55-aefe-5c2cb6f189de": { en: "Skateboarder frozen mid-jump", ru: "Скейтер замер в прыжке", uz: "Sakrashda qotgan skeytbordchi" },
  "99579363-b080-45b5-b1ed-06c712694042": { en: "Bicycle kick in a 2050 stadium", ru: "Удар через себя в 2050 году", uz: "2050-yilgi stadionda zarba" },
  "950e0667-4445-47c3-bbf4-3c681a22bb3c": { en: "Football final in the year 2050", ru: "Футбольный финал 2050 года", uz: "2050-yilgi futbol finali" },
  "e35f41fb-3162-4f9d-ae17-6420d558840d": { en: "Perfume bursting into droplets", ru: "Флакон рассыпается каплями", uz: "Tomchilarga sochilgan atir" },
  "49af4517-9ebf-44d9-80ed-f652cea6e071": { en: "Woman in a sunflower field", ru: "Девушка в поле подсолнухов", uz: "Kungaboqar dalasidagi ayol" },
  "cf2af7b1-5433-4661-979b-f65f3f8a4dbf": { en: "Watch wrapped in liquid chrome", ru: "Часы в ленте жидкого хрома", uz: "Suyuq xromga oʻralgan soat" },
};

/** A sample's title in this language, or null when it has none (a sample merged before its title was written). */
export function cardTitle(jobId: string, locale: Locale): string | null {
  return CARD_TITLES[jobId]?.[locale] ?? null;
}
