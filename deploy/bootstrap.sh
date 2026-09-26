#!/usr/bin/env bash
# Nightshift — one-time hardening and setup of a fresh Ubuntu 24.04 server
# (Hetzner AX42). Step by step, in Uzbek: docs/DEPLOY_AX42.md
#
#   Run as root, once:   bash bootstrap.sh [admin-user]      (default: nightshift)
#
# Safe to run again: every step checks before it changes anything.
#
# What it does
#   1. apt upgrade + base packages
#   2. an admin user with sudo (and docker) rights, SSH key copied from root
#   3. ufw: only 22/tcp, 80/tcp, 443 (tcp+udp) in
#   4. fail2ban on sshd
#   5. unattended security upgrades
#   6. Docker Engine + compose plugin from Docker's own apt repository
#   7. swap and time sync sanity
#   8. SSH: key-only, no root login — LAST, and only if the admin user can
#      actually log in with a key and use sudo. Otherwise it is skipped and the
#      script tells you what is missing: locking yourself out of a dedicated
#      server means a rescue-system boot to get back in.
#
# This script never reads, writes or prints a secret. It only ever reports
# how many SSH keys it found, never the keys themselves.
#
# Environment knobs (all optional):
#   ADMIN_SUDO_NOPASSWD=1   let the admin sudo without a password instead of
#                           being asked to set one
#   SWAP_SIZE=4G            size of /swapfile when the server has no swap at all
#   ALLOW_UNSUPPORTED=1     run on something other than Ubuntu 24.04

set -Eeuo pipefail

ADMIN_USER="${1:-${ADMIN_USER:-nightshift}}"
SWAP_SIZE="${SWAP_SIZE:-4G}"
APP_DIR=/opt/nightshift

export DEBIAN_FRONTEND=noninteractive
# 24.04's needrestart otherwise stops apt with an interactive prompt.
export NEEDRESTART_MODE=a

log()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\n!!  %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

trap 'die "failed at line $LINENO (exit $?). Fix the cause and re-run; finished steps are skipped."' ERR

# ── 0. Preconditions ─────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "run as root (e.g. sudo bash $0)"
[[ "$ADMIN_USER" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "invalid user name: $ADMIN_USER"
[[ "$ADMIN_USER" != root ]] || die "the admin user must not be root"

# shellcheck source=/dev/null
. /etc/os-release
if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != "24.04" ]]; then
  [[ "${ALLOW_UNSUPPORTED:-0}" == 1 ]] || die "expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}. Set ALLOW_UNSUPPORTED=1 to continue anyway."
  warn "not Ubuntu 24.04 (${PRETTY_NAME:-unknown}) — continuing because ALLOW_UNSUPPORTED=1"
fi

# Write a file only when its content differs; return 0 if it changed.
write_if_changed() {
  local path="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
  install -m "$mode" -o root -g root "$tmp" "$path"
  rm -f "$tmp"
  return 0
}

# ── 1. Packages ──────────────────────────────────────────────────────────────
log "Updating packages"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install \
  ca-certificates curl gnupg git ufw fail2ban python3-systemd \
  unattended-upgrades apt-listchanges systemd-timesyncd

# ── 2. Admin user ────────────────────────────────────────────────────────────
log "Admin user: $ADMIN_USER"
if id -u "$ADMIN_USER" >/dev/null 2>&1; then
  info "exists"
else
  adduser --disabled-password --gecos "" "$ADMIN_USER"
  info "created"
fi
usermod -aG sudo "$ADMIN_USER"

ADMIN_HOME="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
ADMIN_KEYS="$ADMIN_HOME/.ssh/authorized_keys"
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "$ADMIN_HOME/.ssh"

# Hetzner puts the key chosen at order time into root's authorized_keys. Copy
# it over only when the admin has none yet — never overwrite keys added since.
if [[ ! -s "$ADMIN_KEYS" && -s /root/.ssh/authorized_keys ]]; then
  install -m 600 -o "$ADMIN_USER" -g "$ADMIN_USER" /root/.ssh/authorized_keys "$ADMIN_KEYS"
  info "copied root's authorized SSH keys to $ADMIN_USER"
fi
if [[ -f "$ADMIN_KEYS" ]]; then
  chown "$ADMIN_USER:$ADMIN_USER" "$ADMIN_KEYS"
  chmod 600 "$ADMIN_KEYS"
fi

# Count keys that ssh-keygen accepts; a file of blank lines or typos is no key.
count_valid_keys() {
  local file="$1"
  [[ -s "$file" ]] || { echo 0; return; }
  ssh-keygen -l -f "$file" 2>/dev/null | grep -c . || true
}
KEY_COUNT="$(count_valid_keys "$ADMIN_KEYS")"
info "valid SSH keys for $ADMIN_USER: $KEY_COUNT"

# sudo needs either a password or an explicit NOPASSWD rule; with neither the
# admin can log in but never become root, and disabling root login would leave
# nobody who can.
SUDOERS_FILE="/etc/sudoers.d/90-nightshift-$ADMIN_USER"
if [[ "${ADMIN_SUDO_NOPASSWD:-0}" == 1 ]]; then
  tmp="$(mktemp)"
  printf '%s ALL=(ALL:ALL) NOPASSWD:ALL\n' "$ADMIN_USER" >"$tmp"
  visudo -cf "$tmp" >/dev/null || die "generated sudoers rule failed validation"
  install -m 440 -o root -g root "$tmp" "$SUDOERS_FILE"
  rm -f "$tmp"
  info "passwordless sudo enabled for $ADMIN_USER"
fi

admin_has_password() {
  [[ "$(passwd -S "$ADMIN_USER" 2>/dev/null | awk '{print $2}')" == P ]]
}
if ! admin_has_password && [[ ! -f "$SUDOERS_FILE" ]]; then
  if [[ -t 0 ]]; then
    log "Set a sudo password for $ADMIN_USER (SSH login stays key-only; this is for sudo)"
    until passwd "$ADMIN_USER"; do warn "try again"; done
  else
    warn "$ADMIN_USER has no password and no NOPASSWD rule, and there is no terminal to ask for one."
  fi
fi
admin_can_sudo() { admin_has_password || [[ -f "$SUDOERS_FILE" ]]; }

install -d -m 750 -o "$ADMIN_USER" -g "$ADMIN_USER" "$APP_DIR"

# ── 3. Firewall ──────────────────────────────────────────────────────────────
log "Firewall (ufw)"
# SSH is allowed BEFORE enabling, or the current session is cut off.
ufw allow 22/tcp comment 'ssh' >/dev/null
ufw allow 80/tcp comment 'http (ACME + redirect)' >/dev/null
ufw allow 443 comment 'https + http/3' >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null
info "$(ufw status | sed -n 1p)"
# Note: ports published by Docker bypass ufw. That is why the compose file
# publishes only Caddy's 80/443 and nothing else.

# ── 4. fail2ban ──────────────────────────────────────────────────────────────
log "fail2ban"
if write_if_changed /etc/fail2ban/jail.d/nightshift-sshd.local 644 <<'EOF'
# Managed by nightshift deploy/bootstrap.sh
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
then
  info "jail written"
fi
systemctl enable fail2ban >/dev/null 2>&1
systemctl restart fail2ban
info "fail2ban $(systemctl is-active fail2ban)"

# ── 5. Unattended security upgrades ──────────────────────────────────────────
log "Unattended upgrades"
write_if_changed /etc/apt/apt.conf.d/20auto-upgrades 644 <<'EOF' || true
// Managed by nightshift deploy/bootstrap.sh
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# Kernel updates need a reboot. It is left to a human (see the runbook) so a
# render is never killed mid-way by an automatic 3 a.m. restart.
write_if_changed /etc/apt/apt.conf.d/52nightshift-unattended 644 <<'EOF' || true
// Managed by nightshift deploy/bootstrap.sh
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1
info "unattended-upgrades $(systemctl is-active unattended-upgrades)"

# ── 6. Docker Engine from Docker's apt repository ────────────────────────────
log "Docker Engine"
# Ubuntu's own docker.io / podman shims conflict with the official packages.
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  if dpkg -s "$pkg" >/dev/null 2>&1; then
    apt-get -y -q remove "$pkg"
  fi
done
install -m 0755 -d /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
fi
chmod a+r /etc/apt/keyrings/docker.asc
write_if_changed /etc/apt/sources.list.d/docker.list 644 <<EOF || true
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable
EOF
apt-get update -q
apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Rotate container logs by default, for anything started outside compose too.
# An existing daemon.json is someone's deliberate config: leave it alone.
DOCKER_RESTART=0
if [[ ! -e /etc/docker/daemon.json ]]; then
  install -d -m 755 /etc/docker
  write_if_changed /etc/docker/daemon.json 644 <<'EOF' && DOCKER_RESTART=1
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}
EOF
fi
systemctl enable --now docker >/dev/null 2>&1
if [[ $DOCKER_RESTART == 1 ]]; then systemctl restart docker; fi
# Membership in `docker` is root-equivalent; the admin already has sudo, so it
# adds convenience (no sudo before every compose command), not power.
usermod -aG docker "$ADMIN_USER"
info "$(docker --version)"
info "$(docker compose version)"

# ── 7. Swap and time ─────────────────────────────────────────────────────────
log "Swap"
if [[ -n "$(swapon --show --noheadings)" ]]; then
  info "swap present: $(swapon --show --noheadings --bytes | awk '{s+=$3} END {printf "%.1f GiB", s/1073741824}')"
elif [[ -e /swapfile ]]; then
  warn "/swapfile exists but is not active — left alone; check it by hand"
else
  fstype="$(findmnt -no FSTYPE /)"
  if [[ "$fstype" == ext4 || "$fstype" == xfs ]]; then
    fallocate -l "$SWAP_SIZE" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    info "created /swapfile ($SWAP_SIZE)"
  else
    warn "no swap, and / is $fstype — not creating a swapfile automatically"
  fi
fi
# With 64 GB of RAM swap is a safety net, not working memory.
write_if_changed /etc/sysctl.d/90-nightshift.conf 644 <<'EOF' && sysctl -q --system || true
# Managed by nightshift deploy/bootstrap.sh
vm.swappiness = 10
EOF

log "Time sync"
timedatectl set-ntp true
info "timezone: $(timedatectl show -p Timezone --value), NTP synchronized: $(timedatectl show -p NTPSynchronized --value)"

# ── 8. SSH hardening (last, and guarded) ─────────────────────────────────────
log "SSH hardening"
SSHD_DROPIN=/etc/ssh/sshd_config.d/00-nightshift.conf
if [[ "$KEY_COUNT" -lt 1 ]]; then
  warn "SKIPPED: $ADMIN_USER has no valid key in $ADMIN_KEYS.
    Password login stays ON so you are not locked out. Add your PUBLIC key
    (the .pub file) to that file, then re-run this script."
  SSH_HARDENED=0
else
  if admin_can_sudo; then
    ROOT_LOGIN=no
  else
    # Key-only root login is Ubuntu's default and keeps a way to become root.
    ROOT_LOGIN=prohibit-password
    warn "$ADMIN_USER cannot sudo yet (no password, no NOPASSWD rule), so root
    login stays allowed with a key. Run 'passwd $ADMIN_USER' and re-run to close it."
  fi
  # 00- so it sorts first: sshd keeps the FIRST value it reads, and cloud-init
  # or installimage drop-ins (50-*) would otherwise win.
  if write_if_changed "$SSHD_DROPIN" 644 <<EOF
# Managed by nightshift deploy/bootstrap.sh
PermitRootLogin $ROOT_LOGIN
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitEmptyPasswords no
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
  then
    if sshd -t; then
      systemctl reload ssh 2>/dev/null || systemctl restart ssh
      info "applied: key-only login, PermitRootLogin $ROOT_LOGIN"
    else
      rm -f "$SSHD_DROPIN"
      die "sshd rejected the new config; it was removed and nothing changed"
    fi
  else
    info "already applied"
  fi
  SSH_HARDENED=1
fi

# ── Done ─────────────────────────────────────────────────────────────────────
log "Done"
info "Admin user:  $ADMIN_USER   (sudo, docker)"
info "App dir:     $APP_DIR"
if [[ $SSH_HARDENED == 1 ]]; then
  info "IMPORTANT: keep this session open and, in a NEW terminal, check that"
  info "  ssh $ADMIN_USER@<server-ip>   works, and that   sudo -v   works there."
fi
if [[ -f /var/run/reboot-required ]]; then
  info "A reboot is required to finish updates:  sudo reboot"
fi
