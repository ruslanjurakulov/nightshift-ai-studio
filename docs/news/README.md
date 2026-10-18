# News items (what the Telegram channel may announce)

One file per change that could be announced, added **in the pull request that ships it**:

    docs/news/<yyyy-mm-dd>-<slug>.json        e.g. 2026-10-15-editor-shapes.json

The date is the day the change reached the live product (the file name and `shipped` must
agree). The slug becomes the post's idempotency key (`news:<slug>`), so it is unique and never
reused. The whole feature is described in [`docs/MARKETING_POSTS.md`](../MARKETING_POSTS.md).

Nothing here is posted by itself. A file is only the *source text*. A person approves every
post, one by one, on the owner page (which is a later change). The marketing worker (off by default) reads these files
and drafts the `public: true` ones, but **only while `shipped` is at most 30 days old**: set `public: true` within 30 days of
shipping, or edit the date (and the file name) to announce it later.

## The file

```json
{
  "pr": 484,
  "shipped": "2026-10-15",
  "kind": "feature",
  "public": false,
  "text": {
    "uz": "...",
    "ru": "...",
    "en": "..."
  },
  "link": "/pricing",
  "media": { "hint": "A phone screenshot of the message, chat name hidden." }
}
```

| Key | Required | Meaning |
|---|---|---|
| `pr` | yes | The pull request that shipped the change. Not announced twice. |
| `shipped` | yes | `yyyy-mm-dd`, equal to the file name's date; not in the future. |
| `kind` | yes | `feature` or `fix`. |
| `public` | yes | `true` only when a human decided this may be announced. Without `true` a file is never announceable, and a missing key is an error, not a "no". Security work is `false` by default. |
| `text.uz`, `text.ru`, `text.en` | yes | Plain text, 20 to 260 characters each, the same facts in all three languages. Uzbek in Latin letters. No markup, no URL, no new line. |
| `link` | no | A path on our own site (`/pricing`), never a full URL. |
| `media` | no | `{"hint": "..."}` for the owner. Nothing is ever attached automatically. |

[`schema.json`](schema.json) is the machine-readable shape. The validator of record is
`tests/test_news_format.py`: it runs over every file in this folder in CI, and it also checks
what a schema cannot say (each language in its own script, the numbers, the banned wording).

## How a post looks

One Telegram message with three labelled blocks, then the link:

    Oʻzbekcha
    <uz>

    Русский
    <ru>

    English
    <en>

    <our site><link>

The per-language limit is chosen so that the whole message, with labels and link, also fits a
1024-character media caption. The test enforces both that and Telegram's 4096-character limit.

## Rules for the words

1. **Facts a reader can check.** Write what the product does today, in plain sentences. Every
   claim should be visible in the diff of the pull request named in `pr`.
2. **Numbers are the same in every language.** The test compares them.
3. **The free plan is a one-time welcome grant.** The real figure is 100 credits, given once
   to a new account (migration 0027, `docs/BILLING_PLANS.md`). Say that. Never write
   "free", "free forever" or "free plan". A text that mentions the welcome grant must contain
   `100` and say it is one-time (the test checks).
4. **Plans are called Plus and Business** (migration 0095). Do not put a money amount in a
   text: prices are not in the database, only Paddle and the owner-typed display price know
   them, and "no price in this repository is a fact".
5. **No provider or model name** until a real call through its adapter has succeeded (the
   Definition of Done in `CLAUDE.md`). The list of names is in `banned-claims.json`; remove a
   name in the same pull request that announces it, with the evidence in the description.
6. **No promise about results**: no income, views, reach or subscribers, no "guaranteed",
   "unlimited", "best", "fastest", "forever", "100%", and no sign that YouTube, Google,
   Telegram, Instagram or TikTok approves or partners with us.
7. **No security fix is news by default.** Describing a hole before every deployment has the
   fix tells an attacker where to look. `public: true` on a security item needs the owner's
   explicit word.
8. **The Russian and Uzbek wording is a draft** (the existing notification wording is too). The
   owner reads all three before approving; a native reader is still wanted.

## Banned claims

[`banned-claims.json`](banned-claims.json) holds one rule per kind of claim (`free`,
`unlimited`, `guarantee`, `superlative`, `income`, `views`, `certainty`, `endorsement`) with
patterns in English, Russian and Uzbek, and the provider and model names. It is blunt on
purpose: a false positive costs one rewording, a false negative is a public claim we cannot
back. To add a pattern, add it to the JSON; `tests/test_news_format.py` requires a sample
sentence for every rule, so a rule that never fires cannot be added by accident. The same list
is meant to guard the price-post and showcase templates in later changes.

## Adding an item

1. Copy the example (`2026-10-15-example-editor-shapes.json`, `public: false`).
2. Write the three texts. Keep `public` false until the change is live and you want it announced.
3. `python3 -m unittest tests.test_news_format` and fix what it says.
4. In the pull request description, say who decided `public`.

`*.json` is ignored by this repository (credentials), and `.gitignore` re-includes
`docs/news/*.json`; a test fails if that line is removed.
