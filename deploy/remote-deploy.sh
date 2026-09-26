#!/usr/bin/env bash
# Nightshift — the server side of the automatic deploy (.github/workflows/deploy_web.yml).
# Step by step (Uzbek): docs/DEPLOY_AX42.md, "Avtomatik deploy".
#
# This is an SSH *forced command*: deploy/setup-gha-deploy.sh pins it to one
# dedicated key in ~nightshift/.ssh/authorized_keys, so whoever holds that key
# can run this script and nothing else — no shell, no port forwarding, no pty.
# Whatever command the client asks for is ignored.
#
# Input, on stdin (never on a command line, so never in `ps` or a log):
#
#   NIGHTSHIFT_DEPLOY_SHA=<40-hex commit on origin/main>
#   KEY=value          one line per key in deploy/.env.web.example
#   ...
#
# What it does, and refuses:
#   1. reads at most 64 KiB, checks the SHA line;
#   2. fetches origin/main and refuses a commit that is not on it — the key
#      can deploy what main already holds, never an arbitrary commit;
#   3. checks every env line against the keys that commit's .env.web.example
#      declares: KEY=value only, known keys only, each exactly once, no "$"
#      (compose would interpolate it), required ones non-empty;
#   4. writes /opt/nightshift/.env.web atomically, mode 600 (the previous copy
#      is kept as .env.web.prev, also 600);
#   5. checks out exactly that commit on the local `main` branch, runs
#      `docker compose up -d --build --remove-orphans`, and waits for `web` to
#      report healthy.
#
# It never prints a value — only key names, the commit, and container status.
# Its output ends up in a PUBLIC Actions log, so that is not a style choice.
# No sudo: the nightshift user owns /opt/nightshift and is in the docker group.
#
# Safe to run again with the same input: every step converges.
#
# Overridable for tests (tests/test_deploy_gha.py); production uses the defaults.
#   NIGHTSHIFT_APP_DIR        git checkout             (/opt/nightshift/app)
#   NIGHTSHIFT_ENV_FILE       env file compose reads   (/opt/nightshift/.env.web)
#   NIGHTSHIFT_LOCK_FILE      one deploy at a time     (/opt/nightshift/.deploy.lock)
#   NIGHTSHIFT_DOCKER         docker binary            (docker)
#   NIGHTSHIFT_HEALTH_TIMEOUT seconds to wait for web  (420)
# sshd does not accept client-sent environment by default (PermitUserEnvironment
# no, AcceptEnv LANG LC_*), so the key holder cannot set these.

# Everything lives in main(), called on the last line. The deploy checks out a
# new commit, which can rewrite this very file while bash is still reading it;
# a function is parsed whole before it runs, so the running copy cannot change
# under its own feet.

set -euo pipefail
# Byte semantics for the checks below: [A-Z] means ASCII, [[:cntrl:]] means
# the control bytes, whatever locale the SSH session arrived with.
export LC_ALL=C

APP_DIR="${NIGHTSHIFT_APP_DIR:-/opt/nightshift/app}"
ENV_FILE="${NIGHTSHIFT_ENV_FILE:-/opt/nightshift/.env.web}"
LOCK_FILE="${NIGHTSHIFT_LOCK_FILE:-/opt/nightshift/.deploy.lock}"
DOCKER="${NIGHTSHIFT_DOCKER:-docker}"
HEALTH_TIMEOUT="${NIGHTSHIFT_HEALTH_TIMEOUT:-420}"

MAX_INPUT_BYTES=65536
SHA_KEY=NIGHTSHIFT_DEPLOY_SHA
# Mirrors the ${VAR:?} guards in docker-compose.yml: without these the stack
# either refuses to start or builds a dashboard that reads "NOT CONFIGURED".
REQUIRED_KEYS=(DOMAIN ACME_EMAIL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY)

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() {
  # WEB_ENV_FILE keeps the web container's env_file pointed at the same file
  # the interpolation reads, including under a test override.
  WEB_ENV_FILE="$ENV_FILE" "$DOCKER" compose \
    --env-file "$ENV_FILE" -f "$APP_DIR/deploy/docker-compose.yml" "$@"
}

main() {
  umask 077

  exec 9>"$LOCK_FILE" || die "cannot open the lock file $LOCK_FILE"
  if ! flock -n 9; then
    die "another deploy is running on the server; re-run this one when it finishes"
  fi

  # ── 1. Input ───────────────────────────────────────────────────────────────
  # Held in memory only: nothing touches disk until every line has passed.
  local input
  input="$(head -c "$((MAX_INPUT_BYTES + 1))")" || true
  if (( ${#input} > MAX_INPUT_BYTES )); then
    die "input is larger than $MAX_INPUT_BYTES bytes"
  fi
  [[ -n "$input" ]] || die "no input on stdin (expected $SHA_KEY=<sha> and the env lines)"

  local -a lines=()
  mapfile -t lines <<<"$input"

  local first="${lines[0]}"
  [[ "$first" =~ ^${SHA_KEY}=([0-9a-f]{40})$ ]] \
    || die "the first line must be $SHA_KEY=<40 lowercase hex characters>"
  local sha="${BASH_REMATCH[1]}"
  lines=("${lines[@]:1}")

  # ── 2. The commit must already be on origin/main ───────────────────────────
  [[ -d "$APP_DIR/.git" ]] || die "$APP_DIR is not a git checkout"
  cd "$APP_DIR"
  log "fetching origin/main"
  git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' \
    || die "git fetch origin main failed (network, or the remote URL in $APP_DIR)"
  git cat-file -e "${sha}^{commit}" 2>/dev/null \
    || die "commit $sha does not exist on origin/main"
  git merge-base --is-ancestor "$sha" refs/remotes/origin/main \
    || die "commit $sha is not on origin/main; only commits already on main are deployed"

  # ── 3. Validate the env against the example AT THAT COMMIT ─────────────────
  # Read from git, not the working tree: a key added in the commit being
  # deployed is known before it is checked out.
  local example
  example="$(git show "${sha}:deploy/.env.web.example")" \
    || die "deploy/.env.web.example is missing at $sha"
  local -A known=()
  local line key
  while IFS= read -r line; do
    if [[ "$line" =~ ^([A-Z][A-Z0-9_]*)= ]]; then
      known["${BASH_REMATCH[1]}"]=1
    fi
  done <<<"$example"
  (( ${#known[@]} > 0 )) || die "no keys found in deploy/.env.web.example at $sha"

  local -A seen=()
  local -A empty=()
  local -a problems=()
  local n=1
  for line in "${lines[@]}"; do
    n=$((n + 1))
    if [[ -z "$line" ]]; then continue; fi
    # Only the line number and key name are ever reported, never the value.
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      problems+=("line $n is not KEY=value")
      continue
    fi
    key="${BASH_REMATCH[1]}"
    local value="${BASH_REMATCH[2]}"
    if [[ -z "${known[$key]:-}" ]]; then
      problems+=("$key is not a key in deploy/.env.web.example")
      continue
    fi
    if [[ -n "${seen[$key]:-}" ]]; then
      problems+=("$key is given more than once")
      continue
    fi
    seen["$key"]=1
    if [[ "$value" == *'$'* ]]; then
      problems+=("$key contains \"\$\", which compose would interpolate")
    fi
    if [[ "$value" =~ [[:cntrl:]] ]]; then
      problems+=("$key contains a control character (a pasted line break?)")
    fi
    if [[ -z "$value" ]]; then empty["$key"]=1; fi
  done
  for key in "${!known[@]}"; do
    if [[ -z "${seen[$key]:-}" ]]; then
      problems+=("$key is missing (the workflow maps every key, empty or not)")
    fi
  done
  for key in "${REQUIRED_KEYS[@]}"; do
    if [[ -n "${seen[$key]:-}" && -n "${empty[$key]:-}" ]]; then
      problems+=("$key is required and empty")
    fi
  done
  if (( ${#problems[@]} > 0 )); then
    printf 'ERROR: the env sent by the workflow was refused; nothing was changed:\n' >&2
    printf '  - %s\n' "${problems[@]}" | sort >&2
    exit 1
  fi

  # ── 4. Write the env file, atomically ──────────────────────────────────────
  # Same directory as the target so the rename is atomic; umask 077 makes the
  # temp file 600 from the moment it exists.
  local tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  # shellcheck disable=SC2064  # expand $tmp now: it is local to main()
  trap "rm -f '$tmp'" EXIT
  {
    printf '# Written by deploy/remote-deploy.sh from GitHub Actions (commit %s).\n' "$sha"
    printf '# Edits here are overwritten by the next deploy: change the value in\n'
    printf '# GitHub -> Settings -> Environments -> production instead.\n'
    for line in "${lines[@]}"; do
      if [[ -n "$line" ]]; then printf '%s\n' "$line"; fi
    done
  } >"$tmp"
  chmod 600 "$tmp"
  if [[ -f "$ENV_FILE" ]]; then
    cp -p "$ENV_FILE" "${ENV_FILE}.prev"
    chmod 600 "${ENV_FILE}.prev"
  fi
  mv -f "$tmp" "$ENV_FILE"
  trap - EXIT
  log "wrote $ENV_FILE (${#seen[@]} keys, mode 600)"

  # ── 5. Check out exactly that commit ───────────────────────────────────────
  # On the local `main` branch rather than a detached HEAD, so the manual
  # `git pull --ff-only` in the runbook keeps working afterwards. Local commits
  # that origin/main does not have would be dropped by -B, so refuse instead.
  if git show-ref --verify --quiet refs/heads/main \
     && [[ -n "$(git rev-list refs/remotes/origin/main..refs/heads/main)" ]]; then
    die "local branch main has commits origin/main does not; resolve by hand in $APP_DIR"
  fi
  if ! git diff --quiet HEAD -- 2>/dev/null || ! git diff --cached --quiet HEAD -- 2>/dev/null; then
    die "$APP_DIR has local changes; see 'git -C $APP_DIR status' and discard or commit them"
  fi
  git -c advice.detachedHead=false checkout --quiet -B main "$sha" \
    || die "git checkout $sha failed in $APP_DIR"
  log "checked out $sha"

  # ── 6. Build and start ─────────────────────────────────────────────────────
  log "docker compose up -d --build --remove-orphans"
  compose up -d --build --remove-orphans \
    || die "docker compose up failed; on the server: dc ps, then dc logs web"

  # ── 7. Wait for web to be healthy ──────────────────────────────────────────
  local cid status="" waited=0
  cid="$(compose ps -q web)"
  [[ -n "$cid" ]] || die "no web container after compose up; on the server: dc ps"
  while (( waited < HEALTH_TIMEOUT )); do
    status="$("$DOCKER" inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)"
    case "$status" in
      healthy) break ;;
      unhealthy) break ;;
    esac
    sleep 5
    waited=$((waited + 5))
  done
  # Status only. Container logs stay on the server: this output is public, and
  # an app log line can carry a user's e-mail or a request path.
  compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' || true
  if [[ "$status" != healthy ]]; then
    die "web is ${status:-not reporting health} after ${waited}s; on the server: dc logs --tail 100 web"
  fi

  # Each build leaves the previous image dangling; a few of these a week fill
  # a disk. Only dangling images: nothing a container still uses.
  "$DOCKER" image prune -f >/dev/null 2>&1 || true

  log "deployed $sha; web is healthy"
}

main "$@"
exit
