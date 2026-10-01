/**
 * The Style Library: hand-written art directions an organization can add with
 * one click. Content lives in code, not in the database — adding one copies
 * its name and description into an ordinary style kit (migration 0065), and
 * from there the kit reaches a generation exactly the way a kit made from
 * pictures does: creative_job_style reads the kit's description and
 * modules/creative_style.py appends it to the prompt as "Look: …". There is no
 * second path and no Python copy of this list, on purpose.
 *
 * WHAT A DESCRIPTION IS
 * Concrete visual vocabulary a model can act on — medium and material, named
 * colours, light, lens, texture, composition rules — and one closing sentence
 * that names what to avoid, always including the glossy, symmetrical,
 * over-saturated stock-AI look. It is a direction, not a promise: nothing here
 * claims what a model will produce.
 *
 * RULES (tests/style-library.test.ts holds them):
 *  - ids are stable forever (an organization's kit remembers its library id);
 *  - names and "good for" lines exist in en, ru and uz;
 *  - a description fits the style kit's own 2000-character limit (0047), and
 *    stays under DESCRIPTION_SOFT_MAX so a person's own prompt keeps room (the
 *    worker refuses a prompt the descriptions make longer than the model takes);
 *  - no brand or IP names, no living artist's name, no real person's likeness;
 *  - 3–5 tags, 3–5 swatch colours, at least one suggested aspect.
 *
 * Pure and client-safe: the page, the add route and the tests import it.
 */

import type { Locale } from "@/lib/i18n";
import { KIT_LIMITS } from "@/lib/style-kits";

export type Localized = Readonly<Record<Locale, string>>;

export const STYLE_TAGS = [
  "youtube-thumbnail",
  "shorts",
  "story",
  "product",
  "kids",
  "documentary",
  "music",
  "travel",
  "education",
  "history",
] as const;
export type StyleTag = (typeof STYLE_TAGS)[number];

/** The shapes a tile draws over the palette (components/styles/StyleTile). */
export const TILE_MOTIFS = ["grain", "halftone", "hatch", "grid", "lattice", "stars", "frames", "bands", "wash"] as const;
export type TileMotif = (typeof TILE_MOTIFS)[number];

export type LibraryAspect = "16:9" | "9:16" | "1:1";

export interface LibraryStyle {
  /** Stable, lower-case, hyphenated. Stored on the organization's kit (library_id). */
  id: string;
  name: Localized;
  goodFor: Localized;
  tags: readonly StyleTag[];
  /** English visual vocabulary, as it goes into a prompt. */
  description: string;
  /** 3–5 hex colours; the first is the tile's ground. */
  swatch: readonly string[];
  aspects: readonly LibraryAspect[];
  motif: TileMotif;
}

/** The style kit's own limit (0047 CHECK on style_kits.description). */
export const DESCRIPTION_HARD_MAX = KIT_LIMITS.descriptionMax;
/** Authoring ceiling: leaves room in a model's prompt for what the person types. */
export const DESCRIPTION_SOFT_MAX = 1200;
export const LIBRARY_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const L = (en: string, ru: string, uz: string): Localized => ({ en, ru, uz });

export const STYLE_LIBRARY: readonly LibraryStyle[] = [
  // ── Film and photo looks ──────────────────────────────────────────────
  {
    id: "night-street-16mm",
    name: L("16 mm night street", "Ночная улица на 16 мм", "16 mm plyonkada tungi ko'cha"),
    goodFor: L(
      "Moody city stories, music videos and late-night shorts",
      "Атмосферные городские истории, клипы и ночные шорты",
      "Kayfiyatli shahar hikoyalari, musiqiy videolar va tungi shortslar",
    ),
    tags: ["story", "music", "shorts"],
    description:
      "16 mm colour negative film, pushed two stops, shot handheld on a wet city street at night. Palette: sodium-lamp amber, tail-light vermilion, bottle-glass green and ink-blue shadows lifted slightly so the blacks stay milky. Light comes only from real sources such as shop signs, street lamps and a passing bus; every bright source blooms with a soft red-orange halation fringe. Lens: 25 mm prime wide open, shallow depth, soft corners, gentle vignette. Texture: coarse visible grain, slight gate weave, faint dust, no digital sharpening. Composition: off-centre subject, reflections in puddles in the foreground, figures caught mid-step or half in silhouette, generous dark negative space. Avoid the glossy, symmetrical, over-saturated stock-AI look: no rainbow neon cyberpunk, no perfectly centred framing, no plastic skin, no clean 4K sheen.",
    swatch: ["#141B2B", "#E08A2B", "#C8452D", "#2E5E4E", "#F2D9A8"],
    aspects: ["16:9", "9:16"],
    motif: "grain",
  },
  {
    id: "tungsten-night-film",
    name: L("Tungsten night film", "Вольфрамовая ночная плёнка", "Tungsten tungi plyonka"),
    goodFor: L(
      "Cinematic portraits, diners, rain on glass and thriller thumbnails",
      "Кинематографичные портреты, закусочные, дождь на стекле и триллерные превью",
      "Kinematografik portretlar, yomg'irli oynalar va triller muqovalari",
    ),
    tags: ["youtube-thumbnail", "story", "documentary"],
    description:
      "Tungsten-balanced cinema film exposed at night under mixed artificial light, so practical bulbs read warm orange while everything else falls to cool teal-blue. Palette: filament amber, cyan-teal shadow, brick red and blue-black. Light: bare bulbs, fluorescent tubes and shop signs; each bright bulb wears a soft red halation glow and a faint bloom spills over the highlights. Lens: 35 mm or 50 mm wide open, a mild flare streak across the frame, slightly lifted blacks. Texture: fine-to-medium grain that clumps in the shadows. Composition: a lone figure under a canopy of light, diner windows, parked cars, rain on glass, layered foreground and background, uneven framing. Avoid the glossy, symmetrical, over-saturated stock-AI look: no even studio lighting, no cartoon-strength teal-and-orange grade, no smooth airbrushed faces.",
    swatch: ["#10202A", "#F0A24A", "#1F5C66", "#A8412F", "#0B0D12"],
    aspects: ["16:9", "1:1"],
    motif: "grain",
  },
  {
    id: "instant-print-flash",
    name: L("Instant-print flash", "Моментальный снимок со вспышкой", "Chaqmoq chiroqli lahzali surat"),
    goodFor: L(
      "Friends, parties, behind-the-scenes and personal vlog covers",
      "Друзья, вечеринки, закулисье и личные обложки для влогов",
      "Do'stlar, bazmlar, sahna ortidagi lavhalar va vlog muqovalari",
    ),
    tags: ["youtube-thumbnail", "shorts", "story"],
    description:
      "A direct on-camera flash photograph on a square instant print, the kind taken at a party or in a kitchen at night. Palette: bleached skin highlights, warm cream border, faded cyan, muted brick and slightly milky blacks. Light: harsh frontal flash, a hard-edged shadow thrown on the wall behind the subject, a bright face falling off into a dark background. Lens: fixed plastic lens, soft focus, vignette, a hint of light leak along one edge. Texture: chemical colour shifts, low contrast, a faint dust speck, a thin cream frame with a wider margin at the bottom. Composition: slightly tilted, subject close and a little off-centre, cropped limbs, honest imperfections. Avoid the glossy, symmetrical, over-saturated stock-AI look: no flawless portrait lighting, no perfect skin, no sharp edge-to-edge detail.",
    swatch: ["#F1E8D4", "#7DB5B1", "#B5523B", "#2A2622", "#E7C9A5"],
    aspects: ["1:1", "9:16"],
    motif: "grain",
  },
  {
    id: "tilt-shift-miniature",
    name: L("Tilt-shift miniature", "Миниатюра в тилт-шифте", "Tilt-shift maket"),
    goodFor: L(
      "Cities, trains and busy places that should feel like toy models",
      "Города, поезда и людные места, которые должны выглядеть как игрушечные макеты",
      "Shaharlar, poyezdlar va o'yinchoq maketdek ko'rinishi kerak bo'lgan gavjum joylar",
    ),
    tags: ["travel", "kids", "documentary"],
    description:
      "A real place photographed as if it were a hand-built scale model: shot from a high oblique angle with a tilt-shift lens, so only a narrow band is sharp and the top and bottom melt into blur. Palette: slightly dusty toy primaries, brick red, mustard, grass green and sky blue on a soft cream sky, saturated just enough to look painted, not neon. Light: clear midday sun with short crisp shadows, like a lamp over a diorama table. Lens: tilt-shift 45 mm, plane of focus laid across the middle. Texture: matte painted surfaces, tiny visible seams, light film grain. Composition: elevated viewpoint, many small people, cars and roofs in rows, diagonal roads leading the eye, tiny incidental details. Avoid the glossy, symmetrical, over-saturated stock-AI look: no clay-render sheen, no uniform blur everywhere, no mirrored layout.",
    swatch: ["#F3E9D2", "#D94F3D", "#F2C14E", "#4C8C4A", "#4A7FB5"],
    aspects: ["16:9", "1:1"],
    motif: "bands",
  },
  {
    id: "darkroom-contact-sheet",
    name: L("Darkroom contact sheet", "Контактный лист из тёмной комнаты", "Qorong'i xona kontakt varag'i"),
    goodFor: L(
      "Photo essays, documentary openers and 'the making of' thumbnails",
      "Фотоочерки, заставки для документальных фильмов и превью «как это снималось»",
      "Foto-ocherklar, hujjatli film boshlanishlari va «qanday suratga olingan» muqovalari",
    ),
    tags: ["documentary", "youtube-thumbnail", "history"],
    description:
      "A black-and-white contact sheet printed in a darkroom: a grid of small frames from one roll, with a few chosen frames circled in red grease pencil. Palette: silver-grey tones from paper white to deep black, warm fixer-stained edges, one red wax-pencil mark. Light: natural window light and street light on fast film, contrasty, blown-out windows, crushed shadows. Lens: 35 mm, slightly off level, frames that drift as the photographer moves. Texture: visible film grain, sprocket holes and edge markings along the border, scratches, uneven developer streaks, a thumbprint. Composition: rows of near-duplicate frames with small changes of pose, one frame circled as the keeper, handwritten frame numbers kept as unreadable marks. Avoid the glossy, symmetrical, over-saturated stock-AI look: no clean digital monochrome, no tidy identical frames, no glossy sheen over the paper.",
    swatch: ["#EDEBE4", "#B9B6AC", "#5A5954", "#0E0E0E", "#C0392B"],
    aspects: ["16:9", "1:1"],
    motif: "frames",
  },
  {
    id: "faded-slide-1970s",
    name: L("Faded 1970s slide", "Выцветший слайд 1970-х", "1970-yillar so'lgan slayd"),
    goodFor: L(
      "Family history, nostalgia and 'how it used to be' stories",
      "Семейная история, ностальгия и рассказы «как раньше»",
      "Oila tarixi, sog'inch va «avvallari qanday edi» hikoyalari",
    ),
    tags: ["history", "story", "documentary"],
    description:
      "Colour reversal slide film from the 1970s, held to a window or projected on a wall, with warm dye fade. Palette: a drifted warm magenta cast, faded teal, mustard, cream highlights and brown-black shadows. Light: ordinary daylight, family-snapshot exposure, slightly overexposed skies, soft contrast. Lens: 50 mm kit lens, mild softness at the edges, a little colour fringing. Texture: dust, tiny scratches, a rounded slide-mount border with a deckled edge, grain in the shadows, a hint of mould bloom in one corner. Composition: casual snapshot framing, subjects caught mid-action, a cropped head or a thumb at the edge, ordinary domestic or holiday settings. Avoid the glossy, symmetrical, over-saturated stock-AI look: no flawless studio portrait, no sharp HDR detail, no blockbuster teal-and-orange grade.",
    swatch: ["#EFE2C0", "#B4503F", "#4E8A87", "#C99A3A", "#2A211C"],
    aspects: ["1:1", "16:9"],
    motif: "grain",
  },

  // ── Print and paper ───────────────────────────────────────────────────
  {
    id: "two-colour-risograph",
    name: L("Two-colour risograph", "Двухцветный ризограф", "Ikki rangli rizograf"),
    goodFor: L(
      "Bold explainers, music covers and playful thumbnails",
      "Яркие объяснялки, обложки для музыки и игривые превью",
      "Yorqin tushuntirishlar, musiqa muqovalari va quvnoq muqovalar",
    ),
    tags: ["youtube-thumbnail", "music", "education", "shorts"],
    description:
      "Two-colour risograph print on uncoated cream stock. Palette: fluorescent pink and a deep teal-blue are the only inks, and where they overlap they make a dark violet-navy. Flat shapes with grainy, slightly speckled fills, visible variation in ink density, a pixel or two of misregistration between the layers, and halftone grain in the gradients. Light is implied by overlap, never rendered. Subjects are simplified into bold silhouettes, cut-out shapes and offset outlines; paper texture and tiny ink dropouts show through. Composition: asymmetrical, large calm areas, one strong focal shape pushed off-centre, generous margins. Avoid the glossy, symmetrical, over-saturated stock-AI look: no smooth vector gradients, no third or fourth colour, no perfect registration, no glossy drop shadows.",
    swatch: ["#F6EFDF", "#FF5C8A", "#1F4E79", "#3A2A66"],
    aspects: ["1:1", "9:16", "16:9"],
    motif: "halftone",
  },
  {
    id: "linocut-print",
    name: L("Linocut", "Линогравюра", "Linogravyura"),
    goodFor: L(
      "Folk tales, history chapters and strong, simple graphics",
      "Народные сказки, главы истории и сильная простая графика",
      "Xalq ertaklari, tarix boblari va kuchli, sodda grafika",
    ),
    tags: ["story", "history", "education"],
    description:
      "A hand-carved linoleum block print inked with oil-based ink on slightly damp paper. Palette: one or two inks, near-black or deep red-brown on warm off-white, with an optional second block in ochre. Bold gouge marks: parallel carved lines for shading, chunky solid black areas, rough edges, small ridges where the carving left stray ink. Light is the white of the paper cut away, strong contrast between solid ink and clean paper, no greys. Texture: uneven ink coverage, paper grain, roller marks, a slightly off-register second colour. Composition: simplified, graphic and heavy-outlined, a dense pattern in the background, the subject stylised and chunky. Avoid the glossy, symmetrical, over-saturated stock-AI look: no smooth digital strokes, no gradients, no perfectly clean lines, no mirrored composition.",
    swatch: ["#F2EBDD", "#1B1A18", "#8E2F1F", "#C9922E"],
    aspects: ["1:1", "9:16"],
    motif: "hatch",
  },
  {
    id: "cut-paper-collage",
    name: L("Cut-paper collage", "Коллаж из бумаги", "Qog'oz kollaj"),
    goodFor: L(
      "Kids' stories, explainers and lively intros with a handmade feel",
      "Детские истории, объяснялки и живые заставки с ощущением ручной работы",
      "Bolalar hikoyalari, tushuntirishlar va qo'lda yasalgandek jonli kirishlar",
    ),
    tags: ["kids", "education", "story", "shorts"],
    description:
      "Layered collage assembled from hand-torn and scissor-cut paper: coloured sheets, old printed pages, graph paper and tissue. Palette: tomato red, mustard, sage green, powder blue and cream, with black ink accents. Light: a soft overhead lamp with thin cast shadows under each layer's edge, so the depth is a few millimetres, not a render. Texture: paper fibres, torn edges showing a white core, glue wrinkles, tape, a staple; occasional halftone from old magazines. Composition: overlapping shapes at slightly different angles, an off-centre focal figure built from simple geometric pieces, intentional gaps, a cutting-mat edge visible in one corner. Avoid the glossy, symmetrical, over-saturated stock-AI look: no smooth gradients, no symmetry, no plastic 3D depth, no perfectly straight cuts everywhere.",
    swatch: ["#F3EBD8", "#D8452B", "#E3A92F", "#8DA17A", "#9CB9C9"],
    aspects: ["16:9", "1:1", "9:16"],
    motif: "bands",
  },
  {
    id: "newsprint-halftone",
    name: L("Newsprint halftone", "Газетная полутоновая печать", "Gazeta yarim ton bosmasi"),
    goodFor: L(
      "News-style explainers, history and 'what really happened' videos",
      "Новостные объяснялки, история и ролики «что было на самом деле»",
      "Yangilik uslubidagi tushuntirishlar, tarix va «aslida nima bo'lgan» videolari",
    ),
    tags: ["documentary", "history", "youtube-thumbnail"],
    description:
      "Mass-printed newspaper look: coarse black halftone dots on yellowed newsprint with a single flat spot colour, red or blue, printed slightly out of register. Palette: newsprint cream, ink black, spot red and faded blue-grey. Light: high contrast; the dots do the shading, so skin and sky become fields of dots with clear gaps. Texture: visible dot rosettes at the edges, ink bleed, paper creases and fold lines, tiny tears, reverse-side text showing through as unreadable grey stripes. Composition: tightly cropped reportage photographs inside a thin black rule, caption-style negative space, an angled heading band left blank. Avoid the glossy, symmetrical, over-saturated stock-AI look: no smooth-gradient photographs, no razor-sharp detail, no readable invented headlines, no saturated colour.",
    swatch: ["#E9DFC4", "#1C1B1A", "#D63A2A", "#6C7F8F"],
    aspects: ["16:9", "1:1"],
    motif: "halftone",
  },
  {
    id: "blueprint-technical",
    name: L("Blueprint", "Синька (чертёж)", "Ko'k chizma (blueprint)"),
    goodFor: L(
      "How things work, tech explainers and engineering topics",
      "Как всё устроено, технические объяснялки и инженерные темы",
      "Narsalar qanday ishlaydi, texnik tushuntirishlar va muhandislik mavzulari",
    ),
    tags: ["education", "product", "youtube-thumbnail"],
    description:
      "A technical blueprint. Palette: chalk-white and pale-cyan linework on a deep Prussian-blue ground. Drawing: thin, even-weight lines, hatched sections, dimension lines with arrowheads, centre lines, circled detail views and grid squares; annotations kept as abstract marks with no legible words. Objects are shown in orthographic views (plan and side) and one exploded axonometric view. Light: none, flat and diagrammatic. Texture: slightly mottled blue paper, fold creases, an uneven coating, smudged corners. Composition: a title-block frame, crowded but orderly, the subject placed on the grid with measuring clutter around it. Avoid the glossy, symmetrical, over-saturated stock-AI look: no glowing sci-fi HUD, no neon cyan gradients, no plastic 3D render, no perfect mirror symmetry.",
    swatch: ["#14407A", "#2B6CB0", "#9FD3F0", "#EAF2FA"],
    aspects: ["16:9", "1:1"],
    motif: "grid",
  },
  {
    id: "cyanotype-sun-print",
    name: L("Cyanotype sun print", "Цианотипия", "Siyanotipiya (quyosh bosmasi)"),
    goodFor: L(
      "Nature, botany, calm educational pieces and poetic intros",
      "Природа, ботаника, спокойные образовательные ролики и поэтичные заставки",
      "Tabiat, botanika, sokin ta'limiy lavhalar va she'riy kirishlar",
    ),
    tags: ["education", "documentary", "story"],
    description:
      "A cyanotype sun print: an iron-based photographic print in cyan-blue and white on handmade paper, made by laying objects on coated paper in sunlight. Palette: deep Prussian blue, mid cyan-blue, pale blue-white and a cream paper border. Light: no light model; shapes appear as white silhouettes where objects blocked the sun, with soft halo edges and mid-tones where thin leaves let some light through. Texture: brush marks along the coating edge, blotchy uneven blue, paper fibres, tiny watermarks, a rough deckled edge. Composition: botanical specimens, feathers, lace and hands pressed flat and arranged like a herbarium page, objects overlapping, scattered rather than centred. Avoid the glossy, symmetrical, over-saturated stock-AI look: no digital glow, no smooth gradients, no perfect mirror symmetry, no neon blue.",
    swatch: ["#0F3A6B", "#2F6FA8", "#DCE9F2", "#EFE8D6"],
    aspects: ["1:1", "9:16"],
    motif: "wash",
  },

  // ── Graphic traditions ────────────────────────────────────────────────
  {
    id: "bauhaus-poster",
    name: L("Bauhaus poster", "Плакат в духе Баухауса", "Bauhaus plakati"),
    goodFor: L(
      "Design and architecture topics, bold titles and clean thumbnails",
      "Дизайн и архитектура, смелые заголовки и чистые превью",
      "Dizayn va arxitektura mavzulari, jasur sarlavhalar va toza muqovalar",
    ),
    tags: ["youtube-thumbnail", "education", "product"],
    description:
      "Geometric poster design in the spirit of the early twentieth-century Bauhaus school: circles, triangles and rectangles, strong diagonals and flat primary colours. Palette: signal red, primary yellow, cobalt blue and black on off-white paper. Light: none; shapes are flat and overlap with slight transparency where inks cross, no shadows. Lettering is replaced by blocks and bars, no readable text. Texture: faint offset-print grain and light paper wear. Composition: asymmetrical balance, a diagonal axis, a grid with deliberate rule-breaks, big shapes against small ones, generous empty space. Avoid the glossy, symmetrical, over-saturated stock-AI look: no gradients, no glossy 3D bevels, no centred symmetry, no stock-vector sheen.",
    swatch: ["#EFE8D8", "#D7261E", "#F2C200", "#1B3FA0", "#111111"],
    aspects: ["9:16", "1:1", "16:9"],
    motif: "bands",
  },
  {
    id: "constructivist-poster",
    name: L("Soviet constructivist poster", "Советский конструктивистский плакат", "Sovet konstruktivizm plakati"),
    goodFor: L(
      "Bold history, technology and 'rise of' stories with a strong diagonal",
      "Яркая история, технологии и рассказы о «подъёме» с сильной диагональю",
      "Jasur tarix, texnologiya va «yuksalish» hikoyalari, kuchli diagonal bilan",
    ),
    tags: ["history", "youtube-thumbnail", "documentary"],
    description:
      "Constructivist poster in the 1920s avant-garde tradition: a stark diagonal composition, photomontage cut-outs, heavy sans-serif-style blocks and a red, black and cream scheme. Palette: red, black, cream and a little steel grey. Light: none; shadows are drawn as hard flat wedges. Dynamics: diagonals at thirty to forty-five degrees, wedges, circles and sharp triangles, cut-out figures in silhouette set against them, megaphone-like cones and radiating lines. Texture: rough lithographic print, off-register red, paper grain, halftone in the cut-out photographs. Composition: a rotated frame, an oversized subject breaking the edge, lettering replaced by angled bars with no readable words, no slogans and no state emblems. Avoid the glossy, symmetrical, over-saturated stock-AI look: no gradients, no soft glow, no centred symmetry, no political slogans or flags.",
    swatch: ["#EDE3CB", "#C8201E", "#141414", "#7A8087"],
    aspects: ["9:16", "1:1"],
    motif: "halftone",
  },
  {
    id: "ukiyo-e-woodblock",
    name: L("Ukiyo-e woodblock", "Гравюра укиё-э", "Ukiyo-e yog'och o'ymakorligi"),
    goodFor: L(
      "Journeys, seasons, weather and calm storytelling",
      "Путешествия, времена года, погода и спокойное повествование",
      "Sayohatlar, fasllar, ob-havo va sokin hikoya",
    ),
    tags: ["travel", "story", "history"],
    description:
      "Japanese woodblock print tradition of the Edo period: flat colour areas printed from several carved blocks, with fine black key-line outlines. Palette: indigo, vermilion, soft ochre, moss green and cream washi paper, with graded colour blends fading at the edges of sky and water. Light: none is cast; form is described by line and colour, and wave crests, mist bands and clouds are stylised into curling shapes. Texture: visible wood grain inside flat areas, subtle paper fibre, a slightly uneven impression with embossing around the lines. Composition: a high horizon or a tall vertical crop, strong diagonals, a large foreground element cropping the scene, tiny figures for scale, empty label areas with no readable text. Avoid the glossy, symmetrical, over-saturated stock-AI look: no smooth digital gradients, no 3D shading, no anime-style eyes, no copy of any particular print.",
    swatch: ["#F1E7D0", "#1F3A5F", "#D9482B", "#D8A84B", "#6E8B5B"],
    aspects: ["9:16", "16:9"],
    motif: "wash",
  },
  {
    id: "art-nouveau-poster",
    name: L("Art Nouveau", "Ар-нуво", "Art nuvo (Modern uslubi)"),
    goodFor: L(
      "Fairy tales, music, fashion and elegant title cards",
      "Сказки, музыка, мода и изящные титульные карточки",
      "Ertaklar, musiqa, moda va nafis sarlavha kartalari",
    ),
    tags: ["story", "music", "youtube-thumbnail"],
    description:
      "The decorative poster style of around 1900: sinuous whiplash lines, flowing hair and vines, botanical ornament and an arched or arabesque border. Palette: muted sage, antique gold, dusty rose, deep teal and cream paper. Light: flat and evenly lit, with soft tonal gradation inside shapes and thin dark outlines. Texture: lithographic grain, a matte finish, gilded accents. Composition: tall vertical, the subject set inside a decorative arch, flowers and curved stems framing it, an ornamental pattern border, balance made by asymmetrical curves. Avoid the glossy, symmetrical, over-saturated stock-AI look: no chrome, no neon, no strict symmetry, no glossy airbrush, no lettering.",
    swatch: ["#F0E6CF", "#8FA382", "#C79A3B", "#C98B8B", "#1F5A5A"],
    aspects: ["9:16", "1:1"],
    motif: "wash",
  },
  {
    id: "mid-century-travel-poster",
    name: L("Mid-century travel poster", "Туристический плакат середины века", "O'tgan asr o'rtalari sayohat plakati"),
    goodFor: L(
      "Destinations, road trips and 'places to see' lists",
      "Направления, поездки и подборки «куда поехать»",
      "Manzillar, yo'l sayohatlari va «qayerga borish kerak» ro'yxatlari",
    ),
    tags: ["travel", "youtube-thumbnail", "shorts"],
    description:
      "Flat-colour travel posters of the 1950s: bold simplified landscapes printed with a few screen-printed inks. Palette: sunset coral, deep teal, butter yellow, sand and ink navy. Light: stylised, with flat gradations built from stippled grain or stepped bands, and long hard shadows drawn as flat shapes. Texture: slight overprint where inks overlap, gritty screen-print grain, faded folded-paper creases. Composition: strongly simplified silhouettes such as mountains, domes, a caravan or a train, a huge sun or moon disc, a wide horizon with cropped foreground shapes, an empty block reserved for lettering with no readable words. Avoid the glossy, symmetrical, over-saturated stock-AI look: no photoreal detail, no smooth gradients, no mirrored layout, no neon.",
    swatch: ["#E8D6B0", "#E2603F", "#1F5F6B", "#F0C75E", "#1D2B45"],
    aspects: ["9:16", "16:9"],
    motif: "bands",
  },

  // ── Craft ─────────────────────────────────────────────────────────────
  {
    id: "claymation-set",
    name: L("Claymation", "Пластилиновая анимация", "Plastilin animatsiya"),
    goodFor: L(
      "Kids' videos, funny characters and short comic scenes",
      "Детские ролики, забавные персонажи и короткие комичные сценки",
      "Bolalar videolari, kulgili qahramonlar va qisqa hajviy lavhalar",
    ),
    tags: ["kids", "story", "shorts", "youtube-thumbnail"],
    description:
      "Stop-motion clay figures on a handmade miniature set. Palette: warm plasticine tones, terracotta, mustard, moss green and sky blue on a neutral beige ground. Light: a single warm key lamp from the side with soft shadow falloff and real small-scale depth of field. Texture: visible thumbprints, seam lines, slight dents, lumpy edges, tiny fibres and dust caught in the clay, a painted cardboard backdrop. Figures are chunky and slightly asymmetric, with wide simple eyes and imperfect shapes. Composition: low camera at figure height, a handmade prop in the foreground, a little motion blur on a moving limb. Avoid the glossy, symmetrical, over-saturated stock-AI look: no smooth CGI plastic, no perfect symmetry, no glossy waxy skin, no uniform saturation.",
    swatch: ["#E9D9BE", "#C8643B", "#E0A83A", "#6F8F4E", "#7FB2D6"],
    aspects: ["16:9", "1:1"],
    motif: "grain",
  },
  {
    id: "felt-and-wool",
    name: L("Felt and wool", "Войлок и шерсть", "Namat va jun"),
    goodFor: L(
      "Bedtime stories, cosy kids' content and gentle tutorials",
      "Сказки на ночь, уютный детский контент и мягкие уроки",
      "Uyqu oldi ertaklari, shinam bolalar kontenti va yumshoq darslar",
    ),
    tags: ["kids", "story", "education"],
    description:
      "Needle-felted wool figures and felt-appliqué scenes. Palette: oatmeal, cranberry, pine green, mustard and cornflower blue. Light: soft diffuse window daylight with shallow depth, so loose fibres glow at the edges. Texture: fuzzy fibre halos, visible stitches in contrast thread, slightly frayed felt edges, wool roving for clouds and hills, a blanket-stitch border. Shapes are simplified, rounded and soft, with bead or button eyes. Composition: a handmade diorama on a table, objects at tabletop scale, a stitched-thread horizon, small imperfections in alignment. Avoid the glossy, symmetrical, over-saturated stock-AI look: no smooth plastic, no hard glossy highlights, no flawless symmetry, no uniform glow.",
    swatch: ["#D9C9A8", "#A8344A", "#3E6B52", "#D9A441", "#6C8CC4"],
    aspects: ["1:1", "16:9"],
    motif: "grain",
  },
  {
    id: "oil-pastel",
    name: L("Oil pastel", "Масляная пастель", "Moy pastel"),
    goodFor: L(
      "Sunsets, feelings, travel diaries and warm personal stories",
      "Закаты, чувства, дневники путешествий и тёплые личные истории",
      "Quyosh botishi, his-tuyg'ular, sayohat kundaliklari va iliq shaxsiy hikoyalar",
    ),
    tags: ["travel", "story", "kids"],
    description:
      "Drawn with oil pastels on toothy tinted paper. Palette: warm orange, ultramarine, rose madder, leaf green and a warm grey paper. Light: colour is layered, not blended; the light areas are the paper showing through, and sunsets and glows are built from stacked strokes. Texture: waxy thick strokes, scratched sgraffito lines revealing colour beneath, crumbs, smudged fingertips, paper tooth visible in the gaps. Composition: bold simplified shapes, a tilted horizon, a large subject slightly off-centre, loose edges that do not reach the paper border. Avoid the glossy, symmetrical, over-saturated stock-AI look: no digital airbrush, no smooth blends, no sharp outlines, no symmetry.",
    swatch: ["#CFC3AE", "#E4702A", "#2B3F9E", "#C94C6E", "#4F8F3C"],
    aspects: ["16:9", "1:1"],
    motif: "hatch",
  },
  {
    id: "gouache-storybook",
    name: L("Gouache storybook", "Книжная гуашь", "Guash bilan kitob rasmi"),
    goodFor: L(
      "Fairy tales, bedtime stories and gentle narrated videos",
      "Сказки, истории на ночь и мягкие закадровые ролики",
      "Ertaklar, uyqu oldi hikoyalari va yumshoq ovozli videolar",
    ),
    tags: ["kids", "story", "youtube-thumbnail"],
    description:
      "Opaque gouache painting in the manner of a children's picture book. Palette: matte warm colours, ochre, brick, forest green, dusk blue and blush on cream paper. Light: soft late-afternoon light painted as flat colour shifts, no hard shadows. Texture: visible brush strokes, slightly streaky matte fills, dry-brush edges, tiny paint specks, paper tooth. Shapes: rounded, friendly characters in simple forms, patterned clothing, small repeated leaf or dot motifs. Composition: wide storytelling spreads with a quiet foreground, characters small in a big landscape, a winding path leading in, space left for a line of text with no readable words. Avoid the glossy, symmetrical, over-saturated stock-AI look: no airbrushed gradients, no 3D plastic characters, no mirrored layouts, no neon.",
    swatch: ["#F4E9D3", "#D9A441", "#B8553C", "#3F6B4F", "#3C5A8A"],
    aspects: ["16:9", "1:1"],
    motif: "wash",
  },
  {
    id: "field-notes-watercolour",
    name: L("Pencil and watercolour field notes", "Карандаш и акварель: полевой блокнот", "Qalam va akvarel dala daftari"),
    goodFor: L(
      "Nature and science explainers, travel notes and curious how-it-works pages",
      "Природа и наука, путевые заметки и любопытные разборы «как это работает»",
      "Tabiat va fan tushuntirishlari, sayohat yozuvlari va qiziqarli «bu qanday ishlaydi» sahifalari",
    ),
    tags: ["education", "documentary", "travel"],
    description:
      "A naturalist's field notebook: graphite pencil drawing with loose watercolour washes on lightly yellowed paper. Palette: sepia, sap green, yellow ochre and washed ultramarine on warm paper. Light: indicated by leaving the paper white and letting colour pool at the edges, with a few hatching strokes instead of cast shadows. Texture: visible pencil construction lines, pooled pigment edges, bleeding blooms, fingerprints, small coffee-ring stains, a torn page edge, taped-in scraps. Details: handwritten notes kept as unreadable scribbles, measurement ticks, arrows and small scale bars; several views of one subject on one page. Composition: a page layout with one main drawing and smaller studies around it, uneven margins. Avoid the glossy, symmetrical, over-saturated stock-AI look: no polished digital illustration, no perfect line weight, no readable invented text.",
    swatch: ["#F2E8CF", "#6B4A2F", "#7C9A4B", "#D6A64A", "#5C7FB8"],
    aspects: ["16:9", "1:1"],
    motif: "wash",
  },
  {
    id: "chalk-on-slate",
    name: L("Chalk on slate", "Мел на грифельной доске", "Doskadagi bo'r chizmasi"),
    goodFor: L(
      "Lessons, step-by-step explainers and kids' learning",
      "Уроки, пошаговые объяснения и детское обучение",
      "Darslar, bosqichma-bosqich tushuntirishlar va bolalar ta'limi",
    ),
    tags: ["education", "kids", "shorts"],
    description:
      "Hand-drawn chalk illustrations on a dark classroom slate board. Palette: slate green-black, chalk white, dusty yellow, pink and sky-blue chalk. Light: even classroom light with a faint soft sheen across the board; the lines read because they are pale on dark. Texture: powdery stroke edges, ghost marks of earlier drawings that were wiped away, finger-smudged shading, a wooden frame and a chalk ledge with a dusty stub. Drawing: simple diagrams, arrows, stick figures and doodle icons, boxed key ideas, hand-drawn dashed lines and brackets, no legible words or equations. Composition: a main sketch left of centre, smaller steps trailing to the right, deliberate empty spaces. Avoid the glossy, symmetrical, over-saturated stock-AI look: no neon glow, no clean vector icons, no perfectly straight lines, no readable text.",
    swatch: ["#2B3431", "#F2F0E8", "#E8C95A", "#E48DA6", "#7FB6D5"],
    aspects: ["16:9", "9:16"],
    motif: "hatch",
  },

  // ── Central-Asian roots ───────────────────────────────────────────────
  {
    id: "ikat-atlas-silk",
    name: L("Ikat and atlas silk", "Икат и атлас", "Ikat va atlas"),
    goodFor: L(
      "Fashion, craft, festivals and bright cultural stories from the region",
      "Мода, ремёсла, праздники и яркие культурные истории региона",
      "Moda, hunarmandchilik, bayramlar va mintaqaning yorqin madaniy hikoyalari",
    ),
    tags: ["story", "documentary", "youtube-thumbnail", "shorts"],
    description:
      "Central Asian warp-ikat silk (atlas and adras): resist-dyed threads woven so that every pattern edge is feathered and softly blurred. Palette: madder red, indigo, pomegranate pink, saffron, emerald and undyed cream. Light: flat, like cloth laid out in daylight, with the sheen of silk catching along the folds. Pattern: vertical stripes and bands of repeating almond, pepper-pod, ram's-horn and comb motifs, with a deliberate irregular shimmer where the dyed warps do not line up. Texture: visible woven threads, a soft sheen, small imperfections in alignment. Composition: bands running the length of the frame, a subject or object wrapped or draped in the cloth, patterns cropped at the edges rather than tiled perfectly. Avoid the glossy, symmetrical, over-saturated stock-AI look: no crisp vector repeats, no seamless perfect tiling, no neon colour, no cheap satin shine.",
    swatch: ["#B3282D", "#1D2F6F", "#D6457A", "#E7A622", "#1F7A5C"],
    aspects: ["9:16", "1:1"],
    motif: "lattice",
  },
  {
    id: "suzani-embroidery",
    name: L("Suzani embroidery", "Сюзане: вышивка", "Suzani kashtasi"),
    goodFor: L(
      "Home and hospitality, weddings, crafts and warm heritage stories",
      "Дом и гостеприимство, свадьбы, ремёсла и тёплые истории о наследии",
      "Uy va mehmondo'stlik, to'ylar, hunarmandchilik va iliq meros hikoyalari",
    ),
    tags: ["story", "documentary", "product"],
    description:
      "Suzani needlework of Uzbekistan and its neighbours: silk thread embroidered by hand on cotton or silk cloth. Palette: deep madder red, ivory cotton ground, indigo, saffron, olive green and blossom pink. Pattern: large sun-and-moon discs, pomegranates, tulips, irises and curling vines, balanced but drawn by hand, filled with chain stitch and couched thread lines that follow the shapes. Light: soft raking light across the thread, so each stitch has a tiny highlight and shadow. Texture: raised silk, slight puckering of the ground, lightly irregular motif edges, small knots, aged wear. Composition: one large central medallion with smaller flowers around it and a border of leaves; the scene may read as an embroidered panel hung on a wall. Avoid the glossy, symmetrical, over-saturated stock-AI look: no printed-wallpaper repeats, no perfect mirror symmetry, no neon, no plastic sheen.",
    swatch: ["#F1E7D2", "#9E2A2B", "#27407F", "#E3A32A", "#6B7A3A"],
    aspects: ["1:1", "9:16"],
    motif: "lattice",
  },
  {
    id: "timurid-tilework",
    name: L("Timurid tilework", "Тимуридская изразцовая мозаика", "Temuriylar davri koshinlari"),
    goodFor: L(
      "History, architecture, Silk Road journeys and cultural landmarks",
      "История, архитектура, путешествия по Шёлковому пути и культурные достопримечательности",
      "Tarix, me'morchilik, Ipak yo'li sayohatlari va madaniy yodgorliklar",
    ),
    tags: ["history", "travel", "documentary", "youtube-thumbnail"],
    description:
      "Blue-and-turquoise glazed tilework in the manner of Timurid-era Samarkand: mosaic faience and glazed brick covering portals, domes and walls. Palette: cobalt blue, turquoise, dark lapis, white glaze, touches of gold and a dark brown-black outline. Pattern: interlacing geometric stars and polygons, arabesque vines in cut tile, bands of angular brick lettering kept abstract with no readable words, honeycomb muqarnas vaulting in the shadows. Light: strong sun slanting across glazed surfaces, wet-looking highlights, crackled glaze, deep cool shadow in recessed arches. Texture: tiny cracks, glaze pooling, uneven edges where tile pieces meet, weathered patches of bare brick. Composition: an arched portal framing the subject, pattern filling the frame to its edges, a small figure at the base for scale, no human figures in the tile patterns. Avoid the glossy, symmetrical, over-saturated stock-AI look: no flat wallpaper repeats, no chrome highlights, no fake lettering, no perfect mirror symmetry.",
    swatch: ["#1B3C8C", "#1FA9A8", "#12275E", "#F4F1E6", "#C79A3B"],
    aspects: ["9:16", "16:9"],
    motif: "stars",
  },
  {
    id: "central-asian-miniature",
    name: L(
      "Persian and Central Asian miniature",
      "Персидская и среднеазиатская миниатюра",
      "Fors va Markaziy Osiyo miniatyurasi",
    ),
    goodFor: L(
      "Legends, epic tales, poetry and historical stories",
      "Легенды, эпосы, поэзия и исторические рассказы",
      "Rivoyatlar, dostonlar, she'riyat va tarixiy hikoyalar",
    ),
    tags: ["story", "history", "kids"],
    description:
      "Manuscript miniature painting of the Persianate Central Asian tradition, as in the Herat, Bukhara and Samarkand schools: opaque watercolour and gold on burnished paper. Palette: lapis blue, vermilion, malachite green, gold leaf, warm cream paper and rose pink. Light: none is cast, with no shadows and no atmospheric depth; the scene is a high tilted view where garden, architecture and landscape stack up the page. Details: tiny elegant figures in layered robes and turbans in small groups, blossoming trees, cypress, rocks painted as crinkled stacks, tiled pavilions in flat elevation, a gold-flecked sky, an illuminated border. Texture: smooth burnished surface, hair-fine brush lines, small cracks in the gold. Composition: several viewpoints in one picture, a courtyard cut open to show inside and outside, a decorative frame of ornament bands. Avoid the glossy, symmetrical, over-saturated stock-AI look: no photographic perspective, no cast shadows, no sacred figures, no real person's likeness.",
    swatch: ["#F2E5C6", "#1F3F8A", "#D2412D", "#2E8B57", "#C9A13B"],
    aspects: ["16:9", "1:1"],
    motif: "lattice",
  },
  {
    id: "samarkand-golden-hour",
    name: L("Samarkand golden hour", "Самарканд на закате", "Samarqand oltin soat nurida"),
    goodFor: L(
      "Travel, city films, tourism and architecture of the Silk Road",
      "Путешествия, городские фильмы, туризм и архитектура Шёлкового пути",
      "Sayohat, shahar filmlari, turizm va Ipak yo'li me'morchiligi",
    ),
    tags: ["travel", "documentary", "youtube-thumbnail", "shorts"],
    description:
      "Architectural photography of Silk Road monuments at golden hour: ribbed turquoise domes, tall arched portals and slender minarets of a Samarkand-style madrasa. Palette: honey-coloured sunbaked brick, turquoise dome, deep cobalt tile, warm sand and a low-sun peach sky fading to blue. Light: low sun about half an hour before sunset, warm side light raking across brick, long soft shadows, a glow on the domes, the sky still bright blue above. Lens: 70 to 135 mm telephoto that compresses the layers with slight atmospheric haze, or a 24 mm from a low corner leading into a portal. Texture: crisp tile detail, rough brick, fine natural grain. Composition: a pishtaq portal off-centre, a person or a tree for scale, foreground paving with long shadows, sky given one third of the frame. Avoid the glossy, symmetrical, over-saturated stock-AI look: no oversaturated orange-teal poster grade, no tilted fantasy towers, no invented lettering, no perfect mirror symmetry.",
    swatch: ["#E7C98E", "#C98F4B", "#1AA6A0", "#1D3F8F", "#E98F5B"],
    aspects: ["16:9", "9:16"],
    motif: "bands",
  },
];

/** Ids are matched exactly: a stored library id is never normalised into another. */
export function libraryStyleById(id: unknown): LibraryStyle | null {
  if (typeof id !== "string") return null;
  return STYLE_LIBRARY.find((s) => s.id === id) ?? null;
}

/** The name an organization's kit is saved under: the person's language, within the kit's 60-character limit. */
export function kitNameFor(style: LibraryStyle, locale: Locale): string {
  const name = style.name[locale] || style.name.en;
  return [...name].slice(0, KIT_LIMITS.nameMax).join("").trim();
}

function norm(s: string): string {
  return s.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/ё/g, "е").trim();
}

export interface LibraryFilter {
  query: string;
  /** A style must carry every tag listed (narrowing, not widening). */
  tags: readonly StyleTag[];
}

/**
 * The styles that match a search and the picked tags. Search looks at the
 * name in every language (a person may type the English name in a Russian UI),
 * the "good for" line in the current language, the tags' words and the id.
 */
export function filterLibrary(
  styles: readonly LibraryStyle[],
  filter: LibraryFilter,
  locale: Locale,
  tagLabels: Readonly<Record<StyleTag, string>>,
): LibraryStyle[] {
  const q = norm(filter.query);
  return styles.filter((s) => {
    if (!filter.tags.every((t) => s.tags.includes(t))) return false;
    if (!q) return true;
    const haystack = [
      s.id.replace(/-/g, " "),
      s.name.en,
      s.name.ru,
      s.name.uz,
      s.goodFor[locale],
      ...s.tags.map((t) => tagLabels[t]),
    ]
      .map(norm)
      .join(" | ");
    return q.split(/\s+/).every((word) => haystack.includes(word));
  });
}
