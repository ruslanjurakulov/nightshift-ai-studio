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
#   NIGHTSHIFT_NOTIFY_ENV=on      optional, own section for the customer Telegram
#   KEY=value                     sender (variable NIGHTSHIFT_NOTIFY_WORKER): one
#   ...                           line per key in deploy/.env.notify.example
#   NIGHTSHIFT_EMAIL_ENV=on       optional, own section for the customer e-mail
#   KEY=value                     sender (variable NIGHTSHIFT_EMAIL_WORKER): one
#   ...                           line per key in deploy/.env.email.example
#   NIGHTSHIFT_OPERATOR_ENV=on    optional, own section for the operator bot
#   KEY=value                     (variable NIGHTSHIFT_OPERATOR_BOT): one line per
#   ...                           key in deploy/.env.operator.example
#   (sections may come in any order after the web lines; each marker once)
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
#      (600) — without one, that file is deleted. The notify and e-mail
#      sections are checked the same way and go to /opt/nightshift/.env.notify
#      and .env.email (600), each its own file, never the worker's; so does the
#      operator-bot section (/opt/nightshift/.env.operator);
#   5. checks out exactly that commit on the local `main` branch, runs
#      `docker compose up -d --build --remove-orphans web caddy`, and waits for
#      `web` to report healthy;
#   6. then starts or updates the worker, or removes it when it is off. A
#      worker in the middle of a video gets stop_grace_period to finish it; a
#      run cut short is re-queued and resumed from its checkpoint. The
#      creative worker follows the worker-section line
#      NIGHTSHIFT_CREATIVE_WORKER=on (the repository variable of that name):
#      started or recreated when it says `on` and the worker is on, stopped
#      and removed otherwise. The notify-worker and email-worker follow their
#      own sections the same way, independent of the pipeline worker, and so
#      does the operator-bot (tools/operator_bot_service.py: it long-polls
#      Telegram and runs the alert pass, no port, no Caddy route);
#   7. last, loads deploy/Caddyfile into the running Caddy without a restart
#      (a bind-mounted file that changes does not make compose recreate it),
#      but ONLY the exact file whose sha256 is pinned below
#      (CADDYFILE_APPROVED_SHA256): any other Caddyfile is refused and Caddy
#      keeps its config. Then it checks the headers Caddy really sends and puts
#      the previous config back if anything is off (see "Caddy" below and
#      docs/DEPLOY_AX42.md).
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
#   NIGHTSHIFT_NOTIFY_ENV_FILE the notify worker's     (/opt/nightshift/.env.notify)
#   NIGHTSHIFT_EMAIL_ENV_FILE  the e-mail worker's     (/opt/nightshift/.env.email)
#   NIGHTSHIFT_OPERATOR_ENV_FILE the operator bot's    (/opt/nightshift/.env.operator)
#   NIGHTSHIFT_LOCK_FILE      one deploy at a time     (/opt/nightshift/.deploy.lock)
#   NIGHTSHIFT_DOCKER         docker binary            (docker)
#   NIGHTSHIFT_HEALTH_TIMEOUT seconds to wait for web  (420)
#   NIGHTSHIFT_WORKER_SETTLE_SECONDS  pause before the worker state line (20)
#   NIGHTSHIFT_CURL           curl binary              (curl)
#   NIGHTSHIFT_CADDYFILE_APPROVED_SHA256  the pinned hash (see CADDYFILE_APPROVED_SHA256)
#   NIGHTSHIFT_CADDY_STATE_DIR where the last loaded Caddyfile is kept (dir of the env file)
#   NIGHTSHIFT_CADDY_VERIFY_HOST / _SCHEME / _PORT / _TIMEOUT / NIGHTSHIFT_CADDY_RETRY_SLEEP
#                             how the header check reaches Caddy (DOMAIN / https / 443 / 30 / 2)
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
NOTIFY_ENV_FILE="${NIGHTSHIFT_NOTIFY_ENV_FILE:-/opt/nightshift/.env.notify}"
EMAIL_ENV_FILE="${NIGHTSHIFT_EMAIL_ENV_FILE:-/opt/nightshift/.env.email}"
OPERATOR_ENV_FILE="${NIGHTSHIFT_OPERATOR_ENV_FILE:-/opt/nightshift/.env.operator}"
LOCK_FILE="${NIGHTSHIFT_LOCK_FILE:-/opt/nightshift/.deploy.lock}"
DOCKER="${NIGHTSHIFT_DOCKER:-docker}"
HEALTH_TIMEOUT="${NIGHTSHIFT_HEALTH_TIMEOUT:-420}"
WORKER_SETTLE_SECONDS="${NIGHTSHIFT_WORKER_SETTLE_SECONDS:-20}"
CURL="${NIGHTSHIFT_CURL:-curl}"
CADDY_STATE_DIR="${NIGHTSHIFT_CADDY_STATE_DIR:-$(dirname "$ENV_FILE")}"
CADDY_VERIFY_HOST="${NIGHTSHIFT_CADDY_VERIFY_HOST:-}"
CADDY_VERIFY_SCHEME="${NIGHTSHIFT_CADDY_VERIFY_SCHEME:-https}"
CADDY_VERIFY_PORT="${NIGHTSHIFT_CADDY_VERIFY_PORT:-443}"
CADDY_VERIFY_TIMEOUT="${NIGHTSHIFT_CADDY_VERIFY_TIMEOUT:-30}"
CADDY_RETRY_SLEEP="${NIGHTSHIFT_CADDY_RETRY_SLEEP:-2}"

MAX_INPUT_BYTES=262144
SHA_KEY=NIGHTSHIFT_DEPLOY_SHA
WORKER_MARKER=NIGHTSHIFT_WORKER_ENV=on
NOTIFY_MARKER=NIGHTSHIFT_NOTIFY_ENV=on
EMAIL_MARKER=NIGHTSHIFT_EMAIL_ENV=on
OPERATOR_MARKER=NIGHTSHIFT_OPERATOR_ENV=on
# The per-channel YouTube tokens: the one family of worker keys that is not
# listed in .env.worker.example, because each channel brings its own name.
WORKER_TOKEN_KEY='^CHRONOS_YT_TOKEN_[A-Z0-9_]+$'
WORKER_REQUIRED_KEYS=(SUPABASE_URL SUPABASE_SERVICE_KEY)
# Every key of the two small workers' files is required: switched on with one
# empty, they would only log that they are OFF.
NOTIFY_REQUIRED_KEYS=(SUPABASE_URL SUPABASE_SERVICE_KEY TELEGRAM_CUSTOMER_BOT_TOKEN NOTIFY_APP_ORIGIN)
EMAIL_REQUIRED_KEYS=(SUPABASE_URL SUPABASE_SERVICE_KEY RESEND_API_KEY NIGHTSHIFT_EMAIL_FROM APP_ORIGIN)
# The operator bot's file also lists optional keys (present, possibly empty).
OPERATOR_REQUIRED_KEYS=(SUPABASE_URL SUPABASE_SERVICE_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID)
# Mirrors the ${VAR:?} guards in docker-compose.yml: without these the stack
# either refuses to start or builds a dashboard that reads "NOT CONFIGURED".
REQUIRED_KEYS=(DOMAIN ACME_EMAIL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY)

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Print which of a fixed list of phrases occur in $1 (comma separated, or
# nothing). The words printed are the list's, so the text itself never leaks.
hint_words() {
  local text="$1" out="" w
  for w in "unrecognized arguments" "usage:" "Traceback" "ModuleNotFoundError" "ImportError" \
           "must be set" "must be absolute" "not a writable directory" "are required" "Permission denied" "No such file" \
           "pillow-heif" "ConnectionError" "Timeout" \
           "a webhook is set" "rejected the bot token" "are not set"; do
    if printf '%s' "$text" | grep -qiF -- "$w"; then out="${out:+$out,}${w// /_}"; fi
  done
  printf '%s' "$out"
}

# Why web is not healthy, in words that cannot carry a value. Docker's own
# numbers (state, exit code, OOM, restarts) plus which names from a fixed list
# the container's recent output contains: the built-in error classes
# (TypeError ...) and system or Node error codes (EROFS, ERR_MODULE_NOT_FOUND
# ...). Never the log text: this output is public and an app log line can carry a user's e-mail or a request path.
#   web_diagnostics [container id]
web_diagnostics() {
  local cid="${1:-}" state log_text names hints w
  [[ -n "$cid" ]] || cid="$(compose ps -aq web 2>/dev/null | head -n 1 || true)"
  if [[ -z "$cid" ]]; then echo "web diagnostics: no web container"; return 0; fi
  state="$("$DOCKER" inspect -f 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' "$cid" 2>/dev/null || true)"
  echo "web diagnostics: ${state:-state unreadable}"
  log_text="$("$DOCKER" logs --tail 200 "$cid" 2>&1 || true)"
  # Fixed list, matched as whole words: an open pattern (anything ending in
  # Error) would let a crafted path or an e-mail's local part pass through as
  # a "name". Only the list's own spelling is ever printed.
  names=""
  for w in EROFS EACCES ENOENT EPERM EADDRINUSE ECONNREFUSED ENOTFOUND ETIMEDOUT EMFILE ENOSPC \
           TypeError ReferenceError SyntaxError RangeError EvalError URIError AggregateError AssertionError \
           ERR_MODULE_NOT_FOUND ERR_REQUIRE_ESM ERR_INVALID_URL ERR_UNKNOWN_FILE_EXTENSION ERR_PACKAGE_PATH_NOT_EXPORTED \
           ERR_INVALID_ARG_TYPE ERR_INVALID_ARG_VALUE ERR_SOCKET_BAD_PORT ERR_SERVER_ALREADY_LISTEN \
           ERR_UNHANDLED_REJECTION ERR_DLOPEN_FAILED ERR_WORKER_OUT_OF_MEMORY ERR_INVALID_PACKAGE_CONFIG; do
    if grep -qwF -- "$w" <<<"$log_text"; then names="${names:+$names,}$w"; fi
  done
  echo "web diagnostics: log names=${names:-none}"
  hints=""
  for w in "read-only file system" "Cannot find module" "Invalid URL" "out of memory" "is not defined" \
           "must be set" "Permission denied" "No such file" "address already in use" "Unexpected token"; do
    if printf '%s' "$log_text" | grep -qiF -- "$w"; then hints="${hints:+$hints,}${w// /_}"; fi
  done
  echo "web diagnostics: log hints=${hints:-none}"
}

compose() {
  # WEB_ENV_FILE keeps the web container's env_file pointed at the same file
  # the interpolation reads, including under a test override; WORKER_ENV_FILE
  # does the same for the worker's, NOTIFY_ENV_FILE and EMAIL_ENV_FILE for the
  # notify and e-mail workers', OPERATOR_ENV_FILE for the operator bot. The
  # worker, notify, email and operator profiles are always active so that
  # compose knows those services (and --remove-orphans never mistakes them for
  # orphans); services are named on every `up`.
  WEB_ENV_FILE="$ENV_FILE" WORKER_ENV_FILE="$WORKER_ENV_FILE" \
    NOTIFY_ENV_FILE="$NOTIFY_ENV_FILE" EMAIL_ENV_FILE="$EMAIL_ENV_FILE" \
    OPERATOR_ENV_FILE="$OPERATOR_ENV_FILE" "$DOCKER" compose \
    --profile worker --profile notify --profile email --profile operator --env-file "$ENV_FILE" -f "$APP_DIR/deploy/docker-compose.yml" "$@"
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

# ── Caddy: validate, reload, verify, roll back ──────────────────────────────
# Caddy reads deploy/Caddyfile through a single-file bind mount, so a deploy
# that only changes that file recreates nothing, and git replacing the file
# (new inode) leaves the container looking at the old one. So the Caddyfile is
# fed to Caddy on stdin from the checkout rather than read from the mount.
# (A relative `import` in the Caddyfile would not resolve from stdin: if one is
# ever added, this step must change with it.)
#
# THE GATE. The one Caddyfile this script will load, by sha256 of its exact
# bytes (no normalisation: a CRLF or BOM variant is a different file and is
# refused, so is a trailing newline). Any other deploy/Caddyfile is not
# validated, not loaded, and fails the step; Caddy keeps the config it has. The
# header guard and the live check below are tripwires for the listed headers
# only, they do NOT see a widened CSP or CORS, a new route, another upstream or
# a matcher that skips a path. A person reviewing the Caddyfile does, and
# updates this hash in the same PR:
#     sha256sum deploy/Caddyfile
# tests/test_deploy_self_host.py fails until the two agree. The environment
# override is for the tests; sshd does not pass client environment.
CADDYFILE_APPROVED_SHA256="${NIGHTSHIFT_CADDYFILE_APPROVED_SHA256:-8c3c4e819f366fbd2a5951d3677f593cb35e729aae093a079e2f592fd7bdfc0c}"

# This is the CONTRACT: what Caddy must keep sending. It mirrors the `header`
# blocks of deploy/Caddyfile (tests/test_deploy_self_host.py compares the two).
# A Caddyfile that drops one of these is refused BEFORE it is loaded, and a
# loaded one that does not send them is rolled back. Changing this list is a
# deliberate act that comes with a test change; the script never edits it.
CADDY_HEADERS=(
  'Strict-Transport-Security: max-age=31536000'
  'X-Content-Type-Options: nosniff'
  'Referrer-Policy: strict-origin-when-cross-origin'
)
CADDY_HEADERS_PRESENT=(Permissions-Policy)
CADDY_HEADERS_ABSENT=(Server X-Powered-By)
# Framing: a request that is not an iframe gets exactly one DENY from Caddy;
# our own page framing itself (same-origin iframe) gets the app's one
# SAMEORIGIN, and only on pages that may be framed; /auth and /api stay DENY.
CADDY_FRAME_PLAIN=/login
CADDY_FRAME_SELF=/login
CADDY_FRAME_NEVER=(/auth/callback /api/account)

# Run caddy inside the running caddy service (root, with the container's own
# DOMAIN and ACME_EMAIL, which is what {$DOMAIN} in the Caddyfile reads).
# The config comes on stdin ("--config -").
caddy_exec() { compose exec -T caddy caddy "$@"; }

# Response headers of one request through Caddy on this machine, lower-cased.
# TLS is verified: --resolve sends the real name to 127.0.0.1, no Cloudflare.
#   caddy_fetch <host> <path> <iframe: 0|1>
caddy_fetch() {
  local host="$1" path="$2" framed="$3"
  local -a args=(-sS -o /dev/null -D - --http1.1 --max-time 10 --resolve "${host}:${CADDY_VERIFY_PORT}:127.0.0.1")
  if [[ "$framed" == 1 ]]; then
    args+=(-H 'Sec-Fetch-Dest: iframe' -H 'Sec-Fetch-Site: same-origin')
  fi
  "$CURL" "${args[@]}" "${CADDY_VERIFY_SCHEME}://${host}:${CADDY_VERIFY_PORT}${path}" 2>/dev/null \
    | tr -d '\r' | tr '[:upper:]' '[:lower:]'
}

# Every X-Frame-Options value in a header dump, comma separated ("" if none).
# Reduced to deny / sameorigin / other: what the app sent is never logged.
xfo_values() {
  local v
  while IFS= read -r v; do
    case "$v" in deny | sameorigin) echo "$v" ;; *) echo other ;; esac
  done < <(grep '^x-frame-options:' <<<"$1" | sed 's/^[^:]*: *//' || true) | paste -sd, - || true
}

# The live check. Prints what is wrong (names and paths only, never a body),
# returns 0 fine, 1 a header is wrong, 2 Caddy did not answer properly (the
# caller may retry). mode "baseline" skips the iframe cases: a restored older
# Caddyfile has to keep the protections, not the newest framing rules.
#   caddy_check <host> <full|baseline>
caddy_check() {
  local host="$1" mode="$2" h x e name p rc=0
  h="$(caddy_fetch "$host" "$CADDY_FRAME_PLAIN" 0)" || { echo "no answer from Caddy on 127.0.0.1:${CADDY_VERIFY_PORT}"; return 2; }
  if [[ "$h" =~ ^http/[0-9.]+\ ([0-9]{3}) ]] && (( 10#${BASH_REMATCH[1]} >= 500 )); then
    echo "$CADDY_FRAME_PLAIN answered ${BASH_REMATCH[1]} (a server error: the app behind Caddy is not answering, or the config points somewhere wrong)"; return 2
  fi
  x="$(xfo_values "$h")"
  [[ "$x" == deny ]] || { echo "$CADDY_FRAME_PLAIN (not framed): X-Frame-Options is '${x:-missing}', expected exactly one DENY"; rc=1; }
  for e in "${CADDY_HEADERS[@]}"; do
    grep -qxF -- "${e,,}" <<<"$h" || { echo "${e%%: *} is missing or changed"; rc=1; }
  done
  for name in "${CADDY_HEADERS_PRESENT[@]}"; do
    grep -q -- "^${name,,}:" <<<"$h" || { echo "$name is missing"; rc=1; }
  done
  for name in "${CADDY_HEADERS_ABSENT[@]}"; do
    if grep -q -- "^${name,,}:" <<<"$h"; then echo "$name is sent"; rc=1; fi
  done
  if [[ "$mode" == full ]]; then
    h="$(caddy_fetch "$host" "$CADDY_FRAME_SELF" 1)" || { echo "no answer from Caddy for a framed request"; return 2; }
    x="$(xfo_values "$h")"
    [[ "$x" == sameorigin ]] || { echo "$CADDY_FRAME_SELF (same-origin iframe): X-Frame-Options is '${x:-missing}', expected exactly one SAMEORIGIN"; rc=1; }
    for p in "${CADDY_FRAME_NEVER[@]}"; do
      h="$(caddy_fetch "$host" "$p" 1)" || { echo "no answer from Caddy for a framed request"; return 2; }
      x="$(xfo_values "$h")"
      [[ "$x" == deny ]] || { echo "$p (iframe): X-Frame-Options is '${x:-missing}', expected exactly one DENY"; rc=1; }
    done
  fi
  return "$rc"
}

# caddy_check, retried while Caddy does not answer (just reloaded, or just
# created); a wrong header is final at once.
#   caddy_verify <host> <full|baseline>
caddy_verify() {
  local host="$1" mode="$2" waited=0 out rc
  while :; do
    rc=0
    out="$(caddy_check "$host" "$mode")" || rc=$?
    if (( rc == 0 )); then return 0; fi
    if (( rc != 2 || waited >= CADDY_VERIFY_TIMEOUT )); then break; fi
    sleep "$CADDY_RETRY_SLEEP"
    waited=$((waited + (CADDY_RETRY_SLEEP > 0 ? CADDY_RETRY_SLEEP : 1)))
  done
  printf '%s\n' "$out" | sed 's/^/  - /' >&2
  return 1
}

# Names the contract needs that the ADAPTED config (JSON) of a Caddyfile no
# longer has. Prints one per line; nothing means the contract holds.
#   caddy_dropped <adapted json>
caddy_dropped() {
  local json="$1" e name
  for e in "${CADDY_HEADERS[@]}"; do
    [[ "$json" == *"\"${e%%: *}\":[\"${e#*: }\"]"* ]] || echo "${e%%: *}"
  done
  for name in "${CADDY_HEADERS_PRESENT[@]}"; do
    [[ "$json" == *"\"${name}\":["* ]] || echo "$name"
  done
  for name in "${CADDY_HEADERS_ABSENT[@]}"; do
    grep -Eq -- "\"delete\":\[[^]]*\"${name}\"" <<<"$json" || echo "-$name"
  done
  [[ "$json" == *'"X-Frame-Options":["DENY"]'* ]] || echo "X-Frame-Options"
  # Any other X-Frame-Options value (SAMEORIGIN, ALLOW-FROM) set by Caddy would
  # widen what the app decides per request.
  if grep -o '"X-Frame-Options":\["[^"]*"\]' <<<"$json" | grep -qv '"X-Frame-Options":\["DENY"\]'; then
    echo "X-Frame-Options (only DENY may be set here)"
  fi
}

# Reload from a file, no restart, no dropped connection. Retried a few times:
# right after `compose up` the admin endpoint may not be listening yet.
#   caddy_reload <file> [caddyfile|json]   (json = a dump of the running config)
caddy_reload() {
  local file="$1" kind="${2:-caddyfile}" n
  local -a adapter=(--adapter caddyfile)
  if [[ "$kind" == json ]]; then adapter=(); fi
  for n in 1 2 3 4 5; do
    if caddy_exec reload --config - "${adapter[@]}" <"$file" >/dev/null 2>&1; then return 0; fi
    if (( n < 5 )); then sleep "$CADDY_RETRY_SLEEP"; fi
  done
  return 1
}

# Where a rollback goes, best first:
#   .caddyfile.loaded     the last Caddyfile this step loaded AND verified
#   .caddy-running.json   what Caddy was running just before the reload (a
#                         dump of its own admin endpoint), when there is no
#                         verified copy yet (first run)
#   .caddyfile.fallback   the Caddyfile of the commit deployed before this one,
#                         copied before the checkout; used only when the dump
#                         failed. It can equal the file being applied (the same
#                         commit deployed again), so it is the last resort.
caddy_seed_previous() {
  local fallback="$CADDY_STATE_DIR/.caddyfile.fallback"
  if [[ ! -f "$CADDY_STATE_DIR/.caddyfile.loaded" && -f "$APP_DIR/deploy/Caddyfile" ]]; then
    cp "$APP_DIR/deploy/Caddyfile" "$fallback" || log "caddy: could not keep the previous Caddyfile as a fallback copy"
  fi
}

# Put the best earlier config back, check the baseline, and fail the deploy.
#   caddy_rollback <host> <why>
caddy_rollback() {
  local host="$1" why="$2" dir="$CADDY_STATE_DIR" file="" kind=caddyfile
  printf 'ERROR: %s\n' "$why" >&2
  if [[ -f "$dir/.caddyfile.loaded" ]]; then file="$dir/.caddyfile.loaded"
  elif [[ -s "$dir/.caddy-running.json" ]]; then file="$dir/.caddy-running.json" kind=json
  elif [[ -f "$dir/.caddyfile.fallback" ]]; then file="$dir/.caddyfile.fallback"
  fi
  if [[ -z "$file" ]]; then
    die "there is no earlier config to restore; Caddy keeps what it was running unless the check above says otherwise. On the server: dc logs --tail 100 caddy"
  fi
  log "restoring the previous Caddy config (${file##*/})"
  if caddy_reload "$file" "$kind" && caddy_verify "$host" baseline; then
    die "the previous config is back and passes the baseline check; deploy/Caddyfile was NOT applied. Fix it and deploy again"
  fi
  die "the previous config could not be verified either (see the lines above: is Caddy or the app answering on 127.0.0.1:${CADDY_VERIFY_PORT}?). On the server: dc ps, dc logs --tail 100 caddy"
}

# The step. Runs after the worker steps, so a worker that fails to start ends
# the deploy before this point and the Caddyfile is not reloaded that time.
# Never leaves Caddy without a working config: the pinned hash, validate and
# the contract guard come before anything is loaded, reload is atomic (a config
# that fails to load leaves the running one in place), and the check after it
# decides whether the new file stays.
#   caddy_apply <host>
caddy_apply() {
  local host="$1" new="$APP_DIR/deploy/Caddyfile" dir="$CADDY_STATE_DIR"
  local loaded="$dir/.caddyfile.loaded" marker="$dir/.caddyfile.loaded.sha256" running="$dir/.caddy-running.json"
  local newsha oldsha=none adapted dropped n up=0 snap
  if [[ -L "$new" ]]; then die "caddy: deploy/Caddyfile is a symlink; refused, nothing was loaded"; fi
  if [[ ! -f "$new" ]]; then log "caddy: this commit has no deploy/Caddyfile; nothing to load"; return 0; fi
  # One copy, made once: the hash, validate, adapt, reload and the saved
  # rollback copy all use these very bytes, so the file cannot change between
  # being approved and being loaded. A symlink could point anywhere: refused.
  snap="$(mktemp "$dir/.caddyfile.XXXXXX")" || die "caddy: cannot create a temporary file in $dir"
  # shellcheck disable=SC2064  # expand $snap now
  trap "rm -f '$snap'" EXIT
  cp "$new" "$snap" || die "caddy: cannot copy deploy/Caddyfile"
  newsha="$(sha256sum "$snap" | cut -d' ' -f1)"
  if [[ "$newsha" != "$CADDYFILE_APPROVED_SHA256" ]]; then
    die "caddy: deploy/Caddyfile changed (${newsha:0:12}, approved ${CADDYFILE_APPROVED_SHA256:0:12}); NOT validated, NOT loaded, Caddy keeps its config. Review it, then update CADDYFILE_APPROVED_SHA256 in deploy/remote-deploy.sh in the same PR"
  fi
  if [[ -f "$marker" ]]; then oldsha="$(cat "$marker")"; fi
  # Reload is idempotent (Caddy answers "unchanged" for a config it already
  # runs) and the live check is the real test, so both always run; the hash
  # only says in the log whether the file moved.
  if [[ "$newsha" == "$oldsha" ]]; then
    log "caddy: approved Caddyfile unchanged since the last good load (${newsha:0:12})"
  else
    log "caddy: approved Caddyfile ${oldsha:0:12} -> ${newsha:0:12}"
  fi

  # Is the caddy service there at all? A stopped or restart-looping container
  # fails every exec below, and that must not read as the file being bad.
  for n in 1 2 3 4 5; do
    if compose exec -T caddy true </dev/null >/dev/null 2>&1; then up=1; break; fi
    if (( n < 5 )); then sleep "$CADDY_RETRY_SLEEP"; fi
  done
  (( up )) || die "caddy: cannot run commands in the caddy service (stopped or restarting?); the Caddyfile was not checked or loaded. On the server: dc ps, dc logs --tail 100 caddy"

  caddy_exec validate --config - --adapter caddyfile <"$snap" >/dev/null 2>&1 \
    || die "caddy: validate refused deploy/Caddyfile; nothing was loaded and Caddy keeps its config. On the server: dc exec -T caddy caddy validate --config - --adapter caddyfile < $new"
  adapted="$(caddy_exec adapt --config - --adapter caddyfile <"$snap" 2>/dev/null)" \
    || die "caddy: could not adapt deploy/Caddyfile; nothing was loaded"
  dropped="$(caddy_dropped "$adapted" | paste -sd, -)"
  if [[ -n "$dropped" ]]; then
    die "caddy: deploy/Caddyfile no longer sets: ${dropped}. Refused before loading; Caddy keeps its config. The list in deploy/remote-deploy.sh (CADDY_HEADERS) is the contract: change it, and tests/test_deploy_self_host.py, in the same PR"
  fi

  # What Caddy runs right now, for a rollback before anything verified exists.
  rm -f "$running"
  if [[ ! -f "$loaded" ]]; then
    if compose exec -T caddy wget -qO- http://localhost:2019/config/ </dev/null >"${running}.tmp" 2>/dev/null \
       && [[ -s "${running}.tmp" ]]; then
      mv -f "${running}.tmp" "$running"
    else
      rm -f "${running}.tmp"
    fi
  fi

  log "caddy: reloading (graceful, no restart)"
  caddy_reload "$snap" || caddy_rollback "$host" "caddy: reload failed; Caddy keeps the config it had"
  if ! caddy_verify "$host" full; then
    caddy_rollback "$host" "caddy: the headers Caddy sends with the new Caddyfile are wrong (above)"
  fi

  { mv -f "$snap" "$loaded" \
    && printf '%s\n' "$newsha" >"${marker}.tmp" && mv -f "${marker}.tmp" "$marker"; } \
    || die "caddy: the new Caddyfile is live and verified, but its copy in $dir could not be saved (disk? permissions?); a later rollback would use an older one"
  rm -f "$running"
  trap - EXIT
  log "caddy: loaded and verified (${newsha:0:12}): one DENY, one SAMEORIGIN for our own frame, /auth and /api DENY, baseline headers present"
}

# One of the small services (notify-worker, email-worker, operator-bot), switched by
# the presence of its section in the payload. Prints a state line as numbers
# only, and the names of known phrases found in its log, never the log text.
#   start_sender <service> <on|off> <env file> <GitHub variable> <words>
start_sender() {
  local svc="$1" state="$2" file="$3" var="$4" words="$5" cid sender_log
  if [[ "$state" == on ]]; then
    log "docker compose up -d --build --no-deps $svc"
    compose up -d --build --no-deps "$svc" \
      || die "$words did not start; on the server: dc logs --tail 100 $svc"
    compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' "$svc" || true
    if [[ "$WORKER_SETTLE_SECONDS" -gt 0 ]]; then sleep "$WORKER_SETTLE_SECONDS"; fi
    cid="$(compose ps -q "$svc" 2>/dev/null || true)"
    if [[ -n "$cid" ]]; then
      "$DOCKER" inspect -f "$svc after ${WORKER_SETTLE_SECONDS}s: state={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}" "$cid" || true
    fi
    sender_log="$(compose logs --no-color --tail 200 "$svc" 2>&1 || true)"
    echo "$svc log hints: $(hint_words "$sender_log" || true)"
  else
    compose rm --stop --force "$svc" >/dev/null 2>&1 || true
    rm -f "$file" "${file}.prev"
    log "$svc is off (GitHub variable $var is not 'on')"
  fi
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
  # The payload is the web lines, then up to four sections, each opened by its
  # marker line (once; a repeated marker is an unknown key and refused below).
  local -a web_lines=() worker_lines=() notify_lines=() email_lines=() operator_lines=()
  local worker=off notify=off email=off operator=off line cur=web
  for line in "${lines[@]}"; do
    if [[ "$worker" == off && "$line" == "$WORKER_MARKER" ]]; then
      worker=on cur=worker
      continue
    fi
    if [[ "$notify" == off && "$line" == "$NOTIFY_MARKER" ]]; then
      notify=on cur=notify
      continue
    fi
    if [[ "$email" == off && "$line" == "$EMAIL_MARKER" ]]; then
      email=on cur=email
      continue
    fi
    if [[ "$operator" == off && "$line" == "$OPERATOR_MARKER" ]]; then
      operator=on cur=operator
      continue
    fi
    case "$cur" in
      worker) worker_lines+=("$line") ;;
      notify) notify_lines+=("$line") ;;
      email) email_lines+=("$line") ;;
      operator) operator_lines+=("$line") ;;
      *) web_lines+=("$line") ;;
    esac
  done

  local example
  example="$(git show "${sha}:deploy/.env.web.example")" \
    || die "deploy/.env.web.example is missing at $sha"
  local -a problems=()
  local nkeys=0 web_keys=0 worker_keys=0 notify_keys=0 email_keys=0 operator_keys=0
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
  if [[ "$notify" == on ]]; then
    example="$(git show "${sha}:deploy/.env.notify.example" 2>/dev/null)" \
      || die "a notify env was sent, but deploy/.env.notify.example is missing at $sha"
    label="deploy/.env.notify.example" section=notify nkeys=0
    check_section "$example" "" "${NOTIFY_REQUIRED_KEYS[*]}" "${notify_lines[@]}"
    notify_keys=$nkeys
  fi
  if [[ "$email" == on ]]; then
    example="$(git show "${sha}:deploy/.env.email.example" 2>/dev/null)" \
      || die "an e-mail env was sent, but deploy/.env.email.example is missing at $sha"
    label="deploy/.env.email.example" section=email nkeys=0
    check_section "$example" "" "${EMAIL_REQUIRED_KEYS[*]}" "${email_lines[@]}"
    email_keys=$nkeys
  fi
  if [[ "$operator" == on ]]; then
    example="$(git show "${sha}:deploy/.env.operator.example" 2>/dev/null)" \
      || die "an operator-bot env was sent, but deploy/.env.operator.example is missing at $sha"
    label="deploy/.env.operator.example" section=operator nkeys=0
    check_section "$example" "" "${OPERATOR_REQUIRED_KEYS[*]}" "${operator_lines[@]}"
    operator_keys=$nkeys
  fi
  # The creative worker's switch is one of the worker keys (the repository
  # variable NIGHTSHIFT_CREATIVE_WORKER): exactly `on` starts it, anything
  # else (empty, off, a typo) leaves it off. No worker, no creative worker.
  local creative=off
  if [[ "$worker" == on ]]; then
    for line in "${worker_lines[@]}"; do
      if [[ "$line" == NIGHTSHIFT_CREATIVE_WORKER=on ]]; then creative=on; fi
    done
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
  if [[ "$notify" == on ]]; then
    write_env "$NOTIFY_ENV_FILE" "# Written by deploy/remote-deploy.sh from GitHub Actions (commit $sha)." "${notify_lines[@]}"
    log "wrote $NOTIFY_ENV_FILE ($notify_keys keys, mode 600)"
  fi
  if [[ "$email" == on ]]; then
    write_env "$EMAIL_ENV_FILE" "# Written by deploy/remote-deploy.sh from GitHub Actions (commit $sha)." "${email_lines[@]}"
    log "wrote $EMAIL_ENV_FILE ($email_keys keys, mode 600)"
  fi
  if [[ "$operator" == on ]]; then
    write_env "$OPERATOR_ENV_FILE" "# Written by deploy/remote-deploy.sh from GitHub Actions (commit $sha)." "${operator_lines[@]}"
    log "wrote $OPERATOR_ENV_FILE ($operator_keys keys, mode 600)"
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
  caddy_seed_previous
  git -c advice.detachedHead=false checkout --quiet -B main "$sha" \
    || die "git checkout $sha failed in $APP_DIR"
  log "checked out $sha"

  # ── 6. Build and start ─────────────────────────────────────────────────────
  log "docker compose up -d --build --remove-orphans web caddy"
  compose up -d --build --remove-orphans web caddy \
    || { web_diagnostics || true; die "docker compose up failed; on the server: dc ps, then dc logs web"; }

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
  # Status only, plus web_diagnostics on failure (numbers and fixed-list names).
  # Container logs stay on the server: this output is public, and an app log
  # line can carry a user's e-mail or a request path.
  compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' || true
  if [[ "$status" != healthy ]]; then
    web_diagnostics "$cid" || true
    die "web is ${status:-not reporting health} after ${waited}s; on the server: dc logs --tail 100 web"
  fi

  # ── 8. The worker ──────────────────────────────────────────────────────────
  # After web is healthy, so a long worker stop never delays the dashboard.
  if [[ "$worker" == on ]]; then
    log "docker compose up -d --build --no-deps worker"
    compose up -d --build --no-deps worker \
      || die "the worker did not start; on the server: dc logs --tail 100 worker"
    # The media library's ingest (migration 0038): same image, its own process.
    log "docker compose up -d --no-deps media-worker"
    compose up -d --no-deps media-worker \
      || die "the media worker did not start; on the server: dc logs --tail 100 media-worker"
    # The creative worker (0036): switched by the repository variable
    # NIGHTSHIFT_CREATIVE_WORKER, which travels as one line of the worker
    # section (it shares the worker's env file, so it only exists while the
    # worker is on). `on` starts it, or moves it onto the image just built;
    # anything else stops and removes it.
    local -a services=(worker media-worker)
    if [[ "$creative" == on ]]; then
      log "docker compose up -d --no-deps creative-worker"
      compose up -d --no-deps creative-worker \
        || die "the creative worker did not start; on the server: dc logs --tail 100 creative-worker"
      services+=(creative-worker)
    else
      compose rm --stop --force creative-worker >/dev/null 2>&1 || true
      log "creative-worker is off (GitHub variable NIGHTSHIFT_CREATIVE_WORKER is not 'on')"
    fi
    compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' "${services[@]}" || true
    # A container that dies right after start still reads "Up" in the line
    # above. Wait a moment, then print how each worker is doing: state, last
    # exit code, restart count, whether the kernel killed it for memory.
    # Numbers and a state word only, never log text: this output is public.
    if [[ "$WORKER_SETTLE_SECONDS" -gt 0 ]]; then sleep "$WORKER_SETTLE_SECONDS"; fi
    for svc in "${services[@]}"; do
      cid="$(compose ps -q "$svc" 2>/dev/null || true)"
      if [[ -n "$cid" ]]; then
        "$DOCKER" inspect -f "$svc after ${WORKER_SETTLE_SECONDS}s: state={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}" "$cid" || true
      fi
    done
    # Why does the media worker stop? Its exit code says only "2". Run its own
    # probe in its own configuration (same uid, env file, volumes): yes/no
    # checks and one HTTP status, nothing else. Only "probe:" lines are kept
    # (the output is public), and a probe that fails never fails the deploy.
    # No "probe:" line at all means the run itself failed: say so with the exit
    # code and, if there is one, only the name of the exception class.
    probe_out="$(compose run --rm --no-deps -T media-worker python tools/media_worker.py --probe 2>&1)" \
      && probe_rc=0 || probe_rc=$?
    if ! printf '%s\n' "$probe_out" | grep '^probe: '; then
      probe_err="$(printf '%s\n' "$probe_out" | grep -oE '^[A-Za-z_.]*(Error|Exception)\b' | tail -n 1 || true)"
      echo "probe: no result exit=${probe_rc} error=${probe_err:-none}"
      # Which known phrases appear in the output? The phrases come from this
      # list, never from the output, so no value, path or message gets out.
      probe_hints="$(hint_words "$probe_out")"
      echo "probe: output_hints=${probe_hints:-none}"
    fi
    # The same question for the media worker's own log: which known phrases
    # does its recent output contain (why it exits with 2)?
    media_log="$(compose logs --no-color --tail 200 media-worker 2>&1 || true)"
    echo "media-worker log hints: $(hint_words "$media_log" || true)"
    if [[ "$creative" == on ]]; then
      creative_log="$(compose logs --no-color --tail 200 creative-worker 2>&1 || true)"
      echo "creative-worker log hints: $(hint_words "$creative_log" || true)"
    fi
  else
    # Off: no container, and no copy of the bot's keys left on the disk.
    compose rm --stop --force media-worker >/dev/null 2>&1 || true
    compose rm --stop --force worker >/dev/null 2>&1 || true
    compose rm --stop --force creative-worker >/dev/null 2>&1 || true
    rm -f "$WORKER_ENV_FILE" "${WORKER_ENV_FILE}.prev"
    log "worker is off (GitHub variable NIGHTSHIFT_WORKER is not 'on'); creative-worker is off with it"
  fi

  # ── 8b. The customer senders and the operator bot ──────────────────────────
  # Each follows its own section, whether or not the pipeline worker is on:
  # present = started, or moved onto the image just built; absent = stopped,
  # removed, and its env file (with the token or the mail key) deleted.
  # A start that fails fails the deploy, like the workers above.
  start_sender notify-worker "$notify" "$NOTIFY_ENV_FILE" NIGHTSHIFT_NOTIFY_WORKER "the notify worker"
  start_sender email-worker "$email" "$EMAIL_ENV_FILE" NIGHTSHIFT_EMAIL_WORKER "the e-mail worker"
  # The operator bot (Telegram long-poll + alert pass). While it runs, the two
  # GitHub workflows skip their work (they test the same variable), so Telegram
  # never sees two getUpdates consumers; off, it is removed and they run as before.
  start_sender operator-bot "$operator" "$OPERATOR_ENV_FILE" NIGHTSHIFT_OPERATOR_BOT "the operator bot"

  # ── 9. Caddy ───────────────────────────────────────────────────────────────
  # Last, so a proxy problem never holds back the worker; it still fails the
  # deploy (non-zero) so it is seen.
  local domain=""
  for line in "${web_lines[@]}"; do
    if [[ "$line" == DOMAIN=* ]]; then domain="${line#DOMAIN=}"; fi
  done
  caddy_apply "${CADDY_VERIFY_HOST:-$domain}"

  # Each build leaves the previous image dangling; a few of these a week fill
  # a disk. Only dangling images: nothing a container still uses.
  "$DOCKER" image prune -f >/dev/null 2>&1 || true

  log "deployed $sha; web is healthy; worker $worker; creative-worker $creative; notify-worker $notify; email-worker $email; operator-bot $operator"
}

main "$@"
exit
