"""Builds supabase/migrations/0208_geo_gate_and_image_size_price.sql and its rollback from the real 0156 / 0159 bodies plus marked hunks."""
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIG = ROOT / "supabase" / "migrations"
T156 = (MIG / "0156_named_resolution_params.sql").read_text(encoding="utf-8")
T159 = (MIG / "0159_duration_offered_by_model.sql").read_text(encoding="utf-8")


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def md5_of(fn):
    b = fn[fn.index("$$") + 2: fn.rindex("$$")]
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


PP_OLD = bodies(T156)["creative_params_problem"]
CP_OLD = bodies(T159)["creative_price"]
assert md5_of(PP_OLD) == "25ee9cc62a27ad3a19e71008b04f3f36", md5_of(PP_OLD)
assert md5_of(CP_OLD) == "dafc5edae0000e741ac1b19bd0075790", md5_of(CP_OLD)


def apply(text, anchor, new):
    assert text.count(anchor) == 1, anchor[:80]
    return text.replace(anchor, new)


# ── creative_params_problem: two hunks ──
PP_A1 = """                 -- 0126
                 'regions', 'region_feather') then
"""
PP_H1 = """                 -- 0126
                 'regions', 'region_feather',
                 -- 0208
                 'image_size') then
"""
PP_A2 = """  if p_params ? 'audio' then
    -- The soundtrack of a video (0070): t2v and i2v only, a JSON boolean.
"""
PP_H2 = """  -- 0208: the size of a picture from a model that bills by it (the registry schema's closed list): t2i and edit only. Whether THIS
  -- model is sold by size and lists the size (and has a price for it) is creative_price's question. Absent = no size named.
  if p_params ? 'image_size' then
    if p_capability not in ('t2i', 'edit') then
      return format('image_size does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'image_size') is distinct from 'string'
       or (p_params ->> 'image_size') not in ('512', '1K', '2K', '4K') then
      return 'image_size must be one of 512, 1K, 2K, 4K';
    end if;
  end if;
""" + PP_A2
PP_NEW = apply(apply(PP_OLD, PP_A1, PP_H1), PP_A2, PP_H2)
PP_NEW = PP_NEW.replace("-- 0156's params check", "-- (unused)")  # no-op guard

# ── creative_price: three hunks ──
CP_A1 = """  vcost   numeric;
begin
"""
CP_H1 = """  vcost   numeric;
  -- 0208: the picture size this quote is for (spec.pricing.variants.by = image_size).
  vsize   text;
begin
"""
CP_A2 = """    m_unit := m_unit || '_' || regexp_replace(lower(tier), '[^a-z0-9]', '_', 'g');
  end if;
"""
CP_H2 = CP_A2 + """  -- 0208: a picture size only on a model whose price follows it (spec.pricing.variants.by = image_size) and that lists the size
  -- (spec.image_sizes, the list the worker checks: ModelEntry.problems "image size <s> is not offered by <model>"). On any other
  -- model the size would reach a vendor that bills its own way under a price that was not read for it: refused, never ignored.
  if p_params ? 'image_size'
     and (coalesce(m_spec -> 'pricing' -> 'variants' ->> 'by', '') <> 'image_size'
          or not coalesce(jsonb_typeof(m_spec -> 'image_sizes') = 'array'
                          and (m_spec -> 'image_sizes') @> jsonb_build_array(p_params ->> 'image_size'), false)) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s size', mdl, p_params ->> 'image_size'));
  end if;
  -- 0208: one price per size when the registry prices the sizes apart (model_registry.credit_unit_for: model_<id>_<unit>_<size>).
  -- The size must be named: the worker sends it as the vendor's imageSize, and with none the vendor makes (and bills) its own
  -- default under a price read for no size. A size without its own row is unpriced: never another size's rate, never the base row.
  if cap in ('t2i', 'edit') and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'image_size' then
    vsize := p_params ->> 'image_size';
    if vsize is null then
      perform public.creative_refuse('invalid_params',
        format('%s is sold by picture size: name image_size', mdl));
    end if;
    m_unit := m_unit || '_' || regexp_replace(lower(vsize), '[^a-z0-9]', '_', 'g');
  end if;
"""
CP_A3 = """    || case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end
"""
CP_H3 = CP_A3 + """    -- 0208: the picture size this price is for.
    || case when vsize is null then '{}'::jsonb else jsonb_build_object('image_size', vsize) end
"""
CP_NEW = apply(apply(apply(CP_OLD, CP_A1, CP_H1), CP_A2, CP_H2), CP_A3, CP_H3)

GEO_FN = r"""create or replace function public.geo_claim_country() returns text
  language plpgsql stable security definer set search_path = extensions, public, pg_temp as $$
declare
  hdrs  text := nullif(current_setting('request.headers', true), '');
  raw   text;
  parts text[];
  k     text;
  now_s numeric := floor(extract(epoch from clock_timestamp()));
begin
  if hdrs is null then
    return null;
  end if;
  -- PostgREST writes request.headers as JSON; anything else is no claim (never an error that a caller could read as "allowed").
  begin
    raw := hdrs::json ->> 'x-nightshift-geo';
  exception when others then
    return null;
  end;
  -- v1.<country>.<user id>.<expiry, epoch seconds>.<hex HMAC-SHA256 of the first four parts>: command-center/lib/server/geo-claim.ts.
  if raw is null
     or raw !~ '^v1\.[A-Z]{2}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9]{1,12}\.[0-9a-f]{64}$' then
    return null;
  end if;
  parts := string_to_array(raw, '.');
  -- Made for this person (a claim another session got cannot be replayed here), and alive: the server signs it with an expiry
  -- 120 seconds ahead; one more than 300 seconds ahead was not signed by it.
  if parts[3]::uuid is distinct from auth.uid() then
    return null;
  end if;
  if parts[4]::numeric < now_s or parts[4]::numeric > now_s + 300 then
    return null;
  end if;
  -- The key lives in Vault and in the web server's environment, nowhere else. No key (or a stub) vouches for nothing.
  select s.decrypted_secret into k from vault.decrypted_secrets s where s.name = 'nightshift_geo_claim_key' limit 1;
  if k is null or char_length(k) < 32 then
    return null;
  end if;
  if encode(hmac(array_to_string(parts[1:4], '.'), k, 'sha256'), 'hex') <> parts[5] then
    return null;
  end if;
  return parts[2];
end
$$;
"""

GATE_FN = r"""create or replace function public.creative_jobs_geo_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m   text := coalesce(new.routed_model, new.requested_model);
  lst jsonb;
  c   text;
begin
  -- A row that does not change its model is not asked again (a status, a heartbeat, a result).
  if tg_op = 'UPDATE' and new.routed_model is not distinct from old.routed_model then
    return new;
  end if;
  select r.spec -> 'blocked_countries' into lst from public.model_registry r where r.id = m;
  if lst is null or lst = 'null'::jsonb or lst = '[]'::jsonb then
    return new;
  end if;
  -- A model with a country list: only a country this database can trust (geo_claim_country: signed by our web server for this
  -- person, seconds ago). No claim at all is a member calling create_creative_job straight through PostgREST, the worker moving a
  -- job onto this model (it has no visitor), or a Film Studio take: refused, never let through as "unknown".
  c := public.geo_claim_country();
  if c is null then
    perform public.creative_refuse('country_unverified',
      format('%s is sold only where the country of the request is confirmed by the web app; nothing was held', m));
  end if;
  -- A list of any other shape fails closed.
  if jsonb_typeof(lst) <> 'array' or lst ? c then
    perform public.creative_refuse('country_blocked', format('%s is not available in this region; nothing was held', m));
  end if;
  return new;
end
$$;
"""

PP_NEW_MD5 = md5_of(PP_NEW)
CP_NEW_MD5 = md5_of(CP_NEW)
GEO_MD5 = md5_of(GEO_FN)
GATE_MD5 = md5_of(GATE_FN)

HEADER = """-- 0208_geo_gate_and_image_size_price.sql — the database refuses a job on a model with a country list unless our web server vouches
-- for the request's country; and a picture model priced by size is quoted at the size asked for, never at one flat rate.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It changes NO answer for any model on sale today:
--   * the country gate acts only on a model whose model_registry.spec carries blocked_countries, and 0142's CHECK keeps every such model
--     off sale (beta/ga). The one change a person could see: a platform admin's operator preview (0139) of a hidden model with a list
--     needs a signed country too.
--   * image_size is a new parameter, accepted only by a model priced by size (spec.pricing.variants.by = image_size); every such row in
--     schemas/model_registry.json today has a terms_gate, so none is on sale. Every other quote is answered exactly as 0159 answers it,
--     except that a request naming image_size (refused as an unknown parameter until now) is refused with a sentence that says why.
--
-- PART A. THE COUNTRY GATE (docs/GEO_BLOCK.md "The database's own check")
-- EVIDENCE. The web routes refuse a model by country (lib/server/geo.ts), but create_creative_job (0075 / 0192), start_workflow_run
--   (0073) and advance_workflow_run (0074) are granted to `authenticated`, and the browser holds the anon key and the session: a member
--   can call them straight through PostgREST and skip every route (0142's header; docs/GEO_BLOCK.md "What it cannot do"). Google's
--   terms make its models an ALLOW-list (Gemini API Additional Terms, effective March 23, 2026: "You may only access the Services (or
--   make API Clients available to users) within an available region"), so before any Google model can open, the database itself must
--   refuse a job whose country nobody trustworthy vouched for.
-- DIAGNOSIS. The database cannot see an address. What it can see is the HTTP request's headers (PostgREST writes them to
--   request.headers for the transaction, as 0101's review links read them). A member can send any header, so a header is worth
--   something only if a member cannot make it: an HMAC the web server signs with a key the member never holds.
-- DESIGN (option a of the three compared in VERA_REPORT.md: (b) a per-request setting reduces to a header a member can also send;
--   (c) revoking create_creative_job from members and calling it with the service key breaks CLAUDE.md #3 and rewrites every caller):
--   geo_claim_country()   reads request.headers -> 'x-nightshift-geo' = v1.<CC>.<user id>.<expiry>.<hex HMAC-SHA256>, and answers the
--     country only when the shape is exact, the user id is auth.uid(), the expiry is in the next 300 seconds and the HMAC matches the
--     key in Vault (secret nightshift_geo_claim_key). Anything else is null. Not callable by any API role (no oracle to test claims).
--   creative_jobs_geo_gate()  BEFORE INSERT OR UPDATE OF routed_model on creative_jobs: for a model with a non-empty blocked_countries,
--     no trusted country = NS400 country_unverified; a country on the list (or a list of another shape) = NS400 country_blocked. One
--     trigger on the one table every path writes (create_creative_job, a workflow step, an MCP or API create, a Film Studio take, the
--     worker's failover), so no door is missed and none needs its body replaced. Raised inside the creating transaction, so the hold
--     taken before the insert rolls back with it.
--   What it does NOT do: store the country (it lives in the one transaction); lift 0142 (a model with a list stays off sale until a
--   later migration decides to open one, which this gate makes honest); vouch for a request with no visitor (the worker, a Film
--   Studio take, a workflow step carried on by another member's page, the API, MCP): those are refused for a gated model.
-- BEFORE IT IS USEFUL: create the Vault secret once (SQL editor, owner; the value is never written in a file):
--     select vault.create_secret('<the same 32+ character value as the web's NIGHTSHIFT_GEO_CLAIM_KEY>', 'nightshift_geo_claim_key');
--   Without it every job on a gated model is refused country_unverified, which today is every job nobody can make anyway.
--
-- PART B. PRICE BY PICTURE SIZE
-- EVIDENCE. The registry prices four Gemini picture models (and Flux 3, Krea 3) by size: pricing.variants.by = image_size, one
--   credit_prices unit per size, model_<id>_<unit>_<size> (modules/model_registry.py credit_unit_for; the validator lists them). The
--   worker sends params.image_size as the vendor's imageSize (modules/capabilities/image.py: "512 / 1K / 2K / 4K: priced per size").
--   But creative_params_problem (0156) refused image_size as an unknown parameter and creative_price (0159) never read the variant, so
--   such a model could only be quoted at its base row with no size, and the vendor then billed its own default size.
-- CHANGE. creative_params_problem (0156's body, two marked hunks): image_size is accepted for t2i and edit, one of 512 1K 2K 4K.
--   creative_price (0159's body, three marked hunks): a size on a model not priced by size, or one it does not list, is refused; a
--   model priced by size must be asked a size (refused otherwise, never priced at the base row) and is priced by the size's own row
--   (a size without one is `unpriced`); the quote names the size. The router treats each refusal as "not a candidate".
--   Not changed: sellable_models still lists a size-priced model on its base row (Found, not done in the report); an operator preview
--   of a size-priced model with no credit row stays unpriced (0149's figure is not read per size).
--
-- REPLACES (md5 drift guard, white space folded): creative_params_problem (0156) before 25ee9cc62a27ad3a19e71008b04f3f36, after
--   {PP}; creative_price (0159) before dafc5edae0000e741ac1b19bd0075790, after {CP}.
--   The lab chain: sec_db.take_off_0159 takes this file off first (0159's and 0156's rollbacks refuse any other body).
-- NUMBER. 0208 provisional (0203 #857, 0204 #859, 0205 #862, 0206 #873, 0207 reserved for BR-LIVE-05). Needs 0035, 0036, 0101's
--   pattern (request.headers), 0156, 0159, pgcrypto (Supabase: schema extensions) and Supabase Vault.
-- Rollback: docs/sql/rollback_0208_geo_gate_and_image_size_price.sql (owner-applied).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regclass('public.creative_jobs') is null or to_regclass('public.model_registry') is null
     or to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0208 needs 0035 (model_registry) and 0036 (creative_jobs, creative_refuse): apply them first';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception '0208 needs Supabase Vault (vault.decrypted_secrets): enable the vault extension, then run this file again';
  end if;
  if to_regprocedure('extensions.hmac(text, text, text)') is null and to_regprocedure('public.hmac(text, text, text)') is null then
    raise exception '0208 needs pgcrypto''s hmac(text, text, text) in schema extensions (Supabase) or public: enable pgcrypto first';
  end if;
  for r in select * from (values
      ('public.creative_params_problem(text, jsonb)', '25ee9cc62a27ad3a19e71008b04f3f36', '{PP}', '0156'),
      ('public.creative_price(uuid, text, text, jsonb)', 'dafc5edae0000e741ac1b19bd0075790', '{CP}', '0159')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0208 found % with a body that is neither %''s nor 0208''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
end $$;

-- A missing key is not an error (nothing on sale needs it), but it is said, with the remedy.
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'nightshift_geo_claim_key') then
    raise notice '0208: no Vault secret nightshift_geo_claim_key yet: every job on a model with a country list is refused until the owner creates it (see the header)';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A1. The country our web server signed for this request
-- ───────────────────────────────────────────────────────────────────────────

"""

MID = """
-- ───────────────────────────────────────────────────────────────────────────
-- A2. The gate on creative_jobs
-- ───────────────────────────────────────────────────────────────────────────

"""

TRIG = """
drop trigger if exists creative_jobs_geo_gate on public.creative_jobs;
create trigger creative_jobs_geo_gate
  before insert or update of routed_model on public.creative_jobs
  for each row execute function public.creative_jobs_geo_gate();

revoke all on function public.geo_claim_country() from public, anon, authenticated, service_role;
revoke all on function public.creative_jobs_geo_gate() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- B1. The parameter: 0156's creative_params_problem, two marked hunks (0208)
-- ───────────────────────────────────────────────────────────────────────────

"""

B2 = """
revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- B2. The price: 0159's creative_price, three marked hunks (0208)
-- ───────────────────────────────────────────────────────────────────────────

"""

END = """
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  for r in select * from (values
      ('public.creative_params_problem(text, jsonb)', '{PP}'),
      ('public.creative_price(uuid, text, text, jsonb)', '{CP}'),
      ('public.geo_claim_country()', '{GEO}'),
      ('public.creative_jobs_geo_gate()', '{GATE}')) v(sig, want) loop
    if (select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(r.sig)) is distinct from r.want then
      raise exception '0208 end state: % is not 0208''s body', r.sig;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                  where t.tgrelid = 'public.creative_jobs'::regclass and t.tgname = 'creative_jobs_geo_gate'
                    and p.proname = 'creative_jobs_geo_gate' and not t.tgisinternal and t.tgenabled = 'O') then
    raise exception '0208 end state: creative_jobs has no enabled creative_jobs_geo_gate trigger';
  end if;
  for r in select * from unnest(array['public.geo_claim_country()', 'public.creative_jobs_geo_gate()',
                                      'public.creative_price(uuid, text, text, jsonb)',
                                      'public.creative_params_problem(text, jsonb)']) sig,
                         unnest(array['anon', 'authenticated', 'service_role']) role_ loop
    if has_function_privilege(r.role_, r.sig, 'EXECUTE') then
      raise exception '0208 end state: % may call %', r.role_, r.sig;
    end if;
  end loop;
  if not (select prosecdef from pg_proc where oid = 'public.geo_claim_country()'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.creative_jobs_geo_gate()'::regprocedure) then
    raise exception '0208 end state: the country gate''s functions are not SECURITY DEFINER';
  end if;
  -- The rules on sample params (no table is read): a size for a picture passes, anything else is refused.
  if public.creative_params_problem('t2i', '{"prompt": "x", "image_size": "2K"}'::jsonb) is not null
     or public.creative_params_problem('t2i', '{"prompt": "x", "image_size": "8K"}'::jsonb) is null
     or public.creative_params_problem('t2v', '{"prompt": "x", "duration_s": 4, "image_size": "1K"}'::jsonb) is null then
    raise exception '0208 end state: creative_params_problem does not read image_size as this file says';
  end if;
end $$;

-- Verify (the SQL editor, after applying; every column should read true):
--   select
--     (select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc
--       where oid = 'public.creative_price(uuid,text,text,jsonb)'::regprocedure) = '{CP}' as creative_price_0208,
--     (select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc
--       where oid = 'public.creative_params_problem(text,jsonb)'::regprocedure) = '{PP}' as params_problem_0208,
--     exists (select 1 from pg_trigger where tgrelid = 'public.creative_jobs'::regclass and tgname = 'creative_jobs_geo_gate') as geo_gate,
--     exists (select 1 from vault.decrypted_secrets where name = 'nightshift_geo_claim_key') as geo_key_in_vault;
"""


def fill(t):
    return t.replace("{PP}", PP_NEW_MD5).replace("{CP}", CP_NEW_MD5).replace("{GEO}", GEO_MD5).replace("{GATE}", GATE_MD5)


migration = (fill(HEADER) + GEO_FN + MID + GATE_FN + fill(TRIG)
             + "-- 0156's params check, also taking a picture size (0208).\n" + PP_NEW + fill(B2)
             + "-- 0159's quote, also priced by picture size (0208).\n" + CP_NEW + fill(END))
(MIG / "0208_geo_gate_and_image_size_price.sql").write_text(migration, encoding="utf-8", newline="\n")

ROLLBACK = """-- rollback_0208_geo_gate_and_image_size_price.sql — undo 0208 (owner-applied, in the SQL editor, as one transaction).
--
-- Puts 0156's creative_params_problem and 0159's creative_price back byte for byte, and drops the country gate (the trigger and its
-- two functions). Refuses a body that is neither 0208's nor the earlier one (a later file may have replaced it: read it first). The
-- Vault secret nightshift_geo_claim_key is left alone (delete it by hand if the key is retired). Idempotent.
--
-- After it, a job on a model with a country list is refused by nothing in the database again: 0142's CHECK must keep every such model
-- off sale (it does; this file does not touch it).

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.creative_params_problem(text, jsonb)', '25ee9cc62a27ad3a19e71008b04f3f36', '{PP}'),
      ('public.creative_price(uuid, text, text, jsonb)', 'dafc5edae0000e741ac1b19bd0075790', '{CP}')) v(sig, was, now_) loop
    select md5(regexp_replace(p.prosrc, '\\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception 'rollback 0208: % is neither 0208''s body nor the earlier one (md5 %): read it first', r.sig, h;
    end if;
  end loop;
end $$;

drop trigger if exists creative_jobs_geo_gate on public.creative_jobs;
drop function if exists public.creative_jobs_geo_gate();
drop function if exists public.geo_claim_country();

-- 0156's body.
""" + PP_OLD + """
revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;

-- 0159's body.
""" + CP_OLD + """
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

do $$
begin
  if (select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc
       where oid = 'public.creative_params_problem(text, jsonb)'::regprocedure) <> '25ee9cc62a27ad3a19e71008b04f3f36'
     or (select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc
       where oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure) <> 'dafc5edae0000e741ac1b19bd0075790'
     or exists (select 1 from pg_trigger where tgrelid = 'public.creative_jobs'::regclass and tgname = 'creative_jobs_geo_gate') then
    raise exception 'rollback 0208 end state: the earlier bodies are not back, or the gate is still there';
  end if;
end $$;

commit;
"""
(ROOT / "docs" / "sql" / "rollback_0208_geo_gate_and_image_size_price.sql").write_text(fill(ROLLBACK), encoding="utf-8", newline="\n")
print("PP", PP_NEW_MD5, "CP", CP_NEW_MD5, "GEO", GEO_MD5, "GATE", GATE_MD5)
