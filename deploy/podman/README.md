# yt-cipher Podman (rootless quadlet)

Lavalink가 사용하는 YouTube signature cipher API(`yt-cipher`)를 rootless Podman quadlet으로 운영하기 위한 재현 가능한 배포 파일이다.

## 아키텍처

```text
Lavalink (pm2, host)
  └─ HTTP 127.0.0.1:8001
       └─ rootless Podman (systemd --user quadlet)
            └─ ejs_signature_api (ghcr.io/kikkia/yt-cipher)
```

- Lavalink는 host에서 pm2로 실행되며 `plugins.youtube.remoteCipher.url`로 `127.0.0.1:8001`을 호출한다.
- 컨테이너는 `lishi-net` 네트워크에 연결되지만, 포트는 loopback에만 publish한다.
- 캐시는 named volume `ejs-signature-cache`를 컨테이너의 `/home/nonroot/.cache/yt-cipher`에 마운트해 재시작 후에도 유지한다.
- yt-cipher 이미지는 distroless에 가까워 컨테이너 안에 shell, curl, wget, node가 없다. 따라서 healthcheck는 host의 정적 busybox를 read-only로 마운트해 수행한다. busybox가 없으면 `install.sh`가 HealthCmd를 생략한다.

## 전제

- Podman 4.9 이상 (rootless)
- systemd user session
- 재부팅 후에도 사용자 서비스가 살아 있도록 linger 활성화

```bash
loginctl enable-linger "$USER"
```

## 설치

```bash
cd deploy/podman

# 방법 1: 환경변수로 토큰 전달
API_TOKEN='...' ./install.sh

# 방법 2: 대화형 입력 (화면에 표시되지 않음)
./install.sh
```

`install.sh`가 하는 일:

1. podman/systemctl 존재 확인
2. `API_TOKEN`이 없으면 `read -rsp`로 입력받고 빈 값/개행을 거부
3. `~/.config/containers/systemd/` 생성
4. 토큰을 `~/.config/containers/systemd/ejs-signature-api.env`에 mode 600으로 기록
5. `lishi-net.network`와 `ejs-signature-api.container` quadlet 설치
6. `systemctl --user daemon-reload` 후 서비스 재시작
7. healthcheck가 활성화된 경우 healthy가 될 때까지 대기

이미지 digest를 직접 지정하려면:

```bash
IMAGE_DIGEST=sha256:... ./install.sh
```

`IMAGE_DIGEST`가 없으면 로컬 이미지에서 digest를 자동 추출하고, 이미지가 없으면 pull한 뒤 추출한다. 그래도 실패하면 태그를 그대로 사용하며 경고를 출력한다.

## 토큰과 Lavalink 설정

토큰은 repo나 quadlet에 인라인으로 넣지 않는다. 오직 다음 파일에만 저장한다.

```text
~/.config/containers/systemd/ejs-signature-api.env   (mode 600)
```

Lavalink의 `lavalink/application.yml`에서 아래 값이 **정확히 같은 토큰**이어야 한다.

```yaml
plugins:
  youtube:
    remoteCipher:
      url: "http://127.0.0.1:8001"
      password: "<ejs-signature-api.env의 API_TOKEN과 동일>"
```

- 토큰 값을 README, 로그, 채팅, 커밋에 남기지 않는다.
- 값을 바꾸면 `install.sh`를 다시 실행하고 Lavalink도 재시작한다.

## 이미지 digest 고정과 갱신

quadlet은 `Image=ghcr.io/kikkia/yt-cipher@sha256:<digest>` 형태로 digest를 고정한다. 태그만 쓰면 어느 시점에 다른 이미지가 배포될 수 있다.

현재 digest 확인:

```bash
podman image inspect ghcr.io/kikkia/yt-cipher:master --format '{{.Digest}}'
```

갱신 절차:

```bash
podman pull ghcr.io/kikkia/yt-cipher:master
podman image inspect ghcr.io/kikkia/yt-cipher:master --format '{{.Digest}}'
# 새 digest로 quadlet의 Image=를 수정하거나:
IMAGE_DIGEST=sha256:<new-digest> ./install.sh

systemctl --user daemon-reload
systemctl --user restart ejs-signature-api.service
podman inspect ejs_signature_api --format '{{.State.Health.Status}}'
```

## 검증

서비스/health:

```bash
systemctl --user is-active ejs-signature-api.service
podman ps --filter name=ejs_signature_api
podman inspect ejs_signature_api --format '{{.State.Health.Status}}'
```

인증 동작:

```bash
set -a; . ~/.config/containers/systemd/ejs-signature-api.env; set +a

# 올바른 토큰 + 유효하지 않은 요청 본문 → 400 (인증은 통과)
curl -s -o /dev/null -w 'good=%{http_code}\n' -X POST \
  -H "Authorization: $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' \
  http://localhost:8001/get_sts

# 잘못된 토큰 → 401
curl -s -o /dev/null -w 'bad=%{http_code}\n' -X POST \
  -H 'Authorization: wrong' -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' \
  http://localhost:8001/get_sts
```

`/get_sts`의 400은 "토큰은 맞지만 요청이 유효하지 않음"을 의미한다. 401은 토큰 불일치다.

Lavalink 실제 로드:

```bash
curl -s -H "Authorization: <LAVALINK_PASSWORD>" \
  "http://localhost:2333/v4/loadtracks?identifier=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ"
```

응답의 `loadType`이 `track`이면 정상이다.

캐시 볼륨:

```bash
podman volume inspect ejs-signature-cache --format '{{.Name}} {{.Mountpoint}}'
podman exec ejs_signature_api /usr/local/bin/busybox sh -c 'ls -la "$HOME/.cache/yt-cipher"'
```

## 보안 메모

- `PublishPort=127.0.0.1:8001:8001`을 유지한다. `0.0.0.0`으로 열면 외부에서 접근할 수 있다.
- `/metrics`는 인증이 없다. loopback에만 publish한다는 전제로 허용하며, 외부에 노출해야 한다면 reverse proxy에서 인증을 추가한다.
- 토큰을 quadlet의 `Environment=`에 인라인으로 넣지 않는다. 반드시 `EnvironmentFile=`(mode 600)을 사용한다.
- 이미지 digest를 고정하고 `Memory=512M`, `PidsLimit=256` 제한을 유지한다.
  - Podman 4.9 quadlet은 `Memory=` 키를 지원하지 않으므로 `PodmanArgs=--memory=512M`로 전달한다.
- 백업 파일에는 과거 토큰이 들어 있을 수 있으므로 mode 600을 유지하고, 필요 없으면 안전하게 삭제한다.

## 구 docker-compose (deprecated)

`/home/ubuntu/.dockers-a/yt-cipher`의 docker-compose 구성은 더 이상 사용하지 않는다. 현재 운영은 이 디렉터리의 rootless Podman quadlet을 기준으로 한다.

## 트러블슈팅

### 401 Unauthorized

- `ejs-signature-api.env`의 `API_TOKEN`과 Lavalink의 `plugins.youtube.remoteCipher.password`가 다르다.
- 값을 출력하지 말고 존재 여부만 확인한다.

```bash
podman exec ejs_signature_api /usr/local/bin/busybox sh -c \
  'test -n "$API_TOKEN" && echo TOKEN_SET || echo TOKEN_MISSING'
```

### 400 Bad Request

- 토큰은 통과했지만 요청 본문/URL이 유효하지 않다.
- `{"url":"..."}` 형식과 URL 인코딩을 확인한다.

### Connection refused (127.0.0.1:8001)

- 서비스가 내려갔거나 포트 publish가 빠졌다.

```bash
systemctl --user status ejs-signature-api.service
podman ps --filter name=ejs_signature_api
ss -ltnp | grep 8001
```

- Lavalink의 `remoteCipher.url`이 `http://127.0.0.1:8001`인지 확인한다.

### healthcheck unhealthy

```bash
podman inspect ejs_signature_api --format '{{json .State.Health}}'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8001/metrics
```

- `/metrics`가 200이 아니면 앱이 아직 기동 중이거나 비정상이다.
- busybox 마운트가 빠졌는지 확인한다: `podman inspect ejs_signature_api --format '{{json .Mounts}}'`.
- healthcheck를 끄려면 `ejs-signature-api.container.example`의 `__HEALTH_BEGIN__`~`__HEALTH_END__` 블록을 제거하고 재설치한다.

### 캐시가 사라짐

- named volume `ejs-signature-cache`가 마운트되어 있는지 확인한다.
- 컨테이너를 `podman run --rm`으로 수동 실행하면 볼륨이 붙지 않을 수 있다.

## 제거

```bash
./uninstall.sh            # 서비스/quadlet/env 제거, 캐시 볼륨 보존
./uninstall.sh --purge    # 캐시 볼륨과 busybox 복사본까지 제거
```
