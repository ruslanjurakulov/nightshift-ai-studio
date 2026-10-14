"""Fakes for the operator bot tests: a Telegram HTTP layer that records every
call, a Supabase client that serves canned rows, and a clock. Nothing here
touches the network, a provider or a secret."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.sources import OperatorSources
from modules.supabase_sync import SupabaseReadError
from modules.telegram_control import TelegramControl

NOW = datetime(2026, 10, 14, 12, 0, 0, tzinfo=timezone.utc)
ADMIN = 100
CHAT = "100"


def ts(minutes_ago: float = 0, base: datetime = NOW) -> str:
    return (base - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body if body is not None else {"ok": True}

    def json(self):
        return self._body


class FakeTelegram:
    """Stands in for ``requests``: every POST is recorded as (method, payload)."""

    def __init__(self, status=200):
        self.calls: list = []
        self.status = status

    def post(self, url, json=None, timeout=None):
        method = url.rsplit("/", 1)[-1]
        self.calls.append((method, json))
        return FakeResponse(self.status)

    def sent(self):
        return [p for m, p in self.calls if m == "sendMessage"]

    def texts(self):
        return [p["text"] for p in self.sent()]

    def answers(self):
        return [p for m, p in self.calls if m == "answerCallbackQuery"]


class FakeSync:
    """Serves rows by table name and ignores the PostgREST filters (the code
    under test filters again in Python where the window matters)."""

    enabled = True

    def __init__(self, tables=None, fail=()):
        self.tables = dict(tables or {})
        self.fail = set(fail)
        self.upserts: list = []
        self.claimed: set = set()
        self.reads: list = []

    def select_strict(self, table, params=None):
        self.reads.append((table, dict(params or {})))
        if table in self.fail:
            raise SupabaseReadError(table, 500, "")
        return [dict(r) for r in self.tables.get(table, [])]

    def upsert(self, table, rows, on_conflict=None, ignore_duplicates=False):
        self.upserts.append((table, rows))
        self.tables.setdefault(table, []).extend(rows)
        return len(rows)

    def insert_new(self, table, rows, on_conflict):
        new = [r for r in rows if r["update_id"] not in self.claimed]
        self.claimed |= {r["update_id"] for r in new}
        return new


class FakeHttp:
    """``http_get(url, headers, timeout) -> (status, json)`` from a url->answer map
    (matched by prefix); unknown urls answer (None, None)."""

    def __init__(self, answers=None):
        self.answers = dict(answers or {})
        self.calls: list = []

    def __call__(self, url, headers, timeout):
        self.calls.append((url, headers))
        for prefix in sorted(self.answers, key=len, reverse=True):   # the most specific wins
            if url.startswith(prefix):
                return self.answers[prefix]
        return None, None


def make_control(session=None, chat=CHAT, admins="") -> TelegramControl:
    return TelegramControl(token="123456:TESTTOKENTESTTOKENTESTTOKENTEST", chat_id=chat,
                           admin_user_ids=admins, session=session or FakeTelegram())


def make_ops(tables=None, http=None, cfg=None, now=NOW, fail=(), token=""):
    sync = FakeSync(tables, fail)
    cfg = cfg or OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo")
    return OperatorSources(sync, http or FakeHttp(), cfg, now=lambda: now, github_token=token), sync


def run_ok(run_id=1, conclusion="success", minutes_ago=30, sha="abcdef1234567"):
    return {"id": run_id, "status": "completed", "conclusion": conclusion, "head_sha": sha,
            "updated_at": ts(minutes_ago), "created_at": ts(minutes_ago + 5)}


def github_ok(deploy="success", tests="success", frontend="success"):
    def body(c, i):
        return 200, {"workflow_runs": [run_ok(i, c)]}
    return {
        "https://api.github.com/repos/owner/repo/actions/workflows/deploy_web.yml": body(deploy, 11),
        "https://api.github.com/repos/owner/repo/actions/workflows/tests.yml": body(tests, 12),
        "https://api.github.com/repos/owner/repo/actions/workflows/frontend.yml": body(frontend, 13),
    }


def site_ok():
    return {"https://app.example.test": (200, None)}


def healthy_tables(now=NOW):
    """A system with nothing wrong: one fresh worker, no failures, one balance."""
    return {
        "worker_status": [{"worker_id": "nightshift-01", "kind": "pipeline", "state": "running",
                           "detail": None, "version": "x", "started_at": ts(600, now), "updated_at": ts(0.2, now)}],
        "render_jobs": [], "creative_jobs": [], "provider_balances": [
            {"provider": "elevenlabs", "metric": "credits", "remaining": 80000, "total": 100000,
             "unit": "credits", "tier": "creator", "resets_at": None, "checked_at": ts(60, now)}],
        "creative_job_costs": [], "system_events": [], "organizations": [], "publish_approvals": [],
        "pipeline_runs": [], "app_audit_log": [], "alert_events": [],
    }


def update_message(text, chat=100, user=None, date=None, update_id=1, chat_type="private", **extra):
    msg = {"message_id": 5, "text": text, "chat": {"id": chat, "type": chat_type},
           "from": {"id": chat if user is None else user, "is_bot": False}, "date": date or int(NOW.timestamp()) - 30}
    msg.update(extra)
    return {"update_id": update_id, "message": msg}


def update_callback(data, chat=100, user=None, update_id=2, cb_id="cb1", with_message=True):
    cq = {"id": cb_id, "from": {"id": chat if user is None else user, "is_bot": False}, "data": data}
    if with_message:
        cq["message"] = {"message_id": 6, "chat": {"id": chat, "type": "private"}}
    return {"update_id": update_id, "callback_query": cq}
