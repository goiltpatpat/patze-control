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
SKIP_NPM=false
BUNDLE_PATH=""
VERIFY_BUNDLE_SHA256=""
INSTALL_REPORT_PATH=""
INSTALL_SUDO_CMD=""
BACKUP_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)"
LAST_CONFIG_BACKUP=""
LAST_SERVICE_BACKUP=""
INSTALL_STATUS="started"
INSTALL_ERROR=""
INSTALL_MACHINE_ID=""
INSTALL_EXPIRES_AT=""

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
  --skip-npm              Skip npm install (bundle already uploaded via SFTP)
  --bundle-path <path>    Path to pre-uploaded bridge bundle on remote host
  --verify-bundle-sha256 <hex>  Verify SHA-256 of bundle before install
  --install-report-path <path>   Structured install report output path
  --help                  Show this help
EOF
}

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  INSTALL_STATUS="failed"
  INSTALL_ERROR="$*"
  write_install_report || true
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
      --skip-npm)
        SKIP_NPM=true
        shift
        ;;
      --bundle-path)
        [ $# -ge 2 ] || fail "Missing value for --bundle-path"
        BUNDLE_PATH="$2"
        SKIP_NPM=true
        shift 2
        ;;
      --verify-bundle-sha256)
        [ $# -ge 2 ] || fail "Missing value for --verify-bundle-sha256"
        VERIFY_BUNDLE_SHA256="$2"
        shift 2
        ;;
      --install-report-path)
        [ $# -ge 2 ] || fail "Missing value for --install-report-path"
        INSTALL_REPORT_PATH="$2"
        shift 2
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

json_escape() {
  node -e "const value = process.argv[1] ?? ''; process.stdout.write(JSON.stringify(value));" "$1"
}

resolve_install_report_path() {
  if [ -n "$INSTALL_REPORT_PATH" ]; then
    return
  fi
  if [ "$USER_MODE" = true ]; then
    INSTALL_REPORT_PATH="${HOME}/.local/state/patze-bridge/install-report.json"
  else
    INSTALL_REPORT_PATH="/var/log/patze-bridge-install.json"
  fi
}

write_install_report() {
  if [ -z "$INSTALL_REPORT_PATH" ]; then
    return 0
  fi

  local report_status="$INSTALL_STATUS"
  local error_message="$INSTALL_ERROR"
  local machine_id="$INSTALL_MACHINE_ID"
  local expires_at="$INSTALL_EXPIRES_AT"
  local now_iso
  now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local output_path="$INSTALL_REPORT_PATH"
  local report_dir
  report_dir="$(dirname "$output_path")"
  local tmp_file
  tmp_file="$(mktemp)"

  {
    printf '{\n'
    printf '  "script": %s,\n' "$(json_escape "$SCRIPT_NAME")"
    printf '  "status": %s,\n' "$(json_escape "$report_status")"
    printf '  "generatedAt": %s,\n' "$(json_escape "$now_iso")"
    printf '  "userMode": %s,\n' "$([ "$USER_MODE" = true ] && echo "true" || echo "false")"
    printf '  "controlPlaneUrl": %s,\n' "$(json_escape "$CONTROL_PLANE_URL")"
    printf '  "stateDir": %s,\n' "$(json_escape "$STATE_DIR")"
    printf '  "bundlePath": %s,\n' "$(json_escape "$BUNDLE_PATH")"
    printf '  "verifyBundleSha256": %s,\n' "$(json_escape "$VERIFY_BUNDLE_SHA256")"
    printf '  "machineId": %s,\n' "$(json_escape "$machine_id")"
    printf '  "tokenExpiresAt": %s,\n' "$(json_escape "$expires_at")"
    printf '  "error": %s\n' "$(json_escape "$error_message")"
    printf '}\n'
  } > "$tmp_file"

  if [ "$USER_MODE" = true ]; then
    mkdir -p "$report_dir"
    mv -f "$tmp_file" "$output_path"
    chmod 600 "$output_path"
  else
    if [ -n "$INSTALL_SUDO_CMD" ]; then
      run_sudo "$INSTALL_SUDO_CMD" mkdir -p "$report_dir"
      run_sudo "$INSTALL_SUDO_CMD" mv -f "$tmp_file" "$output_path"
      run_sudo "$INSTALL_SUDO_CMD" chmod 600 "$output_path"
    else
      mkdir -p "$report_dir"
      mv -f "$tmp_file" "$output_path"
      chmod 600 "$output_path"
    fi
  fi
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
    printf '%s\n' "$SUDO_PASSWORD" | sudo -S "$@" 2> >(grep -v '^\[sudo\] password for' >&2)
  elif [ -n "$sudo_cmd" ]; then
    $sudo_cmd "$@"
  else
    "$@"
  fi
}

backup_if_exists() {
  local sudo_cmd="$1"
  local source_path="$2"
  if ! run_sudo "$sudo_cmd" test -f "$source_path"; then
    return
  fi
  local backup_path="${source_path}.bak.${BACKUP_SUFFIX}"
  run_sudo "$sudo_cmd" cp "$source_path" "$backup_path"
  log "Backup created: $backup_path"
  case "$source_path" in
    */config.env)
      LAST_CONFIG_BACKUP="$backup_path"
      ;;
    *.service)
      LAST_SERVICE_BACKUP="$backup_path"
      ;;
  esac
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
  local tmp_file
  tmp_file="$(mktemp)"
  printf '%s\n' "$machine_id" > "$tmp_file"
  run_sudo "$sudo_cmd" mv -f "$tmp_file" "$machine_id_file"
  run_sudo "$sudo_cmd" chmod 600 "$machine_id_file"
  printf '%s\n' "$machine_id"
}

file_sha256() {
  local file_path="$1"
  if has_command sha256sum; then
    sha256sum "$file_path" | awk '{print $1}'
    return
  fi
  if has_command shasum; then
    shasum -a 256 "$file_path" | awk '{print $1}'
    return
  fi
  if has_command openssl; then
    openssl dgst -sha256 "$file_path" | awk '{print $2}'
    return
  fi
  fail "No SHA-256 tool available (need sha256sum, shasum, or openssl)."
}

verify_bundle_sha256() {
  local file_path="$1"
  local expected="$2"
  if [ -z "$expected" ]; then
    return 0
  fi
  local normalized_expected
  normalized_expected="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
  if ! printf '%s' "$normalized_expected" | grep -Eq '^[0-9a-f]{64}$'; then
    fail "--verify-bundle-sha256 must be 64-char hex string."
  fi
  local actual
  actual="$(file_sha256 "$file_path" | tr '[:upper:]' '[:lower:]')"
  if [ "$actual" != "$normalized_expected" ]; then
    fail "Bundle SHA-256 mismatch. expected=$normalized_expected actual=$actual"
  fi
  log "Bundle SHA-256 verified."
}

write_config() {
  local sudo_cmd="$1"
  local machine_id="$2"
  local expires_at="$3"
  local config_file="${STATE_DIR}/config.env"
  local offset_file="${STATE_DIR}/cron-offsets.json"
  local tmp_file

  tmp_file="$(mktemp)"
  run_sudo "$sudo_cmd" mkdir -p "$STATE_DIR"
  backup_if_exists "$sudo_cmd" "$config_file"
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
    printf 'BRIDGE_CONFIG_FILE=%s\n' "$config_file"
    printf 'BRIDGE_CRON_OFFSET_FILE=%s\n' "$offset_file"
    printf 'BRIDGE_TELEMETRY_SPOOL_ENABLED=true\n'
    printf 'BRIDGE_TELEMETRY_SPOOL_FILE=%s\n' "${STATE_DIR}/telemetry-spool.json"
    printf 'BRIDGE_HEALTH_HOST=127.0.0.1\n'
    printf 'BRIDGE_HEALTH_PORT=19701\n'
    if [ -n "$expires_at" ]; then
      printf 'TOKEN_EXPIRES_AT=%s\n' "$expires_at"
    fi
  } > "$tmp_file"
  run_sudo "$sudo_cmd" mv -f "$tmp_file" "$config_file"
  run_sudo "$sudo_cmd" chmod 600 "$config_file"
}

resolve_exec_start() {
  if [ -n "$BUNDLE_PATH" ]; then
    echo "/usr/bin/env node ${BUNDLE_PATH}"
  elif [ "$USER_MODE" = true ]; then
    echo "${HOME}/patze-bridge/bin/openclaw-bridge"
  else
    echo "/usr/bin/env openclaw-bridge"
  fi
}

write_system_service() {
  local sudo_cmd="$1"
  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"
  local exec_start
  local tmp_file
  exec_start="$(resolve_exec_start)"
  tmp_file="$(mktemp)"
  backup_if_exists "$sudo_cmd" "$service_file"
  cat <<EOF > "$tmp_file"
[Unit]
Description=Patze OpenClaw Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${STATE_DIR}/config.env
ExecStart=${exec_start}
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  run_sudo "$sudo_cmd" mv -f "$tmp_file" "$service_file"
  run_sudo "$sudo_cmd" chmod 644 "$service_file"
}

write_user_service() {
  local service_dir="${HOME}/.config/systemd/user"
  local service_file="${service_dir}/${SERVICE_NAME}.service"
  local exec_start
  local tmp_file
  exec_start="$(resolve_exec_start)"
  mkdir -p "$service_dir"
  tmp_file="$(mktemp)"
  backup_if_exists "" "$service_file"
  cat <<EOF > "$tmp_file"
[Unit]
Description=Patze OpenClaw Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${STATE_DIR}/config.env
ExecStart=${exec_start}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  mv -f "$tmp_file" "$service_file"
  chmod 644 "$service_file"
}

print_service_diagnostics() {
  local sudo_cmd="$1"
  local mode="$2"
  local unit="${SERVICE_NAME}.service"
  log "Collecting service diagnostics for $unit ($mode)..."
  if [ "$mode" = "user" ]; then
    systemctl --user --no-pager status "$unit" || true
    journalctl --user -u "$unit" -n 50 --no-pager || true
  else
    run_sudo "$sudo_cmd" systemctl --no-pager status "$unit" || true
    run_sudo "$sudo_cmd" journalctl -u "$unit" -n 50 --no-pager || true
  fi
}

rollback_install() {
  local sudo_cmd="$1"
  local mode="$2"
  local unit="${SERVICE_NAME}.service"
  local service_path
  if [ "$mode" = "user" ]; then
    service_path="${HOME}/.config/systemd/user/${unit}"
  else
    service_path="/etc/systemd/system/${unit}"
  fi

  log "Attempting rollback..."
  if [ -n "$LAST_CONFIG_BACKUP" ]; then
    run_sudo "$sudo_cmd" cp "$LAST_CONFIG_BACKUP" "${STATE_DIR}/config.env" || true
  fi
  if [ -n "$LAST_SERVICE_BACKUP" ]; then
    run_sudo "$sudo_cmd" cp "$LAST_SERVICE_BACKUP" "$service_path" || true
  fi

  if [ "$mode" = "user" ]; then
    systemctl --user daemon-reload || true
    systemctl --user restart "$unit" || true
  else
    run_sudo "$sudo_cmd" systemctl daemon-reload || true
    run_sudo "$sudo_cmd" systemctl restart "$unit" || true
  fi
}

verify_service_stable() {
  local sudo_cmd="$1"
  local mode="$2"
  local unit="${SERVICE_NAME}.service"
  local i
  for i in 1 2 3; do
    if [ "$mode" = "user" ]; then
      if ! systemctl --user is-active --quiet "$unit"; then
        return 1
      fi
    else
      if ! run_sudo "$sudo_cmd" systemctl is-active --quiet "$unit"; then
        return 1
      fi
    fi
    sleep 2
  done
  return 0
}

ensure_system_unit_unmasked() {
  local sudo_cmd="$1"
  local unit="${SERVICE_NAME}.service"
  local unit_file="/etc/systemd/system/${unit}"
  log "Ensuring system unit is unmasked (${unit})."
  # Force-clean stale mask files/symlinks first, then unmask.
  run_sudo "$sudo_cmd" rm -f "/etc/systemd/system/${unit}" "/run/systemd/system/${unit}" || true
  run_sudo "$sudo_cmd" systemctl unmask "$unit" 2>/dev/null || true
  run_sudo "$sudo_cmd" systemctl unmask "$SERVICE_NAME" 2>/dev/null || true
  # Clean again after unmask in case distro/systemd re-created a runtime mask link.
  run_sudo "$sudo_cmd" rm -f "/run/systemd/system/${unit}" || true
}

ensure_user_unit_unmasked() {
  local unit="${SERVICE_NAME}.service"
  log "Ensuring user unit is unmasked (${unit})."
  rm -f "${HOME}/.config/systemd/user/${unit}" "/run/user/$(id -u)/systemd/${unit}" || true
  systemctl --user unmask "$unit" 2>/dev/null || true
  systemctl --user unmask "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/run/user/$(id -u)/systemd/${unit}" || true
}

main() {
  parse_args "$@"
  [ -n "$TOKEN" ] || fail "--token is required"
  require_node_18

  if [ "$USER_MODE" = true ]; then
    STATE_DIR="${HOME}/.config/patze-bridge"
    log "User-mode install (no sudo required)."
  fi

  if [ "$SUDO_PASS_MODE" = true ]; then
    read -r SUDO_PASSWORD
  fi

  resolve_install_report_path

  local sudo_cmd
  sudo_cmd="$(resolve_sudo)"
  INSTALL_SUDO_CMD="$sudo_cmd"
  local expires_at
  expires_at="$(compute_expires_at "$EXPIRES_IN")"
  INSTALL_EXPIRES_AT="$expires_at"

  if [ -n "$VERIFY_BUNDLE_SHA256" ] && [ -z "$BUNDLE_PATH" ]; then
    fail "--verify-bundle-sha256 requires --bundle-path."
  fi

  if [ "$SKIP_NPM" = true ]; then
    if [ -n "$BUNDLE_PATH" ]; then
      verify_bundle_sha256 "$BUNDLE_PATH" "$VERIFY_BUNDLE_SHA256"
      local final_dir
      if [ "$USER_MODE" = true ]; then
        final_dir="${HOME}/patze-bridge"
        mkdir -p "$final_dir"
      else
        final_dir="/opt/patze-bridge"
        run_sudo "$sudo_cmd" mkdir -p "$final_dir"
      fi
      local final_path="${final_dir}/bridge.mjs"
      log "Moving bundle from ${BUNDLE_PATH} to ${final_path}"
      run_sudo "$sudo_cmd" mv "$BUNDLE_PATH" "$final_path"
      run_sudo "$sudo_cmd" chmod +x "$final_path"
      BUNDLE_PATH="$final_path"
    else
      log "Skipping npm install (--skip-npm)."
    fi
  elif [ "$USER_MODE" = true ]; then
    log "Installing @patze/openclaw-bridge to ~/patze-bridge..."
    npm install --prefix "${HOME}/patze-bridge" @patze/openclaw-bridge
  else
    log "Installing @patze/openclaw-bridge globally..."
    run_sudo "$sudo_cmd" npm install -g @patze/openclaw-bridge
  fi

  local machine_id
  machine_id="$(ensure_machine_id "$sudo_cmd")"
  INSTALL_MACHINE_ID="$machine_id"
  write_config "$sudo_cmd" "$machine_id" "$expires_at"

  if [ "$USER_MODE" = true ]; then
    ensure_user_unit_unmasked
    write_user_service
    log "Reloading and starting user systemd service..."
    if ! systemctl --user daemon-reload; then
      print_service_diagnostics "" "user"
      rollback_install "" "user"
      fail "User daemon-reload failed."
    fi
    if ! systemctl --user enable --now "${SERVICE_NAME}.service"; then
      print_service_diagnostics "" "user"
      rollback_install "" "user"
      fail "User service enable/start failed."
    fi
    if ! verify_service_stable "" "user"; then
      print_service_diagnostics "" "user"
      rollback_install "" "user"
      fail "User service is not stable after start."
    fi
    if has_command loginctl; then
      loginctl enable-linger "$(whoami)" 2>/dev/null || true
    fi
  else
    ensure_system_unit_unmasked "$sudo_cmd"
    write_system_service "$sudo_cmd"
    log "Reloading and starting systemd service..."
    if ! run_sudo "$sudo_cmd" systemctl daemon-reload; then
      print_service_diagnostics "$sudo_cmd" "system"
      rollback_install "$sudo_cmd" "system"
      fail "System daemon-reload failed."
    fi
    if ! run_sudo "$sudo_cmd" systemctl enable --now "${SERVICE_NAME}.service"; then
      print_service_diagnostics "$sudo_cmd" "system"
      rollback_install "$sudo_cmd" "system"
      fail "System service enable/start failed."
    fi
    if ! verify_service_stable "$sudo_cmd" "system"; then
      print_service_diagnostics "$sudo_cmd" "system"
      rollback_install "$sudo_cmd" "system"
      fail "System service is not stable after start."
    fi
  fi

  SUDO_PASSWORD=""

  log "Bridge installed successfully."
  log "Machine ID: $machine_id"
  log "Control plane URL: $CONTROL_PLANE_URL"
  log "Bridge health endpoint: http://127.0.0.1:19701/health"
  log "Bridge metrics endpoint: http://127.0.0.1:19701/metrics"
  if [ "$USER_MODE" = true ]; then
    log "Reload config (graceful restart): systemctl --user kill -s HUP ${SERVICE_NAME}.service"
  else
    log "Reload config (graceful restart): sudo systemctl kill -s HUP ${SERVICE_NAME}.service"
  fi
  if has_command curl; then
    if curl -fsS --max-time 5 "http://127.0.0.1:19701/health" >/dev/null 2>&1; then
      log "Health check passed: bridge endpoint is reachable."
    else
      log "WARN: bridge health endpoint did not respond yet. Service may still be warming up."
    fi
    if curl -fsS --max-time 5 "http://127.0.0.1:19701/metrics" >/dev/null 2>&1; then
      log "Metrics check passed: bridge metrics endpoint is reachable."
    else
      log "WARN: bridge metrics endpoint did not respond yet."
    fi
  fi
  if [ -n "$expires_at" ]; then
    log "Token expires at: $expires_at"
  fi
  INSTALL_STATUS="success"
  INSTALL_ERROR=""
  write_install_report
  log "Install report: $INSTALL_REPORT_PATH"
}

main "$@"
