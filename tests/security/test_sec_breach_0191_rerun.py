"""Breach re-run on 0191 (after the merge of 0187/0188/0189 and the renumber): a connection that asked ONLY for studio:create gets
it without the person ticking the Studio choice.

The consent page offers studio:create as an unticked choice, and the decision route takes it off the request unless the body says
`studio: true` (app/oauth/decision/route.ts). The removal is oauth_drop_requested_scope (0191), which "never empties" a request:
it updates only where `cardinality(r.scopes) > 1`, and otherwise answers FALSE. lib/server/oauth.ts dropStudioScope maps every
answer without an error to "ok", false included, and the route goes on to oauth_decide_authorization, which writes the request's
scopes onto the grant unchanged.

So a client (any registered client: oauth_register_client is anon) that sends `scope=studio:create` alone gets a request of
['studio:create'] (oauth_begin_authorization keeps any supported word it was asked for; the "0093's three" default applies only
when nothing supported was asked). The consent page lists no permission at all (page.tsx filters studio:create out of the list
and shows it only as the unticked box), the person clicks Allow without ticking it, the removal answers false, and the connection
is granted exactly studio:create: Studio generations on the workspace's credits, up to the limit on the form (default 500).

Reproduction (this test): begin with scope 'studio:create' -> drop (what the route calls when the box is unticked) answers false ->
decide allow -> the grant's scopes are ['studio:create'].

Safe outcome pinned here: following the route's own sequence for an unticked box, the connection never holds studio:create. A fix
may be in the database (the request loses the permission, or the decision refuses a request whose only permission was not ticked)
or in the route (a removal that did not remove refuses the approval); the emulation below honours the route's answer to a false
removal once dropStudioScope reads the boolean the database returns.

Severity guess: MEDIUM. A consent bypass of the one permission that spends credits: not cross-tenant, and bounded by the
connection's monthly limit and the workspace's balance, but it defeats the stated design (an unticked opt-in) on the very path a
person relies on, and the page shows nothing to warn them.
"""

import base64
import hashlib
import re
import secrets
import uuid
from pathlib import Path

import psycopg

import test_sec_mcp_oauth_creative as base
from test_sec_mcp_oauth_creative import UA

db = base.db  # the 0191 lab database (module fixture)

REPO = Path(__file__).resolve().parents[2]
SERVER_OAUTH = REPO / "command-center" / "lib" / "server" / "oauth.ts"
REDIRECT = "https://claude.ai/api/mcp/auth_callback"


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _route_reads_the_removal_answer() -> bool:
    """Whether dropStudioScope (the route's removal) looks at the boolean the database answers, instead of only at an error."""
    src = SERVER_OAUTH.read_text()
    m = re.search(r"export async function dropStudioScope\([^)]*\)[^{]*\{(.*?)\n\}", src, re.S)
    assert m, "dropStudioScope not found in lib/server/oauth.ts"
    return re.search(r"\bdata\b\s*(===|!==|==|!=)\s*(true|false)|\(\s*!?\s*data\s*\)|data\s*\?", m.group(1)) is not None


def test_a_request_for_studio_create_alone_is_not_granted_it_when_the_person_leaves_the_box_unticked(db):
    reg = db.act("anon", None, "select public.oauth_register_client(%s, %s, %s)",
                 ["Lab client", [REDIRECT], f"198.51.100.{uuid.uuid4().hex[:10]}"])[0][0]
    assert reg["ok"], reg
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    secret = secrets.token_urlsafe(32)

    begun = db.act("authenticated", UA, "select public.oauth_begin_authorization(%s,%s,%s,'S256','st',%s,%s,%s)",
                   [reg["client_id"], REDIRECT, challenge, "studio:create", base.RESOURCE, _sha(secret)])[0][0]
    assert begun["ok"], begun
    assert begun["scopes"] == ["studio:create"], begun  # the consent page lists nothing; only the unticked box names it

    # The person clicks Allow with the Studio box unticked: the route calls the removal first (body.studio !== true) ...
    try:
        removed = db.act("authenticated", UA, "select public.oauth_drop_requested_scope(%s, 'studio:create')", [_sha(secret)])[0][0]
    except psycopg.errors.InvalidParameterValue as e:
        # The fix: the removal refuses by name, and the route answers 409 studio_only before it decides (pinned statically in
        # tests/test_mcp_oauth_creative_migration.py and by mcp-oauth-flow.test.ts). The request still exists, unapproved.
        assert "studio_only" in str(e), e
        assert db.su("select scopes from public.oauth_auth_requests where secret_hash = %s", [_sha(secret)])[0][0] == ["studio:create"]
        return
    if removed is not True and _route_reads_the_removal_answer():
        return  # the route refuses an approval whose unticked permission could not be removed: nothing is granted
    # ... and, as the route does today, decides on whatever the request now holds.
    code = "code-" + secrets.token_urlsafe(32)
    dec = db.act("authenticated", UA, "select public.oauth_decide_authorization(%s, true, 500::numeric, %s)",
                 [_sha(secret), _sha(code)])[0][0]
    if not (dec.get("ok") and dec.get("allowed")):
        return  # the database refused the approval: nothing is granted
    scopes = db.su("select g.scopes from public.oauth_grants g join public.oauth_codes c on c.grant_id = g.id "
                   "where c.code_hash = %s", [_sha(code)])[0][0]
    assert "studio:create" not in scopes, (
        f"the person left 'studio:create' unticked, the removal answered {removed!r} and the route went on: the connection was "
        f"granted {scopes} (Studio spending on the workspace's credits, up to 500 a month) without the opt-in")
