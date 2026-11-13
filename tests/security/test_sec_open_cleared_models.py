"""The nine cleared models go on sale at 2.5x their vendor figure, and nothing else does (migration 0160).

0160 writes credit_prices rows for every unit a quote of Ideogram 3 / 4 / 4.5, MiniMax H3 / Highspeed / Lite / Max and Runway gen4.5 /
gen4_turbo can read, and puts those nine on sale (beta, entitlement NULL). These tests seed the nine from schemas/model_registry.json as
the live database holds them before 0160 (hidden, verified by a probe, a plan-tier entitlement), apply the real file, and run the real
quote and create on a real Postgres:

* every variant of every opened model is quoted to a customer at exactly 2.5x its registry vendor figure per unit, its own variant's row,
  never below the vendor's cost; naming no variant is the default variant;
* the Studio's catalog lists the nine, the API and MCP never do;
* a terms-gated model stays refused, even verified and priced, and can still not be put on sale at all;
* the operator's own organization is still credits-exempt: quoted, held and charged nothing, and no longer a "preview";
* the diagnosis: availability alone (the tier entitlement left in place) sells to nobody and takes the models from the operator;
* the drift guards: an unverified model, a moved registry figure, a missing model, a price row below this file's;
* a replay changes nothing; the rollback takes the nine off sale, restores the tiers, deletes only 0160's own rows, and 0160 re-applies.

Every row is made inside a rolled-back transaction.
"""

from __future__ import annotations

import copy
import json
import re
from decimal import Decimal

import pytest

import sec_db
from sec_scenario import DEFAULT_ORG
from test_sec_operator_preview import _become

# The reviewed file is read directly, not through modules.model_registry: that module imports the capability adapters, which need
# `requests`, and the lab installs only tests/security/requirements.txt. A failed import stops pytest's collection of the WHOLE lab.
# The row is built the way modules.model_registry.sync_rows builds it (tests/test_open_cleared_models_migration.py keeps _COLUMNS equal).
REGISTRY = {m["id"]: m for m in json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
_COLUMNS = ("id", "display_name", "provider", "adapter", "capabilities", "credit_unit", "entitlement")


def _sync_row(mid):
    m = REGISTRY[mid]
    return {"id": m["id"], "display_name": m["display_name"], "provider": m["provider"], "adapter": m["adapter"],
            "capabilities": list(m["capabilities"]), "credit_unit": m["credit_unit"], "entitlement": m["entitlement"],
            "spec": {k: v for k, v in m.items() if k not in _COLUMNS}}


MIGRATION = sec_db.MIGRATIONS / "0160_open_cleared_models.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0160_open_cleared_models.sql"
TEXT = MIGRATION.read_text(encoding="utf-8")


def _block(name):
    return json.loads(re.search(name + r" constant jsonb := \$json\$(.*?)\$json\$::jsonb;", TEXT, re.S).group(1),
                      parse_float=Decimal, parse_int=Decimal)


MODELS = _block("models")
PRICES = _block("prices")
NINE = [m["id"] for m in MODELS]
TIER = {m["id"]: m["tier"] for m in MODELS}
#: Gated entries of every kind of gate, the Runway upscaler (the owner keeps it gated) among them.
GATED = ["runway-video-upscale", "seedance-2.0", "grok-imagine-video-1.5", "grounded-image-1.0", "flux-3-image", "kling-v3"]
SECONDS = 5


def _rollback_body():
    text = ROLLBACK.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def _call(conn, who, q, params):
    """('ok', value) or (sqlstate, first line of the message); run as `who` in a savepoint."""
    try:
        with conn.transaction():
            _become(conn, who)
            v = conn.execute(q, params).fetchone()[0]
            _become(conn, None)
            return "ok", v
    except Exception as e:                                      # noqa: BLE001 - the SQLSTATE and text are the assertion
        return getattr(e, "sqlstate", None), str(e).strip().splitlines()[0]


def _seed(conn, ids=None, *, verified=True, tiers=True, mutate=None):
    """The registry entries as the live database holds them before 0160: the file's static facts, hidden, a successful probe of the
    exact call, and (tiers) the plan-tier entitlement the file carried before 0160."""
    ids = list(NINE if ids is None else ids)
    # A deep copy: the row shares the nested spec with REGISTRY, and a mutation must not reach the next test.
    for row in copy.deepcopy([_sync_row(i) for i in ids]):
        if mutate:
            mutate(row)
        ent = TIER.get(row["id"], row["entitlement"]) if tiers else row["entitlement"]
        conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                     "values (%s, %s, %s, %s, %s, %s::jsonb, %s, %s)",
                     [row["id"], row["display_name"], row["provider"], row["adapter"], row["capabilities"],
                      json.dumps(row["spec"]), row["credit_unit"], ent])
        if verified:
            vm = row["spec"].get("vendor_model")
            conn.execute("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 900, 1234, 'security-lab')",
                         [row["id"], row["adapter"], vm, row["capabilities"][0]])


def _apply(conn):
    conn.execute(TEXT)


def _quote(conn, who, org, cap, mid, params):
    return _call(conn, who, "select public.quote_creative_job(%s, %s, %s, %s::jsonb)", [org, cap, mid, json.dumps(params)])


def _create(conn, who, org, cap, mid, params, maxc=5000):
    return _call(conn, who, "select public.create_creative_job(%s, %s, %s, %s::jsonb, 'exact', null, %s::numeric)",
                 [org, cap, mid, json.dumps(params), maxc])


def _request(sc, model, variant):
    """The capability and params a customer (Bob) sends for this model at this variant (None = name none)."""
    e = REGISTRY[model]
    if e["output"] == "image":
        params = {"prompt": "a poster that says HELLO"}
        if variant is not None:
            params["quality"] = variant
        return "t2i", params
    params = {"prompt": "slow push in", "duration_s": SECONDS}
    if variant is not None:
        params["resolution"] = variant
    if "t2v" in e["capabilities"]:
        return "t2v", params
    return "i2v", {**params, "source_asset_id": sc.bob.media_asset}


def _qty(model):
    return 1 if REGISTRY[model]["output"] == "image" else SECONDS


# ── every variant sells at 2.5x its vendor figure, never below it ─────────────────────────────────────────────────────

@pytest.mark.parametrize("price", PRICES, ids=[p["unit"] for p in PRICES])
def test_every_variant_is_quoted_to_a_customer_at_two_and_a_half_times_its_vendor_figure(conn, sc, price):
    model, variant = price["model"], price["variant"]
    m = next(x for x in MODELS if x["id"] == model)
    if variant is None and m["by"] is not None:
        # a variant model's base row lists it in the catalog; the quote of "no variant named" is the default variant's
        variant_sent, unit_quoted = None, f'{m["credit_unit"]}_{m["default"]}'
    else:
        variant_sent, unit_quoted = variant, price["unit"]
    usd = Decimal(str(price["usd"]))
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn)
        _apply(conn)
        cap, params = _request(sc, model, variant_sent)
        state, q = _quote(conn, sc.bob.actor, sc.bob.org, cap, model, params)
        assert state == "ok", (price["unit"], q)
        assert q["unit"] == unit_quoted and "preview" not in q and q["exempt"] is False, q
        assert Decimal(str(q["credits_per_unit"])) == usd * 100 * Decimal("2.5"), q
        vendor_cents = usd * 100 * _qty(model)
        # The customer's credits never buy more vendor cost than they pay for: 1 credit buys at most 0.4 cents of vendor cost.
        assert Decimal(str(q["credits"])) >= vendor_cents * Decimal("2.5"), q
        assert Decimal(str(q["credits"])) / Decimal("2.5") >= vendor_cents


def test_a_customers_generation_is_held_at_the_quote(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn)
        _apply(conn)
        state, q = _quote(conn, sc.bob.actor, sc.bob.org, "t2v", "minimax-h3", {"prompt": "x", "duration_s": SECONDS, "resolution": "2k"})
        assert state == "ok" and Decimal(str(q["credits"])) == Decimal("32.5") * SECONDS, q
        state, out = _create(conn, sc.bob.actor, sc.bob.org, "t2v", "minimax-h3", {"prompt": "x", "duration_s": SECONDS, "resolution": "2k"})
        assert state == "ok", out
        row = conn.execute("select params ->> 'resolution', quoted_credits, credit_ref is not null from public.creative_jobs where id = %s",
                           [out["job"]["id"]]).fetchone()
        assert (row[0], Decimal(str(row[1])), row[2]) == ("2k", Decimal(str(q["credits"])), True), row


def test_the_studio_lists_the_nine_and_the_api_and_mcp_never_do(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn)
        _apply(conn)
        listed = {s: {r[0] for r in conn.execute("select id from public.sellable_models(null, %s)", [s]).fetchall()}
                  for s in ("web", "api", "mcp")}
        assert set(NINE) <= listed["web"], listed["web"]
        assert not (set(NINE) & listed["api"]) and not (set(NINE) & listed["mcp"]), listed
        rows = conn.execute("select id, availability, entitlement from public.model_registry where id = any(%s)", [NINE]).fetchall()
        assert sorted(rows) == sorted((i, "beta", None) for i in NINE), rows


# ── gated models stay off sale ─────────────────────────────────────────────────────────────────────────────────────

def test_a_terms_gated_model_stays_refused_even_verified_and_priced(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn)
        _seed(conn, GATED, tiers=False)
        for mid in GATED:
            unit = REGISTRY[mid]["credit_unit"]
            conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 50, 1.5) on conflict do nothing", [unit])
        _apply(conn)
        rows = dict(conn.execute("select id, availability from public.model_registry where id = any(%s)", [GATED]).fetchall())
        assert rows == {mid: "hidden" for mid in GATED}, rows
        web = {r[0] for r in conn.execute("select id from public.sellable_models(null, 'web')").fetchall()}
        assert not (set(GATED) & web)
        for mid in GATED:
            caps = REGISTRY[mid]["capabilities"]
            # (the upscaler takes a source video, so it is not quoted here: the catalog above and the CHECK below hold it)
            if "t2i" in caps:
                assert _quote(conn, sc.bob.actor, sc.bob.org, "t2i", mid, {"prompt": "x"}) == ("NS400", "model_not_sellable"), mid
            elif "t2v" in caps:
                got = _quote(conn, sc.bob.actor, sc.bob.org, "t2v", mid, {"prompt": "x", "duration_s": SECONDS})
                assert got == ("NS400", "model_not_sellable"), (mid, got)
            # and no path can put it on sale: 0035's CHECK
            with pytest.raises(Exception) as err:
                with conn.transaction():
                    conn.execute("update public.model_registry set availability = 'beta' where id = %s", [mid])
            assert getattr(err.value, "sqlstate", None) == "23514", (mid, err.value)


# ── the operator ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_operators_organization_is_still_exempt_and_no_longer_a_preview(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn)
        _apply(conn)
        params = {"prompt": "a poster that says HELLO", "quality": "high"}
        state, q = _quote(conn, sc.operator, DEFAULT_ORG, "t2i", "ideogram-4.5", params)
        assert state == "ok", q
        assert q["exempt"] is True and "preview" not in q and q["unit"] == "model_ideogram_4_5_image_high", q
        before = conn.execute("select count(*) from public.credit_transactions").fetchone()[0]
        state, out = _create(conn, sc.operator, DEFAULT_ORG, "t2i", "ideogram-4.5", params)
        assert state == "ok", out
        ref = conn.execute("select credit_ref from public.creative_jobs where id = %s", [out["job"]["id"]]).fetchone()[0]
        assert ref is None and conn.execute("select count(*) from public.credit_transactions").fetchone()[0] == before


def test_availability_alone_with_the_tier_left_in_place_sells_to_nobody_and_takes_the_models_from_the_operator(conn, sc):
    # The diagnosis 0160 rests on: creative_price refuses every plan-tier entitlement, whatever the plan, and a beta model is no
    # longer an operator preview. So opening availability without the entitlement change would be worse than nothing.
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn, ["ideogram-3"])
        conn.execute("update public.model_registry set availability = 'beta' where id = 'ideogram-3'")
        conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_ideogram_3_image', 3, 1.5)")
        params = {"prompt": "x"}
        assert _quote(conn, sc.bob.actor, sc.bob.org, "t2i", "ideogram-3", params)[0] == "NS400"
        assert "entitlement_required" in _quote(conn, sc.bob.actor, sc.bob.org, "t2i", "ideogram-3", params)[1]
        assert "entitlement_required" in _quote(conn, sc.operator, DEFAULT_ORG, "t2i", "ideogram-3", params)[1]
        # hidden, the same model is the operator's preview
        conn.execute("update public.model_registry set availability = 'hidden' where id = 'ideogram-3'")
        state, q = _quote(conn, sc.operator, DEFAULT_ORG, "t2i", "ideogram-3", params)
        assert state == "ok" and q["preview"] is True, q


# ── drift guards ───────────────────────────────────────────────────────────────────────────────────────────────────

def _refused(conn, needle):
    with pytest.raises(Exception) as err:
        with conn.transaction():
            _apply(conn)
    assert needle in str(err.value), str(err.value)


def test_an_unverified_model_stops_the_apply(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn, [i for i in NINE if i != "runway-gen4.5"])
        _seed(conn, ["runway-gen4.5"], verified=False)
        _refused(conn, "runway-gen4.5 has no successful probe")
        assert conn.execute("select count(*) from public.credit_prices where note like '0160:%'").fetchone()[0] == 0


def test_a_registry_figure_that_moved_stops_the_apply(conn, sc):
    def cheaper(row):
        if row["id"] == "minimax-h3":
            row["spec"]["pricing"]["variants"]["prices"]["2k"] = 0.2
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn, mutate=cheaper)
        _refused(conn, "model_minimax_h3_second_2k")


def test_a_synced_registry_without_one_of_the_nine_stops_the_apply(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn, [i for i in NINE if i != "ideogram-4"])
        _refused(conn, "ideogram-4 is not in model_registry")


def test_a_gate_set_on_one_of_the_nine_stops_the_apply(conn, sc):
    def gate(row):
        if row["id"] == "minimax-h3-max":
            row["spec"]["terms_gate"] = "terms_review_required"
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn, mutate=gate)
        _refused(conn, "minimax-h3-max is terms-gated")


def test_a_capability_a_resync_added_stops_the_apply_and_nothing_is_priced_or_opened(conn, sc):
    # ideogram-3 re-synced with an edit capability: never probed or priced for it, so the t2i price must not sell it.
    def edits(row):
        if row["id"] == "ideogram-3":
            row["capabilities"] = ["t2i", "edit"]
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn, mutate=edits)
        _refused(conn, "ideogram-3 now offers")
        assert conn.execute("select count(*) from public.credit_prices where note like '0160:%'").fetchone()[0] == 0
        assert conn.execute("select count(*) from public.model_registry where id = any(%s) and availability <> 'hidden'",
                            [NINE]).fetchone()[0] == 0


def test_a_vendor_model_by_capability_stops_the_apply(conn, sc):
    # gen4.5's t2v served by another (dearer) vendor model would be sold at gen4.5's figure; 0035 accepts either model's probe.
    def split(row):
        if row["id"] == "runway-gen4.5":
            row["spec"]["vendor_model_by_capability"] = {"t2v": "gen4.5-pro"}
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn, mutate=split)
        _refused(conn, "runway-gen4.5 calls another vendor model")


def test_a_price_row_below_this_files_stops_the_apply_and_a_higher_one_is_kept(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn)
        conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_runway_gen4_5_second', 12, 0.2)")
        _refused(conn, "model_runway_gen4_5_second already sells at")
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn)
        conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_ideogram_3_image', 6, 1.5)")
        _apply(conn)
        row = conn.execute("select credits_per_unit, margin from public.credit_prices where unit = 'model_ideogram_3_image'").fetchone()
        assert (Decimal(row[0]), Decimal(row[1])) == (Decimal(6), Decimal("1.5")), row
        state, q = _quote(conn, sc.bob.actor, sc.bob.org, "t2i", "ideogram-3", {"prompt": "x"})
        assert state == "ok" and Decimal(str(q["credits_per_unit"])) == Decimal(15), q


# ── replay and rollback ────────────────────────────────────────────────────────────────────────────────────────────

def test_a_replay_changes_nothing(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn)
        _apply(conn)
        snap = lambda: (conn.execute("select unit, credits_per_unit, margin, note from public.credit_prices order by unit").fetchall(),  # noqa: E731
                        conn.execute("select id, availability, entitlement, updated_at from public.model_registry order by id").fetchall(),
                        conn.execute("select count(*) from public.credit_price_history").fetchone()[0])
        first = snap()
        _apply(conn)
        assert snap() == first


def test_the_rollback_takes_the_nine_off_sale_restores_the_tiers_and_deletes_only_its_own_rows(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _seed(conn)
        # a row that was there before 0160 at this file's very figures, and one the owner raised after it
        conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin, note) values ('model_runway_gen4_turbo_second', 5, 1.5, 'owner')")
        _apply(conn)
        conn.execute("update public.credit_prices set credits_per_unit = 9 where unit = 'model_ideogram_4_image'")
        conn.execute(_rollback_body())
        rows = dict((r[0], (r[1], r[2])) for r in conn.execute(
            "select id, availability, entitlement from public.model_registry where id = any(%s)", [NINE]).fetchall())
        assert rows == {i: ("hidden", TIER[i]) for i in NINE}, rows
        left = {r[0] for r in conn.execute("select unit from public.credit_prices where unit = any(%s)", [[p["unit"] for p in PRICES]]).fetchall()}
        assert left == {"model_runway_gen4_turbo_second", "model_ideogram_4_image"}, left
        # hidden again, the operator previews them as before 0160
        state, q = _quote(conn, sc.operator, DEFAULT_ORG, "t2i", "ideogram-4.5", {"prompt": "x", "quality": "low"})
        assert state == "ok" and q["preview"] is True, q
        # and the file applies again on top of its own rollback (the edited 9-credit row sells above 3, so it is kept)
        _apply(conn)
        assert conn.execute("select count(*) from public.model_registry where id = any(%s) and availability = 'beta'", [NINE]).fetchone()[0] == 9
