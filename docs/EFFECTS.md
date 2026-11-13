# Effects

**Effects** are named, one-press starting points for a clip ("Product burst", "Giant in the city" …): each is a prompt written for
the video models we run, a shape, a length, and the models it is written for in order of preference. The data is
`command-center/lib/effects/effects.json` (loaded and checked by `command-center/lib/effects/catalog.ts`); the names and one-line
descriptions are in `command-center/lib/i18n/effects/{en,ru,uz}.ts`. The prompts are English on purpose, like the Studio templates.

An effect only **fills the Studio's video form** (CLAUDE.md #3). It has no price, no spend path and no run of its own:
`/<channel>/create?tool=<t2v|i2v>&effect=<id>` opens the ordinary composer with the words, the model, the shape and the length in
it, and the person still presses Generate and sees the database's quote and hold.

Where it shows:

- **Studio → Effects** (`/<channel>/create?desk=effects`): one card per effect, with the model it will use *in this workspace*.
  That model is the first of the effect's models that the workspace is offered (the same list the composer gets: sellable,
  probe-verified, not switched off, not geo-blocked; plus the operator's previews in the operator's own organization). When none
  is, the card says "Not open here yet" and its button is disabled, and a link to the effect shows a banner that says so and
  fills nothing. An effect is never pointed at a model it was not written for (CLAUDE.md #4, #5).
- **The public site** (`components/site/EffectsGallery.tsx`, mounted on the landing right after the model samples): the same
  cards without any model name (the public site names none, `command-center/tests/helpers/brands.ts`); "Use this effect" is
  sign-up, then the Studio form.

Until an effect has a real sample its card shows a flat drawing in the effect's colours and says, in words, "No sample yet: this
is a drawing, not a result". It moves only while on screen, never under reduced motion, and stops with the site's "Pause motion".

## Availability today

Every effect lists the MiniMax H3 family and/or Runway Gen-4.5 / Gen-4 Turbo first; all of those are `operator_preview` in
`schemas/model_registry.json` today, so only the operator's own workspace is offered them. The last model on every list is
`minimax-hailuo-2.3` (no terms gate, not a preview, takes both tools, 6 or 10 s): a customer workspace sees an effect as open
only once that model is verified by a probe and on sale there, and its card then names it and says the first choice is not open.
Effects default to **10 s** because that is the one Studio length every listed model takes.

## Making an effect's preview (the operator's steps)

The preview is a real generation of the effect's own words, exported with the Showcase workflow (`docs/SHOWCASE.md`). A sample is
shown as an effect's preview only when its job was a clip of the effect's tool, by one of the effect's models, given **exactly**
the effect's words (a words effect: with any subject in its slot) — `isEffectPrompt` in `catalog.ts`; anything else is ignored
and the drawing stays.

1. Sign in as the operator, in the operator's own workspace. Studio → **Effects** → the effect → **Use this effect**. The card and
   the banner name the model; it should be the first choice listed below (the operator is offered the previews).
2. A words effect: type the subject below into the banner's field and press **Put it in**. A picture effect: pick the input picture
   in the form. It must be ours (docs/SHOWCASE.md): one of the site's AI pictures (`command-center/components/site/art/*.webp`,
   uploaded unchanged) or a picture made in the Studio. For the two product effects, make a product still first in Studio →
   Image → New picture, for example `Clean studio photo of a glass perfume bottle on a soft gradient background, gentle shadow,
   sharp focus, catalogue style` (1:1 for Product burst, 9:16 for Liquid reveal). No stock photograph, no photo of a real person.
3. Do not edit the description, do not pick a style kit. Press **Generate** (the price shows first, as for any clip).
4. When it is done, copy the job id (docs/SHOWCASE.md step 2) and run **Actions → Showcase asset** with it. Merge its PR.
5. In a small PR, set the effect's `previewJobId` in `command-center/lib/effects/effects.json` to that job id. The tests
   (`command-center/tests/effects-catalog.test.ts`) fail unless the id is a merged showcase entry of the right tool, model and words.

One export at a time (docs/SHOWCASE.md: every export edits the same two files).

## The parameters, per effect

### `photo-to-life`

| | |
|:--|:--|
| Tool | Video → From a picture (i2v) |
| Model (first choice) | `runway-gen4.5` |
| Other models, in order | `minimax-h3`, `runway-gen4-turbo`, `minimax-hailuo-2.3` |
| Shape | the picture's (make the input 9:16) |
| Length | 10 s |
| Subject | (none: the picture is the subject) |

Prompt, exactly as the effect fills it:

```text
Bring this exact photo to life as a short real-camera shot. Everything in it moves naturally and subtly: hair and clothes stir in a light breeze, eyes blink, leaves and water move, the light shifts a little. The camera drifts slowly forward. Keep every face, body, colour, outfit and detail of the photo exactly as it is; no new people or objects, no morphing, no cuts, no text.
```

### `product-burst`

| | |
|:--|:--|
| Tool | Video → From a picture (i2v) |
| Model (first choice) | `minimax-h3` |
| Other models, in order | `runway-gen4.5`, `minimax-hailuo-2.3` |
| Shape | the picture's (make the input 1:1) |
| Length | 10 s |
| Subject | (none: the picture is the subject) |

Prompt, exactly as the effect fills it:

```text
The product in this picture stands centred on a clean studio backdrop. On a sharp beat it bursts apart into thousands of glossy paint droplets and fine glittering particles in its own colours, which swirl around in slow motion, then rush back together and snap into the intact product again. Crisp rim light, macro detail, static camera, seamless loop. Keep the product's shape, label and colours exactly as in the picture; no added text, no extra objects.
```

### `liquid-reveal`

| | |
|:--|:--|
| Tool | Video → From a picture (i2v) |
| Model (first choice) | `minimax-h3` |
| Other models, in order | `runway-gen4.5`, `minimax-hailuo-2.3` |
| Shape | the picture's (make the input 9:16) |
| Length | 10 s |
| Subject | (none: the picture is the subject) |

Prompt, exactly as the effect fills it:

```text
A ribbon of glossy liquid, like molten chrome with deep colour inside it, rises from below and wraps the product in this picture in one smooth spiral, hiding it for a moment, then slides away and drips off to reveal the product clean and gleaming. Slow, elegant motion, soft studio light with bright specular highlights, dark seamless background, the camera orbits a quarter turn. Keep the product's shape, label and colours exactly as in the picture; no added text.
```

### `giant-in-the-city`

| | |
|:--|:--|
| Tool | Video → From words (t2v) |
| Model (first choice) | `minimax-h3` |
| Other models, in order | `runway-gen4.5`, `minimax-hailuo-2.3` |
| Shape | 9:16 |
| Length | 10 s |
| Subject | `a ginger cat` |

Prompt, exactly as the effect fills it:

```text
Vertical phone video filmed by a passer-by at street level on a busy city avenue: a ginger cat, at colossal scale and taller than the buildings, walks slowly down the street between the towers. Cars stop, tiny people look up and point, pigeons scatter. Handheld camera with natural shake that tilts up to follow it, bright slightly overexposed daylight, believable scale and real-world physics, photoreal. No text, no captions.
```

### `snow-globe`

| | |
|:--|:--|
| Tool | Video → From words (t2v) |
| Model (first choice) | `minimax-h3` |
| Other models, in order | `minimax-hailuo-2.3` |
| Shape | 1:1 |
| Length | 10 s |
| Subject | `a lighthouse on a rocky island` |

Prompt, exactly as the effect fills it:

```text
Close-up of a glass snow globe on a wooden table by a window at dusk. Inside the globe is a tiny, perfectly detailed miniature world of a lighthouse on a rocky island. A hand gently lifts the globe and shakes it; snowflakes swirl around the miniature and slowly settle while warm fairy lights glow in the background bokeh. Macro lens, shallow depth of field, soft cinematic light, realistic glass refraction, cosy mood. No text.
```

### `orbit-to-street`

| | |
|:--|:--|
| Tool | Video → From words (t2v) |
| Model (first choice) | `runway-gen4.5` |
| Other models, in order | `minimax-h3`, `minimax-hailuo-2.3` |
| Shape | 16:9 |
| Length | 10 s |
| Subject | `the old town of Bukhara` |

Prompt, exactly as the effect fills it:

```text
One continuous camera move with no cuts: the shot opens in orbit high above the Earth at sunrise, then dives straight down through thin clouds, over the landscape and the rooftops, and lands smoothly at street level in the old town of Bukhara, ending on a calm eye-level view of everyday life there. Smooth motion that accelerates and then slows gently at the end, realistic geography and light, photoreal, cinematic. No text, no map labels.
```

### `satisfying-macro`

| | |
|:--|:--|
| Tool | Video → From words (t2v) |
| Model (first choice) | `minimax-h3` |
| Other models, in order | `minimax-hailuo-2.3` |
| Shape | 1:1 |
| Length | 10 s |
| Subject | `glossy pink clay` |

Prompt, exactly as the effect fills it:

```text
Extreme macro close-up, oddly satisfying: glossy pink clay sculpts itself on a clean turntable. It flows, folds and smooths into a perfect symmetrical shape with crisp edges, as if shaped by invisible hands, then holds still for a beat. Slow, smooth, continuous motion, soft diffused studio light, rich texture detail, shallow depth of field, calm and hypnotic, seamless loop. No hands, no tools, no text.
```

### `time-freeze`

| | |
|:--|:--|
| Tool | Video → From words (t2v) |
| Model (first choice) | `runway-gen4.5` |
| Other models, in order | `minimax-h3`, `minimax-hailuo-2.3` |
| Shape | 16:9 |
| Length | 10 s |
| Subject | `a skateboarder mid-jump over a puddle` |

Prompt, exactly as the effect fills it:

```text
A frozen moment in time: a skateboarder mid-jump over a puddle, completely still in mid-action, with droplets, dust and hair hanging motionless in the air. The camera makes one smooth 360-degree orbit around the frozen scene at eye level, showing it from every side, while nothing in the scene moves. Crisp detail, cinematic lighting, shallow depth of field, photoreal, no motion blur, no text.
```

