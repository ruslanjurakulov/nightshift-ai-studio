-- 0191 — Trend templates, second set: the formats that are pulling the most views on Reels and TikTok right now.
--
-- WHY. 0181 seeded the everyday formats (a product ad, a before/after, a food reveal). What makes a person open an AI studio is
-- usually an EFFECT they just saw in their feed and want for themselves. This adds a "viral" category and eight formats chosen
-- from measurement, not taste: on 2026-11-20 an outlier search (vidIQ, Instagram and TikTok, last 30 days, at least 100k views)
-- ranked AI-made posts by how far they out-performed their own account's median. The formats kept here each had at least one
-- such post far above its account's median (for example: a pickaxe strike that bursts a wall into gold, 4.2M views at 656x the
-- account median; a hand-held object morphing into a living creature, 4.0M at 160x; a calm boat shot over a vast creature
-- below, 3.5M at 813x; a single product photo turned into a seasonal ad, 3.0M). These are FORMATS only: no account, person,
-- brand, character, script or audio from those posts is copied, and no view count is shown to customers as a promise.
--
-- WHAT IT ADDS (it replaces nothing)
--   creative_templates.category      'viral' joins the allowed list (the CHECK is dropped and re-added with the old values kept).
--   eight seed rows                   five 'viral', two 'business', one 'story'; each written for a model on sale at the time of
--                                    writing (MiniMax H3 / H3 Max for video, Ideogram 4.5 for the poster).
--
-- MEDIA. As in 0181: each preview is a static app file made in our own Studio (public/templates/<slug>/), listed in
-- lib/templates/media-manifest.json. Nothing about media is stored here.
--
-- SEED RULES (as 0181). A row is inserted only when its model exists in model_registry, and never overwrites a row that is
-- already there (on conflict do nothing), so re-applying this file cannot undo an owner's edit. Whether a model is on sale is
-- asked of sellable_models() per request by /api/templates, never stored here.
--
-- Additive only. Re-runnable: every statement is idempotent.

alter table public.creative_templates drop constraint if exists creative_templates_category_check;
alter table public.creative_templates add constraint creative_templates_category_check
  check (category in ('business', 'story', 'lifestyle', 'text', 'viral'));

-- Formats and structures only. Prompts are English in every language on purpose (the models follow English best); titles and
-- descriptions are translated. {placeholders} are what the person fills in.
insert into public.creative_templates
  (slug, title, description, category, kind, prompt_template, model_id, aspect, duration_s, quality, director, sort, published)
select v.slug, v.title::jsonb, v.description::jsonb, v.category, v.kind, v.prompt_template, v.model_id, v.aspect, v.duration_s,
       v.quality, v.director::jsonb, v.sort, true
  from (values
    ('treasure-strike',
     '{"en":"Treasure strike","ru":"Удар и сокровище","uz":"Zarba va xazina"}',
     '{"en":"Effort, then an impossible payoff: one more swing and the wall bursts open into treasure.","ru":"Усилие, а затем невозможная награда: ещё один удар — и стена рассыпается сокровищами.","uz":"Avval mehnat, keyin aql bovar qilmas natija: yana bir zarba va devordan xazina toshib chiqadi."}',
     'viral', 'video',
     'Vertical cinematic AI effect video with a hook in the first second. Inside {setting}, {character} swings a pickaxe at a rough rock wall: sparks fly, dust falls, the first strike only cracks the stone. On the second strike the wall bursts open and a huge torrent of {treasure} pours out and floods around their legs, glittering in the light, and they stagger back in shock. Close dynamic handheld camera, slow motion on the burst, realistic lighting and physics, a big satisfying payoff, no text.',
     'minimax-h3', '9:16', 10, '768p',
     '{"camera":"close handheld","lighting":"single practical light","mood":"tension, then surprise","pacing":"build-up, burst in slow motion"}',
     1),
    ('object-morph',
     '{"en":"Object comes alive","ru":"Предмет оживает","uz":"Buyum jonlanadi"}',
     '{"en":"One continuous phone-style shot: an everyday object turns into a living thing in someone''s hands.","ru":"Один непрерывный кадр как с телефона: обычный предмет превращается в живое существо прямо в руках.","uz":"Telefonda olingandek bitta uzluksiz kadr: oddiy buyum qoʻlda tirik mavjudotga aylanadi."}',
     'viral', 'video',
     'Vertical single-take AI transformation filmed like a casual phone video. {person} holds {object} on {place}. Halfway through, {object} starts to ripple and twist and seamlessly transforms into {creature}, alive in their hands; they gasp and laugh in surprise. Realistic textures and natural light, one continuous shot with no cuts, the morph is smooth and believable, no text.',
     'minimax-h3', '9:16', 10, '768p',
     '{"camera":"casual phone, one take","lighting":"natural","mood":"playful surprise","pacing":"morph at the midpoint"}',
     2),
    ('giant-hand-makeover',
     '{"en":"Giant hand makeover","ru":"Рука великана","uz":"Ulkan qoʻl"}',
     '{"en":"A tiny world, a giant hand and an old home swapped for a new one. For renovation, real estate and before/after stories.","ru":"Крошечный мир, огромная рука и старый дом, заменённый новым. Для ремонта, недвижимости и историй «до и после».","uz":"Kichkina olam, ulkan qoʻl va eski uy oʻrniga yangisi. Taʼmir, koʻchmas mulk va «oldin-keyin» hikoyalari uchun."}',
     'viral', 'video',
     'Vertical tilt-shift miniature scene. A tiny family stands in the rain in front of {old_home} in {setting}. A giant human hand reaches down from the sky, gently lifts the old home away and carefully places {new_home} in its place; warm lights switch on inside and the tiny family cheers as the sun breaks through. Macro tilt-shift look, toy-like scale, soft daylight, slow smooth camera, a satisfying makeover moment, no text.',
     'minimax-h3', '9:16', 10, '768p',
     '{"camera":"slow, tilt-shift macro","lighting":"rain, then sun breaking through","mood":"satisfying","pacing":"lift, place, lights on"}',
     3),
    ('scale-shock',
     '{"en":"Scale shock","ru":"Шок от масштаба","uz":"Koʻlam zarbasi"}',
     '{"en":"A calm first second, then something enormous glides into view. A cinematic hook people watch twice.","ru":"Спокойная первая секунда, а затем в кадр вплывает нечто огромное. Кинематографичный крючок, который пересматривают.","uz":"Birinchi soniya sokin, keyin kadrga ulkan narsa suzib kiradi. Ikki marta koʻriladigan kinematografik ilmoq."}',
     'viral', 'video',
     'Vertical cinematic shot with a hook in the first second. Close-up of {small_subject} on {place}, calm and quiet, gentle ripples. The camera slowly tilts down into the clear water: an enormous {giant} rises from the deep and glides silently right beneath, its body many times larger than everything above it. Overwhelming sense of scale, quiet tension, realistic water caustics and light rays, slow camera move, cinematic colour grade, no text.',
     'minimax-h3-max', '9:16', 10, '768p',
     '{"camera":"slow tilt down","lighting":"sun rays through water","mood":"quiet awe","pacing":"calm, then reveal"}',
     4),
    ('water-revival',
     '{"en":"Water revival","ru":"Оживление водой","uz":"Suv bilan jonlanish"}',
     '{"en":"Something dry and lifeless drinks and comes back to life in one smooth time-lapse. Satisfying and easy to loop.","ru":"Сухое и безжизненное пьёт воду и оживает в одном плавном таймлапсе. Приятно смотреть, легко зациклить.","uz":"Quruq va jonsiz narsa suv ichib, bitta silliq taymlapsda jonlanadi. Koʻrishga yoqimli, takrorlashga qulay."}',
     'viral', 'video',
     'Vertical satisfying transformation. {subject} lies dried out on {ground}, grey and lifeless. A stream of clear water pours over it and, in one smooth time-lapse, it drinks, swells and comes back to life: {revived}. Macro lens, warm sunlight, glistening droplets, a slow push-in, a hopeful payoff, no text.',
     'minimax-h3', '9:16', 10, '768p',
     '{"camera":"macro, slow push-in","lighting":"warm sunlight","mood":"hopeful","pacing":"one continuous time-lapse"}',
     5),
    ('holiday-sale-ad',
     '{"en":"Holiday sale ad","ru":"Праздничная распродажа","uz":"Bayram aksiyasi"}',
     '{"en":"Your product in seasonal light: three premium beats and room at the top for the offer. For Black Friday and New Year.","ru":"Ваш товар в праздничном свете: три премиальных кадра и место сверху под предложение. Для Чёрной пятницы и Нового года.","uz":"Mahsulotingiz bayram yorugʻida: uchta premium kadr va tepada taklif uchun joy. Black Friday va Yangi yil uchun."}',
     'business', 'video',
     'Vertical seasonal sale ad for {product}, made from a single product idea. Shot 1: {product} on {surface}, {season} decorations around it, warm bokeh lights. Shot 2: a slow orbit as {season_effect} drifts through the frame and catches the light. Shot 3: hero frame, {product} centred and glowing, clean empty space at the top for the offer headline. Premium commercial look, shallow depth of field, no text, no logos.',
     'minimax-h3', '9:16', 10, '768p',
     '{"camera":"slow orbit","lighting":"warm bokeh","mood":"festive, premium","pacing":"three beats, about 3 s each"}',
     12),
    ('animated-family-story',
     '{"en":"3D family moment","ru":"3D-семейная сценка","uz":"3D oilaviy lavha"}',
     '{"en":"A warm, funny moment in a stylised 3D animation look. For stories, brands with heart and channel shorts.","ru":"Тёплая и смешная сценка в стиле 3D-анимации. Для историй, душевных брендов и шортсов канала.","uz":"3D animatsiya uslubida iliq va kulgili lavha. Hikoyalar, samimiy brendlar va kanal shortslari uchun."}',
     'story', 'video',
     'Vertical 3D animated short in a warm, stylised feature-animation look. {characters} in {setting}. {moment} Expressive faces, soft global illumination, rich warm colour, a gentle camera dolly, a heartwarming and funny emotional beat, cinematic composition, no text.',
     'minimax-h3', '9:16', 10, '768p',
     '{"camera":"gentle dolly","lighting":"soft global illumination","mood":"heartwarming, funny","pacing":"one beat with a comic button"}',
     45),
    ('sale-story-poster',
     '{"en":"Sale story poster","ru":"Сторис распродажи","uz":"Aksiya stories posteri"}',
     '{"en":"A vertical story with a bold sale headline, your offer and your product as the hero.","ru":"Вертикальная сторис с крупным заголовком распродажи, вашим предложением и товаром в центре.","uz":"Katta aksiya sarlavhasi, taklifingiz va markazdagi mahsulotingiz bilan vertikal stories."}',
     'business', 'image',
     'Vertical story poster for a {occasion} sale. A big bold headline that reads "{headline}" and a smaller line that reads "{offer}". {product} as a crisp studio hero shot, a dramatic black and {accent_color} design with light streaks, a modern premium layout with clear hierarchy, sharp readable typography, no logos.',
     'ideogram-4.5', '9:16', null, 'high',
     '{"layout":"headline top, hero centre, offer below","palette":"black and one accent","type":"bold condensed sans-serif"}',
     35)
  ) as v(slug, title, description, category, kind, prompt_template, model_id, aspect, duration_s, quality, director, sort)
  join public.model_registry m on m.id = v.model_id
on conflict (slug) do nothing;
