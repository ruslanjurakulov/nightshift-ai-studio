"""A stand-in for Supabase's HTTP surface, in front of a REAL Postgres built from
the repository's own migrations, so the Command Center (next dev) and the MCP
SDK client can be run end to end in a sandbox with no Supabase project.

TEST-ONLY. It speaks just what the Command Center calls on these paths:
  POST /rest/v1/rpc/<fn>   -> `select public.<fn>(named args)` in a transaction as the
                             caller's role (anon, or authenticated for a `tok-<uid>` bearer)
  GET  /auth/v1/user       -> the user a `tok-<uid>` bearer names
Nothing is mocked in the database: every oauth_* / api_* function that runs is the
migration's own. Row-level security and grants apply as on Supabase (the roles are
the lab's: tests/security/bootstrap.sql).

  python3 tests/oauth_e2e/shim.py --dsn postgresql://... --port 54999 --anon-key anon-e2e
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg
from psycopg.types.json import Jsonb


class Shim:
    def __init__(self, dsn: str, anon_key: str):
        self.dsn = dsn
        self.anon_key = anon_key
        self.types: dict[str, dict[str, str]] = {}

    def arg_types(self, conn, fn: str) -> dict[str, str]:
        if fn not in self.types:
            rows = conn.execute(
                "select a.name, format_type(a.typ, null) from pg_proc p, "
                "unnest(p.proargnames, p.proargtypes::oid[]) as a(name, typ) "
                "where p.proname = %s and p.pronamespace = 'public'::regnamespace", [fn]).fetchall()
            self.types[fn] = {n: t for n, t in rows}
        return self.types[fn]

    def user_for(self, bearer: str | None):
        if bearer and bearer.startswith("tok-"):
            uid = bearer[4:]
            with psycopg.connect(self.dsn, autocommit=True) as c:
                row = c.execute("select id::text, email from auth.users where id = %s", [uid]).fetchone()
            if row:
                return {"id": row[0], "email": row[1]}
        return None

    def rpc(self, fn: str, args: dict, bearer: str | None):
        user = self.user_for(bearer)
        role = "authenticated" if user else "anon"
        claims = {"role": role, **({"sub": user["id"], "email": user["email"]} if user else {})}
        with psycopg.connect(self.dsn, autocommit=False) as conn:
            try:
                types = self.arg_types(conn, fn)
                conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
                conn.execute(f"set local role {role}")
                names, vals = [], []
                for k, v in args.items():
                    t = types.get(k)
                    if t is None:
                        raise ValueError(f"unknown argument {k}")
                    names.append(f"{k} => %s::{t}")
                    vals.append(Jsonb(v) if t in ("jsonb", "json") else v)
                row = conn.execute(f"select public.{fn}({', '.join(names)})", vals).fetchone()
                conn.commit()
                return 200, row[0]
            except psycopg.Error as e:
                conn.rollback()
                code = 404 if e.sqlstate == "42883" else 403 if e.sqlstate == "42501" else 400
                return code, {"code": e.sqlstate or "XX000", "message": str(e).splitlines()[0], "details": None, "hint": None}
            except ValueError as e:
                conn.rollback()
                return 404, {"code": "PGRST202", "message": f"Could not find the function {fn}: {e}", "details": None, "hint": None}


def make_handler(shim: Shim):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # quiet
            pass

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _bearer(self):
            h = self.headers.get("authorization", "")
            return h[7:] if h.lower().startswith("bearer ") else None

        def do_GET(self):
            if self.path.startswith("/auth/v1/user"):
                u = shim.user_for(self._bearer())
                if not u:
                    return self._send(401, {"code": 401, "msg": "invalid JWT"})
                return self._send(200, {"id": u["id"], "aud": "authenticated", "role": "authenticated", "email": u["email"],
                                        "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"})
            self._send(404, {"message": "not found"})

        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            if self.path.startswith("/rest/v1/rpc/"):
                fn = self.path.split("/rest/v1/rpc/", 1)[1].split("?")[0]
                try:
                    args = json.loads(raw or b"{}")
                except ValueError:
                    return self._send(400, {"message": "bad json"})
                status, body = shim.rpc(fn, args, self._bearer())
                return self._send(status, body)
            self._send(404, {"message": "not found"})

    return H


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--port", type=int, default=54999)
    ap.add_argument("--anon-key", default="anon-e2e")
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(Shim(a.dsn, a.anon_key)))
    print(f"shim on 127.0.0.1:{a.port}", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
