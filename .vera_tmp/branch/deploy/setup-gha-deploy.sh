#!/usr/bin/env bash
# Nightshift — one-time setup of the automatic deploy key (GitHub Actions -> server).
# Step by step (Uzbek): docs/DEPLOY_AX42.md, "Avtomatik deploy".
#
#   Run ONCE on the server, as the admin user (nightshift), not root:
#     bash /opt/nightshift/app/deploy/setup-gha-deploy.sh <server-ip>
#   After DEPLOY_SSH_KEY is saved in GitHub, delete the local private key:
#     bash /opt/nightshift/app/deploy/setup-gha-deploy.sh --delete-private-key
#   To replace the key (lost, leaked, or just old):
#     bash /opt/nightshift/app/deploy/setup-gha-deploy.sh --rotate <server-ip>
#
# What it does
#   1. creates a dedicated ed25519 key, ~/.ssh/gha_deploy, used for nothing else;
#   2. adds its public half to ~/.ssh/authorized_keys pinned to one forced
#      command, deploy/remote-deploy.sh, with forwarding, pty and user rc off —
#      so the key opens no shell, whoever holds it (safe to run again: the line
#      is written once, and corrected if an older copy differs);
#   3. prints what goes into GitHub -> Settings -> Environments -> production:
#      the private key (secret DEPLOY_SSH_KEY), this server's host key line
#      (secret DEPLOY_KNOWN_HOSTS), and DEPLOY_HOST / DEPLOY_USER (variables,
#      needed only when they differ from the workflow's defaults).
#
# The private key is printed only to an interactive terminal: piped into a
# file or a log it would outlive the paste, which is the one thing it must not.
#
# Overridable for tests (tests/test_deploy_gha.py); production uses the defaults.
#   NIGHTSHIFT_SSH_DIR         (~/.ssh)
#   NIGHTSHIFT_HOST_KEY_PUB    (/etc/ssh/ssh_host_ed25519_key.pub)
#   NIGHTSHIFT_DEPLOY_COMMAND  (/opt/nightshift/app/deploy/remote-deploy.sh)
#   NIGHTSHIFT_ALLOW_ROOT=1    run as root anyway (tests in a root container)

set -euo pipefail

SSH_DIR="${NIGHTSHIFT_SSH_DIR:-$HOME/.ssh}"
HOST_KEY_PUB="${NIGHTSHIFT_HOST_KEY_PUB:-/etc/ssh/ssh_host_ed25519_key.pub}"
DEPLOY_COMMAND="${NIGHTSHIFT_DEPLOY_COMMAND:-/opt/nightshift/app/deploy/remote-deploy.sh}"
KEY="$SSH_DIR/gha_deploy"
AUTH="$SSH_DIR/authorized_keys"
KEY_COMMENT="github-actions-deploy@nightshift"
OPTIONS="command=\"$DEPLOY_COMMAND\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc"

log()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

main() {
  local delete_only=0 rotate=0 ip=""
  while (( $# > 0 )); do
    case "$1" in
      --delete-private-key) delete_only=1 ;;
      --rotate) rotate=1 ;;
      -h|--help) usage ;;
      -*) die "unknown option $1" ;;
      *) [[ -z "$ip" ]] || die "one server address only"; ip="$1" ;;
    esac
    shift
  done

  # Root's authorized_keys would be the wrong file: root SSH login is off on
  # this server, and the deploy runs as the admin user.
  if [[ "$(id -u)" == 0 && "${NIGHTSHIFT_ALLOW_ROOT:-}" != 1 ]]; then
    die "run this as the admin user (nightshift), not root: ssh nightshift@<server-ip>"
  fi

  if (( delete_only )); then
    if [[ -f "$KEY" ]]; then
      shred -u "$KEY" 2>/dev/null || rm -f "$KEY"
      log "deleted $KEY (the public half and the authorized_keys line stay)"
    else
      log "$KEY is already gone; nothing to delete"
    fi
    exit 0
  fi

  [[ -n "$ip" ]] || die "give the server's public IP: bash $0 168.119.142.178"
  # An IPv4 address or a DNS name: what the workflow will connect to, and the
  # name the pinned host key is recorded under.
  [[ "$ip" =~ ^[A-Za-z0-9.-]+$ ]] || die "'$ip' is not an IPv4 address or host name"

  [[ -x "$DEPLOY_COMMAND" ]] \
    || die "$DEPLOY_COMMAND is missing or not executable; first: git -C /opt/nightshift/app pull --ff-only"
  [[ -r "$HOST_KEY_PUB" ]] || die "cannot read this server's host key $HOST_KEY_PUB"
  command -v ssh-keygen >/dev/null || die "ssh-keygen not found (package openssh-client)"

  umask 077
  install -d -m 700 "$SSH_DIR"

  # ── 1. The key ─────────────────────────────────────────────────────────────
  if (( rotate )) && [[ -f "$KEY.pub" ]]; then
    log "rotating: the old key stops working as soon as this finishes"
    remove_auth_line "$(key_blob "$KEY.pub")"
    rm -f "$KEY" "$KEY.pub"
  fi
  if [[ ! -f "$KEY.pub" ]]; then
    log "creating $KEY (ed25519, no passphrase: Actions has nobody to type one)"
    rm -f "$KEY"
    ssh-keygen -q -t ed25519 -N "" -C "$KEY_COMMENT" -f "$KEY" >/dev/null
  else
    log "$KEY.pub already exists; keeping it"
  fi

  # ── 2. authorized_keys, restricted to the forced command ───────────────────
  local blob line
  blob="$(key_blob "$KEY.pub")"
  [[ -n "$blob" ]] || die "$KEY.pub is not a public key"
  line="$OPTIONS $(cut -d' ' -f1,2 "$KEY.pub") $KEY_COMMENT"
  # Already right only if the restricted line is the ONLY one with this key:
  # a second, bare copy (pasted by hand) would open a shell with it.
  if [[ -f "$AUTH" ]] && grep -qxF -- "$line" "$AUTH" \
     && [[ "$(grep -cF -- "$blob" "$AUTH")" == 1 ]]; then
    log "authorized_keys already has the restricted deploy key"
  else
    # Drops any other line carrying this key (an older or unrestricted copy),
    # then appends the restricted one. Every other key is left as it was.
    remove_auth_line "$blob"
    printf '%s\n' "$line" >>"$AUTH"
    chmod 600 "$AUTH"
    log "added the deploy key to $AUTH, forced command: $DEPLOY_COMMAND"
  fi

  # ── 3. What to paste into GitHub ───────────────────────────────────────────
  local host_line
  host_line="$ip $(cut -d' ' -f1,2 "$HOST_KEY_PUB")"
  [[ "$host_line" == "$ip ssh-ed25519 "* ]] || die "$HOST_KEY_PUB is not an ed25519 host key"

  cat <<EOF

==> GitHub -> Settings -> Environments -> production

    Variables DEPLOY_HOST / DEPLOY_USER: the workflow defaults to
    168.119.142.178 / nightshift. Add them only if these differ:
      DEPLOY_HOST          $ip
      DEPLOY_USER          $(id -un)

    Secret DEPLOY_KNOWN_HOSTS (this whole line; a host key is not itself
    secret, it is what lets the workflow refuse an impostor server):

$host_line

EOF

  if [[ ! -f "$KEY" ]]; then
    info "Secret DEPLOY_SSH_KEY: the private key is no longer on this server."
    info "If GitHub already has it, you are done. If it was lost, run:"
    info "  bash $0 --rotate $ip"
    exit 0
  fi
  if [[ ! -t 1 ]]; then
    info "Secret DEPLOY_SSH_KEY: not printed, because this output is not a terminal"
    info "(it would end up in a file or log). Run the script in an SSH session, or"
    info "show it once with:  cat $KEY"
    exit 0
  fi

  cat <<EOF
!!  Secret DEPLOY_SSH_KEY — the PRIVATE key. Copy everything between the lines,
!!  including the BEGIN and END lines, into the GitHub secret DEPLOY_SSH_KEY and
!!  NOWHERE else: not a chat, not a note, not an issue, not a screenshot.
------------------------------------------------------------------------------
EOF
  cat "$KEY"
  cat <<EOF
------------------------------------------------------------------------------
!!  Once it is saved in GitHub, delete it from this server:
!!    bash $0 --delete-private-key
!!  GitHub keeps the only copy; if it is ever lost, run --rotate for a new key.
EOF
}

# The base64 middle of a public key line: what identifies the key whatever
# options or comment surround it.
key_blob() { awk 'NF >= 2 { print $2; exit }' "$1"; }

remove_auth_line() {
  local blob="$1" tmp
  [[ -f "$AUTH" && -n "$blob" ]] || return 0
  tmp="$(mktemp "$AUTH.XXXXXX")"
  grep -vF -- "$blob" "$AUTH" >"$tmp" || true
  chmod 600 "$tmp"
  mv -f "$tmp" "$AUTH"
}

main "$@"
