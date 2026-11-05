#!/usr/bin/env bash
#
# ejs-signature-api rootless Podman quadlet 설치 스크립트
#
# 사용법:
#   API_TOKEN='...' ./install.sh
#   ./install.sh                  # 토큰을 대화형으로 입력
#   IMAGE_DIGEST=sha256:... ./install.sh
#
# 이 스크립트는 실제 비밀값을 하드코딩하지 않는다. 토큰은 600 권한의
# EnvironmentFile에만 기록하고 화면에 출력하지 않는다.

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly CONFIG_DIR="${HOME}/.config/containers/systemd"
readonly ENV_FILE="${CONFIG_DIR}/ejs-signature-api.env"
readonly QUADLET_FILE="${CONFIG_DIR}/ejs-signature-api.container"
readonly NETWORK_FILE="${CONFIG_DIR}/lishi-net.network"
readonly HEALTH_BIN_DIR="${HOME}/.local/share/yt-cipher"
readonly HEALTH_BIN="${HEALTH_BIN_DIR}/busybox"
readonly EXAMPLE_QUADLET="${SCRIPT_DIR}/ejs-signature-api.container.example"
readonly DEFAULT_IMAGE="ghcr.io/kikkia/yt-cipher:master"

HEALTH_ENABLED=0

log() { printf '[install] %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
die() { printf '[error] %s\n' "$*" >&2; exit 1; }

require_tools() {
  command -v podman >/dev/null 2>&1 || die "podman이 필요합니다."
  command -v systemctl >/dev/null 2>&1 || die "systemctl이 필요합니다."
  [[ -f "$EXAMPLE_QUADLET" ]] || die "템플릿을 찾을 수 없습니다: $EXAMPLE_QUADLET"
}

read_token() {
  if [[ -n "${API_TOKEN:-}" ]]; then
    return
  fi
  [[ -t 0 ]] || die "비대화형 실행에서는 API_TOKEN 환경변수를 설정하세요."
  local first second
  read -rsp "API_TOKEN 입력: " first
  printf '\n'
  [[ -n "$first" ]] || die "API_TOKEN이 비어 있습니다."
  read -rsp "API_TOKEN 확인: " second
  printf '\n'
  [[ "$first" == "$second" ]] || die "API_TOKEN이 일치하지 않습니다."
  API_TOKEN="$first"
}

validate_token() {
  [[ -n "${API_TOKEN:-}" ]] || die "API_TOKEN이 비어 있습니다."
  [[ "$API_TOKEN" != *$'\n'* && "$API_TOKEN" != *$'\r'* ]] \
    || die "API_TOKEN에 개행 문자를 사용할 수 없습니다."
}

strip_tag() {
  local ref="$1"
  ref="${ref%@*}"
  if [[ "${ref##*/}" == *:* ]]; then
    ref="${ref%:*}"
  fi
  printf '%s' "$ref"
}

resolve_image_ref() {
  local image="${IMAGE:-$DEFAULT_IMAGE}"
  local digest="${IMAGE_DIGEST:-}"
  local repo

  if [[ "$image" == *"@sha256:"* ]]; then
    printf '%s' "$image"
    return
  fi

  repo="$(strip_tag "$image")"

  if [[ -n "$digest" ]]; then
    [[ "$digest" == sha256:* ]] || digest="sha256:${digest}"
    printf '%s@%s' "$repo" "$digest"
    return
  fi

  digest="$(podman image inspect "$image" --format '{{.Digest}}' 2>/dev/null || true)"
  if [[ -z "$digest" ]]; then
    digest="$(podman image inspect "$image" --format '{{index .RepoDigests 0}}' 2>/dev/null \
      | sed -n 's/.*@\(sha256:[0-9a-f]\{64\}\)$/\1/p' || true)"
  fi

  if [[ -z "$digest" ]]; then
    warn "로컬에 ${image} 이미지가 없어 pull을 시도합니다."
    podman pull "$image" >/dev/null || die "이미지를 pull하지 못했습니다: $image"
    digest="$(podman image inspect "$image" --format '{{.Digest}}' 2>/dev/null || true)"
  fi

  if [[ -z "$digest" ]]; then
    warn "digest를 확인하지 못했습니다. 태그를 그대로 사용합니다(재현성 낮음)."
    printf '%s' "$image"
    return
  fi

  printf '%s@%s' "$repo" "$digest"
}

prepare_health_bin() {
  if [[ -x "$HEALTH_BIN" ]] && "$HEALTH_BIN" --list 2>/dev/null | grep -qw wget; then
    HEALTH_ENABLED=1
    return
  fi

  if ! command -v busybox >/dev/null 2>&1; then
    warn "정적 busybox를 찾지 못했습니다. 이미지에 shell/curl/node가 없어 healthcheck를 생략합니다."
    HEALTH_ENABLED=0
    return
  fi

  mkdir -p "$HEALTH_BIN_DIR"
  install -m 0755 "$(command -v busybox)" "$HEALTH_BIN"
  if ! "$HEALTH_BIN" --list 2>/dev/null | grep -qw wget; then
    warn "busybox에 wget applet이 없어 healthcheck를 생략합니다."
    rm -f "$HEALTH_BIN"
    HEALTH_ENABLED=0
    return
  fi
  HEALTH_ENABLED=1
}

backup_if_exists() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  local backup="${path}.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$path" "$backup"
  chmod 600 "$backup"
  log "기존 파일 백업: $backup"
}

install_network_quadlet() {
  mkdir -p "$CONFIG_DIR"
  if [[ -f "$NETWORK_FILE" ]]; then
    if ! cmp -s "${SCRIPT_DIR}/lishi-net.network" "$NETWORK_FILE"; then
      warn "기존 ${NETWORK_FILE} 내용이 템플릿과 다릅니다. 덮어쓰지 않습니다."
    fi
    return
  fi
  install -m 0644 "${SCRIPT_DIR}/lishi-net.network" "$NETWORK_FILE"
  log "네트워크 quadlet 설치: $NETWORK_FILE"
}

install_env_file() {
  mkdir -p "$CONFIG_DIR"
  backup_if_exists "$ENV_FILE"
  (
    umask 077
    printf 'API_TOKEN=%s\n' "$API_TOKEN" > "$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
  grep -q '^API_TOKEN=.\+' "$ENV_FILE" || die "env 파일에 API_TOKEN을 기록하지 못했습니다."
  log "env 파일 설치: $ENV_FILE (mode 600)"
}

render_quadlet() {
  awk -v home="$HOME" -v image="$1" -v keep="$HEALTH_ENABLED" '
    /__HEALTH_BEGIN__/ { skip = (keep == 0); next }
    /__HEALTH_END__/   { skip = 0; next }
    skip { next }
    {
      gsub(/__HOME__/, home)
      gsub(/__IMAGE_REF__/, image)
      print
    }
  ' "$EXAMPLE_QUADLET"
}

install_container_quadlet() {
  local image_ref="$1"
  local tmp
  mkdir -p "$CONFIG_DIR"
  backup_if_exists "$QUADLET_FILE"
  tmp="$(mktemp)"
  render_quadlet "$image_ref" > "$tmp"
  install -m 0644 "$tmp" "$QUADLET_FILE"
  rm -f "$tmp"
  log "컨테이너 quadlet 설치: $QUADLET_FILE"
  log "이미지: $image_ref"
  if [[ "$HEALTH_ENABLED" == "1" ]]; then
    log "healthcheck: 정적 busybox (${HEALTH_BIN})"
  else
    log "healthcheck: 생략"
  fi
}

check_linger() {
  command -v loginctl >/dev/null 2>&1 || return 0
  local user="${USER:-$(id -un)}"
  local linger
  linger="$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)"
  if [[ "$linger" != "yes" ]]; then
    warn "systemd user linger가 꺼져 있습니다. 재부팅 후 자동 시작하려면:"
    warn "  loginctl enable-linger $user"
  fi
}

restart_service() {
  systemctl --user daemon-reload
  systemctl --user restart ejs-signature-api.service
  log "서비스 재시작 완료"
}

wait_for_health() {
  [[ "$HEALTH_ENABLED" == "1" ]] || return 0
  local status=""
  local _
  for _ in $(seq 1 15); do
    status="$(podman inspect ejs_signature_api --format '{{.State.Health.Status}}' 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && break
    sleep 2
  done
  log "health=${status:-unknown}"
}

print_next_steps() {
  cat <<EOF

설치가 끝났습니다.

확인:
  systemctl --user is-active ejs-signature-api.service
  podman ps --filter name=ejs_signature_api
  podman inspect ejs_signature_api --format '{{.State.Health.Status}}'

인증 확인 (토큰 값은 출력하지 마세요):
  set -a; . "$ENV_FILE"; set +a
  curl -s -o /dev/null -w 'good=%{http_code}\n' -X POST \\
    -H "Authorization: \$API_TOKEN" -H 'Content-Type: application/json' \\
    -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' \\
    http://localhost:8001/get_sts
  curl -s -o /dev/null -w 'bad=%{http_code}\n' -X POST \\
    -H 'Authorization: wrong' -H 'Content-Type: application/json' \\
    -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' \\
    http://localhost:8001/get_sts

Lavalink 확인:
  curl -s -H "Authorization: <LAVALINK_PASSWORD>" \\
    "http://localhost:2333/v4/loadtracks?identifier=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ"

중요:
  - Lavalink의 plugins.youtube.remoteCipher.password는 위 API_TOKEN과 정확히 같아야 합니다.
    (값을 화면/로그/문서에 남기지 마세요.)
  - API_TOKEN은 ${ENV_FILE} (mode 600)에만 저장되어 있습니다.
EOF
}

main() {
  require_tools
  read_token
  validate_token
  prepare_health_bin

  local image_ref
  image_ref="$(resolve_image_ref)"

  install_network_quadlet
  install_env_file
  install_container_quadlet "$image_ref"
  restart_service
  wait_for_health
  check_linger
  print_next_steps
}

main "$@"
