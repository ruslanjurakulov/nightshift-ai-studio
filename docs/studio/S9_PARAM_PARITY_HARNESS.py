"""SCRATCH MEASUREMENT (not committed): for every registry model and generation capability, a grid of params is put to both
the worker's pre-submit checks (RegistryAdapter.submit up to the vendor call, which includes entry.problems and the adapter's own
problems) and the lab database's quote_creative_job. Writes one JSON line per case to $PARITY_OUT."""

from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

import pytest

import test_sec_creative_prompt_limits as pl
import test_sec_films_money as fm

db = fm.db
REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from modules import model_registry as mr  # noqa: E402
from modules import creative_adapters as ca  # noqa: E402
from modules.capabilities import build_adapter  # noqa: E402
from modules.creative_worker import GenerationRequest  # noqa: E402

GEN = ("t2i", "t2v", "i2v", "edit")
SHAPES = ("16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "3:2", "2:3")
OUT = os.environ.get("PARITY_OUT", "/tmp/parity.jsonl")


class _Sent(Exception):
    pass


def _png(path: Path, w=1280, h=720):
    from PIL import Image
    Image.new("RGB", (w, h), (90, 120, 150)).save(path)
    return path


def worker_verdict(entry, cap, params, tmp):
    try:
        adapter = build_adapter(entry.adapter, env={})
    except Exception as e:  # noqa: BLE001
        return ("no_adapter", str(e)[:200])
    def boom(*a, **k):
        raise _Sent()
    adapter.submit = boom
    ra = ca.RegistryAdapter(entry, adapter)
    files = (str(_png(tmp / "src.png")),) if cap in ("i2v", "edit") else ()
    end = str(_png(tmp / "end.png")) if params.get("end_asset_id") else None
    req = GenerationRequest(job_id="j", org_id="o", capability=cap, model=entry.id, params=params,
                            input_files=tuple(Path(x) for x in files), end_file=Path(end) if end else None, quantity=1)
    try:
        ra.submit(req)
    except _Sent:
        return None
    except ca.CreativeAdapterError as e:
        return (e.code, e.message[:300])
    except Exception as e:  # noqa: BLE001
        return (type(e).__name__, str(e)[:300])
    return None


def grid(entry, cap):
    spec = entry.raw
    base = {"prompt": "a lighthouse at dawn, slow push in"}
    timed = cap in ("t2v", "i2v")
    if timed and entry.durations_s:
        base["duration_s"] = entry.durations_s[0]
    if timed and entry.resolutions:
        base["resolution"] = entry.default_resolution or entry.resolutions[0]
    if entry.qualities and cap in ("t2i", "edit"):
        base["quality"] = entry.qualities[0]
    if entry.image_sizes and cap in ("t2i", "edit"):
        base["image_size"] = entry.image_sizes[0]
    if timed and entry.priced_by_audio:
        base["audio"] = False
    yield "base", dict(base)
    nop = {k: v for k, v in base.items() if k != "prompt"}
    yield "no_prompt", nop
    for s in SHAPES:
        yield f"aspect={s}", {**base, "aspect_ratio": s}
    if timed:
        for d in sorted(set(entry.durations_s) | {4, 5, 6, 8, 10}):
            yield f"duration={d}", {**base, "duration_s": d}
        for r in sorted(set(entry.resolutions) | {"480p", "720p", "768p", "1080p"}):
            yield f"resolution={r}", {**base, "resolution": r}
        yield "no_resolution", {k: v for k, v in base.items() if k != "resolution"}
        yield "audio=true", {**base, "audio": True}
    if cap == "i2v":
        yield "end_frame", {**base, "end_asset_id": "END"}
    if "image_size" in base:
        yield "no_image_size", {k: v for k, v in base.items() if k != "image_size"}
    yield "negative_prompt", {**base, "negative_prompt": "blur"}
    yield "long_prompt_2500", {**base, "prompt": "a" * 2500}


def models():
    out = []
    for e in mr.registry().values():
        if e.registry_only or e.shut_down() or mr.is_bytedance(e.raw):
            continue
        for cap in e.capabilities:
            if cap in GEN:
                out.append((e, cap))
    return out


def test_measure(db, tmp_path):
    pairs = models()
    ids = sorted({e.id for e, _ in pairs})
    rows = {}
    bad = []
    for i in ids:  # one by one: a row the sync refuses is recorded, not fatal
        try:
            rows.update(pl._sell_real_rows(db, [i]))
        except Exception as ex:  # noqa: BLE001
            bad.append((i, str(ex).splitlines()[0][:200]))
    # re-sell all at once so every row is on sale together
    rows = pl._sell_real_rows(db, [i for i in ids if i in rows])
    o = db.new_org(credits=100000, image=False)
    import test_sec_adult_attestation as aa
    db.act("authenticated", o.owner, "select public.record_adult_attestation(true, %s, 'email_signup')", [aa.TERMS])
    src = db.asset(o.org, kind="image", mime="image/png")
    end = db.asset(o.org, kind="image", mime="image/png")
    with open(OUT, "w") as f:
        for i, b in bad:
            f.write(json.dumps({"model": i, "sync_error": b}) + "\n")
        for e, cap in pairs:
            if e.id not in rows:
                continue
            for name, params in grid(e, cap):
                q = dict(params)
                if cap in ("i2v", "edit"):
                    q["source_asset_id"] = str(src)
                if q.get("end_asset_id"):
                    q["end_asset_id"] = str(end)
                quote = pl._quote(db, o, cap, e.id, q)
                stored = params
                if quote is None:
                    made = pl._err(lambda: db.one("authenticated", o.owner,
                        "select public.create_creative_job(%s::uuid, %s, %s, %s::jsonb, 'exact', null, 100000::numeric)",
                        [o.org, cap, e.id, json.dumps(q)]))
                    if made is None:
                        got = db.su("select params from public.creative_jobs where org_id = %s order by created_at desc limit 1", [o.org])[0][0]
                        stored = {k: v for k, v in got.items() if k not in ("source_asset_id",)}
                        db.su("update public.creative_jobs set status = 'cancelled', finished_at = now() "
                              "where org_id = %s and status not in ('succeeded', 'failed', 'cancelled')", [o.org])
                        db.su("update public.credit_reservations set status = 'released' where org_id = %s and status = 'open'", [o.org])
                        if "end_asset_id" in stored:
                            stored["end_asset_id"] = "END"
                    else:
                        quote = list(made) + ["create_refused"]
                w = worker_verdict(e, cap, stored, tmp_path)
                f.write(json.dumps({"model": e.id, "adapter": e.adapter, "cap": cap, "case": name,
                                    "quote": quote and list(quote), "worker": w and list(w)}) + "\n")
