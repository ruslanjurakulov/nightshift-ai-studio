# Disposable PostgreSQL harness

This harness is local-only. It uses an approved local Supabase-compatible
runtime, synthetic data and a disposable volume. It must never be pointed at
production.

The old `postgres:16` compose service is only a disposable smoke target. It is
not a Supabase security environment: it does not provide Supabase Auth,
Storage, PostgREST roles or helper functions. Do not report a full migration
chain as passed on that image.

The preferred runtime is the officially supported Supabase CLI local stack. CI
copies `tests/postgres/config.toml` to the ephemeral `supabase/config.toml` and
copies `supabase/schema.sql` to an ephemeral `supabase/migrations/0000_base_schema.sql`.
This makes the base schema run once before the numbered migrations without
editing or committing production files.

## Run on an approved development host

From the repository root:

```bash
export NIGHTSHIFT_TEST_PROJECT=nightshift-phase2b1f
tests/postgres/prepare_supabase.sh
supabase start
tests/postgres/preflight_supabase.sh
docker compose -p "$NIGHTSHIFT_TEST_PROJECT" -f tests/postgres/docker-compose.yml up -d postgres
docker compose -p "$NIGHTSHIFT_TEST_PROJECT" -f tests/postgres/docker-compose.yml exec postgres \
  pg_isready -U nightshift_test -d nightshift_test
tests/postgres/load_supabase.sh
python3 tests/postgres/run_sql_tests.py
tests/postgres/cleanup.sh
tests/postgres/cleanup_supabase.sh
supabase stop
```

For the GitHub Actions path, the workflow performs the temporary config/base
migration setup and installs `psycopg[binary]==3.2.3` inside the runner.

`preflight_supabase.sh` verifies the CLI and local stack status. For the real
Supabase-compatible chain use `load_supabase.sh`, which delegates migration
execution to the official CLI and records the first filename reported on
failure. The `load_schema.sh` script remains a vanilla-Postgres smoke loader;
it is not evidence of Supabase compatibility.
The SQL tests require `psycopg` on the approved development host. They do not
call providers and do not use production credentials.

The SQL runner accepts only `127.0.0.1:55322` (or the equivalent local
`localhost` endpoint). Any other host or port is reported as `UNRUN`. Raw logs
must not be uploaded; use `sanitize_evidence.sh` before creating artifacts.

If Docker, PostgreSQL or psycopg is unavailable, the result is **UNRUN**, never
PASS. This managed Codex sandbox cannot access its Docker daemon, so tests are
not run here.

## Safety

`cleanup.sh` removes only the explicitly named compose project and its
disposable volume. It verifies Docker's project label before removing anything.
Do
not replace the compose file's loopback port with a public bind address.

The base `supabase/schema.sql` is not loaded by the vanilla loader. The CI and
approved-host Supabase path must load it exactly once as the ephemeral `0000`
base migration. Loading it twice is forbidden.

The deterministic CI sequence is:

1. copy the test-only `config.toml` to `supabase/config.toml`;
2. copy `supabase/schema.sql` to `supabase/migrations/0000_base_schema.sql`;
3. start the local Supabase stack using that config;
4. run `supabase db reset --local`, which applies `0000_base_schema.sql` and
   then the numbered migrations in order;
5. run the local SQL smoke runner;
6. sanitize evidence, verify no credential patterns remain, upload only the
   sanitized directory, stop Supabase and remove the ephemeral files.

The CI workflow redirects Supabase and migration output to files. Raw output is
never written to the Actions console. Artifact creation fails if sanitization
fails or known credential/DSN patterns remain.


### X6 ownership evidence (diagnostic only)

Run the existing `phase2b1f_storage_ownership.yml` manually on `main`. It uses
CLI 2.67.1 and a 900-second startup deadline (plus 30-second termination grace).
Postgres, gotrue/Auth, storage-api, Kong/PostgREST and image support remain.
Studio, postgres-meta, logflare, vector, realtime, edge-runtime, mailpit and
supavisor are excluded. Realtime/analytics/edge configuration is disabled too:
CLI service initialization jobs otherwise still run despite `--exclude`.
Names verified against official v2.67.1 `cmd/start.go`,
`internal/start/start.go:ExcludableContainers`, and
`pkg/config/templates/Dockerfile`; the runner also validates `start --help`.

Only the disposable 0003 copy receives a read-only DO/NOTICE probe. This captures
**actual migration-session** current_user/session_user, relowner, inherited
owner-role USAGE, MEMBER, superuser and memberships before startup can destroy
containers. It neither creates a persistent probe nor modifies grants/owners.
The original complete directory is restored by EXIT trap, with byte comparison.
Runner destruction bounds forced-cancellation cleanup; no subsequent full-chain
validation uses the subset. Production SQL is unchanged.

Only `ownership-evidence/report.json` is printed/uploaded. It is built from
validated identity fields, numeric resource readings and fixed failure categories.
Raw start/help logs, Docker environment and health-check output are never exported.
Container status may be unavailable because CLI removes containers after failure.
Exit 137 alone is not proof of OOM; absent evidence remains unknown. A report with
`ownership_sql=UNRUN` is not a pass. The full chain is always UNRUN on this path.
Production executor equivalence remains unverified without owner-supplied evidence.


Follow-up registry evidence: X5 run 40905661048 artifact 12910169734 ends
with `toomanyrequests` while retrying `ghcr.io/supabase/postgres:17.6.1.064`.
X6 run 40911606114 reports only image_pull_failure; its underlying reason is
not independently recorded. Use `SUPABASE_INTERNAL_IMAGE_REGISTRY=public.ecr.aws`
on the diagnostic step only. This is the default mirror in official CLI v2.67.1
`internal/utils/docker.go` (GetRegistry/GetRegistryImageUrl), not a custom image.
Original image version tags and the pinned CLI stay unchanged. Report registry,
allowlisted public image mentions and a fixed rate-limit indicator; never publish
raw error lines. One bounded follow-up run is authorized by the owner's PR #647
instruction. A successful diagnostic still does not validate the full chain.


Ownership evidence correction: owner-role MEMBER/USAGE=false proves absence of
native owner privileges, not absence of all policy management authority. The exact
17.6.1.064 upstream image configuration explicitly grants policy management for
postgres on storage.objects/buckets via supautils.policy_grants:
https://github.com/supabase/postgres/blob/17.6.1.064/ansible/files/postgresql_config/supautils.conf.j2
https://github.com/supabase/supautils#manage-policies
The diagnostic now reads only the supautils version, preload indicators and two
specific policy-grant booleans from the migration session. Missing settings remain
null (unknown). It neither LOADs a library nor changes settings, roles, grants or
policies. These settings are not themselves a successful CREATE POLICY probe.
Production equivalence and the original 0004 failure still need reconciliation.

Manual `mode=full_chain` uses the same disposable runtime and protections, but
leaves every original migration intact (plus the existing ephemeral 0000 base).
No ownership probe is appended in this mode. The complete ordered filename
manifest is compared with CLI migration-start records. PASS requires startup
exit 0 and an exact complete sequence; missing/order-mismatched records yield
UNVERIFIED. SQL failure reports the last migration started and SQLSTATE; no
migrations started means UNRUN. This validates migration loading only, not RLS,
worker ownership, concurrency or production parity. Default mode stays ownership.

### Caught-publication-error diagnostic

Manual `mode=policy_repro` stages **only the generated base schema**, followed by
two rollback-only Storage policy probes around a caught duplicate-publication
error. The duplicate targets public.channels, which must already be a member of
supabase_realtime. A new postgres connection then repeats the policy probe over
the disposable container's local Unix socket. Container name and project label
must match; no host/DSN input, password, role escalation or owner change is used.
Each probe creates a deny-all diagnostic policy inside a subtransaction and
deliberately rolls it back; an existing probe name is a fatal error.

This tests a specific source-supported hypothesis: image source 17.6.1.064 pins
supautils v3.0.1. Its ALTER PUBLICATION hook calls switch_to_superuser, executes
the statement and restores the role only on normal return. utils.c stores an
is_switched_to_superuser flag outside PostgreSQL transactional state. A caught
duplicate_object can therefore leave the flag set after PostgreSQL restores the
actual user. schema.sql adds channels to the publication and original 0001 tries
to add it again. This is a hypothesis until the three real probes demonstrate
success before the error, 42501 afterward, and success on a fresh connection.

Sources (version-bound, not current upstream behavior):
- https://github.com/supabase/postgres/blob/17.6.1.064/nix/ext/supautils.nix
- https://github.com/supabase/supautils/blob/v3.0.1/src/supautils.c
- https://github.com/supabase/supautils/blob/v3.0.1/src/utils.c
- https://github.com/supabase/cli/blob/v2.67.1/pkg/migration/file.go

Report `policy_repro=PASS` means the diagnostic completed and no policy persisted.
Only `reproduction=REPRODUCED` confirms the expected before/after/reconnect pattern.
Missing evidence or failed startup/session remains UNRUN. Full migration chain
and Phase 2B.1G tests remain UNRUN in this mode. Original migrations are restored
byte-for-byte; raw output stays private; only validated JSON is published.
