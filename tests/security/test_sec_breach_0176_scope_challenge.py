"""Breach on 0176: every MCP client is told to ask for studio:create, so "only by asking for it by name" never holds.

0176's oauth_begin_authorization keeps studio:create out of the default on purpose: "Spending on Studio generations is its own
consent, so a client gets it only by asking for it by name; one that asks for nothing gets 0093's three."

But the MCP route's 401 challenge (app/api/mcp/route.ts challenge() -> wwwAuthenticate(..., OAUTH_SCOPES)) now reads
    Bearer resource_metadata="…", scope="videos:read videos:create videos:publish studio:create"
and the MCP authorization spec's scope-selection rule has a client request exactly the challenge's `scope` (falling back to
scopes_supported, which lists it as well). So Claude, ChatGPT and every spec-following client asks for studio:create on every new
connection without the person or the client choosing it, and the consent page (components/oauth/ConsentForm.tsx) is all or
nothing: a person who wants an assistant to make videos cannot approve without also approving Studio spending. The database's
careful default is never reached.

Safe outcome pinned here (the alternative the report named, chosen so a person CAN grant Studio spending when they want it): the
challenge may name studio:create, but the consent page offers it as a separate, UNTICKED choice, and the decision route takes it
off the request unless the person ticked it (JSON true), granting nothing when that cannot be done. The database side is pinned
in tests/test_mcp_oauth_creative_migration.py (oauth_drop_requested_scope only removes) and the route in mcp-oauth-flow.test.ts.

Severity guess: LOW (consent is shown on its own line and the connection's monthly limit still bounds the spend), but it defeats
the stated design of the permission now that recraft-v4.1 / recraft-v4.1-flash carry mcp_oauth_exposure: true.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ROUTE = REPO / "command-center" / "app" / "api" / "mcp" / "route.ts"
CONFIG = REPO / "command-center" / "lib" / "oauth" / "config.ts"


def _const_list(name: str) -> list[str]:
    for src in (CONFIG.read_text(), ROUTE.read_text()):
        m = re.search(rf"export\s+const\s+{re.escape(name)}\s*(?::[^=]+)?=\s*\[([^\]]*)\]", src) or \
            re.search(rf"const\s+{re.escape(name)}\s*(?::[^=]+)?=\s*\[([^\]]*)\]", src)
        if m:
            return re.findall(r'"([^"]+)"', m.group(1))
    raise AssertionError(f"cannot resolve the scope list {name!r} the challenge passes")


ROUTE_DECISION = REPO / "command-center" / "app" / "oauth" / "decision" / "route.ts"
FORM = REPO / "command-center" / "components" / "oauth" / "ConsentForm.tsx"
PAGE = REPO / "command-center" / "app" / "oauth" / "authorize" / "page.tsx"


def test_studio_spending_is_an_unticked_choice_that_the_decision_removes_unless_ticked():
    form, page, route = FORM.read_text(), PAGE.read_text(), ROUTE_DECISION.read_text()
    assert "const [studio, setStudio] = useState(false);" in form, "the Studio choice must start unticked"
    assert 'type="checkbox"' in form and "offerStudio && studio" in form
    # The page does not list studio:create among what the app can do; it offers it only as the checkbox.
    assert 'view.scopes.filter((s) => s !== "studio:create")' in page and 'offerStudio={view.scopes.includes("studio:create")}' in page
    # The route removes it unless the body says exactly true, and fails closed.
    assert "if (allow && body.studio !== true)" in route and "dropStudioScope(secretHash)" in route
    assert 'if (dropped === "unavailable") return json({ error: "unavailable" }, 503);' in route
