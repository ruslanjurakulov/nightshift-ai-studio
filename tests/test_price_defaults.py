"""docs/sql/prices_defaults_2026_10_03.sql — the owner-apply file that gives every
chargeable unit without a price a starting value.

No database, no network: the file is parsed as text. What must hold:

* it is an insert into credit_prices that can never overwrite (``on conflict
  (unit) do nothing``) and contains no other statement;
* it does not repeat a unit the earlier price files / migrations seed (it would
  be a silent no-op or, worse, a second opinion on a price already chosen);
* every number is positive, every note fits credit_prices_note_check, and the
  ``est.:`` notes are exactly the declared guesses;
* every unit in it is one the code can actually charge (the registry's credit
  units and their priced variants, or a product unit a migration reads), so no
  row is dead weight;
* every chargeable registry unit is either seeded somewhere or on a short,
  reasoned list of units left unpriced on purpose, so a new model cannot slip
  in without a price or a decision.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from modules import model_registry as reg

ROOT = Path(__file__).resolve().parent.parent
SQL = ROOT / "docs" / "sql"
SCRIBE = SQL / "prices_scribe_2026_11_14.sql"
MIGRATIONS = ROOT / "supabase" / "migrations"
DEFAULTS = SQL / "prices_defaults_2026_10_03.sql"

#: Earlier files that seed credit_prices, in apply order.
EARLIER_SEEDS = (
    SQL / "prices_2026_10_01.sql",
    SQL / "prices_corrections_2026_10_01.sql",
    MIGRATIONS / "0030_paid_downloads.sql",
    MIGRATIONS / "0070_video_price_variants.sql",
)

UNIT_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")  # credit_prices_unit_check
ROW_RE = re.compile(
    r"\(\s*'(?P<unit>[a-z0-9_]+)'\s*,\s*(?P<rate>[0-9]+(?:\.[0-9]+)?)\s*,\s*(?P<margin>[0-9]+(?:\.[0-9]+)?)\s*,"
    r"\s*'(?P<note>(?:[^']|'')*)'\s*\)"
)

#: The units this file prices, and the ones it guesses (their note says est.:).
EXPECTED_COUNT = 11
EXPECTED_ESTIMATES = {
    "model_openai_gpt_image_2_5_flare_image_low",
    "model_openai_gpt_image_2_5_sunburst_image_low",
    "model_elevenlabs_scribe_v2_second",
    "repurpose_clip",
}

#: Chargeable units left without a price ON PURPOSE, each with the reason.
UNPRICED_ON_PURPOSE = {
    # S10 (2026-11-20): hidden until a probe passes; the owner sets these rows in the database only (0194 / 0195 open a model
    # only once its rows exist), so no price file in the repository names them.
    "model_openai_gpt_image_2_6_sunburst_image": "priced in the database only (S10); hidden until then",
    "model_openai_gpt_image_2_6_sunburst_image_low": "priced in the database only (S10); hidden until then",
    "model_openai_gpt_image_2_6_sunburst_image_medium": "priced in the database only (S10); hidden until then",
    "model_openai_gpt_image_2_6_sunburst_image_high": "priced in the database only (S10); hidden until then",
    "model_openai_gpt_image_2_6_flare_image": "priced in the database only (S10); hidden until then",
    "model_openai_gpt_image_2_6_flare_image_low": "priced in the database only (S10); hidden until then",
    "model_openai_gpt_image_2_6_flare_image_medium": "priced in the database only (S10); hidden until then",
    "model_openai_gpt_image_2_6_flare_image_high": "priced in the database only (S10); hidden until then",
    "model_anthropic_claude_sonnet_5_5_request": "priced in the database only (S10); hidden until then",
    "model_openai_gpt_6_luna_request": "priced in the database only (S10); hidden until then",
    "video_minute": "held back (Lens-380): publishes the public rate and starts paid runs; owner applies when ready",
    "reply_draft": "held back (Lens-380): the comment inbox is the last deploy step",
    "scene_regenerate": "held back (Lens-380): the worker and 0076/0085 first",
    "scene_regenerate_clip_kling": "held back (Lens-380): per-clip unit loses money on a long clip",
    "scene_regenerate_clip_veo": "held back (Lens-380): per-clip unit loses money on a long clip",
    "scene_regenerate_clip_seedance": "held back (Lens-380): per-clip unit loses money on a long clip",
    "scene_regenerate_clip_wan": "held back (Lens-380): per-clip unit loses money on a long clip",
    "scene_regenerate_clip_minimax": "its default model has no price in the repository",
    "scene_regenerate_clip_higgsfield": "its default model has no price in the repository",
    "model_seedance_1_5_pro_second_480p_silent": "registry: no price read, not sold",
    "model_seedance_1_5_pro_second_480p_audio": "registry: no price read, not sold",
    "model_seedance_1_5_pro_second_1080p_silent": "registry: no price read, not sold",
    "model_seedance_2_0_second": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_seedance_2_0_second_480p": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_seedance_2_0_second_720p": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_seedance_2_0_second_1080p": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_seedance_2_5_second": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_seedance_2_5_second_480p": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_seedance_2_5_second_720p": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_seedance_2_5_second_1080p": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_seedream_5_0_pro_image": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_seedream_5_0_flash_image": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_seedream_4_5_image": "registry: ByteDance first-party, terms-gated (written_consent_required) and unpriced; the owner prices it only after BytePlus authorises resale in writing",
    "model_gemini_2_5_flash_image_expand_image": "registry: picture op (0099), unverified and gated; the owner sets a price when a probe has proven it",
    "model_gemini_2_5_flash_image_relight_image": "registry: picture op (0099), unverified and gated; the owner sets a price when a probe has proven it",
    "model_gemini_2_5_flash_image_erase_image": "registry: picture op (0099), unverified and gated; the owner sets a price when a probe has proven it",
    "model_krea_3_image": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_krea_3_regional_image": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_5_pro_second": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_5_pro_second_720p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_5_pro_second_1080p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_5_pro_second_1440p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_5_pro_second_4k": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_5_fast_second": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_5_fast_second_720p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_5_fast_second_1080p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_5_fast_second_1440p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_5_fast_second_4k": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_3_pro_second": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_3_pro_second_720p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_3_pro_second_1080p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_3_pro_second_1440p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_3_pro_second_4k": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_3_fast_second": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_3_fast_second_720p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_3_fast_second_1080p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_3_fast_second_1440p": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_ltx_2_3_fast_second_4k": "registry: first-party, terms-gated (terms_review_required: only consumer terms exist for Krea; the LTX licence bars resale or similar models) and unpriced; the owner prices it only after a person has settled the terms",
    "model_luma_uni_1_image": "registry: Luma first-party, terms-gated (written_consent_required, as Ray 3.2) and unpriced; the owner prices it only after Luma authorises resale in writing",
    "model_luma_uni_1_max_image": "registry: Luma first-party, terms-gated (written_consent_required, as Ray 3.2) and unpriced; the owner prices it only after Luma authorises resale in writing",
    "model_generic_video_edit_second": "registry: video op (0100), unverified and gated; the owner sets a price when a probe has proven it",
    "model_generic_video_reframe_second": "registry: video op (0100), unverified and gated; the owner sets a price when a probe has proven it",
    "model_generic_video_remove_bg_second": "registry: video op (0100), unverified and gated; the owner sets a price when a probe has proven it",
    "model_assemblyai_universal_2_second": "registry: no price read, not sold (terms not reviewed)",
    "model_flux_3_image_image": "registry: FLUX 3 first-party, terms-gated (terms_review_required: BFL training licence on Input and Output, API Terms 2(b)) and unpriced; the owner prices it only after a person has decided",
    "model_flux_3_image_klein_image": "registry: FLUX 3 first-party, terms-gated (terms_review_required: BFL training licence on Input and Output, API Terms 2(b)) and unpriced; the owner prices it only after a person has decided",
    "model_recraft_v4_1_image": "registry: Recraft first-party, terms-gated (terms_review_required: Developer Terms 3.7 no-substitution, 3.2(x) competing services) and unpriced; the owner prices it only after a person has decided",
    "model_recraft_v4_1_flash_image": "registry: Recraft first-party, terms-gated (terms_review_required: Developer Terms 3.7 no-substitution, 3.2(x) competing services) and unpriced; the owner prices it only after a person has decided",
    "model_grok_imagine_video_1_5_second": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_grok_imagine_video_1_5_second_480p": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_grok_imagine_video_1_5_second_720p": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_grok_imagine_video_1_5_second_1080p": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_grok_imagine_video_1_5_lite_second": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_grok_imagine_video_1_5_lite_second_480p": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_grok_imagine_video_1_5_lite_second_720p": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_grok_imagine_video_1_5_lite_second_1080p": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_grok_imagine_image_2_0_image": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_grok_imagine_image_2_0_image_low": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_grok_imagine_image_2_0_image_medium": "registry: xAI first-party, terms-gated (terms_review_required: the xAI terms were not readable) and unpriced; the owner prices it only after a person has read them",
    "model_happyhorse_1_1_second": "registry: Alibaba Cloud first-party, terms-gated (written_consent_required: Product Terms 4.48.1(d)(v) bars resale) and unpriced; the owner prices it only after Alibaba Cloud authorises resale in writing",
    "model_happyhorse_1_1_second_480p": "registry: Alibaba Cloud first-party, terms-gated (written_consent_required: Product Terms 4.48.1(d)(v) bars resale) and unpriced; the owner prices it only after Alibaba Cloud authorises resale in writing",
    "model_happyhorse_1_1_second_720p": "registry: Alibaba Cloud first-party, terms-gated (written_consent_required: Product Terms 4.48.1(d)(v) bars resale) and unpriced; the owner prices it only after Alibaba Cloud authorises resale in writing",
    "model_happyhorse_1_1_second_1080p": "registry: Alibaba Cloud first-party, terms-gated (written_consent_required: Product Terms 4.48.1(d)(v) bars resale) and unpriced; the owner prices it only after Alibaba Cloud authorises resale in writing",
    "model_qwen_image_2_1_pro_image": "registry: Alibaba Cloud first-party, terms-gated (written_consent_required: Product Terms 4.48.1(d)(v) bars resale) and unpriced; the owner prices it only after Alibaba Cloud authorises resale in writing",
    "model_qwen_image_2_1_turbo_image": "registry: Alibaba Cloud first-party, terms-gated (written_consent_required: Product Terms 4.48.1(d)(v) bars resale) and unpriced; the owner prices it only after Alibaba Cloud authorises resale in writing",
    "model_z_image_turbo_image": "registry: Alibaba Cloud first-party, terms-gated (written_consent_required: Product Terms 4.48.1(d)(v) bars resale) and unpriced; the owner prices it only after Alibaba Cloud authorises resale in writing",
    "model_minimax_h3_second": "registry: MiniMax H3 first-party, terms cleared 2026-11-13 on MiniMax's written answer (revenue thresholds far off) but unpriced: an operator-only trial, nothing on sale; the owner sets the price",
    "model_minimax_h3_second_768p": "registry: MiniMax H3 first-party, terms cleared 2026-11-13 on MiniMax's written answer (revenue thresholds far off) but unpriced: an operator-only trial, nothing on sale; the owner sets the price",
    "model_minimax_h3_second_2k": "registry: MiniMax H3 first-party, terms cleared 2026-11-13 on MiniMax's written answer (revenue thresholds far off) but unpriced: an operator-only trial, nothing on sale; the owner sets the price",
    "model_minimax_h3_highspeed_second": "registry: MiniMax H3 first-party, terms cleared 2026-11-13 on MiniMax's written answer (revenue thresholds far off) but unpriced: an operator-only trial, nothing on sale; the owner sets the price",
    "model_minimax_h3_highspeed_second_768p": "registry: MiniMax H3 first-party, terms cleared 2026-11-13 on MiniMax's written answer (revenue thresholds far off) but unpriced: an operator-only trial, nothing on sale; the owner sets the price",
    "model_minimax_h3_highspeed_second_480p": "registry: MiniMax H3 first-party, terms cleared 2026-11-13 on MiniMax's written answer (revenue thresholds far off) but unpriced: an operator-only trial, nothing on sale; the owner sets the price",
    "model_minimax_h3_lite_second": "registry: MiniMax H3 first-party, terms cleared 2026-11-13 on MiniMax's written answer (revenue thresholds far off) but unpriced: an operator-only trial, nothing on sale; the owner sets the price",
    "model_minimax_h3_lite_second_480p": "registry: MiniMax H3 first-party, terms cleared 2026-11-13 on MiniMax's written answer (revenue thresholds far off) but unpriced: an operator-only trial, nothing on sale; the owner sets the price",
    "model_minimax_h3_lite_second_768p": "registry: MiniMax H3 first-party, terms cleared 2026-11-13 on MiniMax's written answer (revenue thresholds far off) but unpriced: an operator-only trial, nothing on sale; the owner sets the price",
    "model_minimax_h3_max_second": "registry: MiniMax H3 first-party, terms-gated (terms_review_required: ToS User Rights and Obligations 7(c) resale outside integrated applications) and unpriced; the owner prices it only after a person has decided",
    "model_minimax_h3_max_second_480p": "registry: MiniMax H3 first-party, terms-gated (terms_review_required: ToS User Rights and Obligations 7(c) resale outside integrated applications) and unpriced; the owner prices it only after a person has decided",
    "model_minimax_h3_max_second_768p": "registry: MiniMax H3 first-party, terms-gated (terms_review_required: ToS User Rights and Obligations 7(c) resale outside integrated applications) and unpriced; the owner prices it only after a person has decided",
    "model_gemini_omni_1_1_flash_second": "registry: Google first-party (Interactions API), terms-gated (terms_review_required: the Gemini API 18+ and consumer-use clauses and Google APIs Terms 4(a) are for the owner's lawyer) and unpriced; the owner prices it only after that",
    "model_gemini_omni_1_1_flash_second_360p": "registry: Google first-party (Interactions API), terms-gated (terms_review_required: the Gemini API 18+ and consumer-use clauses and Google APIs Terms 4(a) are for the owner's lawyer) and unpriced; the owner prices it only after that",
    "model_gemini_omni_1_1_flash_second_720p": "registry: Google first-party (Interactions API), terms-gated (terms_review_required: the Gemini API 18+ and consumer-use clauses and Google APIs Terms 4(a) are for the owner's lawyer) and unpriced; the owner prices it only after that",
    "model_gemini_omni_1_1_flash_second_1080p": "registry: Google first-party (Interactions API), terms-gated (terms_review_required: the Gemini API 18+ and consumer-use clauses and Google APIs Terms 4(a) are for the owner's lawyer) and unpriced; the owner prices it only after that",
    "model_gemini_omni_1_1_flash_second_4k": "registry: Google first-party (Interactions API), terms-gated (terms_review_required: the Gemini API 18+ and consumer-use clauses and Google APIs Terms 4(a) are for the owner's lawyer) and unpriced; the owner prices it only after that",
    "model_gemini_nano_banana_2_1_image": "registry: Google first-party (Interactions API), terms-gated (terms_review_required: the Gemini API 18+ and consumer-use clauses and Google APIs Terms 4(a) are for the owner's lawyer) and unpriced; the owner prices it only after that",
    "model_vidu_q3_pro_second": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q3_pro_second_540p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q3_pro_second_720p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q3_pro_second_1080p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q3_turbo_second": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q3_turbo_second_540p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q3_turbo_second_720p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q3_turbo_second_1080p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q3_pro_fast_second": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q3_pro_fast_second_720p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q3_pro_fast_second_1080p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q4_preview_second": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q4_preview_second_540p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q4_preview_second_720p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q4_preview_second_1080p": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q4_preview_second_2k": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_vidu_q4_preview_second_4k": "registry: Vidu first-party, terms-gated (terms_review_required: Terms of Use clause 4 bars selling 'the Vidu-related technology' without Vidu's prior consent) and unpriced; the owner prices it only after Vidu has confirmed in writing",
    "model_pika_2_5_second": "registry: Pika first-party, terms-gated (terms_review_required: ToS 5 bars resale outside the Plan, 7 requires visible attribution and lets Pika train on anonymised content) and unpriced; the owner prices it only after a person has decided",
    "model_pika_2_5_second_720p": "registry: Pika first-party, terms-gated (terms_review_required: ToS 5 bars resale outside the Plan, 7 requires visible attribution and lets Pika train on anonymised content) and unpriced; the owner prices it only after a person has decided",
    "model_pika_2_5_second_1080p": "registry: Pika first-party, terms-gated (terms_review_required: ToS 5 bars resale outside the Plan, 7 requires visible attribution and lets Pika train on anonymised content) and unpriced; the owner prices it only after a person has decided",
    "model_pika_pikaframes_second": "registry: Pika first-party, terms-gated (terms_review_required: ToS 5 bars resale outside the Plan, 7 requires visible attribution and lets Pika train on anonymised content) and unpriced; the owner prices it only after a person has decided",
    "model_pika_pikaframes_second_720p": "registry: Pika first-party, terms-gated (terms_review_required: ToS 5 bars resale outside the Plan, 7 requires visible attribution and lets Pika train on anonymised content) and unpriced; the owner prices it only after a person has decided",
    "model_pika_pikaframes_second_1080p": "registry: Pika first-party, terms-gated (terms_review_required: ToS 5 bars resale outside the Plan, 7 requires visible attribution and lets Pika train on anonymised content) and unpriced; the owner prices it only after a person has decided",
    "model_kling_4_0_omni_edit_second": "registry: Kling first-party, registry-only (Character Studio sells it through migration 0137's own price table, never credit_prices) and terms-gated (terms_review_required: Terms of API Paid Service 3.3); unpriced until Kling answers in writing",
    "model_seedance_2_5_edit_second": "registry: ByteDance first-party, registry-only (Character Studio sells it through migration 0137's own price table, never credit_prices) and terms-gated (written_consent_required); unpriced until BytePlus authorises resale in writing",
    "model_sonilo_music_second": "registry: Sonilo first-party, synced dark since 0228 (hidden; the database knows music) and terms-gated (terms_review_required: ToS 4 bars a competing product, 12.2 needs written consent for uses not expressly allowed, and uploads train Sonilo's models with no opt-out) and unpriced; the owner prices it only after Sonilo has answered in writing",
    "model_sonilo_video_music_second": "registry: Sonilo first-party, registry-only (the database has no video_music capability yet) and terms-gated (terms_review_required: ToS 4 bars a competing product, 12.2 needs written consent for uses not expressly allowed, and uploads train Sonilo's models with no opt-out) and unpriced; the owner prices it only after Sonilo has answered in writing",
    "model_google_lyria_3_5_request": "registry: Google Lyria 3.5 (Gemini API, paid tier, '$0.08 per song'), terms-gated (terms_review_required: 18+, available regions, Google APIs Terms 4(a)) and synced dark since 0228 (music in the database, quantity 1 per request; the row is hidden); unpriced until a paid probe passes, a vocal-activity check exists and the owner signs the legal text (S6, BR-L-210)",
    "model_grounded_image_1_0_image": "registry: Meta Muse Image first-party, terms-gated (terms_review_required: no requester-country signal for the Geographic Use Policy, the 18+ gate first, ToS 7 bars Meta names) and unpriced; not on sale",
    "model_ideogram_4_5_image": "registry: Ideogram 4.5, an operator-only trial (0139 operator_preview, priced by 0153 at the vendor's list per tier, an estimate the owner read 2026-11-13); nothing on sale, the owner sets the price",
    "model_ideogram_4_5_image_low": "registry: Ideogram 4.5, an operator-only trial (0139 operator_preview, priced by 0153 at the vendor's list per tier, an estimate the owner read 2026-11-13); nothing on sale, the owner sets the price",
    "model_ideogram_4_5_image_medium": "registry: Ideogram 4.5, an operator-only trial (0139 operator_preview, priced by 0153 at the vendor's list per tier, an estimate the owner read 2026-11-13); nothing on sale, the owner sets the price",
    "model_ideogram_4_5_image_high": "registry: Ideogram 4.5, an operator-only trial (0139 operator_preview, priced by 0153 at the vendor's list per tier, an estimate the owner read 2026-11-13); nothing on sale, the owner sets the price",
    "usd": "pricing a ledger unit changes run settlement (metered vs hold): owner policy",
    "gemini_input_tokens": "ledger unit: owner policy",
    "gemini_output_tokens": "ledger unit: owner policy",
    "tts_characters": "ledger unit: owner policy",
    "render_seconds": "ledger unit: owner policy",
    "pexels_requests": "ledger unit: owner policy",
    "upload_bytes": "ledger unit: owner policy",
    "video_gen_clips": "ledger unit: owner policy",
    "image_generations": "ledger unit: owner policy",
    "vision_calls": "ledger unit: owner policy",
}


def _strip_comments(sql: str) -> str:
    return "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))


def _statements(code: str) -> list:
    """Split on ';' outside single-quoted strings ('' escapes a quote)."""
    out, cur, quoted = [], [], False
    for ch in code:
        if ch == "'":
            quoted = not quoted
        if ch == ";" and not quoted:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur))
    return out


def _rows(path: Path):
    return [m.groupdict() for m in ROW_RE.finditer(_strip_comments(path.read_text()))]


def _seeded_units() -> set:
    """Units an earlier file inserts or updates: any quoted unit literal at the
    start of a values tuple, or named by an `update ... where unit = '<u>'`."""
    out = set()
    for path in EARLIER_SEEDS:
        text = _strip_comments(path.read_text())
        out.update(m.group(1) for m in re.finditer(r"\(\s*'([a-z0-9_]+)'\s*,\s*[0-9]", text))
        out.update(m.group(1) for m in re.finditer(r"where unit = '([a-z0-9_]+)'", text))
    return out


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "_", text.lower())


def _registry_units() -> dict:
    """Every credit unit a registry model can be quoted at, as migrations
    0060 / 0070 / 0052 / 0084's creative_price builds them: the base unit
    (sellable_models joins on it), a tier per quality, a variant per priced
    setting, a target per video-upscale resolution. A variant the registry
    states as null ("no price read") is listed too: it is a unit the quote
    would ask for."""
    units = {}
    for m in reg.models():
        base = m.credit_unit
        units[base] = m.id
        variants = m.raw["pricing"].get("variants") or {}
        by = variants.get("by")
        if by == "quality":
            for tier in m.qualities:
                units[f"{base}_{_slug(tier)}"] = m.id
        elif by in ("audio", "resolution_audio") or (by == "resolution" and m.default_resolution):
            for key in variants.get("prices", {}):
                units[f"{base}_{_slug(key)}"] = m.id
        elif by == "upscale_target":
            for target in m.upscale_targets:
                units[f"{base}_{_slug(target)}"] = m.id
    return units


def _scene_providers() -> list:
    text = (MIGRATIONS / "0076_scene_regenerate.sql").read_text()
    m = re.search(r"provider in \(([^)]*)\)", text)
    assert m, "0076 no longer lists its providers"
    return re.findall(r"'([a-z0-9]+)'", m.group(1))


def _product_units() -> set:
    """Units a migration reads by name, outside the registry."""
    return {"video_minute", "job_minimum", "scene_regenerate", "repurpose_clip", "reply_draft"} | {
        f"scene_regenerate_clip_{p}" for p in _scene_providers()
    }


class PriceDefaultsFile(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = DEFAULTS.read_text()
        cls.code = _strip_comments(cls.text)
        cls.rows = _rows(DEFAULTS)

    def test_one_insert_that_never_overwrites(self):
        statements = [s.strip() for s in _statements(self.code) if s.strip()]
        self.assertEqual(len(statements), 1, "the file is a single statement")
        stmt = re.sub(r"\s+", " ", statements[0].lower())
        self.assertTrue(stmt.startswith("insert into public.credit_prices (unit, credits_per_unit, margin, note) values"))
        self.assertTrue(stmt.endswith("on conflict (unit) do nothing"))
        for word in ("update ", "delete ", "drop ", "truncate ", "alter ", "grant ", "revoke ", "do update"):
            self.assertNotIn(word, stmt)

    def test_every_tuple_parsed(self):
        # A tuple the regex skipped (a typo in a number, a stray quote) would
        # silently be unpriced: count the opening quotes of unit names.
        opened = re.findall(r"^\s*\('([^']*)'", self.code, flags=re.M)
        self.assertEqual(len(opened), len(self.rows))
        self.assertEqual(sorted(opened), sorted(r["unit"] for r in self.rows))

    def test_total_and_no_duplicates(self):
        units = [r["unit"] for r in self.rows]
        self.assertEqual(len(units), len(set(units)), "a unit appears twice")
        self.assertEqual(len(units), EXPECTED_COUNT)

    def test_numbers_are_positive_and_notes_fit(self):
        for r in self.rows:
            self.assertRegex(r["unit"], UNIT_RE)
            self.assertGreater(float(r["rate"]), 0, r["unit"])
            self.assertGreater(float(r["margin"]), 0, r["unit"])
            self.assertLessEqual(float(r["margin"]), 10, r["unit"])  # credit_prices_margin_check
            note = r["note"].replace("''", "'")
            self.assertTrue(note.strip(), r["unit"])
            self.assertLessEqual(len(note), 300, f"{r['unit']}: credit_prices_note_check")
            # numeric(18,8): the rate must fit eight decimals
            self.assertLessEqual(len(r["rate"].partition(".")[2]), 8, r["unit"])

    def test_estimates_are_marked_and_only_those(self):
        marked = {r["unit"] for r in self.rows if r["note"].startswith("est.:")}
        self.assertEqual(marked, EXPECTED_ESTIMATES)

    def test_does_not_repeat_an_earlier_seed(self):
        clash = {r["unit"] for r in self.rows} & _seeded_units()
        self.assertEqual(clash, set(), "already priced by an earlier file or migration")

    def test_applies_after_the_other_price_files(self):
        """The real apply order: the seeds, then these defaults, then the Scribe v2 correction
        (prices_scribe_2026_11_14.sql) that replaces one of these defaults with a read price."""
        names = sorted(p.name for p in SQL.glob("prices_*.sql"))
        self.assertEqual(set(names), {"prices_2026_10_01.sql", "prices_corrections_2026_10_01.sql",
                                      DEFAULTS.name, SCRIBE.name},
                         "a new price file: give it a step in the APPLY ORDER block and a test here")
        steps = re.findall(r"^--\s+(\d)\. docs/sql/(prices_\S+\.sql)", self.text, re.M)
        self.assertEqual([n for _, n in steps], ["prices_2026_10_01.sql", "prices_corrections_2026_10_01.sql",
                                                 DEFAULTS.name, SCRIBE.name])
        self.assertEqual([i for i, _ in steps], ["2", "3", "4", "5"])

    def test_every_unit_is_one_the_code_can_charge(self):
        chargeable = set(_registry_units()) | _product_units()
        stray = {r["unit"] for r in self.rows} - chargeable
        self.assertEqual(stray, set(), "a row nothing would ever read")

    def test_product_units_are_read_by_name_in_the_migrations(self):
        reads = {
            "video_minute": "0041_run_billing_hardening.sql",
            "scene_regenerate": "0076_scene_regenerate.sql",
            "repurpose_clip": "0080_repurpose.sql",
            "reply_draft": "0081_comment_inbox.sql",
        }
        for unit, migration in reads.items():
            self.assertIn(f"unit = '{unit}'", (MIGRATIONS / migration).read_text(), unit)
        self.assertIn("'scene_regenerate_clip_' ||", (MIGRATIONS / "0076_scene_regenerate.sql").read_text())

    def test_quality_tiers_match_what_the_registry_sells(self):
        # The gated, unpriced grok tiers, the operator-only Ideogram 4.5 trial and the hidden GPT Image 2.6 tiers (priced in the
        # database only, S10) are not ones the registry SELLS; every other tier must still be priced.
        tiers = {u for u, _ in _registry_units().items() if re.search(r"_image_(low|medium|high)$", u)} \
            - {u for u in UNPRICED_ON_PURPOSE
               if u.startswith(("model_grok_imagine_", "model_ideogram_4_5_", "model_openai_gpt_image_2_6_"))}
        all_tiers = {u for u, _ in _registry_units().items() if re.search(r"_image_(low|medium|high)$", u)}
        self.assertEqual(all_tiers - tiers, {"model_grok_imagine_image_2_0_image_low",
                                             "model_grok_imagine_image_2_0_image_medium",
                                             "model_ideogram_4_5_image_low", "model_ideogram_4_5_image_medium",
                                             "model_ideogram_4_5_image_high",
                                             *(f"model_openai_gpt_image_2_6_{v}_image_{q}" for v in ("sunburst", "flare")
                                               for q in ("low", "medium", "high"))},
                         "only the gated grok tiers, the Ideogram 4.5 trial and the hidden GPT Image 2.6 tiers may be left out")
        self.assertEqual(len(tiers), 9)
        self.assertTrue(tiers <= {r["unit"] for r in self.rows})

    def test_every_chargeable_unit_is_priced_or_left_unpriced_on_purpose(self):
        priced = _seeded_units() | {r["unit"] for r in self.rows}
        ledger = {
            "gemini_input_tokens", "gemini_output_tokens", "tts_characters", "render_seconds", "pexels_requests",
            "upload_bytes", "video_gen_clips", "image_generations", "vision_calls", "usd",
        }
        chargeable = set(_registry_units()) | _product_units() | ledger
        missing = chargeable - priced - set(UNPRICED_ON_PURPOSE)
        self.assertEqual(missing, set(), "chargeable units with no price and no stated reason")
        # And a unit cannot be both priced and "on purpose" unpriced.
        self.assertEqual(set(UNPRICED_ON_PURPOSE) & priced, set())
        # The reasoned list names real units only.
        self.assertEqual(set(UNPRICED_ON_PURPOSE) - chargeable, set())

    def test_ledger_units_here_match_the_code(self):
        from modules import cost_ledger as cl

        in_code = {cl.GEMINI_INPUT_TOKENS, cl.GEMINI_OUTPUT_TOKENS, cl.TTS_CHARACTERS, cl.RENDER_SECONDS,
                   cl.PEXELS_REQUESTS, cl.UPLOAD_BYTES, cl.VIDEO_GEN_CLIPS, cl.IMAGE_GENERATIONS, cl.VISION_CALLS}
        listed = {u for u, why in UNPRICED_ON_PURPOSE.items() if why.startswith("ledger unit")}
        self.assertEqual(in_code, listed)

    def test_held_rows_are_only_comments(self):
        held = [u for u, why in UNPRICED_ON_PURPOSE.items() if why.startswith("held back")]
        self.assertEqual(len(held), 7)
        for unit in held:
            self.assertNotIn(f"('{unit}'", self.code, f"{unit} must not be applied by this file")
            self.assertRegex(self.text, rf"(?m)^--\s+\('{unit}'", f"{unit} should stay visible as a commented row")




class ScribeCorrectionFile(unittest.TestCase):
    """The Scribe v2 correction is a read price, applied by the owner, that never overrides them."""

    @classmethod
    def setUpClass(cls):
        cls.text = SCRIBE.read_text()
        cls.sql = "\n".join(l for l in cls.text.splitlines() if not l.lstrip().startswith("--"))

    def test_it_is_an_owner_apply_file_not_a_migration(self):
        migrations = ROOT / "supabase" / "migrations"
        self.assertFalse(list(migrations.rglob(SCRIBE.name)))
        self.assertFalse([p for p in migrations.rglob("*.sql") if "model_elevenlabs_scribe_v2_second" in p.read_text()],
                         "the Scribe price is the owner's to apply, never a migration's")
        self.assertIn("OWNER-APPLY", self.text)
        self.assertIn("https://elevenlabs.io/pricing/api", self.text)

    def test_the_update_moves_only_the_seeded_estimate_and_leaves_the_margin(self):
        update = re.search(r"update public\.credit_prices(.*?);", self.sql, re.S | re.I).group(1)
        self.assertIn("credits_per_unit = 0.0056", update)
        self.assertNotIn("margin", update.split("where")[0], "an owner's margin must survive the update")
        self.assertRegex(update, r"unit = 'model_elevenlabs_scribe_v2_second'")
        self.assertRegex(update, r"credits_per_unit in \(0\.0112, 0\.0056\)")

    def test_a_missing_row_is_inserted_at_the_read_price_and_a_present_one_kept(self):
        insert = re.search(r"insert into public\.credit_prices.*?;", self.sql, re.S | re.I).group(0)
        self.assertRegex(insert, r"\('model_elevenlabs_scribe_v2_second', 0\.0056, 2\.0,")
        self.assertIn("on conflict (unit) do nothing", insert)

    def test_it_corrects_exactly_the_default_it_names(self):
        self.assertIn("('model_elevenlabs_scribe_v2_second', 0.0112, 2.0,", DEFAULTS.read_text())


if __name__ == "__main__":
    unittest.main()
