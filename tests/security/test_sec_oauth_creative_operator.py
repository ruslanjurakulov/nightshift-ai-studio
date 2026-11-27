"""The operator route for connected assistants (0219), attacked in a real database.

0219 lets a connected assistant in the operator's own workspace (public.default_org_id(), the credits-exempt organization) generate
with a model the Studio sells on the web even when the model is not offered to connected apps (web_only, or not switched on for
assistants): first-party marketing samples made by the owner through our own MCP. These prove:

* the operator's connection lists, quotes and creates such a model, and the route ('operator') is recorded on the quote, the job and
  the creative.generate audit row; the job runs exactly the quoted model and params;
* another workspace's connection with studio:create is refused that same model at the list, the quote and the create, cannot spend
  an operator quote (404, like an unknown id), and its own quotes cannot be turned into operator ones;
* a quote whose route changed before create is refused (quote_exposure_changed) and holds nothing;
* every other gate still holds for the operator: a rights acknowledgement, the owner's switch, being on sale in the Studio;
* no ByteDance model (by id, provider, adapter or vendor model id) is offered to anyone, the operator included;
* every other workspace gets exactly 0191/0192's answers (the only difference is the ByteDance refusal), shown by rolling 0219 back
  inside a transaction and asking again;
* no API role calls the helpers or touches the record; the rollback keeps the record and makes an open operator quote unspendable.

Runs in its own scratch database (it commits).
"""

import hashlib
import json
import os
import uuid

import psycopg
import pytest

import sec_db

MIGRATION = sec_db.MIGRATIONS / "0219_oauth_creative_operator_models.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0219_oauth_creative_operator_models.sql"
OPERATOR = "00000000-0000-0000-0000-000000000001"  # public.default_org_id() (0018)
CUSTOMER = "bbbbbbbb-0000-0000-0000-000000000219"
UOP = str(uuid.UUID(int=0x0219A))
UCU = str(uuid.UUID(int=0x0219B))
RESOURCE = "https://nightshift-ai.studio/api/mcp"
ALL = ["videos:read", "videos:create", "videos:publish", "studio:create"]
PROMPT = {"prompt": "a lighthouse at dawn, cinematic"}

# (id, capabilities, extra spec, provider, adapter, vendor model)
MODELS = [
    # Offered to connected apps (0191): the vendor's connector permission and the switch.
    ("img-mcp", ["t2i"], {"api_exposure": "web_mcp", "mcp_oauth_exposure": True}, "acme", "image.acme", None),
    # Sold in the Studio on the web only: the operator route's whole point.
    ("img-web", ["t2i", "edit"], {"api_exposure": "web_only"}, "acme", "image.acme", None),
    ("img-web-sw", ["t2i"], {"api_exposure": "web_only", "mcp_oauth_exposure": True}, "acme", "image.acme", None),
    ("img-any-off", ["t2i"], {"api_exposure": "any"}, "acme", "image.acme", None),
    # Web-only models another gate still refuses, for the operator too.
    ("img-web-ack", ["t2i"], {"api_exposure": "web_only", "requires_acknowledgement": ["likeness_photo"]}, "acme", "image.acme", None),
    ("img-web-off", ["t2i"], {"api_exposure": "web_only"}, "acme", "image.acme", None),
    ("img-web-hidden", ["t2i"], {"api_exposure": "web_only"}, "acme", "image.acme", None),
    # ByteDance, by each of its names, each one otherwise fully on for assistants.
    ("seedance-lab", ["t2i"], {"api_exposure": "web_mcp", "mcp_oauth_exposure": True}, "acme", "image.acme", None),
    ("bd-provider", ["t2i"], {"api_exposure": "web_mcp", "mcp_oauth_exposure": True}, "bytedance", "image.acme", None),
    ("bd-adapter", ["t2i"], {"api_exposure": "web_mcp", "mcp_oauth_exposure": True}, "acme", "image.seedream", None),
    ("bd-vendor", ["t2i"], {"api_exposure": "web_mcp", "mcp_oauth_exposure": True}, "acme", "image.acme", "seedream-4-0-250828"),
    ("bd-web", ["t2i"], {"api_exposure": "web_only"}, "byteplus", "image.acme", None),
]
BYTEDANCE = ["seedance-lab", "bd-provider", "bd-adapter", "bd-vendor", "bd-web"]


def claims(role, uid=None):
    c = {"role": role}
    if uid:
        c["sub"] = uid
    return json.dumps(c)


class Db:
    def __init__(self, dsn):
        self.dsn = dsn

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, uid, q, p=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid)])
                c.execute(f"set local role {role}")
                cur = c.execute(q, p)
                rows = cur.fetchall() if cur.description else None
                c.commit()
                return rows
            except psycopg.Error:
                c.rollback()
                raise


def vendor(m, vm):
    return vm or "acme-" + m


def setup(d: Db) -> None:
    d.su("insert into auth.users (id, email) values (%s,'op@c218.io'),(%s,'cu@c218.io')", [UOP, UCU])
    d.su("insert into public.organizations (id, name, slug) values (%s,'Nightshift','nightshift') on conflict (id) do nothing", [OPERATOR])
    d.su("insert into public.organizations (id, name, slug) values (%s,'Customer','org-cu-c218')", [CUSTOMER])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'op@c218.io','owner'),(%s,%s,'cu@c218.io','owner')",
         [OPERATOR, UOP, CUSTOMER, UCU])
    d.su("select public.grant_credits(%s, 100, 'test')", [CUSTOMER])
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    rows = [{"id": m, "display_name": m.upper(), "provider": prov, "adapter": ad, "capabilities": caps,
             "credit_unit": f"model_{m.replace('-', '_')}_image", "entitlement": "any",
             "spec": {"vendor_model": vendor(m, vm), "output": "image", **extra}}
            for m, caps, extra, prov, ad, vm in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, _x, _p, ad, vm in MODELS:
        for cap in caps:
            d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
                 [m, ad, vendor(m, vm), cap])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 4, 0.5) on conflict (unit) do nothing",
             [f"model_{m.replace('-', '_')}_image"])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit")
    # Not on sale in the Studio (hidden). A terms gate or a country list cannot be set on a model on sale at all: the table's own
    # checks (model_registry_terms_before_sale, model_registry_countries_before_sale) refuse it, and the judgement refuses it too.
    d.su("update public.model_registry set availability = 'hidden' where id = 'img-web-hidden'")
    # The owner's switch (0124), in force, with one model off.
    d.su("insert into public.model_availability_settings (id, enforced) values (true, true) on conflict (id) do update set enforced = true")
    d.su("insert into public.model_availability (scope, target, enabled, reason) values ('model', 'img-web-off', false, 'vendor_outage')")


def connection(d: Db, uid, org, scopes=ALL, limit=500):
    """A live access token of a connected app, the way 0093's exchange leaves it: (token hash, grant id)."""
    cid = d.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) values "
               "('lab', array['https://claude.ai/api/mcp/auth_callback'], %s) returning client_id::text",
               [hashlib.sha256(uuid.uuid4().bytes).hexdigest()])[0][0]
    grant = d.su("insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits, activated_at) "
                 "values (%s,%s,%s,%s,%s,%s,now()) returning id::text", [uid, org, cid, scopes, RESOURCE, limit])[0][0]
    h = hashlib.sha256(("at-" + uuid.uuid4().hex).encode()).hexdigest()
    d.su("insert into public.oauth_tokens (token_hash, grant_id, kind, expires_at) values (%s,%s,'access',now() + interval '1 hour')",
         [h, grant])
    return h, grant


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_oacr_op_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    setup(d)
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def quote(db, tok, model, cap="t2i", params=PROMPT):
    return db.act("anon", None, "select public.oauth_creative_quote(%s,%s,%s,%s::jsonb,null)", [tok, cap, model, json.dumps(params)])[0][0]


def create(db, tok, quote_id, idem=None):
    return db.act("anon", None, "select public.oauth_creative_create(%s,%s,%s,null)",
                  [tok, quote_id, idem or "k-" + uuid.uuid4().hex])[0][0]


def models(db, tok, cap=None):
    return db.act("anon", None, "select public.oauth_creative_models(%s,%s,null)", [tok, cap])[0][0]


def code(res):
    return res["error"]["code"] if res.get("ok") is False else None


def credits(db, org):
    return tuple(float(x) for x in db.su("select balance, reserved from public.credit_accounts where org_id=%s", [org])[0])


def jobs(db, grant):
    return db.su("select count(*) from public.oauth_creative_jobs where grant_id=%s", [grant])[0][0]


# ── the operator's own workspace ───────────────────────────────────────────

def test_the_operator_lists_quotes_and_creates_a_web_only_model_and_the_route_is_recorded(db):
    tok, grant = connection(db, UOP, OPERATOR)
    listed = {m["id"]: m for m in models(db, tok)["data"]["models"]}
    assert sorted(listed) == ["img-any-off", "img-mcp", "img-web", "img-web-sw"], sorted(listed)
    assert listed["img-web"]["operator_only"] is True and listed["img-web"]["capabilities"] == ["edit", "t2i"]
    assert listed["img-web"]["availability_note"] == "Operator workspace only (first-party use)."
    assert listed["img-mcp"]["operator_only"] is False and "availability_note" not in listed["img-mcp"]
    # Still no price, no terms notes, no vendor id.
    text = json.dumps(listed)
    for leak in ("credits", "terms_notes", "acme-img", "pricing"):
        assert leak not in text, leak

    q = quote(db, tok, "img-web")
    assert q["ok"] and q["status"] == 201 and q["data"]["operator_only"] is True and q["data"]["model"] == "img-web", q
    qid = q["data"]["quote_id"]
    assert db.su("select exposure from public.oauth_creative_quotes where id=%s", [qid])[0][0] == "operator"
    res = create(db, tok, qid)
    assert res["ok"] and res["status"] == 201, res
    job = res["data"]["id"]
    # Exactly the quoted model and params: no swap.
    row = db.su("select requested_model, params ->> 'prompt', quoted_credits from public.creative_jobs where id=%s", [job])[0]
    assert row[0] == "img-web" and row[1] == PROMPT["prompt"] and float(row[2]) == q["data"]["credits"], row
    assert db.su("select exposure from public.oauth_creative_jobs where job_id=%s", [job])[0][0] == "operator"
    audit = db.su("select detail ->> 'exposure', detail ->> 'model', detail ->> 'via' from public.app_audit_log "
                  "where action='creative.generate' and target=%s", [job])
    assert audit == [("operator", "img-web", "mcp_oauth")], audit
    assert jobs(db, grant) == 1


def test_a_model_offered_to_connected_apps_is_the_mcp_route_for_the_operator_too(db):
    tok, _g = connection(db, UOP, OPERATOR)
    q = quote(db, tok, "img-mcp")
    assert q["ok"] and "operator_only" not in q["data"], q
    job = create(db, tok, q["data"]["quote_id"])["data"]["id"]
    assert db.su("select exposure from public.oauth_creative_jobs where job_id=%s", [job])[0][0] == "mcp"
    assert db.su("select detail ->> 'exposure' from public.app_audit_log where target=%s", [job])[0][0] == "mcp"


@pytest.mark.parametrize("model,status,word", [
    ("img-web-ack", 428, "acknowledgement_required"),
    ("img-web-off", 503, "model_temporarily_off"),
    ("img-web-hidden", 422, "model_not_offered"),
    ("no-such-model", 422, "model_not_offered"),
])
def test_every_other_gate_still_holds_for_the_operator(db, model, status, word):
    tok, grant = connection(db, UOP, OPERATOR)
    res = quote(db, tok, model)
    assert res["status"] == status and code(res) == word, res
    assert db.su("select count(*) from public.oauth_creative_quotes where grant_id=%s", [grant])[0][0] == 0
    assert model not in [m["id"] for m in models(db, tok)["data"]["models"]]


def test_a_model_switched_off_after_an_operator_quote_is_refused_at_create(db):
    tok, grant = connection(db, UOP, OPERATOR)
    qid = quote(db, tok, "img-web")["data"]["quote_id"]
    db.su("insert into public.model_availability (scope, target, enabled, reason) values ('model', 'img-web', false, 'vendor_outage')")
    try:
        res = create(db, tok, qid)
        assert res["status"] == 503 and code(res) == "model_temporarily_off", res
        assert jobs(db, grant) == 0
    finally:
        db.su("delete from public.model_availability where scope = 'model' and target = 'img-web'")


def test_a_quote_whose_route_changed_is_refused_and_holds_nothing(db):
    tok, grant = connection(db, UOP, OPERATOR)
    # Quoted as offered to connected apps; then the assistant switch goes off, so it is reachable only by the operator route.
    mcp_q = quote(db, tok, "img-mcp")["data"]["quote_id"]
    db.su("update public.model_registry set spec = spec - 'mcp_oauth_exposure' where id = 'img-mcp'")
    try:
        res = create(db, tok, mcp_q)
        assert res["status"] == 409 and code(res) == "quote_exposure_changed" and res["error"]["model"] == "img-mcp", res
    finally:
        db.su("update public.model_registry set spec = spec || '{\"mcp_oauth_exposure\": true}'::jsonb where id = 'img-mcp'")
    # And the other way: quoted by the operator route; then the model is opened to connected apps.
    op_q = quote(db, tok, "img-web")["data"]["quote_id"]
    db.su("update public.model_registry set spec = spec || '{\"api_exposure\": \"web_mcp\", \"mcp_oauth_exposure\": true}'::jsonb "
          "where id = 'img-web'")
    try:
        res = create(db, tok, op_q)
        assert res["status"] == 409 and code(res) == "quote_exposure_changed", res
    finally:
        db.su("update public.model_registry set spec = (spec - 'mcp_oauth_exposure') || '{\"api_exposure\": \"web_only\"}'::jsonb "
              "where id = 'img-web'")
    assert jobs(db, grant) == 0
    assert db.su("select count(*) from public.oauth_creative_quotes where grant_id=%s and job_id is not null", [grant])[0][0] == 0


# ── another workspace ──────────────────────────────────────────────────────

def test_a_customer_connection_is_refused_the_operator_models_everywhere(db):
    tok, grant = connection(db, UCU, CUSTOMER)
    listed = {m["id"]: m for m in models(db, tok)["data"]["models"]}
    assert sorted(listed) == ["img-mcp"], sorted(listed)
    assert listed["img-mcp"]["operator_only"] is False
    for m in ("img-web", "img-web-sw", "img-any-off"):
        res = quote(db, tok, m)
        assert res["status"] == 422 and code(res) == "model_not_offered", (m, res)
    assert db.su("select count(*) from public.oauth_creative_quotes where grant_id=%s", [grant])[0][0] == 0
    # The operator's quote for that model reads as unknown to the customer's connection, and moves no credit.
    op_tok, _ = connection(db, UOP, OPERATOR)
    op_q = quote(db, op_tok, "img-web")["data"]["quote_id"]
    before = credits(db, CUSTOMER)
    res = create(db, tok, op_q)
    assert res["status"] == 404 and code(res) == "quote_not_found", res
    assert credits(db, CUSTOMER) == before and jobs(db, grant) == 0
    assert db.su("select job_id from public.oauth_creative_quotes where id=%s", [op_q])[0][0] is None


def test_a_customer_quote_cannot_be_upgraded_to_the_operator_route(db):
    tok, grant = connection(db, UCU, CUSTOMER)
    qid = quote(db, tok, "img-mcp")["data"]["quote_id"]
    assert db.su("select exposure from public.oauth_creative_quotes where id=%s", [qid])[0][0] == "mcp"
    # No API role can rewrite the record, and the database holds only the two words.
    for role, uid in (("anon", None), ("authenticated", UCU)):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(role, uid, "update public.oauth_creative_quotes set exposure = 'operator' where id = %s", [qid])
    with pytest.raises(psycopg.errors.CheckViolation):
        db.su("update public.oauth_creative_quotes set exposure = 'owner' where id = %s", [qid])
    # The model then leaves the connector (web only): a customer's quote is refused, never carried by the operator route.
    db.su("update public.model_registry set spec = spec || '{\"api_exposure\": \"web_only\"}'::jsonb where id = 'img-mcp'")
    try:
        before = credits(db, CUSTOMER)
        res = create(db, tok, qid)
        assert res["status"] == 422 and code(res) == "model_not_offered", res
        assert credits(db, CUSTOMER) == before and jobs(db, grant) == 0
    finally:
        db.su("update public.model_registry set spec = spec || '{\"api_exposure\": \"web_mcp\"}'::jsonb where id = 'img-mcp'")
    res = create(db, tok, qid)
    assert res["ok"], res
    assert db.su("select exposure from public.oauth_creative_jobs where job_id=%s", [res["data"]["id"]])[0][0] == "mcp"


# ── no ByteDance model, for anyone ─────────────────────────────────────────

@pytest.mark.parametrize("who", ["operator", "customer"])
@pytest.mark.parametrize("model", BYTEDANCE)
def test_no_bytedance_model_is_offered_to_any_connected_assistant(db, who, model):
    uid, org = (UOP, OPERATOR) if who == "operator" else (UCU, CUSTOMER)
    tok, grant = connection(db, uid, org)
    assert model not in [m["id"] for m in models(db, tok)["data"]["models"]]
    res = quote(db, tok, model)
    assert res["status"] == 422 and code(res) == "model_not_offered", res
    assert db.su("select count(*) from public.oauth_creative_quotes where grant_id=%s", [grant])[0][0] == 0
    assert db.su("select public.oauth_creative_org_model_state(%s, 't2i', %s)", [org, model])[0][0] == "not_offered"


def test_a_bytedance_quote_made_before_0219_is_refused_at_create(db):
    # A quote stored while 0191's judgement still offered the model (here: written directly) is not spendable after 0219.
    tok, grant = connection(db, UCU, CUSTOMER)
    qid = db.su("insert into public.oauth_creative_quotes (grant_id, org_id, capability, model, params, credits, quote, expires_at) "
                "values (%s, %s, 't2i', 'bd-provider', %s::jsonb, 6, '{}'::jsonb, now() + interval '15 minutes') returning id::text",
                [grant, CUSTOMER, json.dumps(PROMPT)])[0][0]
    before = credits(db, CUSTOMER)
    res = create(db, tok, qid)
    assert res["status"] == 422 and code(res) == "model_not_offered", res
    assert credits(db, CUSTOMER) == before and jobs(db, grant) == 0


# ── everyone else: exactly 0191 / 0192 ─────────────────────────────────────

def test_a_customers_answers_are_0191s_and_0192s(db):
    tok, _g = connection(db, UCU, CUSTOMER)
    caps = ["t2i", "edit", "t2v", "captions", "nonsense"]
    ids = [m for m, *_r in MODELS] + ["no-such-model"]
    now = db.su("select c, m, public.oauth_creative_org_model_state(%s, c, m), public.oauth_creative_model_state(c, m) "
                "from unnest(%s::text[]) c, unnest(%s::text[]) m", [CUSTOMER, caps, ids])
    for c, m, new, old in now:
        # The one deliberate difference: a ByteDance model 0191 would offer is refused.
        assert new == ("not_offered" if m in BYTEDANCE else old), (c, m, new, old)
        assert new != "ok_operator", (c, m)
    listed_now = [{k: v for k, v in m.items() if k not in ("operator_only",)} for m in models(db, tok)["data"]["models"]]
    quoted_now = {m: code(quote(db, tok, m)) for m in ids if m not in BYTEDANCE}

    # The same questions with 0219 rolled back, inside one transaction that is then undone.
    body = "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
    tok2, _g2 = connection(db, UCU, CUSTOMER)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(body)
        assert c.execute("select to_regprocedure('public.oauth_creative_org_model_state(uuid, text, text)') is null").fetchone()[0]
        c.execute("select set_config('request.jwt.claims', %s, true)", [claims("anon")])
        c.execute("set local role anon")
        old_list = c.execute("select public.oauth_creative_models(%s, null, null)", [tok2]).fetchone()[0]
        old_quotes = {}
        for m in quoted_now:
            r = c.execute("select public.oauth_creative_quote(%s,'t2i',%s,%s::jsonb,null)", [tok2, m, json.dumps(PROMPT)]).fetchone()[0]
            old_quotes[m] = code(r)
        old_bd = {m: code(c.execute("select public.oauth_creative_quote(%s,'t2i',%s,%s::jsonb,null)",
                                    [tok2, m, json.dumps(PROMPT)]).fetchone()[0]) for m in BYTEDANCE}
        c.rollback()
    assert listed_now == [m for m in old_list["data"]["models"] if m["id"] not in BYTEDANCE], (listed_now, old_list)
    assert quoted_now == old_quotes
    # And what 0219 closed: 0191 offered the ByteDance models switched on for assistants.
    assert old_bd["seedance-lab"] is None and old_bd["bd-provider"] is None and old_bd["bd-web"] == "model_not_offered", old_bd
    assert db.su("select to_regprocedure('public.oauth_creative_org_model_state(uuid, text, text)') is not null")[0][0]


# ── who may call ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
def test_no_api_role_calls_the_helpers_or_reads_the_record(db, role):
    for q in ("select public.oauth_creative_org_model_state(%s::uuid, 't2i', 'img-web')",
              "select public.oauth_creative_operator_org(%s::uuid)"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(role, UOP, q, [OPERATOR])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        db.act(role, UOP, "select public.oauth_creative_bytedance('x')")
    for t in ("oauth_creative_quotes", "oauth_creative_jobs"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(role, UOP, f"select exposure from public.{t}")


def test_a_connection_without_studio_create_reaches_nothing_even_in_the_operators_workspace(db):
    tok, _g = connection(db, UOP, OPERATOR, scopes=["videos:read", "videos:create"])
    for res in (models(db, tok), quote(db, tok, "img-web")):
        assert res["status"] == 403 and code(res) == "insufficient_scope", res


# ── the real registry: what the owner's samples use ────────────────────────

REGISTRY = {m["id"]: m for m in json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
_COLUMNS = ("id", "display_name", "provider", "adapter", "capabilities", "credit_unit", "entitlement")
#: Web-only models of schemas/model_registry.json the operator's samples are made with (S9): pictures and MiniMax H3 clips.
SAMPLE_MODELS = ["ideogram-3", "openai-gpt-image-2.6-sunburst", "minimax-h3"]


def _units(m):
    """Every credit_prices unit a quote of this entry can read: its own, each quality tier's and each price variant's."""
    import re
    unit = m["credit_unit"]
    out = {unit}
    out |= {f"{unit}_{t}" for t in (m.get("qualities") or [])}
    out |= {f"{unit}_{re.sub('[^a-z0-9]', '_', k.lower())}" for k in ((m["pricing"].get("variants") or {}).get("prices") or {})}
    return out


def seed_real(d: Db, ids) -> None:
    """These registry entries on sale in the Studio, as the registry sync and a passing probe leave them (their own file facts)."""
    # Inserted row by row, not through sync_model_registry: a sync takes every model it is not given off sale (the lab's own).
    for i in ids:
        m = REGISTRY[i]
        d.su("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
             "values (%s, %s, %s, %s, %s, %s::jsonb, %s, null)",
             [i, m["display_name"], m["provider"], m["adapter"], m["capabilities"],
              json.dumps({k: v for k, v in m.items() if k not in _COLUMNS}), m["credit_unit"]])
        for cap in m["capabilities"]:
            d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
                 [i, m["adapter"], m["vendor_model"], cap])
        d.su("update public.model_registry set availability = 'beta' where id = %s", [i])
        for u in _units(m):
            d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 4, 0.5) on conflict (unit) do nothing", [u])


def test_the_operator_lists_the_sample_models_and_a_customer_none_of_them(db):
    seed_real(db, [*SAMPLE_MODELS, "seedance-1.5-pro"])
    # seedance-1.5-pro is past its shutdown in the file: put it back on sale here, so only the ByteDance rule can refuse it.
    db.su("update public.model_registry set spec = spec - 'shutdown' where id = 'seedance-1.5-pro'")
    assert db.su("select count(*) from public.sellable_models(null, 'web') where id = any (%s)",
                 [[*SAMPLE_MODELS, "seedance-1.5-pro"]])[0][0] == 4
    op, _g = connection(db, UOP, OPERATOR)
    listed = {m["id"]: m for m in models(db, op)["data"]["models"]}
    for mid in SAMPLE_MODELS:
        assert listed.get(mid, {}).get("operator_only") is True, (mid, sorted(listed))
    assert "seedance-1.5-pro" not in listed
    assert listed["minimax-h3"]["capabilities"] == ["i2v", "t2v"]
    q = quote(db, op, "ideogram-3")
    assert q["ok"] and q["data"]["operator_only"] is True, q
    assert code(quote(db, op, "seedance-1.5-pro", "t2v")) == "model_not_offered"

    cu, grant = connection(db, UCU, CUSTOMER)
    theirs = [m["id"] for m in models(db, cu)["data"]["models"]]
    assert not set(theirs) & {*SAMPLE_MODELS, "seedance-1.5-pro"}, theirs
    for mid, cap in (("ideogram-3", "t2i"), ("openai-gpt-image-2.6-sunburst", "t2i"), ("minimax-h3", "t2v"), ("seedance-1.5-pro", "t2v")):
        res = quote(db, cu, mid, cap)
        assert res["status"] == 422 and code(res) == "model_not_offered", (mid, res)
    before = credits(db, CUSTOMER)
    res = create(db, cu, q["data"]["quote_id"])
    assert res["status"] == 404 and code(res) == "quote_not_found", res
    assert credits(db, CUSTOMER) == before and jobs(db, grant) == 0


def test_no_route_around_the_country_gate_for_the_operator(db):
    # A model with a country list cannot be on sale (0142's CHECK; 0208's gate refuses a job on it without a signed country, and an
    # assistant's request carries none). Lift the CHECK inside a transaction that is undone, put such a model on sale, and the
    # judgement still refuses it to the operator, before 0208's trigger is ever reached.
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("alter table public.model_registry drop constraint if exists model_registry_countries_before_sale")
        c.execute("update public.model_registry set spec = spec || '{\"blocked_countries\": [\"XX\"]}'::jsonb where id = 'img-web'")
        assert c.execute("select count(*) from public.sellable_models('t2i', 'web') where id = 'img-web'").fetchone()[0] == 1, \
            c.execute("select availability, verified_at is not null, spec from public.model_registry where id = 'img-web'").fetchone()
        assert c.execute("select public.oauth_creative_org_model_state(%s, 't2i', 'img-web')", [OPERATOR]).fetchone()[0] == "not_offered"
        c.rollback()
    assert db.su("select public.oauth_creative_org_model_state(%s, 't2i', 'img-web')", [OPERATOR])[0][0] == "ok_operator"


# ── replay and rollback (last: it ends where it began) ─────────────────────

def test_replay_changes_nothing_and_the_rollback_keeps_the_record_and_closes_the_route(db):
    sigs = ("public.oauth_creative_models(text, text, text)", "public.oauth_creative_quote(text, text, text, jsonb, text)",
            "public.oauth_creative_create(text, uuid, text, text)")

    def md5s():
        return [db.su("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)", [s])[0][0]
                for s in sigs]

    before = md5s()
    sec_db.apply_files(db.dsn, [MIGRATION, MIGRATION])
    assert md5s() == before == ["3c19fec218d8b140008495a635e57317", "13c960060df92c6e250c6f5e95dddab9", "86e36ace55f20829fa7c4da91f9eef9f"]

    tok, grant = connection(db, UOP, OPERATOR)
    open_q = quote(db, tok, "img-web")["data"]["quote_id"]
    recorded = db.su("select count(*) from public.oauth_creative_jobs where exposure = 'operator'")[0][0]
    assert recorded >= 1
    sec_db.apply_files(db.dsn, [ROLLBACK])
    try:
        assert md5s() == ["beafb530957690f51366c995468ad36f", "e3340606260711781f202aff7abdcdee", "527ce6685df6651507bb9fbd186a1c0c"]
        # The record stays; the open operator quote cannot be spent by 0191's create.
        assert db.su("select count(*) from public.oauth_creative_jobs where exposure = 'operator'")[0][0] == recorded
        res = create(db, tok, open_q)
        assert res["status"] == 422 and code(res) == "model_not_offered", res
        assert jobs(db, grant) == 0
        # The rollback refuses to run twice (the doors are no longer 0219's).
        with pytest.raises(sec_db.ApplyError, match="is not 0219's body"):
            sec_db.apply_files(db.dsn, [ROLLBACK])
    finally:
        sec_db.apply_files(db.dsn, [MIGRATION])
    assert md5s() == before
