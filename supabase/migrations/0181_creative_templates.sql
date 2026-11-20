-- 0181 — Trend templates: the "Trends" gallery's ready starting points (one click opens Create, prefilled).
--
-- WHY. A person who has never written a prompt needs a starting point that already looks like something people post (a vertical
-- product ad, a before/after, a food reveal). A template is the FORMAT only: a structure with {placeholders} the person fills in.
-- Picking one fills the Create screen and stops there; the price is the quote route's, the spend is the job start's, exactly as
-- for anything typed by hand (CLAUDE.md rule 3: nothing in a browser spends).
--
-- WHAT IT ADDS (one table, one storage bucket, one owner function, the seed; it replaces nothing and alters no existing table)
--   creative_templates               one row per template. Anyone (anon and signed in) reads the PUBLISHED rows; nobody but the
--                                    service key and the function below writes. model_id references model_registry: a template
--                                    names the model it was written for, and whether that model is on sale RIGHT NOW is never
--                                    stored here — /api/templates asks sellable_models() per request, and never names a
--                                    substitute (rule 4).
--   template-media (bucket)          public read, writes by the service key only (no storage policy grants an API role a write).
--                                    preview_asset_path / poster_path are paths inside it. Until Studio has made a template's
--                                    preview, both are NULL and the card draws its designed poster state: no stock or
--                                    third-party picture is ever used in its place.
--   set_creative_template_media()    a platform owner/admin (owner_guard, 0107: second factor, rate limit) or the SQL editor sets a
--                                    template's preview, poster and published switch, and one security_events row records a
--                                    change. A NULL path keeps the stored one ('' clears it), so unpublishing never loses the
--                                    media; a call that changes nothing writes nothing.
--
-- HONEST DEGRADATION. Without this migration /api/templates answers 503 "not_enabled" and the Trends page says so; it never
-- renders an empty gallery that reads as "there are no templates".
--
-- SEED. Ten templates, each written for a model that is on sale on the live database at the time of writing (the MiniMax H3
-- family for video, Ideogram for images). A seed row is inserted only when its model exists in model_registry (a database whose
-- registry was not synced gets fewer templates, not a foreign-key failure), and never overwrites a row that is already there
-- (on conflict do nothing), so re-applying this file cannot undo an owner's edit.
--
-- Additive only. Re-runnable: every statement is idempotent.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The table
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.creative_templates (
  id                  bigint generated always as identity primary key,
  slug                text not null unique,
  title               jsonb not null,
  description         jsonb not null,
  category            text not null,
  kind                text not null,
  prompt_template     text not null,
  model_id            text not null references public.model_registry (id) on update cascade on delete restrict,
  aspect              text not null,
  duration_s          integer,
  quality             text,
  director            jsonb not null default '{}'::jsonb,
  preview_asset_path  text,
  poster_path         text,
  sort                integer not null default 100,
  published           boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.creative_templates is
  'Trend templates (0181): ready formats for the Trends gallery. Anyone reads a published row; only the service key and set_creative_template_media() write. Whether model_id is on sale is asked of sellable_models() per request, never stored here.';

-- A slug is a URL segment (/api/templates/<slug>, ?template=<slug>): lower-case words joined by hyphens, at least two words.
-- The hyphen is required on purpose: the Studio's own starter ids share ?template= and are written with underscores
-- (lib/creative/templates.ts, yt_thumbnail), so a trend slug can never be read as a starter, or a starter as a trend.
alter table public.creative_templates drop constraint if exists creative_templates_slug_check;
alter table public.creative_templates add constraint creative_templates_slug_check
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)+$' and char_length(slug) <= 48);

-- Every user-visible string in three languages (CLAUDE.md): a row missing one would show a blank card in that language.
alter table public.creative_templates drop constraint if exists creative_templates_title_check;
alter table public.creative_templates add constraint creative_templates_title_check
  check (jsonb_typeof(title) = 'object'
         and jsonb_typeof(title -> 'en') = 'string' and char_length(title ->> 'en') between 1 and 80
         and jsonb_typeof(title -> 'ru') = 'string' and char_length(title ->> 'ru') between 1 and 80
         and jsonb_typeof(title -> 'uz') = 'string' and char_length(title ->> 'uz') between 1 and 80);
alter table public.creative_templates drop constraint if exists creative_templates_description_check;
alter table public.creative_templates add constraint creative_templates_description_check
  check (jsonb_typeof(description) = 'object'
         and jsonb_typeof(description -> 'en') = 'string' and char_length(description ->> 'en') between 1 and 240
         and jsonb_typeof(description -> 'ru') = 'string' and char_length(description ->> 'ru') between 1 and 240
         and jsonb_typeof(description -> 'uz') = 'string' and char_length(description ->> 'uz') between 1 and 240);

-- The gallery's chips. A new category is a migration and three dictionary entries, not a typo in a row.
alter table public.creative_templates drop constraint if exists creative_templates_category_check;
alter table public.creative_templates add constraint creative_templates_category_check
  check (category in ('business', 'story', 'lifestyle', 'text'));

alter table public.creative_templates drop constraint if exists creative_templates_kind_check;
alter table public.creative_templates add constraint creative_templates_kind_check
  check (kind in ('video', 'image'));

alter table public.creative_templates drop constraint if exists creative_templates_prompt_check;
alter table public.creative_templates add constraint creative_templates_prompt_check
  check (char_length(prompt_template) between 1 and 4000);

-- The shapes and lengths the Create screen offers today (lib/creative/studio.ts ASPECT_RATIOS, VIDEO_DURATIONS): a template that
-- asked for any other would prefill a form that cannot hold it.
alter table public.creative_templates drop constraint if exists creative_templates_aspect_check;
alter table public.creative_templates add constraint creative_templates_aspect_check
  check (aspect in ('16:9', '9:16', '1:1'));
alter table public.creative_templates drop constraint if exists creative_templates_duration_check;
alter table public.creative_templates add constraint creative_templates_duration_check
  check ((kind = 'video' and duration_s in (5, 10)) or (kind = 'image' and duration_s is null));

-- A video's resolution ("768p") or an image's quality tier ("high"); NULL when the model has no tiers.
alter table public.creative_templates drop constraint if exists creative_templates_quality_check;
alter table public.creative_templates add constraint creative_templates_quality_check
  check (quality is null or quality ~ '^[a-z0-9]{1,16}$');

alter table public.creative_templates drop constraint if exists creative_templates_director_check;
alter table public.creative_templates add constraint creative_templates_director_check
  check (jsonb_typeof(director) = 'object' and pg_column_size(director) <= 4096);

-- A path inside the template-media bucket: no scheme, no host, no "..", so the API can only ever build a URL to our own bucket.
alter table public.creative_templates drop constraint if exists creative_templates_media_path_check;
alter table public.creative_templates add constraint creative_templates_media_path_check
  check ((preview_asset_path is null or (preview_asset_path ~ '^[a-z0-9][a-z0-9_/-]{0,150}\.(mp4|webm)$'
                                          and position('..' in preview_asset_path) = 0 and position('//' in preview_asset_path) = 0))
     and (poster_path is null or (poster_path ~ '^[a-z0-9][a-z0-9_/-]{0,150}\.(webp|jpg|jpeg|png)$'
                                   and position('..' in poster_path) = 0 and position('//' in poster_path) = 0)));

alter table public.creative_templates drop constraint if exists creative_templates_sort_check;
alter table public.creative_templates add constraint creative_templates_sort_check
  check (sort between 0 and 100000);

create index if not exists creative_templates_published_sort_idx
  on public.creative_templates (sort, id) where published;
-- The foreign key's own index, so model_registry's cascade / restrict checks never scan the table.
create index if not exists creative_templates_model_id_idx on public.creative_templates (model_id);

create or replace function public.creative_templates_touch() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end
$$;
revoke all on function public.creative_templates_touch() from public, anon, authenticated, service_role;

drop trigger if exists creative_templates_touch on public.creative_templates;
create trigger creative_templates_touch before update on public.creative_templates
  for each row execute function public.creative_templates_touch();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Who reads, who writes
-- ───────────────────────────────────────────────────────────────────────────

alter table public.creative_templates enable row level security;

revoke all on table public.creative_templates from public, anon, authenticated, service_role;
grant select on table public.creative_templates to anon, authenticated;
grant select, insert, update, delete on table public.creative_templates to service_role;

-- A draft (published = false) is invisible to every API role but the service key: an unfinished template never reaches a card.
drop policy if exists creative_templates_read on public.creative_templates;
create policy creative_templates_read on public.creative_templates
  for select to anon, authenticated using (published);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The media bucket: public read (the gallery is marketing), no API-role write
-- ───────────────────────────────────────────────────────────────────────────

-- 50 MB is the free tier's per-object ceiling (CLAUDE.md "Known ceilings"); a card's preview is a few seconds.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('template-media', 'template-media', true, 52428800,
        array['video/mp4', 'video/webm', 'image/webp', 'image/jpeg', 'image/png'])
-- do nothing: re-applying this file must not undo a setting the owner later changed on the bucket.
on conflict (id) do nothing;

-- No insert / update / delete policy on storage.objects for this bucket: the service key (which bypasses RLS) uploads, nobody
-- else. A public bucket is served by URL without a select policy, so none is added either.

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The owner's one write: a template's preview, poster and published switch
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.set_creative_template_media(
  p_slug text,
  p_published boolean,
  p_preview_asset_path text default null,
  p_poster_path text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  invoker text := case when coalesce(current_setting('role', true), 'none') = 'none' then session_user::text
                       else current_setting('role', true) end;
  -- The SQL editor, as an ALLOW-list (as 0164 reads it): no API claims, not an API role, a member of postgres.
  editor  boolean := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
                     and invoker not in ('anon', 'authenticated', 'service_role', 'authenticator')
                     and pg_has_role(invoker::name, 'postgres', 'member');
  g       jsonb;
  old     public.creative_templates%rowtype;
  -- NULL keeps what is stored, '' clears it: "unpublish" alone must not wipe a preview Studio made.
  v_prev  text;
  v_post  text;
begin
  if not editor then
    -- Signed in and a platform owner/admin, else 42501 before anything is read; then the second factor and a rate limit.
    g := public.owner_guard('creative_templates', 30);
    if g is not null then
      return g;
    end if;
  end if;
  if p_slug is null or p_published is null then
    raise exception 'set_creative_template_media takes a slug and true or false' using errcode = '22023';
  end if;
  select * into old from public.creative_templates t where t.slug = p_slug for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  v_prev := case when p_preview_asset_path is null then old.preview_asset_path else nullif(p_preview_asset_path, '') end;
  v_post := case when p_poster_path is null then old.poster_path else nullif(p_poster_path, '') end;
  if old.published = p_published and old.preview_asset_path is not distinct from v_prev
     and old.poster_path is not distinct from v_post then
    -- A retry or a double press: nothing to change, nothing to audit (as 0164's switch).
    return jsonb_build_object('ok', true, 'slug', p_slug, 'published', p_published, 'changed', false);
  end if;
  -- The table's path CHECK refuses a bad path (23514); it is not caught, so the caller sees the refusal.
  update public.creative_templates
     set published = p_published, preview_asset_path = v_prev, poster_path = v_post
   where id = old.id;
  -- Not swallowed: a change that cannot be audited rolls back with it.
  perform public.security_event_log('creative_template.media', 'notice', p_slug,
    jsonb_build_object(
      'published', jsonb_build_object('from', old.published, 'to', p_published),
      'preview', jsonb_build_object('from', old.preview_asset_path, 'to', v_prev),
      'poster', jsonb_build_object('from', old.poster_path, 'to', v_post),
      'via', case when editor then 'sql_editor' else 'admin' end));
  return jsonb_build_object('ok', true, 'slug', p_slug, 'published', p_published, 'changed', true);
end
$$;

comment on function public.set_creative_template_media(text, boolean, text, text) is
  'Set a trend template''s preview, poster and published switch (0181). A platform owner/admin (owner_guard: second factor, 30 calls per 10 minutes) or the SQL editor; everyone else 42501. A NULL path keeps the stored one, an empty string clears it. A change writes one security_events row (creative_template.media); a call that changes nothing writes none.';

revoke all on function public.set_creative_template_media(text, boolean, text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_creative_template_media(text, boolean, text, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The seed: ten formats, each written for a model on sale at the time of writing
-- ───────────────────────────────────────────────────────────────────────────
-- Formats and structures only: no brand, no person, no copied script. Prompts are English in every language on purpose (the
-- models follow English best); titles and descriptions are translated. {placeholders} are what the person fills in.

insert into public.creative_templates
  (slug, title, description, category, kind, prompt_template, model_id, aspect, duration_s, quality, director, sort, published)
select v.slug, v.title::jsonb, v.description::jsonb, v.category, v.kind, v.prompt_template, v.model_id, v.aspect, v.duration_s,
       v.quality, v.director::jsonb, v.sort, true
  from (values
    ('product-ad-vertical',
     '{"en":"Product ad 9:16","ru":"Реклама товара 9:16","uz":"Mahsulot reklamasi 9:16"}',
     '{"en":"Three premium shots of your product: macro texture, slow turn, hero frame with room for a headline.","ru":"Три премиальных кадра товара: макро-фактура, медленный поворот и главный кадр с местом для заголовка.","uz":"Mahsulotingizning uchta premium kadri: makro tekstura, sekin aylanish va sarlavha uchun joy qoldirilgan asosiy kadr."}',
     'business', 'video',
     'Vertical cinematic product ad for {product}. Shot 1: extreme macro of the surface texture of {product} under a moving rim light. Shot 2: {product} turns slowly on a reflective pedestal, soft haze, premium studio backdrop in {brand_color}. Shot 3: hero frame, {product} centred, a light sweep across it, clean empty space at the top for a headline. Smooth dolly moves, shallow depth of field, high-end commercial look, no text, no logos.',
     'minimax-h3', '9:16', 10, '768p',
     '{"camera":"slow dolly and orbit","lighting":"moving rim light, soft haze","mood":"premium, calm","pacing":"three beats, about 3 s each"}',
     10),
    ('before-after-reveal',
     '{"en":"Before / after","ru":"До и после","uz":"Oldin va keyin"}',
     '{"en":"One locked-off frame, a clean wipe, and the transformation lands. Made for makeovers and results.","ru":"Один неподвижный кадр, чистая шторка — и преображение. Для ремонта, стиля и результатов.","uz":"Bitta qotirilgan kadr, toza oʻtish va oʻzgarish koʻrinadi. Taʼmir, uslub va natijalar uchun."}',
     'business', 'video',
     'Vertical before-and-after reveal. It opens on {before}, flat dull light, static camera. A clean vertical wipe sweeps left to right and reveals {after} in exactly the same framing, bright and polished, warm light. Locked-off camera so both states line up, a satisfying transformation, no text.',
     'minimax-h3', '9:16', 5, '768p',
     '{"camera":"locked off","lighting":"flat before, warm after","mood":"satisfying","pacing":"hold, wipe, hold"}',
     20),
    ('promo-poster-square',
     '{"en":"Promo poster","ru":"Промо-постер","uz":"Promo poster"}',
     '{"en":"A square poster with a bold headline and your product as the hero. For a feed post or a story.","ru":"Квадратный постер с крупным заголовком и вашим товаром в центре. Для ленты или сторис.","uz":"Katta sarlavha va markazda mahsulotingiz bilan kvadrat poster. Lenta yoki stories uchun."}',
     'business', 'image',
     'Square promo poster for {product}. A big bold headline that reads "{headline}". {product} as a crisp studio hero shot in the centre, a bold colour-block background in {brand_color}, a clean modern layout with a clear hierarchy, plenty of empty space, sharp readable typography, no logos.',
     'ideogram-4.5', '1:1', null, 'medium',
     '{"layout":"headline top, hero centre","palette":"one bold brand colour","type":"bold sans-serif"}',
     30),
    ('cinematic-intro',
     '{"en":"Cinematic intro","ru":"Кинематографичное интро","uz":"Kinematografik intro"}',
     '{"en":"A slow aerial push through fog that settles on an empty sky, ready for your title card.","ru":"Медленный пролёт сквозь туман, который останавливается на чистом небе — под ваш титр.","uz":"Tuman ichidan sekin parvoz va boʻsh osmonda toʻxtash — sarlavhangiz uchun tayyor."}',
     'story', 'video',
     'Cinematic channel intro for {channel_topic}. A slow aerial push through drifting fog over {setting} at blue hour, volumetric light beams, anamorphic lens flare, film grain, an epic mood. The camera rises and settles on a wide empty sky in the centre of the frame, leaving room for a title card. No text, no logos.',
     'minimax-h3-max', '16:9', 10, '768p',
     '{"camera":"aerial push-in, then rise","lighting":"blue hour, volumetric beams","mood":"epic","pacing":"one continuous move"}',
     40),
    ('faceless-story',
     '{"en":"Faceless story","ru":"История без лица","uz":"Yuzsiz hikoya"}',
     '{"en":"A moody scene of hands, silhouettes and places, with a calm lower third left for captions.","ru":"Атмосферная сцена: руки, силуэты и места, с пустой нижней третью под субтитры.","uz":"Qoʻllar, siluetlar va joylardan iborat atmosferali sahna, pastki qismi subtitr uchun boʻsh."}',
     'story', 'video',
     'Atmospheric faceless storytelling shot for a short about {story}. No faces visible: hands, silhouettes, objects and places only. Moody low-key lighting, a slow handheld drift, light dust in the air, a muted cinematic colour grade, a sense of mystery. Keep the lower third of the frame calm for captions.',
     'minimax-h3-lite', '9:16', 10, '768p',
     '{"camera":"slow handheld drift","lighting":"low key","mood":"mysterious","pacing":"slow","captions":"lower third kept calm"}',
     50),
    ('podcast-clip',
     '{"en":"Podcast clip","ru":"Клип подкаста","uz":"Podkast klipi"}',
     '{"en":"A warm studio, a broadcast microphone and a pulsing waveform: the backdrop for a clip of your episode.","ru":"Тёплая студия, микрофон и пульсирующая звуковая волна — фон для фрагмента вашего выпуска.","uz":"Iliq studiya, mikrofon va toʻlqinlanuvchi tovush chizigʻi — epizodingiz parchasi uchun fon."}',
     'story', 'video',
     'Vertical podcast-clip style shot: a cozy studio with a large broadcast microphone on a boom arm in the foreground, warm practical lamps, acoustic panels, soft bokeh. A slow push-in toward the microphone while a subtle glowing audio waveform pulses on a screen behind it. The episode is about {topic}. No people, no text, no logos.',
     'minimax-h3-highspeed', '9:16', 10, '768p',
     '{"camera":"slow push-in","lighting":"warm practicals","mood":"intimate","pacing":"steady"}',
     60),
    ('travel-montage',
     '{"en":"Travel montage","ru":"Тревел-монтаж","uz":"Sayohat montaji"}',
     '{"en":"Golden-hour streets, a sweeping skyline, steaming local food and a sunset wide, cut to a rhythm.","ru":"Улицы в золотой час, панорама города, местная еда и закат — в ритме монтажа.","uz":"Oltin soatdagi koʻchalar, shahar panoramasi, mahalliy taom va quyosh botishi — ritmli montajda."}',
     'lifestyle', 'video',
     'Vertical travel montage of {destination}: rhythmic cuts between a golden-hour street, a sweeping drone shot over the skyline, a close-up of steam rising from local food, and a wide landscape at sunset. Vibrant but natural colour, energetic match cuts, a handheld travel-vlog feel, nobody looking into the camera, no text.',
     'minimax-h3', '9:16', 10, '768p',
     '{"camera":"drone and handheld","lighting":"golden hour to sunset","mood":"energetic","pacing":"four quick beats"}',
     70),
    ('food-reveal',
     '{"en":"Food reveal","ru":"Подача блюда","uz":"Taom taqdimoti"}',
     '{"en":"Steam, a lifted lid and a slow pull-back to the dish. For a menu, a recipe or a new item.","ru":"Пар, поднятая крышка и медленный отъезд к блюду. Для меню, рецепта или новинки.","uz":"Bugʻ, koʻtarilgan qopqoq va taomga sekin uzoqlashish. Menyu, retsept yoki yangi taom uchun."}',
     'lifestyle', 'video',
     'Vertical food reveal of {dish}. It starts tight on rising steam, then the camera pulls back as a hand lifts a lid to reveal {dish} on a rustic table, warm side light, glistening textures, slow motion, an appetising close-up, shallow depth of field, no text.',
     'minimax-h3', '9:16', 5, '768p',
     '{"camera":"tight, then pull back","lighting":"warm side light","mood":"appetising","pacing":"slow motion"}',
     80),
    ('fact-card',
     '{"en":"Fact short card","ru":"Карточка с фактом","uz":"Fakt kartochkasi"}',
     '{"en":"A vertical \"Did you know?\" card: a bold headline, your fact in readable type and a striking illustration.","ru":"Вертикальная карточка «А вы знали?»: крупный заголовок, ваш факт и яркая иллюстрация.","uz":"Vertikal «Bilasizmi?» kartochkasi: katta sarlavha, faktingiz va yorqin rasm."}',
     'text', 'image',
     'Vertical "Did you know?" fact card. A large bold headline at the top that reads "DID YOU KNOW?". Below it, the fact in clean readable type: "{fact}". A striking illustration of {subject} fills the middle, flat bold colours, high contrast, generous margins, a modern editorial poster style.',
     'ideogram-4.5', '9:16', null, 'high',
     '{"layout":"headline, fact, illustration","palette":"flat, high contrast","type":"bold sans-serif"}',
     90),
    ('quote-poster',
     '{"en":"Motivational quote","ru":"Мотивационная цитата","uz":"Motivatsion iqtibos"}',
     '{"en":"Your words in elegant type over a cinematic scene, dark enough to stay readable.","ru":"Ваши слова элегантным шрифтом поверх кинематографичной сцены, достаточно тёмной для чтения.","uz":"Soʻzlaringiz kinematografik sahna ustida nafis shriftda, oʻqish uchun yetarlicha qorongʻi."}',
     'text', 'image',
     'Vertical motivational quote poster. The quote in large elegant serif type, centred: "{quote}". The background is {scene}, cinematic and slightly dark so the text stays readable, soft grain, a minimal layout, no signature, no logo.',
     'ideogram-4', '9:16', null, null,
     '{"layout":"centred quote","palette":"dark cinematic","type":"elegant serif"}',
     100)
  ) as v(slug, title, description, category, kind, prompt_template, model_id, aspect, duration_s, quality, director, sort)
  join public.model_registry m on m.id = v.model_id
on conflict (slug) do nothing;
