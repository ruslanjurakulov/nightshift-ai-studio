"""Tests for modules/provider_balance.py — parsing, failure handling, key hygiene."""

import logging
from unittest import mock

from modules import provider_balance as pb


def test_parse_elevenlabs_remaining_and_reset():
    snap = pb.parse_elevenlabs({
        "tier": "creator",
        "character_count": 30000,
        "character_limit": 100000,
        "next_character_count_reset_unix": 1790000000,
    })
    assert snap.provider == "elevenlabs"
    assert snap.remaining == 70000
    assert snap.total == 100000
    assert snap.tier == "creator"
    assert snap.resets_at.startswith("2026-")


def test_parse_elevenlabs_never_negative_and_rejects_bad_shape():
    assert pb.parse_elevenlabs({"character_count": 120, "character_limit": 100}).remaining == 0
    assert pb.parse_elevenlabs({"character_count": 1}) is None
    assert pb.parse_elevenlabs(["nope"]) is None


def test_parse_leonardo_sums_paid_and_subscription():
    snap = pb.parse_leonardo({"user_details": [{"apiPaidTokens": 500, "apiSubscriptionTokens": 250}]})
    assert snap.remaining == 750
    assert snap.total is None
    assert pb.parse_leonardo({"user_details": [{}]}) is None


def test_missing_key_makes_no_request(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    with mock.patch.object(pb.requests, "get") as get:
        assert pb.fetch_elevenlabs() is None
        get.assert_not_called()


def test_http_error_is_swallowed_and_key_never_logged(monkeypatch, caplog):
    secret = "sk_live_SUPERSECRET"
    monkeypatch.setenv("ELEVENLABS_API_KEY", secret)
    resp = mock.Mock(status_code=401)
    with mock.patch.object(pb.requests, "get", return_value=resp), caplog.at_level(logging.DEBUG):
        assert pb.fetch_elevenlabs() is None
    with mock.patch.object(pb.requests, "get", side_effect=ConnectionError(secret)), caplog.at_level(logging.DEBUG):
        assert pb.fetch_elevenlabs() is None
    assert secret not in caplog.text


def test_record_writes_rows_and_low_credit_alert(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_LOW_CREDITS", "1000")
    sync = mock.Mock()
    sync.upsert.return_value = 1
    low = pb.BalanceSnapshot("elevenlabs", "credits", 500.0, 10000.0, "credits")
    assert pb.record(sync=sync, fetchers=[lambda: low]) == 1
    tables = [c.args[0] for c in sync.upsert.call_args_list]
    assert tables == ["provider_balances", "alert_events"]


def test_record_never_raises_on_failing_fetcher():
    def boom():
        raise RuntimeError("x")

    sync = mock.Mock()
    assert pb.record(sync=sync, fetchers=[boom]) == 0
    sync.upsert.assert_not_called()


# ── Runway: GET /v1/organization -> creditBalance (docs.dev.runwayml.com/api.md, read 2026-11-13) ──

def test_parse_runway_reads_the_documented_credit_balance_only():
    snap = pb.parse_runway({"creditBalance": 915, "tier": {"maxMonthlyCreditSpend": 10000, "models": {}}, "usage": {"models": {}}})
    assert (snap.provider, snap.metric, snap.remaining, snap.unit) == ("runway", "credits", 915.0, "credits")
    # The tier's monthly purchase ceiling is not an allowance: storing it as `total` would draw a meter against the wrong figure.
    assert snap.total is None
    # A zero balance is a real, documented answer ("minimum 0"), not a missing one.
    assert pb.parse_runway({"creditBalance": 0}).remaining == 0


def test_parse_runway_unknown_is_no_snapshot_never_zero():
    for bad in ({}, {"creditBalance": None}, {"creditBalance": "lots"}, {"creditBalance": -5}, {"creditBalance": True},
                {"credit_balance": 915}, ["creditBalance", 915], None):
        assert pb.parse_runway(bad) is None, bad


def test_runway_fetch_sends_the_key_and_version_header_to_the_fixed_url_only(monkeypatch):
    monkeypatch.setenv("RUNWAYML_API_SECRET", "key_runway_TESTVALUE")
    resp = mock.Mock(status_code=200)
    resp.json.return_value = {"creditBalance": 915}
    with mock.patch.object(pb.requests, "get", return_value=resp) as get:
        snap = pb.fetch_runway()
    assert snap.remaining == 915
    (url,), kw = get.call_args
    assert url == "https://api.dev.runwayml.com/v1/organization"
    assert kw["headers"]["Authorization"] == "Bearer key_runway_TESTVALUE"
    assert kw["headers"]["X-Runway-Version"] == "2024-11-06"
    assert kw["timeout"] == pb._TIMEOUT


def test_runway_without_a_key_makes_no_request(monkeypatch):
    monkeypatch.delenv("RUNWAYML_API_SECRET", raising=False)
    monkeypatch.delenv("RUNWAY_API_KEY", raising=False)
    with mock.patch.object(pb.requests, "get") as get:
        assert pb.fetch_runway() is None
        get.assert_not_called()


def test_runway_failure_is_skipped_and_the_key_never_reaches_the_log(monkeypatch, caplog):
    secret = "key_runway_SUPERSECRET_0123456789"
    monkeypatch.setenv("RUNWAYML_API_SECRET", secret)
    for status in (401, 429, 500):
        with mock.patch.object(pb.requests, "get", return_value=mock.Mock(status_code=status)), caplog.at_level(logging.DEBUG):
            assert pb.fetch_runway() is None
    with mock.patch.object(pb.requests, "get", side_effect=ConnectionError(f"proxy said {secret}")), caplog.at_level(logging.DEBUG):
        assert pb.fetch_runway() is None
    bad_json = mock.Mock(status_code=200)
    bad_json.json.side_effect = ValueError(secret)
    with mock.patch.object(pb.requests, "get", return_value=bad_json), caplog.at_level(logging.DEBUG):
        assert pb.fetch_runway() is None
    assert secret not in caplog.text
    assert secret[:12] not in caplog.text


def test_runway_is_one_of_the_balance_fetchers_and_its_snapshot_is_written():
    assert pb.fetch_runway in pb.FETCHERS
    sync = mock.Mock()
    sync.upsert.return_value = 1
    snap = pb.parse_runway({"creditBalance": 915})
    assert pb.record(sync=sync, fetchers=[lambda: snap]) == 1
    table, rows = sync.upsert.call_args_list[0].args
    assert table == "provider_balances"
    assert rows == [{"provider": "runway", "metric": "credits", "remaining": 915.0, "total": None, "unit": "credits",
                     "tier": None, "resets_at": None, "source": "api"}]
    # No low-credit alert is invented for Runway: the only alert rule is ElevenLabs'.
    assert [c.args[0] for c in sync.upsert.call_args_list] == ["provider_balances"]
