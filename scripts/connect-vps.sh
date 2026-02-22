#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
TARGET_HOST=""
TOKEN=""
EXPIRES_IN=""
LOCAL_PORT="9700"
REMOTE_PORT="19700"
INSTALL_SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/install-bridge.sh"
SSH_CMD="ssh"
TUNNEL_PID=""

print_usage() {
  cat <<'EOF'
Usage:
  connect-vps.sh <user@host> --token <token> [options]

Options:
  --token <token>          Required auth token
  --expires-in <duration>  Optional duration passed to install script
  --local-port <port>      Local Patze API port (default: 9700)
  --remote-port <port>     Remote reverse tunnel port on VPS (default: 19700)
  --help                   Show this help
EOF
}

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" >/dev/null 2>&1; then
    kill "$TUNNEL_PID" >/dev/null 2>&1 || true
  fi
}

parse_args() {
  if [ $# -lt 1 ]; then
    print_usage
    exit 1
  fi

  TARGET_HOST="$1"
  shift

  while [ $# -gt 0 ]; do
    case "$1" in
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
      --local-port)
        [ $# -ge 2 ] || fail "Missing value for --local-port"
        LOCAL_PORT="$2"
        shift 2
        ;;
      --remote-port)
        [ $# -ge 2 ] || fail "Missing value for --remote-port"
        REMOTE_PORT="$2"
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

  [ -n "$TOKEN" ] || fail "--token is required"
}

require_files() {
  [ -f "$INSTALL_SCRIPT_PATH" ] || fail "Missing install script at $INSTALL_SCRIPT_PATH"
}

select_ssh_command() {
  if command -v autossh >/dev/null 2>&1; then
    SSH_CMD="autossh"
    return
  fi
  SSH_CMD="ssh"
  log "autossh not found, falling back to ssh (no automatic reconnect)."
}

open_tunnel() {
  local remote_spec
  remote_spec="${REMOTE_PORT}:localhost:${LOCAL_PORT}"

  if [ "$SSH_CMD" = "autossh" ]; then
    AUTOSSH_GATETIME=0 autossh -M 0 \
      -o "ServerAliveInterval=15" \
      -o "ServerAliveCountMax=3" \
      -o "ExitOnForwardFailure=yes" \
      -o "StrictHostKeyChecking=accept-new" \
      -N -R "$remote_spec" "$TARGET_HOST" &
  else
    ssh \
      -o "ServerAliveInterval=15" \
      -o "ServerAliveCountMax=3" \
      -o "ExitOnForwardFailure=yes" \
      -o "StrictHostKeyChecking=accept-new" \
      -N -R "$remote_spec" "$TARGET_HOST" &
  fi

  TUNNEL_PID="$!"
  sleep 2
  if ! kill -0 "$TUNNEL_PID" >/dev/null 2>&1; then
    fail "Reverse tunnel process exited early."
  fi
}

install_remote_bridge() {
  local remote_url
  remote_url="http://localhost:${REMOTE_PORT}"

  local -a install_args
  install_args=(--url "$remote_url" --token "$TOKEN")
  if [ -n "$EXPIRES_IN" ]; then
    install_args+=(--expires-in "$EXPIRES_IN")
  fi

  local quoted_args=""
  local arg
  for arg in "${install_args[@]}"; do
    quoted_args+=" $(printf '%q' "$arg")"
  done
  # shellcheck disable=SC2086
  ssh "$TARGET_HOST" "bash -s --${quoted_args}" < "$INSTALL_SCRIPT_PATH"
}

verify_remote_status() {
  ssh "$TARGET_HOST" "systemctl is-active --quiet patze-bridge"
  local machine_id
  machine_id="$(ssh "$TARGET_HOST" "cat /etc/patze-bridge/machine-id" 2>/dev/null || true)"
  log "Remote bridge is active."
  if [ -n "$machine_id" ]; then
    log "Remote machine ID: $machine_id"
  fi
  log "Reverse tunnel: $TARGET_HOST:${REMOTE_PORT} -> localhost:${LOCAL_PORT}"
}

main() {
  parse_args "$@"
  require_files
  select_ssh_command
  trap cleanup EXIT INT TERM

  log "Opening reverse tunnel..."
  open_tunnel
  log "Installing bridge on VPS..."
  install_remote_bridge
  verify_remote_status

  log "Connection is ready. Press Ctrl+C to stop tunnel."
  wait "$TUNNEL_PID"
}

main "$@"
