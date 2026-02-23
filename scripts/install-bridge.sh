#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
STATE_DIR="/etc/patze-bridge"
CONTROL_PLANE_URL="http://localhost:19700"
TOKEN=""
EXPIRES_IN=""
OPENCLAW_HOME="${HOME}/.openclaw"
SERVICE_NAME="patze-bridge"
USER_MODE=false
SUDO_PASS_MODE=false

print_usage() {
  cat <<'EOF'
Usage:
  install-bridge.sh --token <token> [options]

Options:
  --url <url>             Control plane base URL (default: http://localhost:19700)
  --token <token>         Required auth token for Patze Control
  --expires-in <duration> Optional token lifetime (example: 24h, 7d)
  --state-dir <path>      State/config dir (default: /etc/patze-bridge)
  --openclaw-home <path>  OpenClaw home dir (default: ~/.openclaw)
  --user-mode             Install without sudo (user-level systemd + local prefix)
  --sudo-pass             Read sudo password from stdin for non-interactive sudo -S
  --help                  Show this help
EOF
}

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --url)
        [ $# -ge 2 ] || fail "Missing value for --url"
        CONTROL_PLANE_URL="$2"
        shift 2
        ;;
      --token)
        [ $# -ge 2 ] || fail "Missing value for --token"
        TOKEN="$2"
        shift 2
        ;;
      --expires-in)
        [ $# -ge 2 ] || fail "Missing value for --expires-in"
        EXPIRES_IN="$2"
        shift 2
        ;;
      --state-dir)
        [ $# -ge 2 ] || fail "Missing value for --state-dir"
        STATE_DIR="$2"
        shift 2
        ;;
      --openclaw-home)
        [ $# -ge 2 ] || fail "Missing value for --openclaw-home"
        OPENCLAW_HOME="$2"
        shift 2
        ;;
      --user-mode)
        USER_MODE=true
        shift
        ;;
      --sudo-pass)
        SUDO_PASS_MODE=true
        shift
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
  done
}

require_node_18() {
  has_command node || fail "Node.js not found. Please install Node.js 18+ first."
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [ "${major}" -lt 18 ]; then
    fail "Node.js ${major} detected. Node.js 18+ is required."
  fi
}

SUDO_PASSWORD=""

resolve_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    echo ""
    return
  fi

  if [ "$USER_MODE" = true ]; then
    echo ""
    return
  fi

  if [ "$SUDO_PASS_MODE" = true ]; then
    read -r SUDO_PASSWORD
    echo "sudo -S"
    return
  fi

  if has_command sudo; then
    echo "sudo"
    return
  fi

  fail "This script needs root access for systemd and /etc. Run as root or install sudo."
}

run_sudo() {
  local sudo_cmd="$1"
  shift
  if [ "$sudo_cmd" = "sudo -S" ] && [ -n "$SUDO_PASSWORD" ]; then
    printf '%s\n' "$SUDO_PASSWORD" | sudo -S "$@" 2>/dev/null
  elif [ -n "$sudo_cmd" ]; then
    $sudo_cmd "$@"
  else
    "$@"
  fi
}

compute_expires_at() {
  local duration="$1"
  if [ -z "$duration" ]; then
    echo ""
    return
  fi

  if has_command date; then
    local value
    value="$(date -u -d "+${duration}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || true)"
    if [ -n "$value" ]; then
      echo "$value"
      return
    fi
  fi

  if has_command python3; then
    python3 - "$duration" <<'PY'
import re
import sys
from datetime import datetime, timedelta, timezone

raw = sys.argv[1]
match = re.fullmatch(r"(\d+)([smhdw])", raw)
if not match:
    raise SystemExit(1)
amount = int(match.group(1))
unit = match.group(2)
seconds = {
    "s": amount,
    "m": amount * 60,
    "h": amount * 3600,
    "d": amount * 86400,
    "w": amount * 7 * 86400,
}[unit]
expires = datetime.now(timezone.utc) + timedelta(seconds=seconds)
print(expires.strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
    return
  fi

  fail "Could not parse --expires-in '${duration}'. Install python3 or use GNU date."
}

ensure_machine_id() {
  local sudo_cmd="$1"
  local machine_id_file="${STATE_DIR}/machine-id"
  if run_sudo "$sudo_cmd" test -f "$machine_id_file"; then
    run_sudo "$sudo_cmd" cat "$machine_id_file"
    return
  fi

  local machine_id
  if [ -r /proc/sys/kernel/random/uuid ]; then
    machine_id="$(cat /proc/sys/kernel/random/uuid)"
  else
    machine_id="$(node -e 'console.log(crypto.randomUUID())')"
  fi
  machine_id="machine_${machine_id}"
  run_sudo "$sudo_cmd" mkdir -p "$STATE_DIR"
  printf '%s\n' "$machine_id" | run_sudo "$sudo_cmd" tee "$machine_id_file" >/dev/null
  printf '%s\n' "$machine_id"
}

write_config() {
  local sudo_cmd="$1"
  local machine_id="$2"
  local expires_at="$3"
  local config_file="${STATE_DIR}/config.env"
  local offset_file="${STATE_DIR}/cron-offsets.json"

  run_sudo "$sudo_cmd" mkdir -p "$STATE_DIR"
  {
    printf 'CONTROL_PLANE_BASE_URL=%s\n' "$CONTROL_PLANE_URL"
    printf 'CONTROL_PLANE_TOKEN=%s\n' "$TOKEN"
    printf 'MACHINE_ID=%s\n' "$machine_id"
    printf 'MACHINE_ID_FILE=%s\n' "${STATE_DIR}/machine-id"
    printf 'MACHINE_LABEL=%s\n' "$(hostname)"
    printf 'MACHINE_KIND=vps\n'
    printf 'OPENCLAW_BRIDGE_SOURCE=files\n'
    printf 'OPENCLAW_HOME=%s\n' "$OPENCLAW_HOME"
    printf 'OPENCLAW_SESSION_DIR=%s\n' "${OPENCLAW_HOME}/sessions"
    printf 'HEARTBEAT_INTERVAL_MS=5000\n'
    printf 'CRON_SYNC_PATH=/openclaw/bridge/cron-sync\n'
    printf 'CRON_SYNC_INTERVAL_MS=30000\n'
    printf 'BRIDGE_STATE_DIR=%s\n' "$STATE_DIR"
    printf 'BRIDGE_CRON_OFFSET_FILE=%s\n' "$offset_file"
    if [ -n "$expires_at" ]; then
      printf 'TOKEN_EXPIRES_AT=%s\n' "$expires_at"
    fi
  } | run_sudo "$sudo_cmd" tee "$config_file" >/dev/null
}

write_system_service() {
  local sudo_cmd="$1"
  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"
  cat <<EOF | run_sudo "$sudo_cmd" tee "$service_file" >/dev/null
[Unit]
Description=Patze OpenClaw Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${STATE_DIR}/config.env
ExecStart=/usr/bin/env openclaw-bridge
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
}

write_user_service() {
  local service_dir="${HOME}/.config/systemd/user"
  local service_file="${service_dir}/${SERVICE_NAME}.service"
  local bridge_bin="${HOME}/patze-bridge/bin/openclaw-bridge"
  mkdir -p "$service_dir"
  cat <<EOF > "$service_file"
[Unit]
Description=Patze OpenClaw Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${STATE_DIR}/config.env
ExecStart=${bridge_bin}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
}

main() {
  parse_args "$@"
  [ -n "$TOKEN" ] || fail "--token is required"
  require_node_18

  if [ "$USER_MODE" = true ]; then
    STATE_DIR="${HOME}/.config/patze-bridge"
    log "User-mode install (no sudo required)."
  fi

  local sudo_cmd
  sudo_cmd="$(resolve_sudo)"
  local expires_at
  expires_at="$(compute_expires_at "$EXPIRES_IN")"

  if [ "$USER_MODE" = true ]; then
    log "Installing @patze/openclaw-bridge to ~/patze-bridge..."
    npm install --prefix "${HOME}/patze-bridge" @patze/openclaw-bridge
  else
    log "Installing @patze/openclaw-bridge globally..."
    run_sudo "$sudo_cmd" npm install -g @patze/openclaw-bridge
  fi

  local machine_id
  machine_id="$(ensure_machine_id "$sudo_cmd")"
  write_config "$sudo_cmd" "$machine_id" "$expires_at"

  if [ "$USER_MODE" = true ]; then
    write_user_service
    log "Reloading and starting user systemd service..."
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVICE_NAME"
    systemctl --user is-active --quiet "$SERVICE_NAME" || fail "User service failed to start."
    if has_command loginctl; then
      loginctl enable-linger "$(whoami)" 2>/dev/null || true
    fi
  else
    write_system_service "$sudo_cmd"
    log "Reloading and starting systemd service..."
    run_sudo "$sudo_cmd" systemctl daemon-reload
    run_sudo "$sudo_cmd" systemctl enable --now "$SERVICE_NAME"
    run_sudo "$sudo_cmd" systemctl is-active --quiet "$SERVICE_NAME" || fail "Service failed to start."
  fi

  SUDO_PASSWORD=""

  log "Bridge installed successfully."
  log "Machine ID: $machine_id"
  log "Control plane URL: $CONTROL_PLANE_URL"
  if [ -n "$expires_at" ]; then
    log "Token expires at: $expires_at"
  fi
}

main "$@"
