"""Where the Short is cut from, and what must never move it back.

`_publish_short` spent its life inside the upload's `except` handler. So a
Short was published only when the long video's upload had *failed* — carrying
`parent_video_id=None` and `parent_url=None`, pointing at nothing — and was
never published on a run that actually succeeded. Its own comment said the
opposite ("the long video is out"), which is exactly why nobody caught it by
reading.

A test that reads the structure catches that; a test that reads the comment
would have agreed with it. These parse `main.py` and ask where the call
actually sits, because the bug was never in what the function does — only in
which branch reaches it.
"""

import ast
import unittest
from pathlib import Path

MAIN = Path(__file__).resolve().parent.parent / "main.py"


def _tree() -> ast.Module:
    return ast.parse(MAIN.read_text())


def _calls_named(tree: ast.Module, name: str) -> list[ast.Call]:
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == name
    ]


def _paths_to(node: ast.AST, target: ast.AST, trail=()) -> list[tuple]:
    """Every ancestor chain from `node` down to `target`."""
    if node is target:
        return [trail]
    found = []
    for child in ast.iter_child_nodes(node):
        found.extend(_paths_to(child, target, trail + (node,)))
    return found


class TheShortFollowsTheVideoThatPublished(unittest.TestCase):
    def setUp(self):
        self.tree = _tree()
        calls = _calls_named(self.tree, "_publish_short")
        self.assertEqual(
            len(calls), 1,
            "run() cuts a Short in exactly one place; two would be two chances to get this wrong",
        )
        self.call = calls[0]
        self.ancestors = _paths_to(self.tree, self.call)[0]

    def test_it_is_not_reached_from_a_failure_handler(self):
        """The bug, stated as a test. A Short must never be the consolation
        prize for an upload that did not happen."""
        handlers = [a for a in self.ancestors if isinstance(a, ast.ExceptHandler)]
        self.assertEqual(
            handlers, [],
            "_publish_short is inside an `except` block: it would publish a Short "
            "only when the long video failed to upload, with no parent to point at",
        )

    def test_it_is_reached_only_when_the_upload_raised_nothing(self):
        """`else` on a try is the one branch that means 'the block completed'.
        The end of the `try` body would also run after a partial success in a
        future edit; `else` cannot."""
        trys = [a for a in self.ancestors if isinstance(a, ast.Try)]
        self.assertTrue(trys, "the Short must sit under the upload's try statement")
        upload_try = trys[-1]
        in_else = any(
            _paths_to(stmt, self.call) for stmt in upload_try.orelse
        )
        self.assertTrue(
            in_else,
            "_publish_short must be in the try's `else` clause — the only branch "
            "that runs when, and only when, the upload raised nothing",
        )

    def test_the_upload_it_follows_is_behind_the_publish_gate(self):
        """`gate.allowed` guards the whole upload block, so the Short inherits
        it. If the Short ever moves out from under that guard, this fails."""
        guards = [
            a for a in self.ancestors
            if isinstance(a, ast.If) and "gate.allowed" in ast.unparse(a.test)
        ]
        self.assertTrue(
            guards,
            "the Short is not under an `if ... gate.allowed` — the publish gate "
            "must be in front of every path that uploads anything",
        )


if __name__ == "__main__":
    unittest.main()
