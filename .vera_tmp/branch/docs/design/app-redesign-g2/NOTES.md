# App redesign, group G2: channels and the library of ideas

Pages: Channels (and Add channel), All accounts, Unit economics (portfolio), Series, Topics, Memory, Styles, Models, Providers,
Integrations. They follow `docs/design/app-redesign-1/FOUNDATION.md`: `ns-open` on the page root, `PageHeader`, one desk and one
filled key per page, frames for media, lamps for status. Behaviour, billing, auth, the publish gate and every data read are as before.

## What each page is now

| Page | The desk (the lit thing) | The one filled key | What changed |
| :-- | :-- | :-- | :-- |
| Channels | the comparison of all channels | Add channel | channel marks on film tiles, one ruled section per channel (switches in words, health, YouTube, DNA, facts) instead of nested boxes |
| Add channel | the wizard | Create channel | steps as a rundown with an amber current step, fields at 44px |
| All accounts | the ledger of channels | none (a read-only screen) | figure strip, ledger that folds into labelled blocks on a phone |
| Unit economics | the per-channel ledger | none | same; "you are here" is a word in the dictionary, no longer a hard-coded English tag |
| Series | the new-series form | Create series | ruled rows with an edge number and a lamp, chips for platforms |
| Topics | the score ledger | none | score bar beside the number, demand as ruled rows with a count |
| Memory | what Nightshift has learned | none | findings as sentences with evidence under them, confidence as a lamp |
| Styles | search and filters | Use in Studio (in the sheet) | every style is a frame of film with its edge number and the honest "Palette preview" label |
| Models | the model you are reading (as before) | Use in Studio | open page, operator availability list as ruled rows instead of a card grid |
| Providers | YouTube connection | Connect YouTube | keys as one ruled row per provider; routing as rows with a real switch |
| Integrations | service health | none | lamps in a ruled list; workers as ruled rows |

## Pieces added

- `app/(app)/app-pages-g2.css`: ledger (`g2-ledger`, folds to labelled blocks below 768px, or 1024px for the eight-column ones),
  figure strip, switch, ruled rows, channel mark, key rows. Tokens only; nothing under 13px, capitalised or tracked.
- `components/g2/Figures.tsx`, `components/channels/ChannelMark.tsx`.
- Words: the portfolio lead, the Memory "not set up" and "no prediction" lines were written in capitals and are now sentences in
  en, ru and uz; the integrations row that named a model vendor now says what the step does.

Screenshots (webp; fake backend, `tools/visual-qa/fake-g2.mjs`; `before/` is the Foundation commit): `before/` and `after/`, 1440 and 390, light and dark, English; `after/` also
has Russian and Uzbek and the empty states.
