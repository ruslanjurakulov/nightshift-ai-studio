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
