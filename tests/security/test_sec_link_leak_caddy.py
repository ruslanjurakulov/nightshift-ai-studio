"""A leaked link: what the self-hosted edge (deploy/Caddyfile) does to the URLs that ARE the credential.

Several Nightshift URLs are bearer capabilities by design: /r/<token> (a review link, up to 30 days, 0101),
/i/<token> (a friend invite, 0092), /unsubscribe?t=<token> (0103), /api/media/file/...?sig= (an hour, 0038) and
/auth/callback?token_hash=... (any browser, if a Supabase e-mail template is switched to token_hash as
docs/SIGNUP_SETUP.md section 7 suggests). The app answers every one of them with `Referrer-Policy: no-referrer`
(next.config.ts headers(), app/i/[token]/route.ts, app/auth/callback/route.ts NO_FRAME, the media route), and the
code comments say so: "the address is the secret, so it ... never leaves a Referer".

On the self-hosted box that is not what reaches the browser. The site-wide `header { ... }` block in the
Caddyfile also deletes `-Server` and `-X-Powered-By`; any deletion makes Caddy DEFER the whole block to
write time (caddyhttp/headers/caddyfile.go: `if len(handler.Response.HeaderOps.Delete) > 0 { Deferred = true }`),
and a deferred plain field is a Set, which overwrites what the upstream sent. So every one of those pages leaves
Caddy with `strict-origin-when-cross-origin` instead of `no-referrer`. (Cross-origin requests still get only the
origin, so this is defense in depth lost, not a token sent to a third party today: severity low.) The fix is
`?Referrer-Policy` (set only when the app sent none), which keeps the site-wide default and lets the app's
stricter value stand.

Second: Caddy's JSON access log records `request.uri` with its full path and query, so every review token,
invite token, unsubscribe token, media signature and (with a token_hash template) unused sign-in or
password-reset link is written to the server's container logs (5 x 10 MB rotation, docker-compose.yml). The
PKCE `code` there is useless without the browser's verifier; a `token_hash` is not. The fix is a `format filter`
on `request>uri` that drops those query values and path tokens.

Static tests: no database, no network, no Caddy binary. They stay FAILING until deploy/Caddyfile is fixed.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CADDYFILE = REPO / "deploy" / "Caddyfile"
NEXT_CONFIG = REPO / "command-center" / "next.config.ts"


def _code_lines() -> list[str]:
    """The Caddyfile without comments (a `#` starts a comment at line start or after whitespace)."""
    out = []
    for raw in CADDYFILE.read_text(encoding="utf-8").splitlines():
        line = re.sub(r"(^|\s)#.*$", "", raw).rstrip()
        if line.strip():
            out.append(line)
    return out


def _blocks(lines: list[str], opener: re.Pattern[str]) -> list[list[str]]:
    """Every `<directive> ... {` block whose opening line matches `opener`, as its inner lines."""
    found: list[list[str]] = []
    i = 0
    while i < len(lines):
        if opener.search(lines[i]) and lines[i].rstrip().endswith("{"):
            depth, body = 1, []
            i += 1
            while i < len(lines) and depth:
                depth += lines[i].count("{") - lines[i].count("}")
                if depth:
                    body.append(lines[i])
                i += 1
            found.append(body)
            continue
        i += 1
    return found


def test_the_app_really_sends_no_referrer_on_the_pages_whose_url_is_the_secret():
    # The premise of the test below: if these go, the Caddy question changes with them.
    text = NEXT_CONFIG.read_text(encoding="utf-8")
    for source in ('"/r/:token"', '"/unsubscribe"', '"/auth/:path*"', '"/oauth/:path*"'):
        at = text.index(source)
        assert '"Referrer-Policy", value: "no-referrer"' in text[at : at + 400], source


def test_caddy_does_not_overwrite_the_apps_no_referrer_on_token_pages():
    lines = _code_lines()
    offenders = []
    for body in _blocks(lines, re.compile(r"^\s*header(\s+@\S+)?\s*\{$")):
        fields = [b.strip().split()[0] for b in body if b.strip()]
        deferred = any(f.startswith(("-", ">")) or f == "defer" for f in fields)
        for f in fields:
            name = f.lstrip("+-?>")
            if name.lower() == "referrer-policy" and not f.startswith("?") and (deferred or f.startswith(">")):
                offenders.append(f)
    # Single-line `header [matcher] >Referrer-Policy ...` forms overwrite too.
    for line in lines:
        m = re.match(r"^\s*header(\s+@\S+)?\s+(>|-)?Referrer-Policy\b", line, re.I)
        if m and m.group(2) == ">":
            offenders.append(line.strip())
    assert not offenders, (
        "deploy/Caddyfile overwrites the app's `Referrer-Policy: no-referrer` on /r/<token>, /i/<token>, "
        "/unsubscribe, /auth/*, /oauth/* and the signed media route (the header block is deferred because it "
        f"deletes -Server/-X-Powered-By, and a deferred set replaces the upstream value): {offenders}. "
        "Use `?Referrer-Policy \"strict-origin-when-cross-origin\"` so it is only a default."
    )


def test_caddy_access_log_does_not_record_link_tokens():
    lines = _code_lines()
    logs = _blocks(lines, re.compile(r"^\s*log\s*\{$"))
    assert logs, "the Caddyfile has no log block (then nothing is recorded and this test should be revisited)"
    for body in logs:
        joined = "\n".join(body)
        filters_uri = "format filter" in joined and "request>uri" in joined
        assert filters_uri, (
            "Caddy's access log writes request.uri verbatim: /r/<token>, /i/<token>, /unsubscribe?t=, "
            "/api/media/file?...&sig=, /auth/callback?token_hash= all land in the container log. Add "
            "`format filter { request>uri query { delete token_hash  delete code  delete t  delete sig } ... }` "
            "and a regexp filter on the /r/ and /i/ path segment."
        )
