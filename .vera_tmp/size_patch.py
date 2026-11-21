def patch(p, pairs):
    s = open(p, encoding='utf-8').read()
    for old, new in pairs:
        assert s.count(old) >= 1, (p, old[:90])
        s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8', newline='\n').write(s)


# ── operations.ts: the key, its closed list, and the route's own check ──
patch('lib/creative/operations.ts', [
    ('''export function isImageQuality(v: unknown): v is ImageQuality {''',
     '''/**
 * 0208's `image_size` (t2i and edit only, optional): the size of a picture from a model that bills by it (registry
 * pricing.variants.by = image_size, one credit_prices row per size). The closed list is the registry schema's own. Whether THIS model
 * sells the size, and at what price, is the database's question; a model priced by size refuses a request that names none.
 */
export const IMAGE_SIZES = ["512", "1K", "2K", "4K"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export function isImageSize(v: unknown): v is ImageSize {
  return typeof v === "string" && (IMAGE_SIZES as readonly string[]).includes(v);
}

export function isImageQuality(v: unknown): v is ImageQuality {'''),
    ('''  "quality",
  "audio",
  "look",
] as const;''', '''  "quality",
  "audio",
  "look",
  // 0208
  "image_size",
] as const;'''),
    ('''  if (params.audio !== undefined) {''', '''  if (params.image_size !== undefined) {
    if (!(QUALITY_CAPABILITIES as readonly string[]).includes(capability))
      return { ok: false, result: fail(400, "invalid_params", { detail: `image_size does not apply to ${capability}` }) };
    if (!isImageSize(params.image_size))
      return { ok: false, result: fail(400, "invalid_params", { detail: `image_size must be one of ${IMAGE_SIZES.join(", ")}` }) };
  }
  if (params.audio !== undefined) {'''),
])

# ── studio.ts: the model's sizes, the effective size, the param ──
patch('lib/creative/studio.ts', [
    ('''  IMAGE_QUALITIES,''', '''  IMAGE_QUALITIES,
  IMAGE_SIZES,
  isImageSize,
  type ImageSize,'''),
    ('''export { IMAGE_QUALITIES, type ImageQuality, isImageQuality };''',
     '''export { IMAGE_QUALITIES, type ImageQuality, isImageQuality, IMAGE_SIZES, type ImageSize, isImageSize };

/**
 * 0208: the size a model priced by size is asked for: the one picked if this model sells it, else its smallest (the list is in the
 * schema's order, smallest first), shown in the picker and named in the quote, never left to the vendor's default. null = the model
 * is not priced by size, so none is sent (the database refuses a size on such a model).
 */
export function effectiveImageSize(
  model: Pick<StudioModel, "imageSizes"> | null | undefined,
  picked: ImageSize | null | undefined,
): ImageSize | null {
  const offered = model?.imageSizes ?? [];
  if (offered.length === 0) return null;
  return picked && offered.includes(picked) ? picked : offered[0];
}'''),
    ('''  qualities?: ImageQuality[];
  /**
   * 0070:''', '''  qualities?: ImageQuality[];
  /**
   * 0208: the picture sizes the model is sold by (spec.image_sizes, only when spec.pricing.variants.by is image_size), smallest
   * first; absent = it is not priced by size. Each size's price is asked of /api/creative/quote (the database).
   */
  imageSizes?: ImageSize[];
  /**
   * 0070:'''),
    ('''    const tiers = Array.isArray(spec.qualities) ? IMAGE_QUALITIES.filter((q) => (spec.qualities as unknown[]).includes(q)) : [];''',
     '''    const tiers = Array.isArray(spec.qualities) ? IMAGE_QUALITIES.filter((q) => (spec.qualities as unknown[]).includes(q)) : [];
    // 0208: the sizes, in the schema's order, only for a model whose price follows the size (any other model is sent no size).
    const sizes =
      spec.price_variants_by === "image_size" && Array.isArray(spec.image_sizes)
        ? IMAGE_SIZES.filter((s) => (spec.image_sizes as unknown[]).includes(s))
        : [];'''),
    ('''      ...(tiers.length ? { qualities: tiers } : {}),''', '''      ...(tiers.length ? { qualities: tiers } : {}),
      ...(sizes.length ? { imageSizes: sizes } : {}),'''),
    ('''  audio?: boolean | null;
  /**
   * The picked model takes no aspect ratio''', '''  audio?: boolean | null;
  /**
   * 0208: the picture's size, only for a picture tool whose model is priced by size (the panel passes the model's effective size,
   * else null). null / absent = the key is left out.
   */
  imageSize?: ImageSize | null;
  /**
   * The picked model takes no aspect ratio'''),
    ('''  const tiered = takesQuality(form.capability) && isImageQuality(form.quality) ? { ...styled, quality: form.quality } : styled;''',
     '''  const tiered = takesQuality(form.capability) && isImageQuality(form.quality) ? { ...styled, quality: form.quality } : styled;
  // A size likewise only for the picture tools, and never an unnamed one (0208 refuses a size on any other tool).
  const sized = takesQuality(form.capability) && isImageSize(form.imageSize) ? { ...tiered, image_size: form.imageSize } : tiered;'''),
    ('''  return takesSound(form.capability) && typeof form.audio === "boolean" ? { ...tiered, audio: form.audio } : tiered;''',
     '''  return takesSound(form.capability) && typeof form.audio === "boolean" ? { ...sized, audio: form.audio } : sized;'''),
])

# ── GeneratePanel ──
p = 'components/studio/GeneratePanel.tsx'
patch(p, [
    ('''  effectiveQuality,''', '''  effectiveQuality,
  effectiveImageSize,'''),
    ('''  type ImageQuality,''', '''  type ImageQuality,
  type ImageSize,'''),
    ('''  const [quality, setQuality] = useState<ImageQuality | null>(initial?.quality ?? null);''',
     '''  const [quality, setQuality] = useState<ImageQuality | null>(initial?.quality ?? null);
  // 0208: the picture size, for a model priced by size; the model's smallest until one is picked (shown, never implied).
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);'''),
    ('''  const effectiveQ = !routed && takesQuality(capability) ? effectiveQuality(current, quality) : null;''',
     '''  const effectiveQ = !routed && takesQuality(capability) ? effectiveQuality(current, quality) : null;
  // A size only for a picture tool on a model priced by size; another model never gets one.
  const effectiveSize = !routed && takesQuality(capability) ? effectiveImageSize(current, imageSize) : null;'''),
    ('''    quality: effectiveQ,
    audio: effectiveSnd,
    noAspect: shapeless,
  };''', '''    quality: effectiveQ,
    audio: effectiveSnd,
    imageSize: effectiveSize,
    noAspect: shapeless,
  };'''),
    ('''        quality: effectiveQ,
        audio: effectiveSnd,
        noAspect: shapeless,
      }),
    [capability, prompt, effectiveAspect, effectiveSeconds, effectiveRes, sourceId, factor, effectiveStyle, voiceId, targetLanguage, effectiveEnd, effectiveTarget, effectiveShape, effectiveLook, describeLanguage, effectiveQ, effectiveSnd, shapeless],''',
     '''        quality: effectiveQ,
        audio: effectiveSnd,
        imageSize: effectiveSize,
        noAspect: shapeless,
      }),
    [capability, prompt, effectiveAspect, effectiveSeconds, effectiveRes, sourceId, factor, effectiveStyle, voiceId, targetLanguage, effectiveEnd, effectiveTarget, effectiveShape, effectiveLook, describeLanguage, effectiveQ, effectiveSnd, effectiveSize, shapeless],'''),
    ('''    settingsFor: sheetSettings,''', '''    settingsFor: withSizes(sheetSettings, takesQuality(capability) ? available.map((m) => [m.id, effectiveImageSize(m, imageSize)]) : []),'''),
])

s = open(p, encoding='utf-8').read()
anchor = '''  const soundBlock = soundChoice ? ('''
assert anchor in s
s = s.replace(anchor, '''  // 0208: the picked model's sizes; the price of the picked one is the quote's (the database's), never a number from here.
  const sizes: readonly ImageSize[] = takesQuality(capability) && !locked ? (current?.imageSizes ?? []) : [];
  const sizeBlock =
    sizes.length > 0 && effectiveSize ? (
      <div className="flex flex-col gap-2" data-testid="gen-size">
        <span className="studio-label" id="gen-size-label">
          {t.gen.sizeLabel}
        </span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="gen-size-label">
          {sizes.map((z) => (
            <button
              key={z}
              type="button"
              data-testid={`gen-size-${z}`}
              aria-pressed={effectiveSize === z}
              onClick={() => {
                setImageSize(z);
                edited();
              }}
              className="studio-chip"
            >
              {z}
            </button>
          ))}
        </div>
        <span className="text-xs text-[var(--color-muted)]">{t.gen.sizeNote}</span>
      </div>
    ) : null;

''' + anchor, 1)
assert s.count('{qualityBlock}') == 2
s = s.replace('{qualityBlock}', '{qualityBlock}\n            {sizeBlock}', 1)
i = s.index('{qualityBlock}', s.index('{sizeBlock}'))
s = s[:i] + '{qualityBlock}\n          {sizeBlock}' + s[i + len('{qualityBlock}'):]
# the helper, at the end of the file
s = s.rstrip('\n') + '''

/**
 * 0208: each model's own size merged into the sheet's per-model settings: a model priced by size is asked at its effective size, and
 * every other model with the key left out (null), so the form's size never reaches a model that is not sold by size.
 */
function withSizes(
  settings: Record<string, Record<string, string | number | null>> | undefined,
  sizes: Array<[string, ImageSize | null]>,
): Record<string, Record<string, string | number | null>> | undefined {
  if (sizes.length === 0) return settings;
  const out: Record<string, Record<string, string | number | null>> = { ...(settings ?? {}) };
  for (const [id, size] of sizes) out[id] = { ...(out[id] ?? {}), image_size: size };
  return out;
}
'''
open(p, 'w', encoding='utf-8', newline='\n').write(s)

# ── i18n ──
for lang, label, note in (
    ('en', 'Size', 'A bigger picture costs more credits. The price shown is for the size picked.'),
    ('ru', 'Размер', 'Чем больше картинка, тем больше кредитов. Цена указана за выбранный размер.'),
    ('uz', 'Oʻlcham', 'Rasm qanchalik katta boʻlsa, shuncha koʻp kredit sarflanadi. Narx tanlangan oʻlcham uchun.'),
):
    f = 'lib/i18n/%s.ts' % lang
    t = open(f, encoding='utf-8').read()
    key = '    qualityNote: '
    i = t.index(key)
    j = t.index('\n', i)
    t = t[:j + 1] + '    sizeLabel: "%s",\n    sizeNote: "%s",\n' % (label, note) + t[j + 1:]
    open(f, 'w', encoding='utf-8', newline='\n').write(t)
print('ok')
