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
#   NIGHTSHIFT_WORKER_ENV=on      only while the worker is enabled (the
#   KEY=value                     variable NIGHTSHIFT_WORKER), then one line
#   ...                           per key in deploy/.env.worker.example plus
#                                 any CHRONOS_YT_TOKEN_<REF>
#
# What it does, and refuses:
#   1. reads at most 64 KiB, checks the SHA line;
#   2. fetches origin/main and refuses a commit that is not on it — the key
#      can deploy what main already holds, never an arbitrary commit;
#   3. checks every env line against the keys that commit's .env.web.example
#      declares: KEY=value only, known keys only, each exactly once, no "$"
#      (compose would interpolate it), required ones non-empty;
#   4. writes /opt/nightshift/.env.web atomically, mode 600 (the previous copy
#      is kept as .env.web.prev, also 600); the worker section, checked the
#      same way against .env.worker.example, goes to /opt/nightshift/.env.worker
#      (600) — without one, that file is deleted;
#   5. checks out exactly that commit on the local `main` branch, runs
#      `docker compose up -d --build --remove-orphans web caddy`, and waits for
#      `web` to report healthy;
#   6. then starts or updates the worker, or removes it when it is off. A
#      worker in the middle of a video gets stop_grace_period to finish it; a
#      run cut short is re-queued and resumed from its checkpoint.
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
#   NIGHTSHIFT_WORKER_ENV_FILE the worker's env file   (/opt/nightshift/.env.worker)
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
WORKER_ENV_FILE="${NIGHTSHIFT_WORKER_ENV_FILE:-/opt/nightshift/.env.worker}"
LOCK_FILE="${NIGHTSHIFT_LOCK_FILE:-/opt/nightshift/.deploy.lock}"
DOCKER="${NIGHTSHIFT_DOCKER:-docker}"
HEALTH_TIMEOUT="${NIGHTSHIFT_HEALTH_TIMEOUT:-420}"

MAX_INPUT_BYTES=262144
SHA_KEY=NIGHTSHIFT_DEPLOY_SHA
WORKER_MARKER=NIGHTSHIFT_WORKER_ENV=on
# The per-channel YouTube tokens: the one family of worker keys that is not
# listed in .env.worker.example, because each channel brings its own name.
WORKER_TOKEN_KEY='^CHRONOS_YT_TOKEN_[A-Z0-9_]+$'
WORKER_REQUIRED_KEYS=(SUPABASE_URL SUPABASE_SERVICE_KEY)
# Mirrors the ${VAR:?} guards in docker-compose.yml: without these the stack
# either refuses to start or builds a dashboard that reads "NOT CONFIGURED".
REQUIRED_KEYS=(DOMAIN ACME_EMAIL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY)

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() {
  # WEB_ENV_FILE keeps the web container's env_file pointed at the same file
  # the interpolation reads, including under a test override; WORKER_ENV_FILE
  # does the same for the worker's. The worker profile is always active so
  # that compose knows the worker service (and --remove-orphans never mistakes
  # it for an orphan); services are named on every `up`.
  WEB_ENV_FILE="$ENV_FILE" WORKER_ENV_FILE="$WORKER_ENV_FILE" "$DOCKER" compose \
    --profile worker --env-file "$ENV_FILE" -f "$APP_DIR/deploy/docker-compose.yml" "$@"
}

# Checks the lines of one section against the KEY= lines of an example file.
# Appends to the caller's `problems` array; sets the caller's `nkeys`.
#   check_section <example text> <token regex or ''> <required keys, space-separated> <lines...>
check_section() {
  local example="$1" token_re="$2" required="$3"
  shift 3
  local -A known=() seen=() empty=()
  local line key value
  while IFS= read -r line; do
    if [[ "$line" =~ ^([A-Z][A-Z0-9_]*)= ]]; then
      known["${BASH_REMATCH[1]}"]=1
    fi
  done <<<"$example"
  if (( ${#known[@]} == 0 )); then
    problems+=("no keys found in $label")
    return
  fi
  for line in "$@"; do
    if [[ -z "$line" ]]; then continue; fi
    # Only the key name is ever reported, never the value.
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      problems+=("a line in the $section section is not KEY=value")
      continue
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ -z "${known[$key]:-}" ]] && ! [[ -n "$token_re" && "$key" =~ $token_re ]]; then
      problems+=("$key is not a key in $label")
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
  for key in $required; do
    if [[ -n "${seen[$key]:-}" && -n "${empty[$key]:-}" ]]; then
      problems+=("$key is required and empty")
    fi
  done
  nkeys=${#seen[@]}
}

# Writes lines to a file atomically, mode 600, keeping the previous copy as
# <file>.prev (600).   write_env <file> <header line> <lines...>
write_env() {
  local target="$1" header="$2" tmp line
  shift 2
  # Same directory as the target so the rename is atomic; umask 077 makes the
  # temp file 600 from the moment it exists.
  tmp="$(mktemp "${target}.XXXXXX")"
  # shellcheck disable=SC2064  # expand $tmp now
  trap "rm -f '$tmp'" EXIT
  {
    printf '%s\n' "$header"
    printf '# Edits here are overwritten by the next deploy: change the value in\n'
    printf '# GitHub (Environments -> production, or repository secrets) instead.\n'
    for line in "$@"; do
      if [[ -n "$line" ]]; then printf '%s\n' "$line"; fi
    done
  } >"$tmp"
  chmod 600 "$tmp"
  if [[ -f "$target" ]]; then
    cp -p "$target" "${target}.prev"
    chmod 600 "${target}.prev"
  fi
  mv -f "$tmp" "$target"
  trap - EXIT
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

  # ── 3. Validate the env against the examples AT THAT COMMIT ────────────────
  # Read from git, not the working tree: a key added in the commit being
  # deployed is known before it is checked out.
  local -a web_lines=() worker_lines=()
  local worker=off line
  for line in "${lines[@]}"; do
    if [[ "$worker" == off && "$line" == "$WORKER_MARKER" ]]; then
      worker=on
      continue
    fi
    if [[ "$worker" == on ]]; then worker_lines+=("$line"); else web_lines+=("$line"); fi
  done

  local example
  example="$(git show "${sha}:deploy/.env.web.example")" \
    || die "deploy/.env.web.example is missing at $sha"
  local -a problems=()
  local nkeys=0 web_keys=0 worker_keys=0
  local label="deploy/.env.web.example" section=web
  check_section "$example" "" "${REQUIRED_KEYS[*]}" "${web_lines[@]}"
  web_keys=$nkeys
  if [[ "$worker" == on ]]; then
    example="$(git show "${sha}:deploy/.env.worker.example" 2>/dev/null)" \
      || die "a worker env was sent, but deploy/.env.worker.example is missing at $sha"
    label="deploy/.env.worker.example" section=worker nkeys=0
    check_section "$example" "$WORKER_TOKEN_KEY" "${WORKER_REQUIRED_KEYS[*]}" "${worker_lines[@]}"
    worker_keys=$nkeys
  fi
  if (( ${#problems[@]} > 0 )); then
    printf 'ERROR: the env sent by the workflow was refused; nothing was changed:\n' >&2
    printf '  - %s\n' "${problems[@]}" | sort >&2
    exit 1
  fi

  # ── 4. Write the env files ─────────────────────────────────────────────────
  write_env "$ENV_FILE" "# Written by deploy/remote-deploy.sh from GitHub Actions (commit $sha)." "${web_lines[@]}"
  log "wrote $ENV_FILE ($web_keys keys, mode 600)"
  if [[ "$worker" == on ]]; then
    write_env "$WORKER_ENV_FILE" "# Written by deploy/remote-deploy.sh from GitHub Actions (commit $sha)." "${worker_lines[@]}"
    log "wrote $WORKER_ENV_FILE ($worker_keys keys, mode 600)"
  fi

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
  log "docker compose up -d --build --remove-orphans web caddy"
  compose up -d --build --remove-orphans web caddy \
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

  # ── 8. The worker ──────────────────────────────────────────────────────────
  # After web is healthy, so a long worker stop never delays the dashboard.
  if [[ "$worker" == on ]]; then
    log "docker compose up -d --build --no-deps worker"
    compose up -d --build --no-deps worker \
      || die "the worker did not start; on the server: dc logs --tail 100 worker"
    compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' worker || true
  else
    # Off: no container, and no copy of the bot's keys left on the disk.
    compose rm --stop --force worker >/dev/null 2>&1 || true
    rm -f "$WORKER_ENV_FILE" "${WORKER_ENV_FILE}.prev"
    log "worker is off (GitHub variable NIGHTSHIFT_WORKER is not 'on')"
  fi

  # Each build leaves the previous image dangling; a few of these a week fill
  # a disk. Only dangling images: nothing a container still uses.
  "$DOCKER" image prune -f >/dev/null 2>&1 || true

  log "deployed $sha; web is healthy; worker $worker"
}

main "$@"
exit
