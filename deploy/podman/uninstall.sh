#!/usr/bin/env bash
#
# ejs-signature-api quadlet 제거 스크립트
#
# 기본 동작: 서비스 중지/비활성, quadlet과 env 파일 제거. 캐시 볼륨은 보존한다.
# --purge: 캐시 볼륨과 healthcheck용 busybox 복사본까지 제거한다.
# --yes: 확인 프롬프트 생략.

set -euo pipefail

readonly CONFIG_DIR="${HOME}/.config/containers/systemd"
readonly ENV_FILE="${CONFIG_DIR}/ejs-signature-api.env"
readonly QUADLET_FILE="${CONFIG_DIR}/ejs-signature-api.container"
readonly HEALTH_BIN_DIR="${HOME}/.local/share/yt-cipher"
readonly HEALTH_BIN="${HEALTH_BIN_DIR}/busybox"
readonly VOLUME_NAME="ejs-signature-cache"

PURGE=0
ASSUME_YES=0

log() { printf '[uninstall] %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --purge) PURGE=1 ;;
      --yes|-y) ASSUME_YES=1 ;;
      -h|--help)
        printf '사용법: %s [--purge] [--yes]\n' "$0"
        exit 0
        ;;
      *) printf '알 수 없는 옵션: %s\n' "$1" >&2; exit 1 ;;
    esac
    shift
  done
}

confirm() {
  [[ "$ASSUME_YES" == "1" ]] && return 0
  local answer
  read -rp "ejs-signature-api 서비스와 quadlet을 제거할까요? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

main() {
  parse_args "$@"

  confirm || { log "취소했습니다."; exit 0; }

  local unit_files
  unit_files="$(systemctl --user list-unit-files 2>/dev/null || true)"
  if grep -q '^ejs-signature-api.service' <<<"$unit_files"; then
    systemctl --user stop ejs-signature-api.service || true
    systemctl --user disable ejs-signature-api.service || true
    log "서비스 중지/비활성 완료"
  else
    warn "ejs-signature-api.service를 찾지 못했습니다. 파일만 정리합니다."
  fi

  rm -f "$QUADLET_FILE" "$ENV_FILE"
  log "quadlet/env 제거: $QUADLET_FILE, $ENV_FILE"

  if command -v podman >/dev/null 2>&1; then
    podman rm -f ejs_signature_api >/dev/null 2>&1 || true
  fi

  systemctl --user daemon-reload || true

  if [[ "$PURGE" == "1" ]]; then
    if command -v podman >/dev/null 2>&1 && podman volume exists "$VOLUME_NAME" 2>/dev/null; then
      podman volume rm "$VOLUME_NAME" >/dev/null
      log "볼륨 제거: $VOLUME_NAME"
    fi
    rm -f "$HEALTH_BIN"
    rmdir "$HEALTH_BIN_DIR" 2>/dev/null || true
    log "healthcheck busybox 제거: $HEALTH_BIN"
  else
    log "캐시 볼륨은 보존했습니다: $VOLUME_NAME"
    log "완전 제거하려면: $0 --purge --yes"
  fi

  log "lishi-net 네트워크 quadlet은 다른 서비스와 공유되므로 제거하지 않았습니다."
}

main "$@"
