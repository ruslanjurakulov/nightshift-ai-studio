# Security workflow: Breach, Sentinel, Patch

This folder is the security record for Nightshift. `LEDGER.md` lists every
finding, open or closed, in one table. A finding stays in the ledger after it
is fixed. The row then shows which PR fixed it and which test fails if it
comes back.

## Who does what

| Agent | Job | Writes |
|---|---|---|
| **Breach** (`.claude/agents/breach.md`) | Attacks the code in the local or CI security lab only, never production. Every attack that works becomes a test. | Tests in `tests/security/` (and `command-center/tests/` for route-level holes). A findings file in the inbox. |
| **Sentinel** (`.claude/agents/sentinel.md`) | Reproduces each finding, merges duplicates, assigns severity, finds the root cause and other places with the same flaw, then specifies the minimal fix and the regression test. Also does the static review (CI workflows, dependencies, headers, secrets). | `docs/security/LEDGER.md` only. No code. |
| **Patch** (`.claude/agents/patch.md`) | Fixes open findings in priority order (critical > high > medium > low). Flips the failing test to passing and adds the regression test. | Migrations `0066+`, route/module fixes, tests. One draft PR per cluster of findings. |

The owner merges. No agent merges, and no agent pushes to `main`.

## The inbox

Breach agents drop raw findings in **`/home/user/security-inbox/`** on the shared
machine, one Markdown file per finding (or per small group):

| Prefix | Source |
|---|---|
| `BR-A-NNN` | Breach lane A |
| `BR-B-NNN` | Breach lane B |
| `BR-C-NNN` | Breach lane C |
| `BR-D-NNN` | Breach lane D (wave 3) |
| `BR-E-NNN` | Breach lane E (wave 4) |
| `BR-S-NNN` | Sentinel's own static review (written straight to the ledger, not the inbox) |

A finding file should contain:

- **Attack**: who the attacker is (anon, signed-up user in another org,
  revoked API key, a pull request from a fork, ...) and what they do.
- **Result** and **evidence**: the test name, or SQL or HTTP steps that
  reproduce it in the lab.
- **Severity guess**: Sentinel makes the final call.
- **Test**: the path and node id of the failing test, for example
  `tests/security/test_sec_x.py::test_tenant_b_reads_a_storyboard`.

Sentinel checks the inbox about every ten minutes. For each new file it:

1. Reproduces the finding, or marks it `not reproducible` or `false positive`.
2. Merges duplicates into one ledger row and keeps the original IDs in the
   title (`BR-A-003 = BR-C-001`).
3. Assigns severity using the rubric below.
4. Adds the row to `LEDGER.md` with status `open` and pushes.

Inbox files are never deleted. The ledger row is the record.

## Severity rubric

Severity depends on who can exploit the finding, what they gain, and what has
to be true first.

| Severity | Meaning (Nightshift terms) |
|---|---|
| **critical** | Anonymous user or any signed-up user can, with no special preconditions: read or write another org's data, mint, move or burn credits, publish or re-render, take over an account or org, or reach a secret (service key, provider key, OAuth token). |
| **high** | Same impact but needs a precondition that a real attacker can plausibly meet: being a member of the target org with a lower role, holding a revoked key, winning a race, getting a PR from a fork run. Also: the publish gate or approvals can be bypassed in any way. |
| **medium** | Defense-in-depth gap with a real but limited impact: a missing security header, a SECURITY DEFINER function without a pinned `search_path` that needs another bug to exploit, an unpinned third-party action, an information leak that does not reveal secrets or other orgs' content. |
| **low** | Hardening or hygiene with no demonstrated path to impact. |
| **info** | Recorded so that nobody re-reports it. No action needed. |

Critical and high findings that are `open` block a PR that touches the same
area from being called ready.

## Failing-test convention

A real hole must have a test that **fails while the hole is open**. To keep CI
green without hiding the hole, the test is marked as expected to fail, and
the marker is strict. A strict marker makes CI go red the moment the test
starts passing. That forces whoever closed the hole to remove the marker and
update the ledger in the same PR.

Pick the marker for the runner that CI actually uses for that folder:

| Folder | CI runner (workflow) | Marker |
|---|---|---|
| `tests/security/` | pytest (`security.yml`) | `@pytest.mark.xfail(strict=True, reason="BR-X-NNN open")` |
| `tests/` (everything else) | `python -m unittest discover` (`tests.yml`): **no pytest in CI** | `@unittest.expectedFailure  # BR-X-NNN open` |
| `command-center/tests/` | vitest (`frontend.yml`) | `it.fails(...)` with `// BR-X-NNN open` |

`unittest` ignores pytest markers, so a `pytest.mark.xfail` test under `tests/` would just fail
CI. `@unittest.expectedFailure` is strict in the same way: an unexpected success makes the run
unsuccessful.

**Python, security lab (pytest, `tests/security/`):**

```python
import pytest

@pytest.mark.xfail(strict=True, reason="BR-A-007 open")
def test_tenant_b_cannot_read_tenant_a_storyboard(sec):
    ...  # asserts the SAFE behaviour; fails today because the hole is open
```

**Python, unit tests (unittest, `tests/`):**

```python
class MediaBombTest(unittest.TestCase):
    @unittest.expectedFailure  # BR-C-001 open
    def test_raster_megapixel_bomb_is_refused(self):
        ...  # asserts the SAFE behaviour
```

**TypeScript (vitest, `command-center/tests/`):**

```ts
// BR-B-002 open
it.fails("rejects a revoked API key on /api/v1/videos", async () => {
  ...  // asserts the SAFE behaviour
});
```

Rules:

- The test asserts the **safe** behaviour. It is not written to pass against
  the bug.
- The marker's reason or comment contains exactly `BR-X-NNN open`, so that
  `grep -rn "BR-A-007 open"` finds every test pinned to that finding.
- Never `skip`, never `xfail(strict=False)`, never `it.skip` or `it.todo`. A
  skipped test cannot go red when the hole closes or reopens.
- When Patch fixes it, Patch deletes the marker (`xfail` or `expectedFailure`
  becomes a plain test, `it.fails` becomes `it`), adds at least one more regression test for the
  variant that Sentinel's root-cause search found, and sets the ledger row to
  `fixed` with the PR number.

## Static review scope (BR-S)

Sentinel also reviews things no attack test covers:

- `.github/workflows/*`: `permissions:`, `pull_request_target`, secrets passed
  to steps that run untrusted code, `${{ github.event.* }}` interpolated into
  `run:`, and third-party actions not pinned to a commit SHA.
- Dependencies: `npm audit` and `pip-audit` when they can run, otherwise a
  review of the manifests.
- Hard-coded secrets in tracked files.
- `command-center/vercel.json`, `next.config.ts` and middleware: security
  headers, CSP, redirects, image remote patterns.

## Ground rules (from CLAUDE.md)

- Lab only. No test touches production, the live Supabase project, real
  social accounts or real keys.
- The ledger never contains a secret or any part of one, even a redacted
  fragment. Write "the service key" and the file and line. Do not write the
  value.
- A fix never loosens publishing, privacy, the publish gate, approvals or
  the anon-key-only rule for the Command Center.
