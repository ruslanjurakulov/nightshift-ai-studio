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
     that migration already created it in the form in which it first reached
     main (including pre-merge review fixes). An object that arrived there by a
     later in-place edit is not a safe prerequisite:
     the production database was built from the first form.

Guards written `is not null` are optional features and are not checked. Objects in
schemas other than public (storage., auth.) come from the platform.
The process rule is in docs/MIGRATIONS.md: never edit an applied migration.
Full history and an origin/main (or local main) ref are required. When both refs
exist, use their first-parent descendant or fail if their mainlines diverge.
GitHub PR events, when present, bind the baseline to their main-base commit.
Git failures are errors, not permission to skip the check. For squash/rebase
histories with no merge boundary, the earliest main first-parent addition is conservative:
Git alone cannot reconstruct which intermediate commits were deployed together.
"""

import json
import os
import re
import subprocess
import tempfile
import unittest
from functools import lru_cache
from pathlib import Path
from unittest.mock import patch

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
    first_form(filename) -> first integrated form, or current form for an unmerged file.
    History lookup failures must raise rather than silently disable this guard."""
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
            if first is None:
                raise RuntimeError(f"Cannot verify first integration of {earlier[0]}; history is required")
            if key not in created(first):
                problems.append(f"{name}: guard needs {text!r}, which {earlier[0]} only gained by an edit after it was first merged "
                                f"- a database built from that first form lacks it; create it in {name} itself (or a new migration)")
    return problems


def git_read(root, *args):
    try:
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True,
                              timeout=60, check=True).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError("Cannot verify migration history; provide a complete checkout and main ref") from exc


@lru_cache(maxsize=None)
def integrated_form(root, main_tip, head_tip, rel):
    # First-parent follows what main actually received, not the oldest draft
    # reachable through a merge's second parent. Squash and rebase integrations
    # remain ordinary first-parent additions.
    additions = git_read(root, "log", "--first-parent", "--diff-filter=A", "--format=%H",
                         main_tip, "--", rel).split()
    if additions:
        return git_read(root, "show", f"{additions[-1]}:{rel}")
    # Absence on complete main is a new, unapplied prerequisite. Its reviewed
    # HEAD form will be integrated together with its dependent migration.
    return git_read(root, "show", f"{head_tip}:{rel}")


@lru_cache(maxsize=None)
def first_parent_chain(root, tip):
    return frozenset(git_read(root, "rev-list", "--first-parent", tip).split())


def ci_main_base(root):
    # The PR event binds CI to a known base commit even if both fetched refs
    # are stale. Temporary DAG fixtures do not inherit the enclosing PR event.
    if Path(root).resolve() != ROOT.resolve() or os.environ.get("GITHUB_BASE_REF") != "main":
        return None
    if os.environ.get("GITHUB_EVENT_NAME") not in ("pull_request", "pull_request_target"):
        return None
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        sha = event["pull_request"]["base"]["sha"]
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise ValueError("invalid base commit")
        return sha
    except (KeyError, OSError, ValueError, TypeError) as exc:
        raise RuntimeError("Cannot verify the GitHub PR main-base commit") from exc


def git_first_form(name, root=ROOT, main_ref=None, ci_base_sha=None):
    if git_read(root, "rev-parse", "--is-shallow-repository").strip() != "false":
        raise RuntimeError("Migration history requires fetch-depth: 0; shallow history cannot prove first integration")
    if main_ref is None:
        refs = set(git_read(root, "for-each-ref", "--format=%(refname)",
                            "refs/remotes/origin/main", "refs/heads/main").split())
        refs &= {"refs/remotes/origin/main", "refs/heads/main"}
        if not refs:
            raise RuntimeError("Migration history requires origin/main or main; no baseline is verified")
        tips = [git_read(root, "rev-parse", "--verify", f"{r}^{{commit}}").strip() for r in sorted(refs)]
        main_tip = tips[0]
        for tip in tips[1:]:
            if main_tip in first_parent_chain(str(root), tip):
                main_tip = tip
            elif tip not in first_parent_chain(str(root), main_tip):
                raise RuntimeError("Local main and origin/main diverge; refresh and verify the integration baseline")
    else:
        main_tip = git_read(root, "rev-parse", "--verify", f"{main_ref}^{{commit}}").strip()
    ci_base_sha = ci_base_sha or ci_main_base(root)
    if ci_base_sha is not None and ci_base_sha not in first_parent_chain(str(root), main_tip):
        raise RuntimeError("Main history does not include the CI base on its first-parent chain; refresh main")
    head_tip = git_read(root, "rev-parse", "--verify", "HEAD^{commit}").strip()
    return integrated_form(str(root), main_tip, head_tip, f"supabase/migrations/{name}")


def repo_migrations():
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(MIGRATIONS.glob("*.sql"))}


def repo_base():
    return [(ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8"),
            (ROOT / "tests" / "security" / "bootstrap.sql").read_text(encoding="utf-8")]


FIRST = "create table public.notifications (id int);\ncreate function public.notification_emit(a uuid, b text) returns int as $$ select 1 $$;\n"
LATER = FIRST + "create or replace function public.notification_emit_org_role(a uuid, b text, c text) returns int as $$ select 1 $$;\n"
GUARD = "do $$ begin if to_regprocedure('public.notification_emit_org_role(uuid, text, text)') is null then raise exception 'x'; end if; end $$;\n"


class GitIntegrationHistory(unittest.TestCase):
    """Actual temporary Git DAGs distinguish review edits from applied-file edits."""

    name = "0064_n.sql"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-b", "main")
        self.git("commit", "--allow-empty", "-m", "bootstrap")

    def git(self, *args):
        return git_read(self.root, "-c", "user.name=History Fixture", "-c",
                        "user.email=history@example.invalid", *args)

    def write(self, text):
        p = self.root / "supabase" / "migrations" / self.name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        self.git("add", str(p.relative_to(self.root)))
        self.git("commit", "-m", "migration revision")

    def first(self):
        return git_first_form(self.name, self.root)

    def problems(self):
        return find_problems({self.name: LATER, "0103_x.sql": GUARD}, [], lambda _: self.first())

    def reviewed_feature(self):
        self.git("switch", "-c", "feature")
        self.write(FIRST)
        self.write(LATER)

    def test_premerge_review_edits_are_in_the_first_main_form(self):
        self.reviewed_feature()
        self.git("switch", "main")
        self.git("merge", "--no-ff", "feature", "-m", "reviewed integration")
        self.assertEqual(self.first(), LATER)
        self.assertEqual(self.problems(), [])

    def test_postintegration_edit_still_fails_like_the_0064_incident(self):
        self.git("switch", "-c", "feature")
        self.write(FIRST)
        self.git("switch", "main")
        self.git("merge", "--no-ff", "feature", "-m", "first integration")
        self.write(LATER)
        self.assertEqual(self.first(), FIRST)
        self.assertIn("after it was first merged", self.problems()[0])

    def test_stacked_branch_uses_main_integration_not_its_own_draft_ancestor(self):
        self.reviewed_feature()
        self.git("switch", "-c", "stacked")
        self.git("commit", "--allow-empty", "-m", "dependent feature")
        self.git("switch", "main")
        self.git("merge", "--no-ff", "feature", "-m", "first integration")
        self.git("switch", "stacked")
        self.assertEqual(self.first(), LATER)
        self.assertEqual(self.problems(), [])

    def test_squash_integration_uses_reviewed_blob(self):
        self.reviewed_feature()
        self.git("switch", "main")
        self.git("merge", "--squash", "feature")
        self.git("commit", "-m", "squash reviewed migration")
        self.assertEqual(self.first(), LATER)

    def test_linear_main_commits_preserve_later_edit_detection(self):
        self.write(FIRST)
        self.write(LATER)
        self.assertEqual(self.first(), FIRST)
        self.assertEqual(len(self.problems()), 1)

    def test_single_commit_rebase_integration_uses_the_rebased_blob(self):
        self.git("switch", "-c", "feature")
        self.write(LATER)
        self.git("switch", "main")
        self.git("commit", "--allow-empty", "-m", "advance main")
        self.git("switch", "feature")
        self.git("rebase", "main")
        self.git("switch", "main")
        self.git("merge", "--ff-only", "feature")
        self.assertEqual(self.first(), LATER)
        self.assertEqual(self.problems(), [])

    def test_unmerged_prerequisite_uses_current_committed_form(self):
        self.reviewed_feature()
        self.assertEqual(self.first(), LATER)
        self.assertEqual(self.problems(), [])

    def test_remote_main_is_used_on_a_detached_ci_checkout(self):
        self.write(FIRST)
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("switch", "--detach")
        self.git("branch", "-D", "main")
        self.write(LATER)
        self.assertEqual(self.first(), FIRST)

    def test_stale_remote_cannot_hide_a_real_edit_after_local_main_integration(self):
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("switch", "-c", "feature")
        self.write(FIRST)
        self.git("switch", "main")
        self.git("merge", "--no-ff", "feature", "-m", "first integration")
        self.git("switch", "-c", "dependent")
        self.write(LATER)
        self.assertEqual(self.first(), FIRST)
        self.assertEqual(len(self.problems()), 1)

    def test_stale_local_main_uses_the_newer_remote_main(self):
        bootstrap = self.git("rev-parse", "HEAD").strip()
        self.write(FIRST)
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("switch", "-c", "dependent")
        self.git("update-ref", "refs/heads/main", bootstrap)
        self.write(LATER)
        self.assertEqual(self.first(), FIRST)

    def test_divergent_main_refs_fail_instead_of_guessing(self):
        self.git("switch", "-c", "remote-history")
        self.write(FIRST)
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("switch", "main")
        self.write(LATER)
        with self.assertRaisesRegex(RuntimeError, "diverge"):
            self.first()

    def test_main_prefixed_branches_are_not_integration_refs(self):
        self.git("switch", "-c", "main-experiment")
        self.write(FIRST)
        self.git("switch", "main")
        self.write(LATER)
        self.assertEqual(self.first(), LATER)

    def test_refs_related_only_by_second_parent_are_ambiguous(self):
        self.git("switch", "-c", "remote-history")
        self.write(FIRST)
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("switch", "main")
        self.git("commit", "--allow-empty", "-m", "different main line")
        self.git("merge", "--no-ff", "remote-history", "-m", "merge divergent history")
        with self.assertRaisesRegex(RuntimeError, "diverge"):
            self.first()

    def test_ci_base_rejects_stale_refs_and_accepts_a_verified_descendant(self):
        bootstrap = self.git("rev-parse", "HEAD").strip()
        self.write(FIRST)
        base = self.git("rev-parse", "HEAD").strip()
        self.git("switch", "-c", "dependent")
        self.git("update-ref", "refs/heads/main", bootstrap)
        self.write(LATER)
        with self.assertRaisesRegex(RuntimeError, "CI base"):
            git_first_form(self.name, self.root, ci_base_sha=base)
        self.git("update-ref", "refs/remotes/origin/main", base)
        self.assertEqual(git_first_form(self.name, self.root, ci_base_sha=base), FIRST)

    def test_ci_event_reads_only_a_valid_base_commit_and_fails_on_missing_or_malformed_data(self):
        event_path = self.root / "event.json"
        sha = self.git("rev-parse", "HEAD").strip()
        event_path.write_text(json.dumps({"pull_request": {"base": {"sha": sha}}}))
        env = {"GITHUB_BASE_REF": "main", "GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(event_path)}
        with patch.dict(os.environ, env), patch(f"{__name__}.ROOT", self.root):
            self.assertEqual(ci_main_base(self.root), sha)
            for value in ("{malformed", "{}", '{"pull_request":{"base":{"sha":"not-a-commit"}}}'):
                event_path.write_text(value)
                with self.assertRaisesRegex(RuntimeError, "GitHub PR"):
                    ci_main_base(self.root)
            event_path.unlink()
            with self.assertRaisesRegex(RuntimeError, "GitHub PR"):
                ci_main_base(self.root)

    def test_missing_main_fails_loudly(self):
        self.reviewed_feature()
        self.git("branch", "-D", "main")
        with self.assertRaisesRegex(RuntimeError, "no baseline"):
            self.first()

    def test_unknown_ref_and_missing_blob_do_not_disable_the_guard(self):
        with self.assertRaises(RuntimeError):
            git_first_form(self.name, self.root, "refs/heads/not-a-branch")
        with self.assertRaises(RuntimeError):
            self.first()

    def test_shallow_history_fails_loudly(self):
        self.write(FIRST)
        with tempfile.TemporaryDirectory() as dst:
            self.git("clone", "--depth=1", self.root.as_uri(), dst)
            with self.assertRaisesRegex(RuntimeError, "shallow"):
                git_first_form(self.name, Path(dst))


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

    def test_unknown_history_cannot_pass_a_real_prerequisite(self):
        with self.assertRaisesRegex(RuntimeError, "history is required"):
            find_problems({"0064_n.sql": LATER, "0103_x.sql": GUARD}, [], lambda n: None)

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
