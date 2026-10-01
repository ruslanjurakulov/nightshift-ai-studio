"""Named attacks on the media library (migrations 0038 and 0044).

The table-by-table isolation tests already prove that Bob (org B) cannot read,
change, delete, move or insert Alice's (org A) media rows. These prove the
functions: the upload ticket flow, soft delete, and the worker's registering
and purging — the paths where the check lives in plpgsql, not in a policy.

0044 (iPhone photos) adds no table and no function. The attacks on it are of two
kinds: SQL (the widened type allowlist and the new `display` variant open
nothing for another organization, and keep the size cap and the quota) and the
worker's own checks (modules/media_library.py: a PNG renamed .heic, AVIF, a
header that claims a bomb-sized picture). The worker's run on real bytes with no
database; they need pillow-heif, which tests/security/requirements.txt installs.
"""

from __future__ import annotations

import io
import os
import struct
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sec_db import ANON, SERVICE, acting, as_superuser


def ticket_status(conn, ticket: str) -> str:
    with as_superuser(conn, commit=False) as s:
        return s.value("select status from public.media_uploads where id = %s", [ticket])


def asset_row(conn, asset: str):
    with as_superuser(conn, commit=False) as s:
        return s.rows("select org_id::text, deleted_at, purged_at from public.media_assets where id = %s", [asset])[0]


# ── uploads ─────────────────────────────────────────────────────────────────

def test_customer_cannot_request_an_upload_into_another_org(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("select public.request_upload(%s, 'x.png', 'image/png', 10)", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("who", ["stranger", "anon"])
def test_outsiders_cannot_request_uploads(conn, sc, who):
    actor = sc.stranger if who == "stranger" else ANON
    with acting(conn, actor) as s:
        out = s.run("select public.request_upload(%s, 'x.png', 'image/png', 10)", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501", out


def test_customer_cannot_send_the_body_of_another_orgs_ticket(conn, sc):
    before = ticket_status(conn, sc.alice.media_ticket)
    with acting(conn, sc.bob.actor) as s:
        begin = s.run("select public.begin_upload_receive(%s)", [sc.alice.media_ticket])
        finish = s.run("select public.finish_upload_receive(%s, 10, true)", [sc.alice.media_ticket])
    # "Not found", not "forbidden": a ticket id says nothing to someone else.
    assert not begin.ok and begin.sqlstate == "P0002", begin
    assert not finish.ok and finish.sqlstate == "P0002", finish
    assert ticket_status(conn, sc.alice.media_ticket) == before


def test_a_member_cannot_hijack_a_colleagues_ticket(conn, sc):
    # Ivan holds an invite into org A (a member by email), but is not the person who
    # asked for the ticket, so he may not send its body.
    with acting(conn, sc.invitee) as s:
        out = s.run("select public.begin_upload_receive(%s)", [sc.alice.media_ticket])
    assert not out.ok and out.sqlstate == "P0002", out


def test_a_ticket_is_received_once(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        t = s.value("select public.request_upload(%s, 'clip.mp4', 'video/mp4', 100) ->> 'ticket'", [sc.alice.org])
        first = s.value("select public.begin_upload_receive(%s)", [t])
        second = s.value("select public.begin_upload_receive(%s)", [t])
        over = s.value("select public.finish_upload_receive(%s, 101, true)", [t])
    assert first["ok"] is True
    assert second["ok"] is False
    assert over == "rejected"  # more than declared is never 'uploaded'


def test_path_characters_in_a_filename_are_only_a_label(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.value("select public.request_upload(%s, %s, 'image/png', 10)",
                      [sc.alice.org, "../../../etc/cron.d/evil\x01.png"])
    assert out["name"] == "evil.png"


@pytest.mark.parametrize("name,mime", [
    ("photo.png", "video/mp4"),        # extension and type disagree
    ("payload.exe", "image/png"),      # not media by name
    ("x.svg", "image/svg+xml"),        # a browser would run it
    ("page", "text/html"),
])
def test_spoofed_types_are_refused_before_a_ticket(conn, sc, name, mime):
    with acting(conn, sc.alice.actor) as s:
        out = s.run("select public.request_upload(%s, %s, %s, 10)", [sc.alice.org, name, mime])
    assert not out.ok and out.sqlstate == "NS415", out


def test_quota_is_enforced_for_the_member_who_asks(conn, sc):
    with as_superuser(conn) as s:
        s.rows("update public.org_storage_quota set limit_bytes = used_bytes + 5000 where org_id = %s returning 1",
               [sc.bob.org])
    try:
        with acting(conn, sc.bob.actor) as s:
            out = s.run("select public.request_upload(%s, 'big.mp4', 'video/mp4', 10000)", [sc.bob.org])
        assert not out.ok and out.sqlstate == "NS507", out
    finally:
        with as_superuser(conn) as s:
            s.rows("update public.org_storage_quota set limit_bytes = null where org_id = %s returning 1", [sc.bob.org])


# ── assets ──────────────────────────────────────────────────────────────────

def test_customer_cannot_delete_another_orgs_asset(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("select public.soft_delete_asset(%s)", [sc.alice.media_asset])
    assert not out.ok and out.sqlstate == "P0002", out
    assert asset_row(conn, sc.alice.media_asset)[1] is None


@pytest.mark.parametrize("who", ["stranger", "anon"])
def test_outsiders_cannot_delete_assets(conn, sc, who):
    actor = sc.stranger if who == "stranger" else ANON
    with acting(conn, actor) as s:
        out = s.run("select public.soft_delete_asset(%s)", [sc.alice.media_asset])
    assert not out.ok, out
    assert asset_row(conn, sc.alice.media_asset)[1] is None


def test_a_deleted_asset_is_hidden_from_its_own_members(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        assert s.value("select public.soft_delete_asset(%s)", [sc.alice.media_asset]) is True
        assert s.rows("select 1 from public.media_assets where id = %s", [sc.alice.media_asset]) == []
    # acting() rolled it back: the seed row is live again for the other tests.
    assert asset_row(conn, sc.alice.media_asset)[1] is None


SERVICE_CALLS = [
    ("register_asset", "select public.register_asset(gen_random_uuid(), %(org)s, 'image', 'image/png', 1, "
                       "repeat('a', 64), 'generated')"),
    ("claim_media_upload", "select * from public.claim_media_upload('bob')"),
    ("reject_media_upload", "select public.reject_media_upload(%(ticket)s, 'bob', 'nope')"),
    ("claim_media_purge", "select * from public.claim_media_purge(10)"),
    ("mark_asset_purged", "select public.mark_asset_purged(%(asset)s)"),
]


@pytest.mark.parametrize("name,query", SERVICE_CALLS, ids=[c[0] for c in SERVICE_CALLS])
def test_customer_cannot_call_the_workers_functions(conn, sc, name, query):
    args = {"org": sc.alice.org, "ticket": sc.alice.media_ticket, "asset": sc.alice.media_asset}
    for who in (sc.bob.actor, sc.alice.actor, ANON):
        with acting(conn, who) as s:
            out = s.run(query, args)
        assert not out.ok and out.sqlstate == "42501", f"{name} as {who.name}: {out!r}"


def test_the_worker_cannot_register_an_upload_into_another_org(conn, sc):
    with acting(conn, sc.alice.actor, commit=True) as s:
        t = s.value("select public.request_upload(%s, 'a.png', 'image/png', 50) ->> 'ticket'", [sc.alice.org])
        s.value("select public.begin_upload_receive(%s)", [t])
        s.value("select public.finish_upload_receive(%s, 50, true)", [t])
    with acting(conn, SERVICE) as s:
        claimed = s.rows("select id::text from public.claim_media_upload('w1')")
        assert claimed and claimed[0][0] == t
        out = s.run("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 50, repeat('b', 64), "
                    "'upload', p_upload_id => %s)", [sc.bob.org, t])
        assert not out.ok and out.sqlstate == "42501", out
        # Without an org the ticket's own is used, and the row is Alice's.
        ok = s.value("select public.register_asset(gen_random_uuid(), null, 'image', 'image/png', 50, repeat('b', 64), "
                     "'upload', p_upload_id => %s) ->> 'id'", [t])
        assert s.value("select org_id::text from public.media_assets where id = %s", [ok]) == sc.alice.org
    # Leave nothing in flight for the other tests.
    with as_superuser(conn) as s:
        s.rows("update public.media_uploads set status = 'expired' where id = %s returning 1", [t])


def test_a_version_of_another_orgs_asset_cannot_be_registered(conn, sc):
    with acting(conn, SERVICE) as s:
        out = s.run("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 1, repeat('c', 64), "
                    "'generated', p_parent_asset_id => %s)", [sc.bob.org, sc.alice.media_asset])
    assert not out.ok and out.sqlstate == "42501", out


def test_nobody_can_choose_where_a_file_lives(conn, sc):
    aid = str(uuid.uuid4())
    with as_superuser(conn, commit=False) as s:
        out = s.run("insert into public.media_assets (id, org_id, kind, mime, bytes, sha256, source, storage_key) "
                    "values (%s, %s, 'image', 'image/png', 1, repeat('d', 64), 'generated', '../../etc')",
                    [aid, sc.alice.org])
        assert not out.ok and out.sqlstate == "428C9", out  # generated column
        key = s.value("select storage_key from public.media_assets where id = %s", [sc.alice.media_asset])
    assert key == f"{sc.alice.media_asset[:2]}/{sc.alice.media_asset}"


# ── 0044: HEIC / HEIF — SQL ─────────────────────────────────────────────────

@pytest.mark.parametrize("name,mime,want", [
    ("photo.heic", "image/heic", "image/heic"),
    ("photo.heif", "image/heif", "image/heif"),
    ("IMG_0001.HEIC", "image/x-heic", "image/heic"),   # an alias folded to the canonical type
    ("IMG_0001.HEIF", "image/x-heif", "image/heif"),
    ("photo.heic", "", "image/heic"),                   # Windows browsers send no type
    ("photo.heic", "application/octet-stream", "image/heic"),
    ("photo.jpg", "image/heic", "image/heic"),          # same kind: the worker decides by content
])
def test_a_member_may_ask_to_upload_a_heic(conn, sc, name, mime, want):
    with acting(conn, sc.alice.actor) as s:
        out = s.value("select public.request_upload(%s, %s, %s, 1000)", [sc.alice.org, name, mime])
    assert out["mime"] == want and out["kind"] == "image", out


@pytest.mark.parametrize("name,mime", [
    ("photo.heic", "video/mp4"),            # extension and type name different kinds
    ("clip.mp4", "image/heic"),
    ("photo.heic", "audio/mpeg"),
    ("photo.avif", "image/avif"),           # AVIF is not accepted
    ("photo.heic", "image/avif"),
    ("photo.heic", "image/heic-sequence"),  # sequences (live photo motion) are not accepted
    ("photo.heics", "image/heic-sequence"),
    ("photo.heic.exe", "image/heic"),
    ("photo.heic", "image/svg+xml"),
    ("photo.heic", "text/html"),
])
def test_what_heic_does_not_open_is_still_refused(conn, sc, name, mime):
    with acting(conn, sc.alice.actor) as s:
        out = s.run("select public.request_upload(%s, %s, %s, 1000)", [sc.alice.org, name, mime])
    assert not out.ok and out.sqlstate == "NS415", out


def test_heic_is_no_way_into_another_org_or_around_the_gates(conn, sc):
    for who in (sc.bob.actor, sc.stranger, ANON):
        with acting(conn, who) as s:
            out = s.run("select public.request_upload(%s, 'photo.heic', 'image/heic', 1000)", [sc.alice.org])
        assert not out.ok and out.sqlstate == "42501", f"{who.name}: {out!r}"
    with as_superuser(conn, commit=False) as s:
        cap = s.value("select max_upload_bytes from public.media_storage_settings where id")
    with acting(conn, sc.alice.actor) as s:
        out = s.run("select public.request_upload(%s, 'photo.heic', 'image/heic', %s)", [sc.alice.org, cap + 1])
    assert not out.ok and out.sqlstate == "NS413", out  # the per-file cap is the same for a photo
    assert cap == 95 * 1024 * 1024


def test_the_quota_applies_to_heic_uploads_too(conn, sc):
    with as_superuser(conn) as s:
        s.rows("update public.org_storage_quota set limit_bytes = used_bytes + 5000 where org_id = %s returning 1",
               [sc.bob.org])
    try:
        with acting(conn, sc.bob.actor) as s:
            out = s.run("select public.request_upload(%s, 'IMG_1.HEIC', 'image/heic', 10000)", [sc.bob.org])
        assert not out.ok and out.sqlstate == "NS507", out
    finally:
        with as_superuser(conn) as s:
            s.rows("update public.org_storage_quota set limit_bytes = null where org_id = %s returning 1", [sc.bob.org])


def test_a_heic_asset_is_registered_for_its_own_org_with_both_variants(conn, sc):
    with acting(conn, sc.alice.actor, commit=True) as s:
        t = s.value("select public.request_upload(%s, 'IMG_1.HEIC', 'image/heic', 400) ->> 'ticket'", [sc.alice.org])
        s.value("select public.begin_upload_receive(%s)", [t])
        s.value("select public.finish_upload_receive(%s, 400, true)", [t])
    try:
        with acting(conn, SERVICE) as s:
            assert s.rows("select id::text from public.claim_media_upload('w-heic')")[0][0] == t
            # Another org cannot be named for it ...
            bad = s.run("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/heic', 400, repeat('e', 64), "
                        "'upload', p_variants => array['thumb', 'display'], p_upload_id => %s)", [sc.bob.org, t])
            assert not bad.ok and bad.sqlstate == "42501", bad
            # ... a HEIC cannot be filed as a video ...
            kind = s.run("select public.register_asset(gen_random_uuid(), null, 'video', 'image/heic', 400, repeat('e', 64), "
                         "'upload', p_upload_id => %s)", [t])
            assert not kind.ok and kind.sqlstate == "23514", kind
            # ... and the ticket's own org gets it, with the derived bytes in its quota.
            before = s.value("select used_bytes from public.org_storage_quota where org_id = %s", [sc.alice.org])
            aid = s.value("select public.register_asset(gen_random_uuid(), null, 'image', 'image/heic', 400, repeat('e', 64), "
                          "'upload', p_width => 30, p_height => 40, p_derived_bytes => 900, "
                          "p_variants => array['thumb', 'display'], p_upload_id => %s) ->> 'id'", [t])
            row = s.rows("select org_id::text, mime, variants from public.media_assets where id = %s", [aid])[0]
            assert tuple(row) == (sc.alice.org, "image/heic", ["thumb", "display"])
            after = s.value("select used_bytes from public.org_storage_quota where org_id = %s", [sc.alice.org])
            assert after - before == 400 + 900
    finally:
        with as_superuser(conn) as s:
            s.rows("update public.media_uploads set status = 'expired' where id = %s returning 1", [t])


@pytest.mark.parametrize("variants,ok", [
    (["thumb", "display"], True),
    (["display"], True),
    (["thumb", "proxy", "display"], True),
    (["original"], False),
    (["display.jpg"], False),
    (["thumb", "../display"], False),
    (["zip"], False),
])
def test_the_variants_list_allows_display_and_nothing_else_new(conn, sc, variants, ok):
    aid = str(uuid.uuid4())
    with as_superuser(conn, commit=False) as s:
        out = s.run("insert into public.media_assets (id, org_id, kind, mime, bytes, sha256, source, variants) "
                    "values (%s, %s, 'image', 'image/heic', 1, repeat('f', 64), 'generated', %s)",
                    [aid, sc.alice.org, variants])
    assert out.ok is ok, out
    if not ok:
        assert out.sqlstate == "23514", out


def test_the_type_helpers_stay_out_of_reach_of_the_api_roles(conn, sc):
    for who in (sc.alice.actor, sc.bob.actor, ANON):
        for call in ("public.media_mime_kind('image/heic')", "public.media_ext_mime('heic')",
                     "public.media_normalize_mime('image/x-heic', 'a.heic')"):
            with acting(conn, who) as s:
                out = s.run(f"select {call}")
            assert not out.ok and out.sqlstate == "42501", f"{call} as {who.name}: {out!r}"


# ── 0044: HEIC / HEIF — the worker's own checks, on real bytes, no database ──

def _ml():
    from modules import media_library as ml
    return ml


def _heif():
    try:
        import pillow_heif
        from PIL import Image
    except ImportError:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail("pillow-heif is not installed: tests/security/requirements.txt lists it", pytrace=False)
        pytest.skip("pillow-heif is not installed (pip install pillow-heif)")
    pillow_heif.register_heif_opener()
    return Image


def _box(kind: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def _ftyp(major: bytes, *compat: bytes) -> bytes:
    return _box(b"ftyp", major + b"\x00\x00\x00\x00" + b"".join(compat))


class _Store:
    def __init__(self):
        self.registered, self.rejected = [], []

    def heartbeat(self, *_a):
        pass

    def register(self, **kw):
        self.registered.append(kw)
        return {"id": kw["asset_id"], "reused": False}

    def reject(self, tid, worker, reason, detail):
        self.rejected.append(reason)


def _ingest(data: bytes, *, mime: str, name: str):
    """One ticket through the worker's real code path; returns (outcome, reason, files left)."""
    ml = _ml()
    with tempfile.TemporaryDirectory() as d:
        staging, media = Path(d, "staging"), Path(d, "media")
        staging.mkdir()
        media.mkdir()
        tid = str(uuid.uuid4())
        ml.staged_path(staging, tid).write_bytes(data)
        store = _Store()
        out = ml.process_ticket({"id": tid, "declared_mime": mime, "original_name": name, "declared_bytes": len(data)},
                                store=store, staging_root=staging, media_root=media, worker_id="sec",
                                tools=ml.Tools("ffprobe", "ffmpeg"))
        files = [p for p in media.rglob("*") if p.is_file()]
        reason = store.rejected[-1] if store.rejected else None
        return out, reason, files, store.registered


def test_non_heic_bytes_named_heic_are_rejected():
    Image = _heif()
    png, jpg = io.BytesIO(), io.BytesIO()
    Image.new("RGB", (16, 16)).save(png, format="PNG")
    Image.new("RGB", (16, 16)).save(jpg, format="JPEG")
    mp4 = _ftyp(b"isom", b"isom", b"mp41") + b"\x00" * 64
    cases = [
        (png.getvalue(), "image/heic", "photo.heic"),
        (png.getvalue(), "image/png", "photo.HEIC"),
        (jpg.getvalue(), "image/jpeg", "IMG_0001.heif"),
        (jpg.getvalue(), "image/heif", "photo.jpg"),
        (mp4, "video/mp4", "photo.heic"),
        (b"<html><script>alert(1)</script></html>", "image/heic", "photo.heic"),
        (b"PK\x03\x04" + b"\x00" * 40, "image/heic", "photo.heic"),
        (b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "image/heic", "photo.heic"),
    ]
    for data, mime, name in cases:
        out, reason, files, registered = _ingest(data, mime=mime, name=name)
        assert out == "rejected" and registered == [] and files == [], (name, mime, out, reason)
    # A HEIC brand with nothing behind it is not a picture either.
    out, reason, files, registered = _ingest(_ftyp(b"heic", b"mif1", b"heic") + os.urandom(512),
                                             mime="image/heic", name="photo.heic")
    assert (out, reason, files, registered) == ("rejected", "not_media", [], [])


def test_avif_is_rejected_under_every_name():
    ml = _ml()
    heads = [_ftyp(b"avif", b"avif", b"mif1", b"miaf"), _ftyp(b"avis", b"avis", b"msf1"),
             _ftyp(b"heic", b"mif1", b"avif"), _ftyp(b"mif1", b"mif1", b"miaf")]
    for head in heads:
        assert ml.sniff(head + b"\x00" * 64) is None, head
        for mime, name in (("image/heic", "photo.heic"), ("image/jpeg", "photo.jpg"), ("image/avif", "photo.avif"),
                           ("video/mp4", "clip.mp4")):
            out, reason, files, registered = _ingest(head + b"\x00" * 64, mime=mime, name=name)
            assert (out, reason, files, registered) == ("rejected", "unsupported_type", [], []), (head[8:12], name)
    # A real AVIF file, when this build can write one.
    Image = _heif()
    buf = io.BytesIO()
    try:
        Image.new("RGB", (32, 24), (9, 9, 9)).save(buf, format="AVIF")
    except Exception:
        return
    out, reason, files, registered = _ingest(buf.getvalue(), mime="image/heic", name="photo.heic")
    assert (out, reason, files, registered) == ("rejected", "unsupported_type", [], [])


def test_oversized_pixel_dimensions_are_rejected_before_decoding():
    Image = _heif()
    buf = io.BytesIO()
    Image.new("RGB", (400, 200), (200, 30, 30)).save(buf, format="HEIF", quality=70)
    real = buf.getvalue()
    i = real.find(b"ispe")
    assert i > 0

    def claim(w, h):
        data = bytearray(real)
        data[i + 8:i + 16] = struct.pack(">II", w, h)
        return bytes(data)

    # Over the 16384 px side limit; over 100 megapixels; absurd.
    for w, h in ((16385, 10), (10, 16385), (11000, 10000), (65000, 65000), (2 ** 31 - 1, 2 ** 31 - 1)):
        out, reason, files, registered = _ingest(claim(w, h), mime="image/heic", name="bomb.heic")
        assert (out, reason, files, registered) == ("rejected", "too_large_dimensions", [], []), (w, h, reason)
    # The honest file next to them is stored.
    out, reason, files, registered = _ingest(real, mime="image/heic", name="ok.heic")
    assert out == "ingested" and registered[0]["variants"] == ["thumb", "display"], (out, reason)
