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
