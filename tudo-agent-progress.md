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

## E. 다음 할 일 / 주의

- **증축 계획 6단계 전부 구현 완료.** 남은 건 배포/검증:
- ✅ **마이그레이션 022 적용 완료** (2026-07-08, D-10): `cron_jobs` 테이블 생성·스키마 검증 완료. 예약 저장 경로 활성화.
- ⚠️ **인터랙티브 스모크 잔여**(리시 손 필요): 부팅/명령어등록/DB로더는 확인됨(D-11·D-12). 실제 클릭·발화 확인 필요 — **`/에이전트 셋업` 패널(소울·컨셉·지침 모달, 정책 드롭다운, 자동발화 토글, 채널용도, 세션초기화)**, 승인 카드 [실행 승인]/[거부], 온보딩 버튼, `schedule_task` 예약→정시 실행, heartbeat on 후 발화.
- ⚠️ **package.json/pnpm-lock 미커밋**: croner 외 음성/TTS/욕설필터 의존성이 섞여 AI 커밋에서 제외. croner 선언은 그 정리 때 반영(워킹트리엔 설치됨).
- ⚠️ **커맨드 등록**: `/에이전트` 그룹은 봇 재시작 시 sync.
- 역할 분담: 초안·검토·리스크 지적은 칸나(동생), 다듬기·최종 확인·마무리는 코하루(언니).
