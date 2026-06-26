# 🌙 FullMoon Bot (리시)

한국 Discord 서버를 위한 종합 관리 봇입니다. AI 대화, 음악 재생, 경제 시스템, 게임, 서버 관리 기능을 하나에 담았습니다.

AI 캐릭터 **"리시"**는 따뜻하고 친절한 성격의 조력자예요. 사용자와 자연스럽게 대화하면서 서버 관리 작업을 직접 수행합니다.

---

## ✨ 주요 기능

### 🤖 AI 대화 (리시)
- 봇 **@멘션**으로 자연어 대화
- **답장**으로 대화 스레드 이어가기 (세션 TTL 2시간)
- **스마트 메모리**: 사용자 정보(이름, 취향, 일정 등) 자동 저장 → 다음 대화부터 맞춤 대응
- **연속 툴 사용**: 최대 20개 툴을 연속으로 호출하여 복잡한 작업 처리 (AI SDK 기반)
- **위험 작업 제안**: 삭제 등 위험 작업은 승인 후 실행
- **성격 조정**: 저장된 메모리 기반으로 말투/태도 자동 조정 (말투 자체는 유지)

### 🎵 음악 (Lavalink)
- YouTube / YouTube Music 검색 · 재생
- Components V2 재생 컨트롤러 패널 (재생/일시정지/스킵/대기열/볼륨/반복)
- 대기열 관리, 셔플, 특정 위치 탐색, 곡 제거
- 길드별 설정 영속화 (볼륨, 반복 모드, DJ 채널)
- 5분 자동 퇴장

### 💰 경제 시스템
- 매일 출석 보상 (+1,000원, KST 기준)
- 잔액 확인, 사용자 간 송금
- Supabase RPC 기반 원자적 연산

### 🎲 게임
- 동전 던지기, 주사위, 가위바위보

### 🛠️ 서버 관리
- 채널/카테고리 생성 · 삭제 · 수정 · 조회
- 멤버 조회, 역할 목록, 서버 정보
- 권한 점검

---

## 🧰 기술 스택

| 카테고리 | 기술 |
|---------|------|
| Runtime | Node.js 16.9+, TypeScript 5.4, SWC |
| 패키지 매니저 | pnpm 8.3 |
| Discord | discord.js 14, @discordjs/rest, discord-api-types |
| 프레임워크 | @pikokr/command.ts v5 |
| AI | Vercel AI SDK 7 (`@ai-sdk/google`, `@ai-sdk/openai-compatible`), zod |
| 음악 | Lavalink 4.2 + lavalink-client (YouTube KR 플러그인) |
| 데이터베이스 | Supabase (PostgreSQL) |
| 로깅 | tslog, winston |
| 프로세스 관리 | PM2 (선택) |

---

## 📁 프로젝트 구조

```
src/
├── index.ts                      # 진입점
├── config.ts                     # 설정 타입 (config.json 로드)
├── structures/Client.ts          # 모듈 자동 로더
├── modules/                      # 기능 확장 (9개)
│   ├── AiMentionExtension.ts     #   AI 멘션 디스패치 + 제안 승인
│   ├── MusicExtension.ts         #   /음악 (15개 서브커맨드)
│   ├── EconomyExtension.ts       #   /경제 (출석/잔액/송금)
│   ├── GameExtension.ts          #   /게임 (동전/주사위/가위바위보)
│   ├── AdminExtension.ts         #   /서버 (채널/카테고리/권한)
│   ├── MemoryExtension.ts        #   /memory (목록/삭제/초기화)
│   ├── LavalinkExtension.ts      #   Lavalink 이벤트 핸들러
│   ├── AutoLeaveExtension.ts     #   음성채널 자동 퇴장
│   └── Hello.ts                  #   /ping + ready
├── features/
│   ├── ai/                       # AI 시스템
│   │   ├── systemPrompt.ts       #   리시 페르소나 프롬프트
│   │   ├── geminiProvider.ts     #   1차: Gemini (AI SDK)
│   │   ├── opencodeZenProvider.ts#   2차: OpenAI 호환 (fallback)
│   │   ├── aiProviderChain.ts    #   primary → fallback 체인
│   │   ├── conversationStore.ts  #   인메모리 세션 (TTL 2h)
│   │   ├── memoryStore.ts        #   사용자 메모리 (Supabase)
│   │   ├── sessionReply.ts       #   답장 기반 대화 이어가기
│   │   ├── permissions/          #   3-Layer 권한 시스템
│   │   └── tools/                #   34개 AI 도구 + 레지스트리
│   ├── economy/economy.ts        # 경제 서비스
│   ├── game/game.ts              # 게임 로직
│   └── music/musicSettings.ts    # 길드별 음악 설정
├── music/                        # Lavalink 오디오 아키텍처
│   ├── lavalinkManager.ts        #   매니저 생성
│   ├── customPlayer.ts           #   Player 확장
│   ├── playerController.ts       #   컨트롤러 패널
│   ├── controllerInteraction.ts  #   버튼 인터랙션
│   └── ...
├── components/musicPanel.ts      # Components V2 재생 패널
└── events/messageCreate.ts       # 멘션 → AI 호출 플로우
```

---

## 🚀 설치 및 실행

### 사전 요구사항

- **Node.js 16.9+** (LTS 권장)
- **pnpm** (`corepack enable`)
- **Java** (Lavalink 실행용)
- Discord Bot Token + Application ID
- (권장) Gemini API Key
- (선택) OpenCode Zen API Key, Supabase 프로젝트

### 설치

```bash
pnpm install
```

### 설정

```bash
cp config.example.json config.json
```

`config.json`을 열어 값 입력:

```json
{
  "token": "DISCORD_BOT_TOKEN",
  "guilds": ["테스트_길드_ID"],
  "clientId": "봇_어플리케이션_ID",
  "lavalink": {
    "host": "localhost",
    "port": 2333,
    "password": "youshallnotpass",
    "secure": false
  },
  "ai": {
    "provider": "opencode-zen",
    "geminiApiKey": "GEMINI_API_KEY",
    "apiKey": "OPENCODE_ZEN_KEY",
    "model": "deepseek-v4-flash-free"
  },
  "supabase": {
    "url": "https://xxx.supabase.co",
    "secretKey": "service_role_key"
  }
}
```

### 실행

```bash
# 개발 모드
pnpm dev

# 빌드 + 프로덕션
pnpm build
pnpm start
```

**Lavalink + 봇 동시 실행:**

```bash
# Windows
.\start.ps1

# Linux/macOS
./start.sh
```

### Discord 설정

Privileged Intent에서 **MESSAGE CONTENT** 활성화 필수

---

## 🗄️ 데이터베이스 마이그레이션 (Supabase)

Supabase SQL Editor에서 순서대로 실행:

1. `data/migrations/001_create_user_memories.sql` — AI 메모리 테이블
2. `data/migrations/002_create_economy_music_rpc.sql` — 경제 + 음악 설정 + RPC 함수

---

## 🧠 AI 도구 목록 (34개)

리시가 대화 중 자유롭게 사용할 수 있는 도구입니다:

### 서버 관리 (16개)

| 도구 | 설명 |
|------|------|
| `get_server_info` | 서버 정보 조회 |
| `create_channel` | 채널 생성 |
| `delete_channel` | 채널 삭제 |
| `edit_channel` | 채널 수정 (이름/주제/NSFW/카테고리/위치) |
| `lookup_channel` | 채널 조회 |
| `list_channels` | 채널 목록 |
| `read_channel_messages` | 채널 메시지 읽기 |
| `create_category` | 카테고리 생성 |
| `delete_category` | 카테고리 삭제 |
| `list_category_channels` | 카테고리 채널 조회 |
| `reorder_category_channels` | 채널 순서 변경 |
| `edit_thread` | 스레드 수정 |
| `read_thread_messages` | 스레드 메시지 읽기 |
| `list_forum_posts` | 포럼 게시글 목록 |
| `read_forum_post` | 포럼 게시글 읽기 |
| `lookup_member` | 멤버 조회 |

### 음악 (12개)

| 도구 | 설명 |
|------|------|
| `play_music` | 음악 재생 (YouTube 검색/URL) |
| `stop_music` | 완전 정지 + 대기열 비움 |
| `pause_music` | 일시정지 |
| `resume_music` | 다시 재생 |
| `set_volume` | 볼륨 설정 (0-100) |
| `shuffle_queue` | 대기열 셔플 |
| `get_music_state` | 현재 재생 상태 확인 |
| `search_music` | 음악 검색 (재생 X) |
| `seek_music` | 특정 위치로 이동 |
| `skip_track` | 곡 건너뛰기 |
| `remove_from_queue` | 대기열에서 곡 제거 |
| `clear_queue` | 대기열 비우기 |

### 기타 (6개)

| 도구 | 설명 |
|------|------|
| `list_roles` | 역할 목록 |
| `lookup_role` | 역할 조회 |
| `save_memory` | 사용자 정보 기억 |
| `send_message` | 채널에 Components V2 메시지 전송 (텍스트/이미지/버튼/구분선) |
| `get_sticker` | 스티커 조회 |
| `send_sticker` | 스티커 전송 |

---

## 🎭 리시 페르소나

- **정체성**: AI이지만 따뜻한 성격의 조력자
- **말투**: 친근한 해요체, 간결함 우선 (2~3문장)
- **성격**: 친절함(최우선), 솔직함, 유머감각, 자신감
- **전용 이모지**: 8개 커스텀 이모지 (한 응답 최대 2개)
- **자발적 기억**: 사용자 정보를 자동으로 메모리에 저장
- **메모리 기반 조정**: 저장된 성향에 따라 태도/응답 길이/이모지 사용 조정 (말투는 유지)

---

## 📜 라이선스

MIT
