"""Regression guard for "an applied migration was edited in place".

Migration 0103 refused to apply on the live database because its guard asked for
`notification_emit_org_role(...)`, a function that 0064 only gained when 0064 was
edited AFTER it had been applied (commit 001a2971). An applied migration is never
re-run, so the live database never got it.

The rule this test enforces, for every migration numbered 0100 or higher: each
`to_regprocedure('...')` / `to_regclass('...')` in a guard that RAISES when the
object is missing (`... is null`) must name something that

  1. the same file creates BEFORE the guard, or
  2. an earlier-numbered migration (or schema.sql / bootstrap.sql) creates, and,
     where git history is available, that migration already created it in the
     form in which it first reached main (the commit that added the file). An
     object that arrived there by a later in-place edit is not a safe prerequisite:
     the production database was built from the first form.

Guards written `is not null` are optional features and are not checked. Objects in
schemas other than public (storage., auth.) come from the platform.
The process rule is in docs/MIGRATIONS.md: never edit an applied migration.
"""

import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"
FIRST_CHECKED = 100

_FN = re.compile(r"create\s+(?:or\s+replace\s+)?function\s+(?:(\w+)\.)?(\w+)\s*\(", re.I)
_REL = re.compile(r"create\s+(?:or\s+replace\s+)?(?:unlogged\s+)?(?:(?:materialized\s+)?view|table|sequence|(?:unique\s+)?index(?:\s+concurrently)?)"
                  r"\s+(?:if\s+not\s+exists\s+)?(?:(\w+)\.)?(\w+)", re.I)
_NEED = re.compile(r"to_reg(procedure|class)\s*\(\s*'([^']+)'\s*(?:::\s*\w+\s*)?\)\s+is\s+null", re.I)


def strip_comments(sql):
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def _split_args(text):
    """Top-level comma-separated pieces of an argument list (parentheses nest)."""
    out, depth, cur = [], 0, ""
    for ch in text:
        depth += ch == "("
        depth -= ch == ")"
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return out


def _balanced(text, start):
    """The text between the '(' at text[start - 1] and its matching ')'."""
    depth = 1
    for i in range(start, len(text)):
        depth += text[i] == "("
        depth -= text[i] == ")"
        if depth == 0:
            return text[start:i]
    return text[start:]


def created(sql):
    """{key: first offset} of what a file creates. Keys: ('fn', name, arity) and ('rel', name),
    public schema only. Arity counts every argument except OUT ones, as to_regprocedure sees it."""
    code = strip_comments(sql)
    found = {}
    for m in _FN.finditer(code):
        if (m.group(1) or "public").lower() != "public":
            continue
        args = [a for a in _split_args(_balanced(code, m.end())) if not re.match(r"\s*out\b", a, re.I)]
        found.setdefault(("fn", m.group(2).lower(), len(args)), m.start())
    for m in _REL.finditer(code):
        if (m.group(1) or "public").lower() != "public":
            continue
        found.setdefault(("rel", m.group(2).lower()), m.start())
    return found


def needs(sql):
    """[(offset, key, text)] for every guard that raises when the object is missing."""
    code = strip_comments(sql)
    out = []
    for m in _NEED.finditer(code):
        kind, ident = m.group(1).lower(), m.group(2).strip()
        schema, _, name = ident.split("(")[0].rpartition(".")
        if kind == "procedure":
            args = _split_args(ident[ident.index("(") + 1:ident.rindex(")")]) if "(" in ident else []
            key = ("fn", name.lower(), len(args))
        else:
            key = ("rel", name.lower())
        if schema.lower() not in ("", "public"):
            continue
        out.append((m.start(), key, ident))
    return out


def find_problems(migrations, base, first_form):
    """migrations: {filename: sql}, base: [sql] applied before all of them (schema.sql, bootstrap.sql),
    first_form(filename) -> the file as first merged, or None when history is unavailable."""
    names = sorted(migrations)
    problems = []
    for name in names:
        if int(name[:4]) < FIRST_CHECKED:
            continue
        for offset, key, text in needs(migrations[name]):
            if key in {k for k, o in created(migrations[name]).items() if o < offset}:
                continue
            if any(key in created(b) for b in base):
                continue
            earlier = [n for n in names if n < name and key in created(migrations[n])]
            if not earlier:
                problems.append(f"{name}: guard needs {text!r}, which no earlier migration and not this file (before the guard) creates")
                continue
            first = first_form(earlier[0])
            if first is not None and key not in created(first):
                problems.append(f"{name}: guard needs {text!r}, which {earlier[0]} only gained by an edit after it was first merged "
                                f"- a database built from that first form lacks it; create it in {name} itself (or a new migration)")
    return problems


def git_first_form(name):
    rel = f"supabase/migrations/{name}"
    try:
        shas = subprocess.run(["git", "log", "--diff-filter=A", "--format=%H", "--", rel], cwd=ROOT, capture_output=True,
                              text=True, timeout=60, check=True).stdout.split()
        if not shas:
            return None
        return subprocess.run(["git", "show", f"{shas[-1]}:{rel}"], cwd=ROOT, capture_output=True, text=True,
                              timeout=60, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None


def repo_migrations():
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(MIGRATIONS.glob("*.sql"))}


def repo_base():
    return [(ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8"),
            (ROOT / "tests" / "security" / "bootstrap.sql").read_text(encoding="utf-8")]


FIRST = "create table public.notifications (id int);\ncreate function public.notification_emit(a uuid, b text) returns int as $$ select 1 $$;\n"
LATER = FIRST + "create or replace function public.notification_emit_org_role(a uuid, b text, c text) returns int as $$ select 1 $$;\n"
GUARD = "do $$ begin if to_regprocedure('public.notification_emit_org_role(uuid, text, text)') is null then raise exception 'x'; end if; end $$;\n"


class MigrationPrerequisites(unittest.TestCase):
    def test_every_guard_in_the_repo_names_something_that_existed_when_the_prerequisite_was_first_merged(self):
        self.assertEqual(find_problems(repo_migrations(), repo_base(), git_first_form), [])

    def test_the_repo_has_guards_to_check(self):
        n = sum(len(needs(sql)) for name, sql in repo_migrations().items() if int(name[:4]) >= FIRST_CHECKED)
        self.assertGreater(n, 5, "the guard pattern was not recognised; the test would pass vacuously")

    def test_the_0103_failure_is_caught(self):
        """The shape that broke production: the function exists in the earlier file only after an in-place edit."""
        files = {"0064_n.sql": LATER, "0103_x.sql": GUARD}
        problems = find_problems(files, [], lambda n: FIRST)
        self.assertEqual(len(problems), 1)
        self.assertIn("after it was first merged", problems[0])

    def test_a_prerequisite_present_in_the_first_form_passes(self):
        self.assertEqual(find_problems({"0064_n.sql": LATER, "0103_x.sql": GUARD}, [], lambda n: LATER), [])

    def test_a_prerequisite_created_by_the_file_itself_before_its_guard_passes(self):
        own = "create or replace function public.notification_emit_org_role(a uuid, b text, c text) returns int as $$ select 1 $$;\n"
        self.assertEqual(find_problems({"0064_n.sql": FIRST, "0103_x.sql": own + GUARD}, [], lambda n: FIRST), [])

    def test_a_prerequisite_created_after_its_guard_or_nowhere_fails(self):
        own = "create or replace function public.notification_emit_org_role(a uuid, b text, c text) returns int as $$ select 1 $$;\n"
        self.assertEqual(len(find_problems({"0064_n.sql": FIRST, "0103_x.sql": GUARD + own}, [], lambda n: FIRST)), 1)
        self.assertEqual(len(find_problems({"0103_x.sql": GUARD}, [], lambda n: None)), 1)

    def test_a_later_migration_is_not_a_prerequisite(self):
        self.assertEqual(len(find_problems({"0103_x.sql": GUARD, "0104_y.sql": LATER}, [], lambda n: LATER)), 1)

    def test_the_same_name_with_other_arguments_is_another_function(self):
        files = {"0064_n.sql": FIRST + "create function public.notification_emit_org_role(a uuid) returns int as $$ select 1 $$;\n",
                 "0103_x.sql": GUARD}
        self.assertEqual(len(find_problems(files, [], lambda n: None)), 1)

    def test_optional_and_platform_guards_are_not_prerequisites(self):
        sql = ("select to_regclass('public.worker_status') is not null;\n"
               "select to_regprocedure('storage.allow_any_operation(text[])') is null;\n")
        self.assertEqual(needs(sql), [])

    def test_arguments_with_defaults_types_and_out_params_are_counted_as_postgres_does(self):
        sql = "create function public.f(a numeric(10,2) default 1, b text[], out c int) returns record as $$ select 1 $$;"
        self.assertIn(("fn", "f", 2), created(sql))


if __name__ == "__main__":
    unittest.main()
