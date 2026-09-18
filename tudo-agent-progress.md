# lishibot 에이전트 증축 — 진행 로그 (tudo-agent-progress)

> 짝 문서: `tudo-agent-plan.md`(설계 청사진). 이 문서는 **회의 결정 + 실제 구현 진행**을 기록한다.
> 갱신: 2026-07-08 (KST). 충돌 시 결정 사항은 이 문서, 설계 근거는 plan 문서 기준.

---

## A. 프로젝트 정의 (확정)

- **대상**: FullMoon 디스코드 도우미 에이전트(코하루/칸나). 메인 길드 `1440598081648328816`.
- **범위**: **디스코드 내 작업만.** 프로젝트 코드 작업은 대상 아님.
- **UX 언어**: 사용자 노출은 전부 한국어(온보딩·응답·버튼·설명).
- **허용 유저**: 리시, 설연.
- **접근 방침**: 밑바닥 재작성 아님 → **증축**. `providerCore` 추출부터.

---

## B. 회의 확정 결정 (2026-07-08)

### 구조·순서
- **자율성(cron/heartbeat)을 앞에 두지 않는다.** 상태 영속화 · 승인 게이트 · rate-limit이 먼저.
- **확정 구현 순서**:
  1. 데이터 모델 (`server_profile` + agent self model + 권한 판정)
  2. 세션 DB (`guild:channel:user` 채널 키, 테이블 없으면 RAM fallback)
  3. 승인 게이트 (`onToolExecutionStart/End`로 위험 도구 직전 차단, 세션 삭제·채널 orphan 흡수)
  4. 온보딩 (서버 컨셉·권한·채널 용도·승인 정책 안내)
  5. 한국어 명령어 (`/에이전트` 서브커맨드 그룹, 각 authz 게이트)
  6. 자율성 (standing orders/rate-limit → cron → heartbeat)

### 세션
- **기존 RAM 세션은 전면 폐기.** 남길 대화 기록 없음(RAM Map뿐) → 호환 레이어·`messageIdToSession` 브리지 불필요.
- 처음부터 `guild:channel:user` 채널 키로 **클린 구축**.
- 만료 이원화: `session_started_at`(daily/KST 롤오버) + `last_interaction_at`(idle 2h).

### 승인·권한
- **승인 게이트가 온보딩보다 먼저.** 온보딩 중에도 위험 작업이 나올 수 있음.
- 프로필 없을 때 **안전 기본값 하드코딩**: 위험 도구는 무조건 관리자 승인. 온보딩이 이를 덮어씀.
- `onStepEnd`는 관측용으로만 충분, 승인 개입엔 부족 → `onToolExecutionStart/End` 필요.
- 권한은 신규 구축 불필요. `permissionCheck.ts`의 3계층(`requireAdmin`/`requireManageGuild`/`runtimeCheck`) 재사용.
- 위험 작업 UI는 Component v2 승인 카드. 세션 삭제·채널 orphan 처리도 승인 게이트 레인에 흡수.

### 온보딩
- 관리자 첫 진입 시 안내. 거부하면 2시간 / 24시간 / 다음 채팅까지 숨김.

### 자동화 아키텍처
- 자동화는 **자식 프로세스 worker**. 메인 봇이 권한·발화 통제.
- **통신: 신호는 IPC, 상태(작업 원장)는 DB.** = "실행은 IPC, 진실은 DB". worker 크래시 시 작업 유실 방지.
- cron: 인프로세스 `croner`가 실행 엔진, **진실 원천은 DB `cron_jobs`**. 부팅 시 DB에서 읽어 재등록.
- cron 샌드박스 원칙(plan §2 참조): 시스템 스케줄러 금지, 안전 액션 카탈로그(`kind` 화이트리스트)만, 실행 시 승인 게이트 통과, 등록은 관리자 한정.

### 인프라
- **DB는 Supabase Postgres 전용.** SQLite 도입 안 함(의존성조차 없음, DB 이원화 방지).
- 마이그레이션 **자동 러너 없음** → 수동 Supabase 적용. 그래서 "테이블 없으면 RAM fallback"이 필수.
- pgvector 차원 **하드코딩 금지**. `vector(1536)` 고정하지 말고 임베딩 모델 확정 후 별도 마이그레이션.

### 용어
- "티켓" → **"작업"**.

### 모델 역할 분배 (리시 확정, 2026-07-10 · 실측으로 확정)

**실측 결과 (2026-07-10, 이 서버):**
- **로컬 CPU 추론 ≈ 1.5 tok/s** (qwen3.5:4b, 40토큰 27.6s). GPU는 Intel Iris Xe뿐(NVIDIA 없음), `ollama ps`가 "100% GPU"라 떠도 실속도 이 수준. gemma4:8B는 10분 타임아웃. RAM 14GB→스왑 사용. **→ 로컬은 대화형 두뇌로 불가**(멀티스텝 도구 턴이 수 분~수십 분). 야간 배치(dreaming·요약) + 임베딩에만 적합.
- **gemma4:latest(8B)/gemma4:12b/qwen3.5:4b 모두 capability = tools+vision+thinking** ✅ (능력은 되나 속도가 발목).
- **`qwen3.5:cloud` = 403** (Ollama Cloud 인증/구독 필요, 미설정 → 현재 불가).
- **GLM-5.2 via zai-proxy (`http://localhost:18088/v1`, OpenAI-호환) 스모크 통과**: 도구(간단) play_music 14.9s, 도구(위험) delete_channel 5.6s, 잡담 4.9s(도구 안 부름). 전부 정확. **turn당 5~15s = 대화형 OK.** zai-proxy는 이미 pm2로 2일째 구동(z.ai 다중키 롤링, 키는 Cloudflare Worker JWT — 로컬 미저장). 노출 모델: glm-4.5~4.7 / glm-5 / 5-turbo / 5.1 / **5.2**.

**확정 구성 (전부 이미 이 서버에 존재):**
- **두뇌(인지 루프·판단·도구 호출): GLM-5.2** via zai-proxy `http://localhost:18088/v1`, model=`glm-5.2`. 기존 `createOpencodeZenProvider`(OpenAI-호환) 패턴 그대로 — baseURL/model만 지정. **Gemini primary 대체 → Gemini 완전 제거**(무료 rate limit 탈피).
- **눈(이미지): 미확정** — zai-proxy 목록에 vision 전용 모델 없음(glm-4.5v 등 미노출). 옵션: (a) GLM vision 모델 프록시 추가, (b) 로컬 gemma4 vision을 드문 이미지 판독에만(1장 ≈ 1분, 감내). 본체 공사 때 결정.
- **잡무(요약·압축·dreaming): 로컬 Ollama**(gemma4/qwen, 야간 배치라 속도 무관, 무료).
- **임베딩(기억 검색): `embeddinggemma`(768차원)** — 이미 설치·구동 중. plan §7 미결정 2번 해소 → pgvector `vector(768)` 확정, 마이그레이션 작성 가능.

plan §7 미결정 3번(모델 등급) 해소. 배경: 현 구조가 "툴 쓰는 챗봇"임을 리시가 확인, 본체 공사(인지 루프·작업 원장·기억 구조·자기 갱신·지각)는 별도 대형 트랙으로 합의.
---

## C. 구현 진행 상태

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | provider 통합 (`providerCore.ts` 추출, 동작 동일성) | ✅ 완료 (build/eslint 통과) |
| 2 | `toolHistory` read 연결 | ✅ 완료 |
| — | 데이터 모델 `021_ai_agent_sessions.sql` (`ai_sessions`/`ai_session_messages`/`server_profile`) | ✅ 완료 · **Supabase 실적용 완료(2026-07-08)** (pgvector 하드코딩 제외) |
| 4 | 세션 DB write-through + 채널 키 + RAM fallback | ✅ 완료 (아래 D) · 재점검 통과, 롤오버 우회 패치 완료 (D-2) |
| 3 | 승인 게이트 (위험 도구 `execute` 래핑으로 실행 직전 차단) | ✅ 완료 (D-3) · 적대 리뷰 통과, 정리 2건 조치 |
| 4a | 온보딩 (서버 프로필 로더 + 관리자 첫 진입 안내 + 거부 숨김) | ✅ 완료 (D-4) |
| 5 | 한국어 명령어 (`/에이전트` 5종 + 승인 정책 DB 배선) | ✅ 완료 (D-5) |
| 6-1 | standing orders (agent_scope + 프롬프트 주입 + `/에이전트 설정_지침`) | ✅ 완료 (D-7) |
| — | 세션/주입 구멍 A(신규멘션 채널키)·B(server_profile 주입) 수정 | ✅ 완료 (D-7) |
| 6-2 | cron 전체 (기반 + 실행부 + 예약 도구 3종) | ✅ 완료 (D-8/D-9) |
| 6-3 | heartbeat (폴링/5중 게이트/발화/명령어, 기본 OFF) | ✅ 완료 (D-9) |
| — | 온보딩 dismiss DB영속 (칸나 리스크 3) | ✅ 완료 (D-9) |

---

## D. 4번 세션 DB — 완료 상세

**변경 파일**: `conversationStore.ts`, `sessionReply.ts`, `AiMentionExtension.ts`

- RAM Map → Postgres write-through 캐시. 세션 키 `guild:channel:user`.
- 쓰기는 fire-and-forget, 세션별 persist 직렬화 체인으로 upsert→insert 순서 보장(FK 위반 방지).
- 부팅 시 `loadAiSessions()`로 idle TTL 안쪽 세션 복원.
- 테이블 부재(42P01) 시 조용히 RAM fallback.

**검토(칸나) 반영 3건**:
1. **연속 실패 카운터** — `logDbFailure`가 실제 DB 실패를 카운트, 임계치 5회 넘으면 `logger.error` 한 번만 올리고 이후 조용히. 성공 시 리셋. 42P01·예외 경로 포함.
2. **롤오버 시 무조건 새 세션** — `rolledOver`면 이어갈 스레드가 있어도 새 세션. 자정 넘으면 새 대화.
3. **`persistSessionMeta` 분리** — 생성 시점만 full upsert. 매 turn은 `touchSessionMeta`(last_interaction_at 한 컬럼), 도구 실행 시만 `persistToolHistory`(tool_history JSON). 순서 민감해 debounce/skip 미사용.

*build(tsc)·eslint 모두 통과 확인.*

---

## D-2. 재점검 결과 + 롤오버 패치 (2026-07-08)

세션 복원 직후, 완료 주장(1/2/데이터모델/4)을 병렬 에이전트로 코드 대조. **작업 위치 확정: 이전 AI 작업은 전부 메인 리포(`~/lishibot`) `main` 브랜치에 미커밋 상태 → 여기서 직접 이어감** (이 워크트리엔 없음).

**검증 판정:**
- **1 providerCore + onStepEnd**: ✅ 확인. 공통 로직(`toModelMessages`/`buildZodSchema`/`buildToolsParam`/`extractToolRecords`/`runGenerate`) 집약, 두 프로바이더는 얇은 래퍼, `onStepEnd`(providerCore.ts:152) 연결, `stepCountIs(20)` 유지. **단 `onStepEnd`는 관측 전용** → 3번은 도구 `execute` 래핑으로 실행 직전 차단해야 함(계획서 예고대로).
- **2 toolHistory read**: ✅ 확인 (`getToolHistory`→`formatToolHistoryForPrompt`→promptParts 주입).
- **데이터 모델 021**: ✅ 확인. `server_profile` 포함, pgvector 하드코딩 없음, 스케치보다 엄격(NOT NULL/인덱스/RLS).
- **4 세션 DB**: ⚠️→✅. 메인 주장·검토반영3 완전 확인. 발견된 흠 2건:
  1. **🟡 롤오버 우회** — 답장-추적 경로(`sessionReply` `getSessionByMessage`→`reviveSession`)가 자정 KST 롤오버를 건너뜀. → **패치 완료** ↓
  2. **🟢 실패 카운터 로그 문구** — 임계치 후 `error` 재알림만 억제되고 `logger.warn`(conversationStore.ts:78)은 매 실패 지속. 주석 "그 뒤엔 다시 조용히"와 불일치. **기능 결함 아님 → 미룸**(4번 마무리 시 주석/로그 정리).
- **빌드/린트**: ✅ tsc·eslint exit 0.

**롤오버 패치 (완료):**
- `conversationStore.ts`에 `continueSession(referencedMessageId)` 신설: 추적 세션이 같은 KST 날짜면 revive 후 sessionKey 반환, 자정 넘겼으면 `deleteSession` 후 `undefined` → 호출자가 새 세션 생성(getOrCreateSession 롤오버 경로와 동일 규율).
- `reviveSession`(void)은 **그대로 유지** — `AiMentionExtension.ts:347` 위험도구 확인-실행 경로가 쓰고 있고, 그 경로는 3번에서 재작업할 코드라 건드리지 않음.
- `sessionReply.ts`는 `getSessionByMessage`+`reviveSession` 대신 `continueSession` 사용. build/lint 통과.

---

## D-3. 3번 승인 게이트 — 구현 완료 (2026-07-08)

**착수 전 매핑에서 확인된 사실**: 승인 흐름의 ~90%가 이미 "죽은 스캐폴딩"으로 존재했음.
- `pendingProposals` Map은 `.get()`/`.delete()`만 있고 **`.set()`이 리포 전체에 0건** → 확인 블록(confirmWords "네/응" → L3 재검 → 직접 execute) 전체가 도달 불가 죽은 코드 (**B1 버그 확정**).
- `ToolPermission.risk`(`info`/`warning`/`danger`)가 **53개 도구 전부에 채워져 있으나 읽는 코드 0건**. danger ~10개(delete_channel/ban/kick/delete_role/set_role_permissions 등).
- `buildProposalEmbed` 승인 카드도 정의만 있고 호출부 0건.
- 유일한 살아있는 게이트는 도구 "노출 필터"(buildToolDefinitions의 L3 사전검사)뿐 — 노출된 danger 도구는 모델이 루프 안에서 확인 없이 즉시 실행.
- SDK 제약: `generateText` 자율 멀티스텝 루프라 execute 안에서 사람 승인을 await 불가 → "루프 내 보류 + 루프 밖 후속 실행" 구조가 유일하게 안전.

**확정 정책 (리시, 2026-07-08)**:
1. **danger만 게이트** — warning/info는 기존대로 즉시 실행 (온보딩에서 정책으로 조정 가능).
2. **V2 카드 + 버튼** — [실행 승인](빨강)/[거부](회색). 답장-confirmWords 방식 폐기(오탐 위험).
3. **요청자 본인만 결정 + 승인 시점 L3 재검**(관리자 요건) — "위험 도구는 무조건 관리자 승인" 충족.

**구현 (신규 1 + 개편 2)**:
- **`src/features/ai/approvalGate.ts` (신규)** — `ProposalCollector`: danger 도구 호출을 가로채 실행하지 않고 제안 기록(`ApprovalProposal`, UUID id), 모델에는 `success:true` + "보류했어요, 재시도 말고 사용자에게 버튼 안내" sentinel 반환(재시도 루프 방지). 같은 (도구,인자) 중복 제안 dedupe. `drain()`으로 generate 종료 후 수거. `APPROVAL_TTL_MS` 5분.
- **`src/features/ai/tools/proposalCard.ts` (개편)** — 죽은 `buildProposalEmbed`/`severityColor` 제거. Components V2 승인 카드 `buildApprovalCard`(본문+구분선+안내+버튼 ActionRow), 처리 후 카드 `buildResolvedApprovalCard`(버튼 제거+상태줄). customId `aiApproval:approve|deny:<uuid>` 빌드/파싱. `toolNameMap`/`formatArgsForEmbed` 재사용.
- **`src/modules/AiMentionExtension.ts` (배선)**:
  1. `buildToolDefinitions`에 collector 파라미터 추가, execute 래퍼에서 `risk==='danger'`면 `collector.propose()` (초크포인트 인터셉트 — 멘션/답장 두 경로 모두 통과).
  2. generate 종료 후 `sendApprovalCards()`: 제안별 V2 카드 전송 → `pendingApprovals.set(proposalId, proposal)` (**B1 해소** — 이제 맵이 실제로 채워짐).
  3. `@listener interactionCreate` 버튼 핸들러: customId 파싱 → 제안 조회(없으면 ephemeral "만료/처리됨") → **요청자 본인 검증** → **맵에서 먼저 delete(더블클릭/중복 소비 방지)** → deny면 카드 상태 치환 → TTL 검사 → `toolRegistry.get` → **승인 시점 권한으로 L3 재검** → 카드 "승인됨" 치환 → **루프 밖 `toolDef.execute`** → 세션 기록(`getOrCreateSession` 경유로 롤오버 규율 준수) + `appendToToolHistory` + followUp 결과 메시지(세션 바인딩).
  4. 죽은 confirmWords 블록(~122줄) 제거, 미사용 `reviveSession` import 정리.

**동작 흐름 요약**: 모델이 danger 도구 호출 → 루프 안에서 보류 + 모델이 사용자에게 안내 → 봇이 승인 카드 전송 → 요청자가 [실행 승인] 클릭 → L3 재검 통과 시 실행 → 결과 메시지(답장으로 대화 이어가기 가능).

*build(tsc)·eslint 통과.*

**적대 리뷰 완료 (4렌즈, 2026-07-08):**

1. **우회 가능성** — ✅ 안전. danger 도구는 `buildToolDefinitions`의 execute 래퍼(L138)에서 `risk === 'danger'` 체크로 가로채며, 멘션/답장 두 경로 모두 동일 래퍼 사용. 직접 `toolDef.execute`를 호출하는 경로는 승인 버튼 핸들러(L585)뿐이고, 승인 시점 L3 재검(L569-578)을 거침. 우회 경로 없음.
2. **버튼 상태머신** — ✅ 안전. 맵 delete를 승인/거부 결정 전에 선행(L524) → 더블클릭/동시클릭 레이스 방지. 두 번째 클릭은 L493에서 "이미 처리됐거나 만료" ephemeral. TTL 만료 검사 L551 존재. `interaction.update()` → `followUp()` 순서는 discord.js 14.26에서 유효(update=원본 수정 응답, followUp=webhook 추가 메시지).
3. **에이전트 루프 의미론** — 🟡 경미. sentinel이 `success:true`로 toolHistory에 남음 → 다음 턴 `formatToolHistoryForPrompt`에서 "danger_tool (성공) result=보류했어요..." 형태로 주입. 모델이 "성공적으로 보류됨"으로 읽으므로 실질적 혼동 낮음. 승인 후 실제 실행이 별도 appendToToolHistory(L597-604)로 기록되어 상태 추적 가능. → **미룸** (개선: formatToolHistoryForPrompt에서 보류 sentinel 구분 표시, 우선순위 낮음).
4. **회귀** — ✅ 안전. `buildProposalEmbed`/`severityColor` 참조 0건(moderationActions의 severityColor는 무관). `confirmWords` 참조 0건. customId `aiApproval:` prefix는 다른 Extension(`ctrl:`, `drop_`, `server_log_` 등)과 겹치지 않음.

**리뷰 후 정리 조치 (2건, build/lint 통과):**
- `toolTypes.ts`의 `ProposalInfo` 타입 제거 — 카드 개편으로 소비처 전부 소멸, `ApprovalProposal`(approvalGate.ts)이 대체.
- `conversationStore.ts`에서 `reviveSession` export 제거 — 외부 import 0건, 내부에서 `continueSession`만 사용. public API 축소.

---

## D-4. 4번 온보딩 — 서버 프로필 로더 + 관리자 온보딩 안내 (2026-07-08)

**신규 파일 3개**:

- **`src/features/ai/serverProfile.ts`** — 서버 프로필 로더 + RAM 캐시(10분 TTL).
  - `getServerProfile(guildId)`: 캐시 → DB → 하드코딩 기본값 fallback. 절대 throw하지 않음.
  - `upsertServerProfile(guildId, partial)`: 부분 업데이트 → RAM 캐시 + DB.
  - `ApprovalPolicy` 타입: `dangerGate: 'admin_only' | 'requester' | 'none'`. 기본값 `admin_only` (하드코딩 안전기본값과 동일).
  - 테이블 부재(42P01) 시 기본값 반환 (기존 `logDbFailure` 패턴 준수).

- **`src/features/ai/onboarding.ts`** — 온보딩 상태 추적 + 거부 숨김.
  - `shouldShowOnboarding(guildId, isAdmin)`: 관리자 + 미온보딩 + 미숨김이면 `'show'`.
  - `dismissOnboarding(guildId, duration)`: RAM-only 숨김. `2h`/`24h`(시간 기반 만료) / `next_chat`(다음 messageCreate에서 해제).
  - 거부 상태는 **의도적으로 RAM-only** — 봇 재시작 시 리셋되어 미온보딩 서버에 다시 안내.

- **`src/features/ai/onboardingCard.ts`** — Components V2 온보딩 카드.
  - `buildOnboardingCard(guildId)`: 환영 + 기능 소개 + 4버튼([온보딩 완료]/[2시간 뒤에]/[오늘 안 볼래요]/[닫기]).
  - customId: `aiOnboarding:start|dismiss2h|dismiss24h|dismissChat:<guildId>` (다른 Extension과 충돌 없음).
  - `buildOnboardingResolvedCard(statusLine)`: 결정 후 버튼 제거 + 상태줄 치환.

**배선 (`AiMentionExtension.ts`)**:
  1. `messageCreate` — AI 응답 완료 후(응답을 막지 않음) `shouldShowOnboarding` 체크 → `'show'`이면 온보딩 카드를 추가 메시지로 전송.
  2. `onboardingInteraction` — `aiOnboarding:` 버튼 핸들러. 관리자 검증 → `start`(DB upsert `onboarded_at`+완료 카드) / `dismiss*`(RAM 숨김+상태 카드).

**설계 결정**:
- 온보딩은 AI 응답을 **막지 않는다** — 추가 안내 메시지로만 전송.
- 이번 단계에서 `start`는 단순히 `onboarded_at` 기록 + 완료 카드. 세부 세팅(서버 컨셉·채널 용도 등)은 `/에이전트 설정` 명령어 단계에서.
- `approval_policy` 연결은 타입만 준비. 승인 게이트의 동작은 변경하지 않음(여전히 하드코딩 안전기본값).

*build(tsc)·eslint 통과.*

---

## D-5. 5번 한국어 명령어 — `/에이전트` 그룹 + 승인 정책 DB 배선 (2026-07-08)

**변경 파일**: `conversationStore.ts`(헬퍼 2종), `AiMentionExtension.ts`(커맨드 그룹 + 정책 배선)

**세션 헬퍼 (conversationStore.ts)**:
- `getActiveSessionsCount(guildId)` — 만료/고아 아닌 활성 세션만 카운트 (`/에이전트 상태`용).
- `clearSessionsForChannel(guildId, channelId)` — `guild:channel:` prefix 매칭으로 해당 채널 세션 전부 `deleteSession`(DB CASCADE 포함) 후 삭제 수 반환.

**`/에이전트` 서브커맨드 5종 (AdminExtension의 `SubCommandGroup` 패턴)**:
| 명령어 | 동작 |
|---|---|
| `상태` | 활성 세션 수 + 길드별 승인 대기 건수(만료 prune 후) + 프로필 요약(컨셉/정책/채널 용도 최대 5개/온보딩). ephemeral |
| `설정_컨셉` | `server_profile.concept` 저장 (max 500자, trim 후 빈 값 거부) |
| `설정_채널` | `channelRoles[channelId]` 설정/제거 (`용도` max 200자, `삭제` Boolean 옵션) |
| `설정_정책` | `approvalPolicy.dangerGate` 변경 (choices: admin_only/requester/none, none 선택 시 경고 문구) |
| `세션_초기화` | 현재 채널 세션 전부 삭제, 삭제 수 안내 |

- 전부 `requireServerManager` 게이트. 단 **전역 `applicationCommandInvokeError` 핸들러는 로그만 남기고 사용자 응답이 없음**(Hello.ts:137 확인) → `guardServerManager` 헬퍼가 `CommandAccessError`를 흡수해 ephemeral로 거부 사유 안내 (AdminExtension의 bare-throw 패턴과 의도적으로 다름).

**승인 정책 DB 배선 (하드코딩 → `server_profile.approvalPolicy.dangerGate`)**:
1. **게이트 진입** — danger 도구 execute 래퍼가 `getServerProfile(guildId)` 조회. `none`이면 게이트 우회 즉시 실행(로그 남김), 그 외엔 기존대로 `collector.propose()`. 프로필 조회 실패 시 `getServerProfile`이 안전 기본값(admin_only)을 반환하므로 fail-safe.
2. **결정 주체** (D-3 결정 3 "요청자 본인만 결정"을 **정책 기반으로 대체**):
   - `admin_only`(기본값): **관리자(Administrator) 또는 서버 오너만** 승인/거부 가능. 요청자여도 관리자 아니면 불가.
   - `requester`: 요청자 본인만 (기존 동작).
   - `none`: 제안 자체가 안 생기지만, 보류 중 정책이 바뀐 잔여 제안은 requester 규칙으로 처리.
   - 결정 주체 검사는 맵 delete(단일 소비) **앞**에 위치 — 권한 없는 클릭이 제안을 소비하지 않음.
   - 승인 시점 L3 재검(클릭자 권한 기준)은 그대로 유지.

*build(tsc)·eslint 통과.*

---

## D-6. 021 마이그레이션 Supabase 실적용 (2026-07-08)

Supabase MCP(`apply_migration`)로 `021_ai_agent_sessions.sql`을 원격 프로젝트에 직접 적용. 사전에 `list_tables`/`list_migrations`로 미적용·무충돌 확인(마이그레이션 이력은 019까지, 020/021 모두 로컬에만 존재 — 021은 신규 테이블만 만들어 020 미적용과 무관).

- 결과: `ai_sessions`(FK 포함) / `ai_session_messages`(`session_key` FK → `ai_sessions`) / `server_profile` 3개 테이블 생성 확인. 컬럼 스키마가 마이그레이션 원본과 정확히 일치, RLS 전부 활성화, 데이터 0건.
- 보안 어드바이저 `rls_policy_always_true` WARN 3건(신규 테이블마다 1개) — **신규 문제 아님**. 이 리포 기존 테이블 전부(`random_drops`/`moderation_settings` 등)가 쓰는 동일 관례(`FOR ALL USING (true) WITH CHECK (true)`, 봇이 anon key로 서버측에서만 접근)라 조치 불필요.
- 이제 코드가 RAM fallback이 아니라 **실제 Postgres 세션 영속** 경로로 동작. `020_fix_schema_code_drift.sql`은 여전히 미적용 상태(별개 트랙, AI 기반과 무관).

---

## D-7. 6-1 standing orders + 세션/주입 구멍 2개 (2026-07-08)

**6-1 standing orders (완료)**
- `serverProfile.ts`: `agent_scope`(JSONB) 재사용 → 새 마이그레이션 없이 상시 지침 저장. `getStandingOrders`/`setStandingOrders`.
- `formatServerContextForPrompt(guildId, channelId)` — 서버 컨셉 + 이 채널 용도 + 상시 지침을 한 블록으로 프롬프트에 주입.
- `/에이전트 설정_지침` (추가/조회/초기화, 최대 10개).

**착수 중 발견·수정한 구멍 2개**
- **A (4번 구멍)** — 신규 멘션 경로(`events/messageCreate.ts`)가 세션을 채널키(`guild:channel:user`)로 저장하면서 읽기(`getHistory`/`toolHistory`)는 옛 `guild:user` 키로 함 → 매 신규 멘션마다 이전 맥락 유실(답장 경로만 정상이라 그동안 안 드러남). 읽기 키를 채널키로 수정.
- **B (5번 갭)** — `설정_컨셉`/`설정_채널`이 DB 저장만 하고 프롬프트 주입이 없어 AI가 설정을 몰랐음. 멘션·답장 두 경로에 `formatServerContextForPrompt` 주입 배선.

**리스크 1·2 (칸나 검토, 앞서 반영)**
- 승인 거부를 `appendToToolHistory`로 남겨 모델이 인지(재시도 방지).
- 승인 카드 문구를 정책(`admin_only`/`requester`)에 맞춰 분기.

*build(tsc)·eslint 통과.*

---

## D-8. 6-2 cron 기반 착수 (2026-07-08)

**모델 재정의 (리시)**: cron은 정적 액션 목록이 아니라 **"유저 요청을 AI가 예약 등록 → 정한 시각에 AI 턴 실행"**. `kind='agent_prompt'`, `payload`에 유저 요청 프롬프트. 실행 시점에도 danger 도구는 승인 게이트(사람 없으면 TTL 만료로 미실행 = fail-safe). 샌드박스 유지 — cron은 임의 코드 못 부르고 등록된 도구만 쓰는 AI 턴을 돌림.

**완료 (빌드 통과)**
- `croner` 10.0.1 설치.
- `022_cron_jobs.sql` — 진실 원천 테이블(guild/channel/kind/schedule/payload/tz/created_by/실행상태). **Supabase 실적용 완료(2026-07-08, D-10)**.
- `cronStore.ts` — DB CRUD(생성/목록/취소/실행상태) + 부팅 로드. 테이블 없으면 무동작 fallback.
- `cronScheduler.ts` — croner 래핑. 부팅 재등록(`loadAndRegisterAll`), 빈도 상한 5분(`validateSchedule`), 실행부는 `CronRunner` 주입.

**남은 것 (6-2 미완)**
- 실행부: cron 트리거 → AI 턴 실행(멘션 응답 흐름 재사용) → danger 승인 게이트 → 결과 채널 전송.
- 예약 도구 3종(예약/목록/취소) — AI가 유저 요청으로 호출. 등록 권한(허용유저/관리자), 조용채널 존중.
- 부팅 연결(`clientReady`에서 runner 주입) + 관리자 명령어.

---

## D-9. 6-2 cron 실행부·도구 + 6-3 heartbeat + 온보딩 dismiss 영속 (2026-07-08)

**6-2 cron 완결**
- 실행부 `runScheduledJob`(AiMentionExtension): 예약 시각 → 저장된 요청으로 AI 턴 → 결과 채널 전송. `buildToolDefinitions`를 message→context 기반으로 리팩터해 멘션/답장/cron 세 경로가 공유(기존 두 경로 동작 보존). `sendApprovalCards`는 콜백화(멘션·답장=답장, cron=채널 전송). 등록자 권한으로 도구 노출, danger는 실행 시점 승인 카드(사람 없으면 TTL 만료 = fail-safe).
- 예약 도구 3종 `scheduleTools.ts`: `schedule_task`/`list_scheduled_tasks`/`cancel_scheduled_task`. 등록은 requireManageGuild, 빈도 5분. `cronScheduler`를 전역 runner 방식으로 바꿔 도구가 즉시 croner 등록.
- 부팅: `setCronRunner` + `loadAndRegisterAll`.

**6-3 heartbeat (기본 OFF)**
- 30분 폴링(`runHeartbeat`) → 5중 게이트(OFF / 조용시간 23~8시 / rate-limit 하루 4회 / cron 실행중 defer / 채널 미지정) → 통과 시 `heartbeatSpeak` AI turn 1회. 폴링 자체는 AI 없이 규칙 체크만.
- 발화 판단: "먼저 말 걸 이유 없으면 NO_REPLY" → 무발화(exact match). 위험 도구는 승인 카드 그대로.
- `cronScheduler.isAnyJobRunning()`(RAM)로 cron defer 판정. 발화 후 2시간 쿨다운.
- `/에이전트 설정_자동말 켜기 채널`로 관리자만 on/off, 끄면 즉시 적용. `agent_scope.heartbeat={enabled,channelId}`.
- 칸나 리뷰 반영: NO_REPLY exact match, 발화 후 쿨다운 2h.

**온보딩 dismiss 영속 (칸나 리스크 3)**
- 2h/24h 숨김을 `agent_scope.onboardingDismissedUntil`에 저장(재시작해도 유지). next_chat만 RAM.

*build(tsc)·eslint 통과.*

---

## D-10. 022 마이그레이션 Supabase 실적용 (2026-07-08)

Supabase MCP(`apply_migration`)로 `022_cron_jobs.sql`을 원격 프로젝트에 직접 적용. 사전 `list_tables`로 `cron_jobs` 미존재 확인(021 테이블 3종은 그대로 유지).

- 결과: `cron_jobs` 테이블 생성. `information_schema.columns`로 14개 컬럼 스키마 검증 — 마이그레이션 원본과 정확히 일치(`id` bigserial PK, `guild_id`/`kind`/`schedule`/`created_by` NOT NULL, `payload`/`tz`/`enabled` DEFAULT, `last_run_status` nullable). RLS 활성 + `Allow all` 정책(리포 기존 관례).
- 이제 예약(`schedule_task`)이 실제 DB에 저장되고 부팅 시 croner 재등록 경로가 활성화됨(이전엔 "저장 실패" 무동작 fallback).
- **DB 배포 완료.** 남은 건 런타임 스모크(봇 재시작 필요, §E)와 `package.json`/`pnpm-lock` 정리 커밋뿐.

---

## D-11. 빌드·배포·부팅 스모크 (2026-07-08)

`pnpm build`(tsc, exit 0) → `pm2 restart lishibot`(id 4, `node dist`). 새 pid 64061, 재시작 카운트 28에서 안정(크래시 루프 아님), 에러 로그 무증가(마지막 수정 07:06 = 구 인스턴스).

**부팅 로그로 확인된 것:**
- `[AI] Gemini + OpenCode Zen 체인 구성 완료` · `Logged in as 리시봇#1780`.
- 슬래시 명령어 13종 등록에 **`에이전트` 그룹 포함** (두 길드 모두 sync 성공).
- `[AiSession] 0개 AI 세션 로드 완료` → **021 `ai_sessions` 실연결**(테이블 부재 fallback 아님).
- `[CronScheduler] 0개 예약 등록 완료` → **022 `cron_jobs` 실연결**(부팅 재등록 경로 정상, 저장 실패 아님).
- heartbeat는 `clientReady`에서 30분 폴링 setInterval 등록(기본 OFF라 첫 폴링까지 로그 없음 = 정상).

**부팅 스모크 통과.** 남은 건 사람 조작이 필요한 인터랙티브 스모크(§E).

---

## D-12. `/에이전트` UX 개편 — 셋업 패널 + 소울 (2026-07-08)

**리시 피드백**: 평면 서브커맨드 6종(`설정_컨셉`/`설정_채널`/`설정_지침`/`설정_자동말`/`설정_정책`/`세션_초기화`)이 어색함 → **패널 방식**으로. 그리고 에이전트 정의 재확인: *"서버를 이해하고, 내가 누구인지(소울), 스스로 성장하는 에이전트."*

**명령 체계 (확정)**:
- `/에이전트 셋업` — 설정 패널 하나로 전부 흡수. 에이전트에게 정체성과 서버 이해를 심어주는 곳.
- `/에이전트 상태` — 읽기 전용 요약(소울·컨셉·지침 수·정책·자동발화·세션·승인대기·예약·채널용도·온보딩). ephemeral.
- 나머지 서브커맨드 6종 전부 삭제.

**소울(정체성) 신설** — OpenClaw SOUL.md 대응:
- `serverProfile.ts`: `getSoul`/`setSoul` (`agent_scope.soul`, 새 마이그레이션 불필요).
- `formatServerContextForPrompt`가 소울을 **맨 앞줄**로 주입("나의 소울(정체성): …") → 멘션·답장·cron·heartbeat 모든 AI 턴에 반영.
- 남은 축 "스스로 성장"은 plan 기반1(메모리 tier·active recall·dreaming) 트랙 — 다음 증축 후보.

**신규 `agentSettingsPanel.ts`** — 관리로그 패널(serverLogPanel) 관례(ContainerBuilder V2 + `interaction.update`) 준수:
- 컨테이너 6개: 헤더(상태 요약) / 🪞 정체성·서버 이해(소울·컨셉·지침 + 편집 버튼 4개) / 🛡️ 승인 정책(StringSelect 3택) / 🔔 자동 발화(토글 버튼+채널 선택) / 🗂️ 채널 용도(채널 선택→용도 입력·제거) / 🧹 세션(초기화+새로고침).
- 자유 텍스트는 **모달**(LabelBuilder 최신 관례 — deprecated ActionRow<TextInput> 아님): 소울(1000자)/컨셉(500자)/지침(300자)/채널용도(200자). 비우면 삭제.
- 각 조작 **즉시 적용** 후 패널 재렌더(드래프트-저장 아님 — 설정이 독립적이라 즉시 반영이 덜 헷갈림). 승인정책 none이면 패널 강조색 경고색으로.
- customId: `agentcfg:` / 모달 `agentcfgModal:` (충돌 맵에 추가).

**Extension 배선**: `buildPanelData`/`updatePanel`/`canManagePanel`(컴포넌트·모달용 권한 검사) + `agentConfigInteraction`(컴포넌트)/`agentConfigModal`(모달 제출, `isFromMessage`면 패널 갱신) 리스너 2개. 패널 선택 채널 상태는 `panelSelectedChannel`(guildId 키, RAM).

**배포**: build/lint exit 0 → pm2 재시작(29회째, 안정, 에러 0). 두 길드 커맨드 sync 성공. **`[AiSession] 1개 AI 세션 로드`** — 재시작 전 대화가 DB에서 복원됨(세션 영속 실전 첫 증명).

---

## D-13. 승인 게이트 위험도 재분류 (2026-07-09)

**배경**: 리시가 `edit_channel`(채널 주제 수정)이 승인 없이 실행되는 걸 지적 → 위험도 분류가 리시 356 원안("역할 권한·역할 배치·채널 권한·채널 배치·채널 수정 = 승인 대상")과 항목별로 어긋난 사례가 더 있는지 전수 재점검. 코하루·칸나 합의로 확정.

**정적 승격 (warning → danger)**:
- `edit_channel` — 앞선 턴에 이미 danger로 수정(리시 지적 직접 대응).
- `edit_role`(roleManageTools.ts) — 역할 수정에 권한 변경 포함.
- `timeout_member`(memberActionTools.ts) — 제재 수단. ban/kick(danger)과 대칭.
- `move_all_members`/`disconnect_all_members`(voiceBulkTools.ts) — 대량 음성 조작.
- 확인만: `reorder_role`·`set_role_permissions`·`delete_*`·`ban/kick`은 **이미 danger**. `create_*`류는 되돌리기 쉬워 warning 유지(합의).

**동적 판정 (add_role_member / remove_role_member)**: 전부 danger는 색깔 역할까지 매번 승인이라 과함 → **대상 역할 권한으로 실행 시점 분기**.
- 신규 `tools/helpers/roleRisk.ts`: `SENSITIVE_ROLE_PERMISSIONS`(Administrator/ManageGuild/ManageRoles/ManageChannels/ManageWebhooks/BanMembers/KickMembers/ManageMessages) 중 하나라도 가진 역할 → danger, 아니면 정적 warning(즉시 실행). `roleAssignmentIsSensitive`가 role_id/role_name을 캐시로 해석, **판정 불가 시 fail-closed(danger)**.
- `AiMentionExtension.buildToolDefinitions`의 게이트를 정적 `toolDef.permission.risk` 대신 신규 `resolveEffectiveRisk(toolDef, args, context)`로 교체. 이 게이트는 멘션·답장·cron·heartbeat 전 경로가 공유하므로 자동 반영.

**배포**: build/lint exit 0 → pm2 재시작(33회째, 안정, 에러 0). 두 길드 sync 성공, AI 세션 1개 복원. **스모크 잔여**: 관리 권한 역할 부여 시 승인 카드 뜨는지 / 색깔 역할은 즉시 부여되는지 실제 클릭 확인.

---

## D-14. 승인 카드 임베드화 + 요청자 세부 권한 주입 (2026-07-09)

**배경**: 리시 지적 2건 — (1) 승인 카드를 임베드 룩으로 디자인 개선 + `<:kawaiicaution:1521755658792206366>` 사용, (2) 대화 시 요청자 세부 권한이 AI에 안 넘어감. 코드 대조로 확증: `permissionInfo`가 `isOwner`/`hasManageGuild` 두 boolean(주인/관리자/일반 3단계)으로만 판정, 세부 권한(채널/역할/메시지 관리·밴 등) 미주입.

**승인 카드 재디자인 (proposalCard.ts)**:
- `TextDisplayBuilder`만 쓰던 것을 `ContainerBuilder`(accent color 바 = 임베드 룩)로 전환. agentSettingsPanel 관례 따름.
- accent 분기: 결정 전 = 빨강(0xed4245), 승인(✅) = 초록(0x57f287), 거부/만료/실패 = 중립 회색(0x99aab5).
- 헤더에 `KAWAII_CAUTION` 이모지. 작업/세부내용/결정 주체/만료 구조화. 버튼 유지. 호출부(sendApprovalCards·interaction.update) 무변경(반환 `{components,flags}` 동일).

**요청자 세부 권한 주입 (A안 = 핵심 관리 권한만)**:
- 신규 `permissionSummary.ts`: `summarizeMemberPermissions(perms, {isOwner})` — 핵심 관리 권한 11종(서버/역할/채널/메시지 관리·밴/추방·타임아웃·웹훅/이벤트/스레드/닉네임 관리)만 추려 한 줄 요약. 주인·Administrator는 "모든 권한"으로 뭉침.
- 멘션(messageCreate.ts)·답장(sessionReply.ts)·cron(runScheduledJob) 세 경로 `permissionInfo`에 배선. 기존 3단계 fallback 보존(permissionSummary 미제공 시).
- systemPrompt.ts: "(권한: ...)" 해석 규칙 — 작업에 필요한 권한 없으면 실행 대신 안내, 위험 작업은 권한 있어도 승인 카드(권한 확인≠승인).

**배포**: build/lint exit 0 → pm2 재시작(34회째, 에러 0). 두 길드 sync 성공, AI 세션 2개 복원. **스모크 잔여**: 승인 카드 디자인+kawaiicaution 렌더 / 관리 권한 없는 계정의 관리 작업 요청 시 AI 사전 안내.

---

## D-15. 대량 메시지 삭제 도구 (bulk_delete_messages) (2026-07-09)

**배경**: 리시가 "채널 메시지 다 지워줘"류를 시키면 AI가 `delete_message`를 개수만큼(20개+) 개별 호출 → danger라 승인 카드가 하나당 하나씩 쏟아지는 UX 문제 제기(스크린샷). 승인 카드 폭탄.

**해결**: 신규 `bulk_delete_messages`(messageTools.ts).
- count개를 100개씩 페이지네이션으로 수집 → 14일 경계로 이분.
- 14일 이내: `channel.bulkDelete(chunk, true)`로 100개씩 한 번에. 경계에서 filterOld로 빠진 건 개별 폴백.
- 14일 초과: 디스코드가 벌크를 막으므로 개별 순차 삭제(상한 없음, 리시 결정). discord.js가 rate limit 자동 관리.
- danger 1개 = 승인 카드 1개. `delete_message` N개 대신 이 도구 하나로 카드 폭탄 해소.
- description에 "대량 삭제엔 delete_message 여러 번 말고 이걸 써라" 강제 힌트.
- 등록: toolRegistry(register) + proposalCard.toolNameMap('대량 메시지 삭제').

**리시 확정**: 14일 이내 모두 삭제 / 14일 초과 상한 없이 개별. "2개씩 벌크·병렬"은 디스코드 제약(벌크는 14일 초과 불가, 병렬도 채널 단위 rate limit)으로 실익 없어 개별 순차가 유일.

**배포**: build/lint exit 0 → pm2 재시작. 두 길드 sync 성공. **스모크 잔여**: 실제 "N개 지워줘" → 승인 카드 하나 → 삭제 확인.

---

## D-16. 승인 카드 3초 후 자동 제거 (2026-07-09)

**배경**: 리시 요청 — 결정이 끝난 승인 카드가 채널에 계속 남아 지저분함. 결정 후 치울 것.

**해결**(AiMentionExtension.ts 승인 핸들러):
- 신규 `scheduleCardRemoval`(setTimeout 3s → `interaction.message.delete()`, 실패 무시) + `finalizeCard`(updateCard + 제거 예약).
- 결정 종료 지점 전부에 적용 — 거부/만료/정보없음/L3권한실패는 `finalizeCard`로 교체. 승인 실행은 "✅ 승인됨 — 실행 중…" 표시 유지 후 try/catch 종료 시 `scheduleCardRemoval`(성공/실패 무관).
- 실행 결과는 followUp 별도 메시지라 카드가 사라져도 남는다.

**배포**: build/lint exit 0 → pm2 재시작, 두 길드 sync 성공. **스모크 잔여**: 실제 승인/거부 후 카드가 3초 뒤 사라지는지.

---

## D-17. 음악 재생 버그픽스 — AI가 링크 요구하며 재생 안 하던 문제 (2026-07-09)

**배경**: 리시 제보 — 노래 재생 요청 시 봇이 "유튜브 링크를 직접 달라"며 재생 안 함. 로그 확인: `search_music`만 반복 호출, `play_music`은 0회 — 검색만 하고 재생 시도조차 안 함.

**원인**: (1) `search_music` 결과 텍스트(message)에 재생용 uri가 없어(data엔 있으나 모델은 message 위주 + turn 넘기면 240자 절단) AI가 검색→재생 연결을 못 함. (2) `play_music`이 제목만으로 재생된다는 걸 프롬프트/설명이 강조 안 해 AI가 "URL 필요"로 오판.

**수정**:
- musicTool.ts `search_music`: 결과 목록 각 줄에 uri 노출 + "재생하려면 play_music에 제목/URL 넘겨라, 링크 요구 말라" 힌트.
- musicTool.ts `play_music` description: "제목만으로 재생, URL 불필요, 링크 요구 금지" 명시.
- systemPrompt.ts: '## 음악 재생' 섹션 신설 — 노래 요청 시 바로 play_music, 링크 요구 절대 금지, 재생 실패는 대개 음성 채널 문제.

**배포**: build/lint exit 0 → pm2 재시작, sync 성공. **스모크 잔여**: 음성 채널 입장 후 "노래 틀어줘" → 바로 재생되는지.

---

## D-18. 두뇌 모델 스왑 — gemini → GLM-5.2 + gemma4 로컬 폴백 (2026-07-10)

**배경**: B절 "모델 역할 분배(2026-07-10)" 결정 실행. gemini 무료 rate limit 탈피 →
두뇌를 GLM-5.2(zai-proxy, OpenAI-호환)로 교체. gemini는 런타임에서 완전 제거.
폴백은 gemini 대신 **로컬 Ollama gemma4**로(리시 지시) — "gemini 완전 제거"를 지키면서 프록시 장애 시 봇 생존.

**변경**:
- `opencodeZenProvider.ts`: `createOpencodeZenProvider`에 `baseUrl?`/`label?` 옵션 추가(기본은 기존 opencode.ai/zen).
  OpenAI-호환 엔드포인트를 config로 지정 가능해짐 — zai-proxy(GLM)·Ollama(gemma4) 모두 이 한 함수로 배선.
- `config.ts` `AiConfig`: `baseUrl?`(primary 엔드포인트) + `fallbackBaseUrl?`/`fallbackModel?`(폴백) 추가.
- `AiMentionExtension.ts buildProvider()`: gemini 분기·import 완전 제거. primary=GLM(config.baseUrl+model),
  fallback=gemma4(config.fallbackBaseUrl+fallbackModel, 둘 다 있을 때만). `createAiProviderChain({primary, fallback})`로
  primary→fallback→dry-run 강등. 로그: `AI 두뇌 구성 완료 (primary=... fallback=...)`.
- `config.json`(라이브): `baseUrl=http://localhost:18088/v1`, `model=glm-5.2`,
  `fallbackBaseUrl=http://localhost:11434/v1`, `fallbackModel=gemma4:latest`. 기존 geminiApiKey/opencode-zen apiKey는
  **보존**(되돌리기 쉽게 — baseUrl 지우고 model 복원하면 롤백). apiKey는 프록시가 무시(로컬 프록시가 z.ai 키 롤링).
- `config.example.json`: ai 블록을 새 형태로 갱신(gemini/deepseek 제거).
- `geminiProvider.ts` 파일 + `@ai-sdk/google` 의존성은 **미삭제**(런타임 미사용 dead file). 삭제는 package.json 정리 트랙에서.

**검증(build/lint exit 0, pm2 재시작 40회째 안정)**:
- 부팅 로그: `AI 두뇌 구성 완료 (primary=glm-5.2@localhost:18088/v1, fallback=gemma4:latest@localhost:11434/v1)`, 두 길드 sync, 세션/cron 로더 정상, 신규 에러 0.
- GLM-5.2 SDK 스모크(봇과 동일 `@ai-sdk/openai-compatible`+`generateText` 경로): 실제 한국어 content 반환, `finish_reason=stop` — **추론 모델 content 빈 문제 없음**(providerCore가 출력 토큰 미제한).
- gemma4:latest 스모크: "파랑" 정상 생성(콜드 로드 포함 27s).

**발견/주의**:
- ⚠️ **zai-proxy z.ai 키 429 폭풍 관측(09:28~09:41).** 모든 키 쿨다운(쿼터 30분/레이트 300초) 시 서킷 브레이커 OPEN →
  primary 실패 → 체인이 gemma4 폴백으로 강등(그전엔 dry-run). 무료 키 풀 고갈은 상시 리스크. 폴백이 이걸 흡수.
- ⚠️ **gemma4 폴백은 느림**(CPU 1.5 tok/s, 콜드 로드 시 수십 초). GLM 정상일 땐 미실행이라 평시 영향 없음. 장시간 도구 턴이
  폴백으로 떨어지면 수 분 소요 가능 — 필요 시 폴백 전용 maxSteps 축소 검토(현재 미적용).
- **음악 "변경 vs 추가" 교체 도구**: 이번 세션에서 `replace_music`(clientTrack 즉시 교체) 초안까지 만들었으나 **리시 판단으로 접음**(불필요). 되돌려 워킹트리 무흔적.

**스모크 잔여(리시 손 필요)**: 실제 봇 멘션 → GLM-5.2 응답 확인 / 프록시 강제 다운 상태에서 gemma4 폴백 응답 확인.

---

## D-19. zai-proxy 무응답 대응 — HTTP 재시도 5회 + 타임아웃 + 폴백 강등 (2026-07-11)

**배경**: 리시 지시 — zai-proxy가 가끔 실패/무응답. 5회 시도 후 안 되면 다른 모델로 폴백할 것. (안정성 감사에서도 provider 타임아웃 부재가 🔴로 지적됨 — hang 시 무한 대기, heartbeat 영구 정지 콤보.)

**설계 결정**: 재시도를 generateText 턴 단위가 아니라 **HTTP 요청 단위**로 건다. 턴 재시도는 이미 실행된 도구(메시지 전송·삭제 등)를 중복 실행할 수 있지만, 요청 재시도는 부작용 없이 안전. 타임아웃이 있어야 "응답이 아예 안 오는" hang도 실패로 집계돼 재시도가 돈다.

**구현**:
- **`resilientFetch.ts` (신규)** — fetch 래퍼. 시도당 타임아웃(AbortController 수동 조합, @types/node 18에 AbortSignal.any 없음) + 지수 백오프(1→2→4→8s, cap 10s) 재시도. 재시도 대상: 네트워크 오류·타임아웃·HTTP 408/429/5xx. 호출자 abort는 재시도 없이 전파. 스트림 본문은 단일 시도로 강등, Request 객체는 시도마다 clone.
- **`opencodeZenProvider.ts`** — `maxAttempts`/`requestTimeoutMs` 옵션 추가, createOpenAICompatible에 custom fetch 배선.
- **`AiMentionExtension.ts`** — primary(GLM): 5회 × 60s. fallback(gemma4): 2회 × 600s(CPU 1.5tok/s라 넉넉히).
- **`providerCore.ts`** — `maxRetries: 0`. **스모크에서 발견**: SDK 내장 재시도(기본 2회)가 fetch 재시도와 곱해져 3×3=9회 시도됨 → SDK 재시도를 꺼서 재시도 주체를 resilientFetch로 일원화.
- **`aiProviderChain.ts`** — primary 실패/폴백 강등/dry-run 강등을 logger.warn으로 가시화(기존엔 무로그).

**검증**: build/lint exit 0. dist 스모크 3종 통과 — ① 죽은 엔드포인트: 정확히 3회 시도 후 throw ② 블랙홀(무응답): 시도당 3s 타임아웃 발동, 7.0s에 throw(계산 일치) ③ 체인: primary 실패 → 실제 GLM 프록시 폴백이 정답 생성. pm2 재시작(47회째), 부팅 로그 정상(두뇌 구성·세션·cron 로더).

**동작 요약**: 프록시 즉시 실패(429/refused)면 ~15s 내 5회 소진 후 gemma4 폴백. 무응답 hang이면 요청당 60s에 잘려 최악 ~5분 내 폴백(기존엔 무한 대기).

---

## D-20. TTS 봇 생존 감시 + 입장 실패 사유 안내 (2026-07-11)

**배경**: 리시 지시 — ① tts봇이 중간에 꺼지거나 재시작하는 걸 감지할 것, ② 봇이 못 들어가거나 권한이 없어 접속 못 하는 경우 사용자에게 알릴 것. (기존: 세션이 tts-bot RAM에만 있어 죽으면 조용히 침묵. 입장 실패 시 원인 무관하게 "봇이 실행 중인지 확인" 오답 안내.)

**구현**:
- **입장 사전 검사 (tts/index.ts onJoin)** — 서버 미초대 / 음성채널 없음 / 채널 보기·연결 권한 없음 / 말하기 권한 없음 / 인원 초과(이동 권한 없을 때)를 각각 구체적 한국어 메시지로 throw → controlServer가 `{error}`로 반환.
- **오류 사유 전달 (TtsExtension postControl)** — boolean 반환을 `ControlResult`(ok/reason/unreachable)로 교체. 연결 자체가 안 되면 기존 안내, 봇이 거부하면 `"TTS 봇이 입장하지 못했어요 — <사유>"`. 제어 요청에 20s 타임아웃 추가(resilientFetch 재사용, 기존엔 무한 대기 가능).
- **생존 감시 (TtsExtension)** — `/health`가 `startedAt`(부팅시각)+`sessions`(활성 세션)를 반환하도록 확장. 메인봇이 20s 폴링: `startedAt` 변화 = **재시작 감지** → 이전 세션의 텍스트 채널마다 "재시작되어 나갔어요, `/tts 입장`으로 다시" 안내. 연속 2회 실패(≈40s) = **무응답 감지** → "중단된 것 같아요" 안내, 같은 프로세스 복구 시 "복구됐어요" 안내. 입장/퇴장 성공 직후 세션 미러링으로 폴링 전 크래시도 커버.
- **음성 강제 끊김 안내 (ttsVoice + tts/index.ts)** — 재연결 실패로 강제 퇴장될 때(관리자 연결 끊기 등) 훅 호출 → 세션 정리(기존엔 좀비 세션 잔류) + 텍스트 채널에 안내.

**검증**: build/lint exit 0 → pm2 두 봇 재시작. `/health` 응답에 startedAt·sessions 확인. 가짜 길드 `/join` → `{"error":"TTS 봇이 이 서버에 초대되어 있지 않아요."}` 확인. **재시작 감지 실측**: 메인봇 감시 시작 로그 → tts-bot 재시작 → 다음 폴링에서 `TTS 봇 재시작 감지` WARN 확인(세션 0개라 채널 안내는 미발송 = 정상).

**스모크 잔여(리시 손 필요)**: 실제 `/tts 입장` 후 tts-bot 재시작 → 읽던 채널에 재시작 안내 오는지 / 권한 없는 음성채널에 `/tts 입장` → 권한 사유가 그대로 뜨는지.

---

## D-21. 웹 대시보드 (Next.js, 3160) — v1 구축 (2026-07-11)

**리시 확정 스펙**: 디스코드 로그인 + 상태 대시보드 + 음악 제어 + 서버관리 + 유저 대시보드. Next.js 3160 포트.

**아키텍처 (2계층)**:
- **봇 내부 API** (`src/features/dashboard/dashboardApi.ts` + `DashboardApiExtension`, `127.0.0.1:3161`): Bearer 시크릿(`config.dashboard.apiSecret`, config.json에 생성·추가/백업 `config.json.bak-dashboard`). 엔드포인트: `GET /status`(봇·Lavalink·길드·AI세션), `GET /guilds/:g/member/:u`(멤버십·권한·음성채널), `GET|POST /guilds/:g/music`(상태/제어 — pause·resume·skip·stop·shuffle·volume 0~100·repeat).
- **Next.js 앱** (`dashboard/`, 독립 package.json, Next 15 + React 19 + Auth.js v5 beta + supabase-js): pm2 `dashboard`(dashboard.pm2.json), `next start -p 3160`. `.env.local`은 config.json에서 생성(스크립트), git 미추적.

**페이지**: `/login`(디스코드 OAuth) · `/status`(리시봇/TTS봇/Lavalink/zai-proxy 생존 + 길드 표) · `/music/[guild]`(현재 곡·진행바·대기열, 재생/일시정지/스킵/셔플/반복/볼륨/정지, 5s 폴링) · `/server/[guild]`(관리자 전용 — 통계, 레벨 TOP, 예약 목록, AI 프로필 편집: 소울/컨셉/승인정책 → server_profile 직접 upsert, 봇 캐시 10분 후 반영) · `/me`(서버별 지갑·은행·출석·레벨·순위·도박·드랍 + TTS 목소리).

**권한 모델**: 로그인 후 봇 API로 멤버십 검증 — 봇이 있는 서버의 멤버만 통과. 음악 제어는 관리자 또는 봇과 같은 음성채널(디스코드 컨트롤러와 동일 규칙, 서버측 강제). 서버관리는 ManageGuild. 서버 액션 내부에서도 재검증.

**검증**: 봇 API 스모크(401/status/music) 통과. next build 성공(타입체크 포함). pm2 기동 후 `/`→`/status`→`/login` 리다이렉트 체인, 로그인 페이지 렌더, API 401 확인.

**빌드 이슈 해결 기록**: ① next-auth v5 beta의 `next-auth/jwt` 모듈 증강 불가 → 토큰 캐스트로 대체. ② 빌드 서버에서 fonts.gstatic.com 다운로드 불안정 → next/font 대신 브라우저 로드(link 태그). ③ 루트 리포 eslint 상속으로 TSX 파싱 실패 → `eslint.ignoreDuringBuilds`.

**잔여 (리시 손 필요)**: 디스코드 개발자 포털에서 ① OAuth2 Client Secret 발급 → `dashboard/.env.local`의 `AUTH_DISCORD_SECRET=REPLACE_ME` 교체, ② Redirect URI `http://<접속주소>:3160/api/auth/callback/discord` 등록 → `pm2 restart dashboard`. 이후 실로그인 스모크.

**개편 (2026-07-11, 리시 피드백 2건)**:
- **`/`를 공개 랜딩으로** — "메인페이지까지 로그인으로 막은 건 잘못" 지적 수용. `/`는 봇 소개(기능 카드 6종)+로그인 CTA의 공개 페이지, 로그인 게이트는 대시보드 4종(`/status`·`/music`·`/server`·`/me`)에만. `/login` 페이지 삭제(랜딩이 대체).
- **next-auth 제거 → 디스코드 OAuth 수동 구현** — next-auth v5 beta가 `TypeError: Invalid URL`/`error=Configuration`을 불투명하게 던져 디버깅 불가. 직접 구현으로 교체: `lib/session.ts`(HMAC-SHA256 서명 쿠키 `dash_session`, 7일, http 배포라 secure 미설정) + `/api/auth/login`(state 쿠키+인가 리다이렉트) + `/api/auth/callback/discord`(state 검증→토큰 교환→`users/@me`→세션 발급, **경로를 next-auth 시절과 동일하게 유지**해 포털 재등록 불필요) + `/api/auth/logout`. 의존성 0(내장 crypto). 실패 시 `/?err=<사유>`로 사유 노출.
- 검증: 재빌드 성공, `/` 200(공개), `/status` 미로그인 307→`/`, `/api/auth/login` 307→discord.com/oauth2/authorize(client_id·redirect_uri·scope=identify·state 정상), API 미로그인 401.
- ⚠️ redirect_uri는 **브라우저 접속 주소를 그대로 따름**(Host 헤더 기반) — 포털에 등록한 URI와 접속 주소가 정확히 일치해야 함.

---

## D-22. 대시보드 디자인 전면 개편 — DESIGN_AUDIT.md 구현 (2026-07-12)

**배경**: 리시 정정 — 리시봇은 달 상징 봇이 아니라 리시 그 자체의 수인형 봇. 달·관측소 컨셉과 그 뒤의 "시그널 데스크" 컨셉 모두 과해석. `dashboard/DESIGN_AUDIT.md`(감사 문서)가 정본 스펙.

**구현 (감사 §8 순서대로 전부 반영)**:
- **세계관 전면 폐기**: 시그널 데스크/관제/신호/SIGNAL DESK/영문 킥커(SYSTEM · STATUS 등)/다중 서버 배지/펄스 링·격자·글로우·로봇 코어 전부 제거. 브랜드는 `리시봇` 하나, 제품명은 `리시봇 대시보드`만.
- **비주얼**: globals.css 전면 재작성(1990→약 1100줄) — 따뜻한 종이색(#f7f3ea) 배경 + 먹색 타이포 + 인주(#bd3d20) 포인트 한 가지 + 얕은 테두리. 브랜드 마크는 인주 도장풍 "리" 모노그램. Hahmlet/IBM Plex Sans KR/커스텀 선형 아이콘은 유지(감사 유지 목록).
- **홈페이지**: 제목 `디스코드 서버를 더 편하게.`, 웹에서 할 수 있는 일/디스코드에서 하는 일 분리 카드, 기능은 3×2 카드 대신 번호형 편집 목록(01~06).
- **카피 전수 교체(-해요체 통일)**: 음악 리모컨→음악, 서버 운영→서버 관리, 소울(정체성)→리시봇 성격("대화할 때 기본으로 참고해요"), 두뇌 엔드포인트→GLM-5.2 API, 총 유통 코인→전체 코인, 출석 스트릭→연속 출석, 캐시 TTL 삭제, cron 원문 숨김(사람용 설명만), 자동 발화(heartbeat)→자동 발화. 메뉴 내 정보→내 활동. error/loading/not-found 상태 페이지도 정리.
- **검증**: 금지 표현 grep 전수 검사 통과(시그널/데스크/관제/TTL/소울/Full Moon 하드코딩 등 0건 — Full Moon은 서버 데이터로만 노출). next build 성공, pm2 재시작, 전 페이지(랜딩/상태/음악/서버 관리/내 활동) 헤드리스 캡처로 시각 확인.

---

## D-23. 대시보드 모던 라이트 리스킨 (2026-07-12)

**배경**: 리시 — "디자인이 모던하면 좋겠다". D-22 종이색 편집형이 클래식하게 읽힘. 감사 원칙(카피·브랜드·세계관 금지)은 유지, 시각만 교체.

**구현**: 서체 Hahmlet(세리프)+IBM Plex Sans KR → **Pretendard 가변**(jsdelivr CDN, 볼드+타이트 자간). 배경 종이색 → 뉴트럴 그레이(#f4f5f7)+화이트 카드+은은한 섀도+큰 라운드. 포인트는 오렌지레드(#f04e23) 하나로 유지(인주 계승·채도 업). 보조 버튼 그레이 필, 내비 활성은 소프트 오렌지 필. globals.css만 재작성 + layout.tsx 폰트 링크 교체(마크업 무변경). `DESIGN_AUDIT.md`에 부록(시각 방향 갱신) 추가.

**검증**: build/재시작, 전 페이지 캡처 확인 — 토스류 모던 한국 서비스 룩 확인.

---

## D-24. 라이트/다크 테마 + 라이트 톤 보정 (2026-07-12)

**배경**: 리시 — 라이트/다크 테마 필요, 그리고 라이트가 "너무 흰색"(배경과 흰 카드 대비 약해 밋밋). 

**구현**:
- 색 전부 CSS 변수화 → `:root[data-theme='light'|'dark']` 분기. 다크 팔레트 신설(#101116 배경/#191b22 카드/액센트 #8477ff).
- `ThemeToggle.tsx`(클라이언트): 클릭 토글, localStorage 저장, 달↔해 아이콘. 사이드바 브랜드행·랜딩 상단바에 배치.
- FOUC 방지: layout `<head>` 인라인 스크립트가 최초 페인트 전 data-theme 세팅(저장값→없으면 OS prefers-color-scheme). `<html suppressHydrationWarning>`.
- **라이트 톤 보정**: 배경 #f4f5f7→#e8eaee(한 톤 눌러 흰 카드가 뜸), 랜딩을 순백 배경→그레이+상단 바이올렛 글로우+안내 컬럼을 화이트 카드로. 테이블 라인/행호버도 테마 변수화.

**검증**: build 성공, 라이트·다크 각각 헤드리스 캡처(localStorage 주입)로 확인 — 라이트는 카드가 확실히 떠 보이고, 다크는 텍스트 대비·액센트 정상.

---

## D-25. TTS API 만료 대응 — 사전 저장 안내 음성 + 종료 절차 (2026-07-12)

**배경**: 리시 지시 — ElevenLabs api 키 만료 시 ① 안내를 하고 비활성화, ② 만료 후엔 합성 불가라 **키 살아있을 때 안내 음성을 미리 합성·저장**해 두고 만료 시 그 저장본을 재생, ③ 저장된 음성 재생 완료 후 음성채널 퇴장 + embed 알림.

**구현 (3파일)**:
- **elevenLabs.ts**: `ttsDisabled` 플래그 + `markExpired()`. 합성 응답이 401/403 또는 detail에 quota_exceeded/invalid_api_key/expired/unusual_activity면 만료로 판정 → 비활성화 + `setExpirationHandler` 훅 호출. 이후 합성은 죽은 API 재호출 없이 즉시 null. `isTtsDisabled()`/`setExpirationHandler()` export.
- **ttsVoice.ts**: `scheduleLeaveWhenDrained(guildId, cb)` — 큐에 쌓인(합성 완료·저장된) 음성이 전부 재생되면 cb 1회 실행(재생 없고 큐 비었으면 즉시). `playNext`가 큐 소진 시 발화.
- **index.ts**: 부팅(clientReady)에 `primeExpiryNotice()` — 키 유효할 때 안내 멘트를 미리 합성해 `expiryNoticeCache`에 저장(키 헬스체크 겸). 만료 핸들러: 활성 세션마다 (1) 비활성화 embed → (2) `expiryNoticeCache`를 큐 끝에 enqueue(저장본 재생) → (3) `scheduleLeaveWhenDrained`로 재생 완료 후 퇴장+`clearSession`+"TTS 종료" embed. 만료 상태면 `/tts 입장`도 차단. 강제 끊김 안내도 embed화(`sendTtsEmbed` 헬퍼 공용).

**검증**: build/lint exit 0. dist 스모크 — 401 모킹 시 markExpired 발화·핸들러 호출·이후 fetch 재호출 0 확인. `scheduleLeaveWhenDrained` 즉시경로 확인. **tts-bot 재배포 후 실부팅 로그 "만료 안내 음성 사전 합성 완료" 확인**(키 유효, 저장 성공). 실제 만료 재생·퇴장 흐름은 진짜 만료 상황이라야 완전 검증(사전 저장·감지·종료 로직은 유닛 검증 완료).

---

## D-26. 자율성 기능 제거 — cron(예약) + heartbeat(자동응답/자동발화) (2026-07-13)

**배경**: 리시 지시 — 에이전트의 CRON과 자동응답(heartbeat 자동 발화)을 제거. 멘션/답장 응답 흐름은 유지.

**제거 범위**:
- **파일 삭제**: `cronScheduler.ts`, `cronStore.ts`, `tools/tools/scheduleTools.ts`.
- **toolRegistry**: schedule_task/list_scheduled_tasks/cancel_scheduled_task 등록·import 제거(도구 3종 소멸).
- **proposalCard**: 예약 도구 이름 매핑 3줄 제거.
- **serverProfile**: `HeartbeatConfig`/`getHeartbeatConfig`/`setHeartbeatConfig` 블록 제거(agent_scope.heartbeat 미사용).
- **agentSettingsPanel**: 🔔 자동 발화 컨테이너·hbToggle·hbChannel 액션·헤더 자동발화 줄 제거.
- **AiMentionExtension**: cron/heartbeat import, HEARTBEAT_* 상수, heartbeatBusy/heartbeatSpokeAt 필드, ready()의 setCronRunner·loadAndRegisterAll·heartbeat setInterval, `runScheduledJob`·heartbeat 메서드 5종(isQuietHours/canHeartbeatSpeak/markHeartbeatSpoke/runHeartbeat/heartbeatSpeak) 제거. 상태/셋업 패널의 자동발화·예약 표시, 설정 핸들러 정리. 그로 인해 미사용된 import(formatServerContextForPrompt·KOREAN_SYSTEM_PROMPT·stripToolCallSyntax·Guild·GuildTextBasedChannel) 정리.
- **대시보드 서버 관리**: 예약 작업 카드·테이블·CronRow·describeCron·cron_jobs 쿼리 제거, AI 세션 카드의 자동 발화 표시 제거.

**남긴 것(무해)**: DB `cron_jobs` 테이블 + `022_cron_jobs.sql`(적용본). 데이터 미사용이라 방치, 필요 시 DROP 가능. 멘션/답장 AI 응답·승인 게이트·소울/컨셉/지침·세션·온보딩은 그대로.

**검증**: 봇 build/lint exit 0, 대시보드 build 성공. 봇 재배포 부팅 로그에서 **`[CronScheduler]` 로더 로그 소멸** 확인(이전엔 예약 재등록 로그 있었음), 두뇌·세션·명령어 sync 정상. 대시보드 재배포 200. grep으로 src 잔재 0.

---

## E. 다음 할 일 / 주의

- **증축 계획 6단계 전부 구현 완료.** 남은 건 배포/검증:
- ✅ **마이그레이션 022 적용 완료** (2026-07-08, D-10): `cron_jobs` 테이블 생성·스키마 검증 완료. 예약 저장 경로 활성화.
- ⚠️ **인터랙티브 스모크 잔여**(리시 손 필요): 부팅/명령어등록/DB로더는 확인됨(D-11·D-12). 실제 클릭·발화 확인 필요 — **`/에이전트 셋업` 패널(소울·컨셉·지침 모달, 정책 드롭다운, 자동발화 토글, 채널용도, 세션초기화)**, 승인 카드 [실행 승인]/[거부], 온보딩 버튼, `schedule_task` 예약→정시 실행, heartbeat on 후 발화.
- ⚠️ **package.json/pnpm-lock 미커밋**: croner 외 음성/TTS/욕설필터 의존성이 섞여 AI 커밋에서 제외. croner 선언은 그 정리 때 반영(워킹트리엔 설치됨).
- ⚠️ **커맨드 등록**: `/에이전트` 그룹은 봇 재시작 시 sync.
- 역할 분담: 초안·검토·리스크 지적은 칸나(동생), 다듬기·최종 확인·마무리는 코하루(언니).
