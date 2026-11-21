"""What the publish path records, and what must never drift from it.

Two structural bugs lived in `main.py`'s upload block, and both are the kind
that reading the code politely agrees with:

1. The video was uploaded with the A/B *chosen* title (the B arm's title when
   variant B ran) but `store.record_video(...)` recorded `script.title` — the A
   title. The row then credited the A title with a video that actually shipped
   under the B title, quietly corrupting the A/B readback.

2. `PUBLISH_ALLOWED` was emitted only in the `elif gate.warnings:` branch, so a
   clean gate pass emitted nothing. The event stream then could not tell
   "passed cleanly" apart from "the gate never ran".

These parse `main.py` and assert the structure, because neither bug was in what
the code does — only in which value it used and which branch it sat in.
"""

import ast
import unittest
from pathlib import Path

MAIN = Path(__file__).resolve().parent.parent / "main.py"


def _tree() -> ast.Module:
    return ast.parse(MAIN.read_text())


def _attr_calls(tree: ast.Module, attr: str) -> list[ast.Call]:
    """Calls of the form `something.<attr>(...)`."""
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == attr
    ]


def _emit_calls_for(tree: ast.Module, event_attr: str) -> list[ast.Call]:
    """`events.emit(events.<event_attr>, ...)` calls."""
    out = []
    for node in _attr_calls(tree, "emit"):
        if not node.args:
            continue
        first = node.args[0]
        if isinstance(first, ast.Attribute) and first.attr == event_attr:
            out.append(node)
    return out


def _paths_to(node: ast.AST, target: ast.AST, trail=()) -> list[tuple]:
    if node is target:
        return [trail]
    found = []
    for child in ast.iter_child_nodes(node):
        found.extend(_paths_to(child, target, trail + (node,)))
    return found


class TheRecordedTitleMatchesThePublishedTitle(unittest.TestCase):
    def setUp(self):
        self.tree = _tree()

    def test_published_title_is_the_chosen_title_or_script_title(self):
        """`published_title` is the single source of truth: the B arm's title
        when one was chosen, else the script's own title — exactly the value the
        uploader ships (title_override falls back to script.title when empty)."""
        assigns = [
            n for n in ast.walk(self.tree)
            if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "published_title" for t in n.targets)
        ]
        self.assertEqual(
            len(assigns), 1,
            "expected exactly one `published_title = ...` assignment in main.py",
        )
        self.assertEqual(
            ast.unparse(assigns[0].value), "chosen_title or script.title",
            "published_title must be `chosen_title or script.title` so it equals what is uploaded",
        )

    def test_record_video_records_the_published_title_not_script_title(self):
        """main.py records two videos — the long video and its Short. The long
        video's row must carry `published_title`; the Short legitimately titles
        itself with `shorts.short_title(...)`. What must never appear is a bare
        `title=script.title`, the exact value that mis-credited the A title."""
        titles = []
        for call in _attr_calls(self.tree, "record_video"):
            title_kw = next((k for k in call.keywords if k.arg == "title"), None)
            self.assertIsNotNone(title_kw, "every record_video must pass a title=")
            titles.append(ast.unparse(title_kw.value))

        self.assertIn(
            "published_title", titles,
            "the long video's record_video must record `published_title`",
        )
        self.assertNotIn(
            "script.title", titles,
            "no record_video may record a bare `script.title` — the long video's title "
            "must be `published_title` so the DB matches what was uploaded",
        )


class PublishAllowedIsEmittedOnEveryAllowedPass(unittest.TestCase):
    def setUp(self):
        self.tree = _tree()
        calls = _emit_calls_for(self.tree, "PUBLISH_ALLOWED")
        self.assertEqual(
            len(calls), 1,
            "the gate result is announced in exactly one place",
        )
        self.call = calls[0]
        self.ancestors = _paths_to(self.tree, self.call)[0]

    def test_it_is_not_gated_on_warnings(self):
        """The bug, as a test: the emit must not sit behind an `if gate.warnings`,
        or a clean pass emits nothing and looks identical to the gate never
        running."""
        warning_ifs = [
            a for a in self.ancestors
            if isinstance(a, ast.If) and "warnings" in ast.unparse(a.test)
        ]
        self.assertEqual(
            warning_ifs, [],
            "PUBLISH_ALLOWED is emitted only when gate.warnings is truthy — a clean "
            "pass then leaves no record that the gate ran",
        )

    def test_it_still_only_fires_when_the_gate_allowed(self):
        """It belongs to the `not gate.allowed` split — the allowed side. If it
        ever escapes that guard it would announce an allow the gate refused."""
        allowed_ifs = [
            a for a in self.ancestors
            if isinstance(a, ast.If) and "gate.allowed" in ast.unparse(a.test)
        ]
        self.assertTrue(
            allowed_ifs,
            "PUBLISH_ALLOWED must sit under the `if not gate.allowed: ... else:` split",
        )


if __name__ == "__main__":
    unittest.main()
