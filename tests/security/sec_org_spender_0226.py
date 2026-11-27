"""Security-lab contract for migration 0226 (only a member spends an organization's credits, on every path: 0215's is_org_spender asked
by the twenty-two spend paths and rules that did not ask it yet).

Kept in its own module, like sec_film_resume_0215. One hook wires it in, at the bottom of sec_expectations.py:

        import sec_org_spender_0226; sec_org_spender_0226.extend(TABLES, FUNCTIONS)

0226 adds no table and no function: it replaces twenty-two bodies, each keeping its signature and its grants, so every catalog entry
(TABLES, FUNCTIONS) stays as the earlier migrations declared it and extend() adds nothing. What this module holds is the one list
the tests, the drift-guard pins and sec_db's chain read: each path, the role it asks of a member, and its body's md5 before and after
(whitespace runs read as one space, the way the file's own guard reads them). The attacks are in test_sec_org_spender_0226.py.
"""

from __future__ import annotations

#: (signature, the role a member needs, the file whose body 0226 replaced, that body's md5, 0226's md5).
PATHS = (
    ("public.reserve_credits(uuid, text, numeric)", "admin", "0094",
     "20800909ce4fdbcff87c5a99e735299f", "0fc6122a91a6287c632a59f2855a0d14"),
    ("public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)", "viewer", "0192",
     "a5e00e65d1161bccd2acefb7745e659b", "ab939bb64ef626e30c1438c6030d8801"),
    ("public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)", "editor", "0192",
     "67c4d21342ed9c6c144ec2559d4b34cc", "04d4ac338fbce93ceec279aac3fce89d"),
    ("public.advance_workflow_run(uuid)", "editor", "0074",
     "a349d79c4f1ca791135002cef82193a9", "a6c798fb11095202b6a71498eef45f35"),
    ("public.approve_storyboard(uuid, numeric, text)", "admin", "0057",
     "69885e5eb4dfebc05f2ca44a51a03a6a", "36b3874c4cb8737c907f46e65e237ad0"),
    ("public.request_scene_regenerate(text, text, text, text, numeric, text)", "admin", "0085",
     "2fed9d76de1030b44f0121e86e2fb663", "511456091d187f15a98c2b45fc922e87"),
    ("public.request_repurpose(text, jsonb, numeric, text)", "admin", "0080",
     "8771b0e2f943e7ff424482c4c1bbb50d", "924ce2a73e0bb9eb1818a59ee5a10adb"),
    ("public.start_series_episode(uuid, numeric, text, boolean)", "admin", "0120",
     "f3598d71d76e780b6973f88d8a743d2b", "e7c93eed4a138fb703cb82408c7dc173"),
    ("public.request_editor_export(uuid, integer, text, numeric)", "editor", "0136",
     "b6c3cdf6e63c02ce982b4f046df63c63", "9320aa81226161a59ca36b1699e51f18"),
    ("public.request_brand_scan(uuid, text, text, numeric)", "editor", "0133",
     "e696f6295465ae9b321766aea7a40b99", "38861da61bc8723b95897ab1fd23c0e4"),
    ("public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text)", "editor", "0137",
     "8b25050c082a66baf873ff871380ebc3", "83c3388e4124add9522eef573776486d"),
    ("public.request_download(text, text, numeric)", "editor", "0094",
     "268af77d1e00070cb96a7c98baeb51b1", "f4ae9d569094dc50f5e9df5b36f327f0"),
    ("public.render_jobs_payment_guard()", "admin", "0122",
     "3807936ade6801fa20da292e27fa7f64", "5f39cc352da2a0a8fd96bcc9b4ce8dd2"),
    ("public.create_api_key(uuid, text, bigint)", "admin", "0042",
     "4b311587d0f62ade8334beec83049e01", "c751606e0eafff55b916e603c1d78f2e"),
    ("public.api_begin(text, text, text)", "admin", "0093",
     "8b3b4fb4f4a5ab698584bc4f30e9fd14", "9ff0b39b5c5f86b82a4df3054b1908e8"),
    ("public.oauth_ctx(text, text, text)", "admin", "0147",
     "fe42c9e4f53a6c9aaba40077ce905cdc", "8cf90c6006cf30dc492c56fbfdcdb789"),
    # Breach 0226-1: the rule a workflow's later step asks of its confirmer. Not is_org_spender (it is asked of the confirmer, not the
    # caller, so it reads org_members itself): a seat of editor or above, and the platform owner or admin only in the exempt organization.
    ("public.workflow_confirmer_may_spend(uuid, uuid)", "editor", "0074",
     "bf5b3922c06fb82f832de36394e88ef7", "f3869c81bfc92baa38380830943f9985"),
    # The owner's yes (27 Nov): Nightshift AI's trial and daily cap, and a key's access, limit and the API's terms.
    ("public.ai_chat_start(uuid, text)", "editor", "0199",
     "f2365e962c429bd2640e5b3b155a32d5", "a8f1f8c7b6880c44fe0ccdb32e2ccbc5"),
    ("public.ai_chat_reserve_turn(uuid, text, boolean, text)", "editor", "0199",
     "7c89309bd1e2c15109d3824cc1104df8", "e105fa9373fac86e9a36cf4a945a21b4"),
    ("public.set_api_key_access(uuid, text[], integer, numeric)", "admin", "0062",
     "31a0ee1c15ba91f948446f95c8aeb1d2", "3255e1411d0d2ec9d5a85121e62d1dd3"),
    ("public.set_api_key_limit(uuid, bigint)", "admin", "0031",
     "538ad2e8ed9ab8eac10e11e3e60ba655", "c2b04ddeacdc908d02be94360bcc8e66"),
    ("public.api_activate(uuid, text)", "admin", "0031",
     "8cc2ead31d60e2c809c9e2ca4f161b90", "345750e4dfb8abdf49076e222b9ed22d"),
)


def extend(tables: dict, functions: dict) -> None:
    """Nothing to declare: every replaced function keeps the entry (and the grants) its earlier migration gave it."""
    return None
