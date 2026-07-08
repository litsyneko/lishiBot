# lishibot 에이전트 전환 계획 (tudo-agent-plan)

> 작성: 2026-07-08
> 목적: lishibot의 AI 기능을 "도구 쓰는 챗봇" → "진짜 에이전트"로 증축하기 위한 실행 계획.
> 근거: (1) lishibot 코드 정밀 분석(파일:라인 검증), (2) OpenClaw 에이전트 런타임 문서 대조,
> (3) `AGENT_AUDIT.md`의 7개 진단을 코드로 재검증.
> 이 문서는 `AGENT_AUDIT.md`를 **정정·확장**한 상위 계획서다. 충돌 시 이 문서가 우선.

---

## 0. 한 줄 결론

lishibot은 **"기억상실증 걸린 반응형 에이전트"** 다.
- 실행부(멀티스텝 도구 루프)는 **이미 에이전트급**으로 작동한다. → 챗봇이 아님.
- 그 루프를 감싸는 **인지 계층(영속 상태 · 계획 · 자율)** 이 비어 있다. → 완전한 에이전트도 아님.

> 핵심: 매 턴 유능하게 도구를 쓰는데, 턴이 끝나면 자기가 뭘 했는지 다 잊는다.
> "간단하다"의 정체는 기능 부족이 아니라 **연속성의 부재**다.

**OpenClaw가 lishibot과 다른 건 기능이 아니라 3개의 구조 분리축이다:**
1. **모든 상태를 디스크/DB에 소유** — "모델은 저장된 것만 기억한다, 숨은 상태 없음". (lishibot: 세션이 RAM Map → 재시작 시 소멸)
2. **model boundary(스텝 경계)를 코드가 소유** — 도구 호출↔결과 사이에 개입 훅. (lishibot: `stepCountIs(20)` 루프를 SDK에 통째로 위임 → 개입 지점 없음)
3. **관심사 물리 분리** — 트리거(언제)/원장(뭐가 일어났나)/권한(뭘 할 수 있나). (lishibot: 뭉개거나 생략)

**결론: 밑바닥 재작성이 아니라 증축이다.** lishibot은 substrate의 ~80%를 이미 갖고 있다(§6).

---

## 1. 코드로 검증한 현황 (AGENT_AUDIT.md 7개 진단 대조)

`AGENT_AUDIT.md`의 진단은 방향은 맞지만 **사실관계 4곳이 틀렸다.** Claude Code가 그 문서를
그대로 읽으면 틀린 전제로 작업하므로 아래 정정본을 기준으로 한다.

| # | AGENT_AUDIT 주장 | 판정 | 코드 근거 |
|---|---|---|---|
| 1 | 세션이 `{content,role}`만 쌓음 | ⚠️ 부분틀림 | `Session`은 4필드: `history/toolHistory/lastActivity/messageIds` (`conversationStore.ts:9-14`) |
| 1 | 세션 키 `guildId:userId` → 채널 분리 없음 | ✅ 맞음 | `conversationStore.ts:54` — channelId 미포함 |
| 1 | 진행상태/todo/대기 컨텍스트 없음 | ✅ 맞음 | 해당 필드 부재. RAM only, 재시작 소멸, TTL 2h |
| 2 | 저장이 모델 tool call 재량 | ✅ 맞음 | 쓰기는 `save_memory` 호출 시에만 (`memoryTool.ts:44`) |
| 2 | **메모리 주입되는지 확인 필요** | ❌ **해소됨 — 주입됨** | 매 요청 코드가 강제 (`messageCreate.ts:152,159` / `sessionReply.ts:83,85`) |
| 2 | 메모리 계층 없음 | ✅ 맞음 | 단일 `user_memories`, 15개 FIFO (`memoryStore.ts:11,57-63`) |
| 3 | 도구 실패 재시도가 프롬프트 지시뿐 | ✅ 맞음 | 코드 레벨 재시도/백오프 없음 (`systemPrompt.ts:104-106` 자연어만) |
| 3 | **멀티스텝 루프 도는지 의문 / 한 번 호출로 끝** | ❌ **틀림 — 진짜 돎** | `stopWhen: stepCountIs(20)` (`geminiProvider.ts:105`, `opencodeZenProvider.ts:113`) |
| 4 | 멘션/답장에만 반응 | ✅ 맞음 | AI는 100% 반응형, 트리거는 `messageCreate`뿐 |
| 4 | heartbeat/cron/자발 행동 전무 | ⚠️ 부분틀림 | LLM 자발은 없지만 규칙기반 자율은 있음: `RewardExtension` 60초 선착보상, `Hello` presence 30초. cron 라이브러리는 없음 |
| 4 | 지연 작업 큐 없음 | ✅ 맞음 | deferred queue 부재 |
| 5 | 도구 ~40개 | ❌ **53개** | `toolRegistry.ts` register 53회 |
| 5 | 메시지 검색/삭제/수정·웹훅·이모지·핀·투표·이벤트 없음 | ✅ 맞음 | grep 0건 |
| 6 | `deepseek-v4-flash-free` 사용 | ⚠️ 부분틀림 | Gemini 키 있으면 **`gemini-3.1-flash-lite`가 primary**(하드코딩 `AiMentionExtension.ts:48`), deepseek는 fallback |
| 7 | plan→execute→verify 없음 | ✅ 맞음 | 명시적 plan 모듈 부재. AI SDK 내장 루프 + 프롬프트 지침만 |

### 1-1. AGENT_AUDIT가 놓친 실제 버그 2개 🔴

- **B1 — `pendingProposals`가 죽은 코드.** `AiMentionExtension.ts`에서 `.get()`(:302)/`.delete()`(:304)만
  호출되고 **`.set()`이 어디에도 없다**(grep 확인). 위험작업 승인 게이트("채널 삭제할까요→네", :302-424)가
  **런타임에서 절대 안 열린다.** 시스템 프롬프트엔 확인 로직이 있는데 코드가 맵을 안 채운다.
- **B2 — `toolHistory`가 write-only.** `appendToToolHistory`는 호출되지만(`AiMentionExtension.ts:276,498`)
  `getToolHistory`(`conversationStore.ts:139`)를 **읽는 코드가 0개**. 도구 실행 기록을 쌓기만 하고
  다음 스텝/턴에서 안 본다. → 진단 1의 "지금 뭘 하는지 모른다"의 실제 증거.

---

## 2. OpenClaw 참고 — 3대 기반 이식 지도

OpenClaw 문서 3클러스터(세션·메모리 / 추론루프·작업추적 / 자율성)를 정독해 lishibot 이식 지점을 매핑했다.
(Discord 채널 연동 클러스터는 미완 — 에이전트 기반과 무관해 우선순위 낮음, §7 참조.)

OpenClaw 문서 경로: `~/.nvm/versions/node/v24.11.0/lib/node_modules/openclaw/docs/`

### 기반 1 — 세션 + 메모리

| OpenClaw 설계 | 근거 문서 | lishibot 이식 (구체) |
|---|---|---|
| 세션을 디스크 소유(`sessions.json` + `<id>.jsonl`), 재시작 생존 | `concepts/session.md` | 새 테이블 `ai_sessions` + `ai_session_messages` → `conversationStore`를 write-through 캐시로 |
| 세션 키 = 스코프 정책(`per-channel-peer` 권장) | `concepts/session.md` | `getOrCreateSession`에 `channelId` 추가 → 키 `guild:channel:user` |
| 만료 이원화: daily(4AM 롤오버) + idle | `concepts/session.md` | 단일 `SESSION_TTL_MS`(2h) → `session_started_at`(daily/KST) + `last_interaction_at`(idle) |
| Compaction: 오래된 턴 요약·트랜스크립트에 영속, 최근 원형 | `concepts/compaction.md` | `appendToSession`의 `.slice(-20)` 무손실 절단 → "초과분을 저비용 모델로 요약해 `role:summary` 엔트리로 치환" |
| 메모리 3계층: long(`MEMORY.md`, 매턴)/working(일간, 검색)/short(dreams) | `concepts/memory.md` | `user_memories`에 `tier`(longterm/daily) 컬럼. `formatForPrompt`는 longterm만 주입 |
| 검색: SQLite FTS5(BM25)+vector hybrid, CJK trigram, temporal decay/MMR | `concepts/memory-builtin.md`, `memory-search.md` | Supabase **pgvector** + `to_tsvector`(simple+pg_trgm) hybrid merge. `match_user_memories()` RPC |
| Active memory: 답변 직전 blocking sub-agent가 연관 회상 주입 | `concepts/active-memory.md` | 15개 전량주입(`formatForPrompt`) → **쿼리 연관 top-k**로. `generate` 전 검색 후 `enrichedPrompt`에 |
| Dreaming: 야간 cron이 short→long 승격(가중 스코어) | `concepts/dreaming.md` | 야간 배치가 `recall_count`/recency 기반 daily→longterm 승격 |

**체감 최대**: 재시작 생존(세션 DB) + 채널 격리. **품질 최대**: 전량주입 → 연관 top-k (pgvector 선행).

### 기반 2 — 추론 루프

| OpenClaw 설계 | 근거 문서 | lishibot 이식 |
|---|---|---|
| 루프의 model boundary마다 `before/after_tool_call` 훅 | `concepts/agent-loop.md`, `queue-steering.md` | `generateText`에 `onStepEnd` 콜백 추가 → **스텝 경계 확보 (나머지 전부의 전제)** |
| 도구 실패 재시도를 코드가 강제(에러 분류) | `concepts/agent-loop.md`, `retry.md` | 프롬프트 "2회 재시도"를 코드 래퍼로 승격 (not-found=1회, permission-denied=즉시중단) |
| model-failover: 에러 분류 + cooldown(SQLite `usageStats`) + notice | `concepts/model-failover.md` | `aiProviderChain`의 "throw면 무조건 fallback"을 분류/cooldown/사용자 notice로 |
| 실행된 tool 이벤트를 판단·로깅에 사용 | `concepts/agent-loop.md` | **`toolHistory` read 연결** (B2 해소, 데이터 이미 존재 → 최소 변경 최대 효과) |
| Commitments: 지연 후속작업을 별도 스토어+due window, heartbeat가 실행 | `concepts/commitments.md` | (자율성 도입 후) `agent_tasks` 원장 + due clamp + maxPerDay |
| Queue: 세션당 직렬화 lane + steer/collect/interrupt 모드 | `concepts/queue.md` | 동시성 cap + 세션 lock (규모 커질 때) |
| Sub-agent/delegate: tool policy를 프롬프트와 분리해 코드로 강제 | `concepts/delegate-architecture.md`, `multi-agent.md` | 위험 도구를 제한된 allowlist 서브호출로 (선택, 큰 변경) |

> ⚠️ **두 프로바이더(`geminiProvider.ts`/`opencodeZenProvider.ts`)가 로직 100% 중복.**
> `createGoogleGenerativeAI` vs `createOpenAICompatible` 한 줄과 로그 라벨만 다름.
> 공통 코어 추출이 이 기반의 첫 단계다.

### 기반 3 — 자율성

OpenClaw는 자율성을 **트리거/원장/권한 3층**으로 분리한다:
"cron/heartbeat/hooks가 *언제* 깨울지, tasks가 *뭐가 일어났나*, standing orders가 *뭘 할 수 있나*."

| OpenClaw 설계 | 근거 문서 | lishibot 이식 | 우선 |
|---|---|---|---|
| Cron: Gateway 내장 스케줄러, **croner** 파싱, SQLite 영속, `at`/`every`/`cron` | `automation/cron-jobs.md` | `croner` 추가 + `cron_jobs` 테이블 + `SchedulerExtension`. RewardExtension이 첫 소비자 | P0 |
| Heartbeat: 30분마다 self-turn "지금 할 게 있나", 빈 파일이면 스킵(opt-in) | `automation/index.md`, `HEARTBEAT.md` | `HeartbeatExtension` → 틱마다 `provider.generate("서버 점검, 먼저 말 걸 이유 판단")`, `NO_REPLY` 무발화 토큰 | P0 |
| Standing Orders: 권한/규율을 매턴 자동 주입 | `automation/standing-orders.md` | `handleMessageCreate`의 `promptParts` 배열에 블록 추가 (슬롯 이미 존재, 최소 침습) | P1 |
| Tasks: 지연 작업 원장(`queued→running→terminal`), 완료 시 push wake | `automation/tasks.md` | `agent_tasks` 테이블 + heartbeat가 `queued` 실행 후 채널 push | P1 |
| Hooks: 생명주기/메시지 이벤트 반응(`message:received`, `gateway:startup`) | `automation/hooks.md` | `@pikokr/command.ts`의 `@listener`가 이미 대응 인프라. 자발 개입 훅 추가 | P2 |

> ⚠️ **자발 발화는 스팸/비용 리스크가 크다.** OpenClaw 방어장치 필수 동반:
> 빈 HEARTBEAT 스킵 · `skipWhenBusy` · cron 활성 시 heartbeat defer · rate-limit · `NO_REPLY` 토큰.

> 🔒 **cron 샌드박스 원칙 (리시 지시, 2026-07-08).**
> - **시스템 아님, 프로젝트 안.** OS crontab/systemd/외부 스케줄러 금지. 봇 프로세스 내부 `croner`로만 실행 → 봇이 죽으면 같이 멈춤(고아 스케줄 없음).
> - **샌드박스 실행.** cron 잡은 임의 코드·`exec`·shell을 부르지 못한다. 등록된 안전 액션 카탈로그(`kind` 화이트리스트: 리마인더·메모리 승격·정기 점검 등)만 트리거.
> - **승인 게이트 우회 금지.** 위험 액션은 cron이 트리거해도 실행 시점에 `permissionCheck` 3계층을 그대로 통과. 스케줄됐다고 무조건 실행 아님.
> - **생성 권한 제한.** cron 잡 등록/수정/삭제는 관리자 권한 한정. `maxPerDay`·조용채널·rate-limit 존중.

> **용어 주의**: OpenClaw `presence`(클라이언트 상태 뷰)는 lishibot Discord presence(`Hello.ts` setActivity)와
> **무관** — 이식 대상 아님.

---

## 3. 착수 전 청소 (기반 아님, 선행 정리)

- **C1 — 두 프로바이더 공통화.** `geminiProvider.ts`/`opencodeZenProvider.ts`의 중복 `generate` 본문·
  `toModelMessages`·`buildZodSchema`·`toolRecords` 추출을 `src/features/ai/providerCore.ts`로.
  이후 모든 스텝 경계/재시도/failover 이식이 한 곳에서 이뤄진다.
- **C2 — `toolHistory` read 연결 (B2 해소).** `getToolHistory`를 `sessionReply.ts`/`messageCreate.ts`의
  프롬프트 조립에 연결 → 직전 턴 도구 성공/실패를 모델이 인지. 데이터 이미 존재.
- **C3 — `PendingProposal` 결정 (B1 해소).** 되살릴지(위험작업 승인 게이트 + 자율행동 승인에 재사용)
  걷어낼지 결정. **되살리기 권장** — 자율성 도입 시 approval gate로 그대로 재사용 가능.

---

## 4. 빌드 시퀀스 (의존성 순서)

```
0. [청소]   C1 프로바이더 공통화 · C2 toolHistory read · C3 PendingProposal 결정
1. [기반]   스텝 경계 확보 (onStepEnd)            ← 추론루프 전부의 전제
2. [기반]   세션 DB 영속 + 채널 키                ← 자율성/heartbeat의 전제
3. [기반]   pgvector 메모리 검색 + tier + active recall
4. [자율]   croner cron → heartbeat               ← 2번 이후에야 의미
5. [심화]   task 원장 · compaction · dreaming · failover 강화
```

각 단계는 독립적으로 빌드/lint 통과 + 동작 확인 후 다음으로. (프로덕션 봇이므로 증분 검증 필수.)

---

## 5. 진행 상황 (2026-07-08 기준)

- ✅ 코드 정밀 분석 완료 (§1) — 세션/메모리/추론루프/자율성 4영역 파일:라인 검증.
- ✅ OpenClaw 3클러스터 이식 지도 완료 (§2).
- ⏸ **증축 0~1단계 설계까지 진행, 코드 변경은 아직 미적용.** (사용자 요청으로 문서화 우선)
  - C1 대상 파일 정독 완료: `geminiProvider.ts`, `opencodeZenProvider.ts`, `aiPolicy.ts`,
    `conversationStore.ts`, `messageCreate.ts`, `sessionReply.ts`.
  - **SDK 확인(context7, Vercel AI SDK v7):**
    - 스텝 콜백은 `onStepFinish`가 **아니라 `onStepEnd`** — 시그니처
      `onStepEnd({ stepNumber, text, toolCalls, toolResults, finishReason, usage, performance })`.
    - `experimental_prepareStep` → v7에서 `prepareStep`으로 개명(접두사 제거).
    - 스텝 종료 조건은 `stopWhen: stepCountIs(n)` (현 코드 사용 중, 정상). 문서 예시엔 `isStepCount`도 등장 —
      실제 빌드 시 `ai` v7.0.2가 export하는 심볼로 확정할 것.

### 5-1. 증축 1단계 상세 설계 (착수 예정)

`src/features/ai/providerCore.ts` 신설:
```ts
// 공통: toModelMessages, buildZodSchema, runGenerate(model, prompt, history, options, label)
// runGenerate 내부 generateText 호출에 onStepEnd 콜백 추가:
//   - 각 스텝의 toolCalls/toolResults를 즉시 수집(현 result.steps 사후파싱보다 견고)
//   - 스텝별 성공/실패 로깅 (= model boundary 관측점 확보)
//   - 반환은 기존과 동일한 { text, toolRecords } (behavior-preserving)
```
`geminiProvider.ts`/`opencodeZenProvider.ts`는 model 빌드 + `runGenerate` 호출만 하는 얇은 래퍼로 축소.
`conversationStore.getToolHistory`를 `sessionReply.ts`(답장 이어가기)의 히스토리 조립에 연결 —
직전 턴 도구 성공/실패 요약을 프롬프트 컨텍스트로 주입.

---

## 6. 재사용 자산 (이미 lishibot에 존재 — "증축" 근거)

| 필요한 것 | lishibot 기존 자산 |
|---|---|
| LLM 자발 호출 인터페이스 | `ProviderAdapter.generate()` (`aiPolicy.ts:56`) |
| 액션 실행 + 권한 | `toolRegistry` (53개 도구) + 3계층 `permissionCheck.ts` |
| 승인 게이트 | `PendingProposal` (단, **죽어 있음 → C3**) |
| 스케줄링 원형 | `RewardExtension` 시각 랜덤 드롭 + Supabase 스케줄 저장 (→ croner 첫 치환 대상) |
| 이벤트 훅 인프라 | `@pikokr/command.ts` `@listener` (= OpenClaw internal hooks 대응) |
| 영속 DB 파이프라인 | Supabase + `data/migrations/*.sql` (테이블만 추가) |
| 프롬프트 주입 슬롯 | `handleMessageCreate`의 `promptParts` 배열 (`messageCreate.ts:162`) |
| HTTP 서버 패턴(웹훅용) | `src/tts/controlServer.ts` |

---

## 7. 미결정 사항 (결정 필요)

1. **PendingProposal (C3)**: 되살리기 vs 제거? → 되살리기 권장.
2. **pgvector 도입 (기반 3단계)**: 임베딩 비용/인프라 감수? 임베딩 모델은? (Gemini embedding vs OpenAI `text-embedding-3-small`)
3. **모델 등급 (AGENT_AUDIT #6)**: 현 `gemini-3.1-flash-lite`/`deepseek-flash`로 plan-execute-verify는 무리.
   자율 판단/다단계 작업 도입 전 모델 등급 결정 필요.
4. **자율 발화 허용 범위**: heartbeat가 "먼저 말 걸기"를 어디까지 허용? (스팸 리스크 — 채널/빈도/조건 게이트)
5. **세션 영속 대상**: 대화 히스토리 전체 vs 요약만? (Supabase 용량/비용)
6. **Discord 도구 빈틈 (AGENT_AUDIT #5)**: 메시지 검색/삭제/수정·웹훅·이모지·핀·투표·이벤트 —
   기반 완성 후 별도 트랙. (OpenClaw Discord 채널 클러스터 재분석 필요 시 §2 참조)

---

## 부록 A — 핵심 파일 경로 (절대경로)

**추론 루프/프로바이더**
- `/home/ubuntu/lishibot/src/features/ai/geminiProvider.ts` (`generateText` :100, `stepCountIs` :105)
- `/home/ubuntu/lishibot/src/features/ai/opencodeZenProvider.ts` (:108, :113)
- `/home/ubuntu/lishibot/src/features/ai/aiProviderChain.ts` (primary→fallback→dryRun)
- `/home/ubuntu/lishibot/src/modules/AiMentionExtension.ts` (체인 배선 :40-78, provider 하드코딩 :48)
- `/home/ubuntu/lishibot/src/features/ai/aiPolicy.ts` (타입 계약 `ProviderAdapter` :56)

**세션/메모리**
- `/home/ubuntu/lishibot/src/features/ai/conversationStore.ts` (인메모리 Map, `getToolHistory` :139 write-only)
- `/home/ubuntu/lishibot/src/features/ai/memoryStore.ts` (`user_memories`, 15개 FIFO :57-63)
- `/home/ubuntu/lishibot/src/features/ai/systemPrompt.ts` (`KOREAN_SYSTEM_PROMPT`, 재시도 지시 :100-106)
- `/home/ubuntu/lishibot/src/events/messageCreate.ts` (신규 대화 오케스트레이션, `promptParts` :162)
- `/home/ubuntu/lishibot/src/features/ai/sessionReply.ts` (답장 이어가기 :98)
- `/home/ubuntu/lishibot/data/migrations/001_create_user_memories.sql`

**자율성 원형**
- `/home/ubuntu/lishibot/src/modules/RewardExtension.ts` (60초 selfInterval 스케줄 :240-249)
- `/home/ubuntu/lishibot/src/modules/Hello.ts` (30초 presence :90-96)
- `/home/ubuntu/lishibot/src/structures/Client.ts`, `/home/ubuntu/lishibot/src/index.ts` (부팅)

## 부록 B — OpenClaw 참고 문서 (경로)

`~/.nvm/versions/node/v24.11.0/lib/node_modules/openclaw/docs/`
- `concepts/`: `session.md` `session-pruning.md` `memory.md` `memory-builtin.md` `active-memory.md`
  `memory-search.md` `compaction.md` `dreaming.md` `agent-loop.md` `commitments.md` `queue.md`
  `queue-steering.md` `model-failover.md` `retry.md` `delegate-architecture.md` `multi-agent.md`
- `automation/`: `index.md` `cron-jobs.md` `standing-orders.md` `tasks.md` `hooks.md`
- `src/agents/templates/HEARTBEAT.md`

## 부록 C — 신규 테이블 스케치 (마이그레이션은 수동 적용)

> 프로젝트 관례: Supabase 마이그레이션은 수동 적용, 메인 길드 `1440598081648328816`.

```sql
-- 기반 2단계: 세션 영속
CREATE TABLE ai_sessions (
  session_key TEXT PRIMARY KEY,           -- guild:channel:user
  guild_id TEXT, channel_id TEXT, user_id TEXT,
  session_started_at TIMESTAMPTZ, last_interaction_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);
CREATE TABLE ai_session_messages (
  id BIGSERIAL PRIMARY KEY,
  session_key TEXT REFERENCES ai_sessions(session_key) ON DELETE CASCADE,
  role TEXT,                              -- user | assistant | summary
  content TEXT, created_at TIMESTAMPTZ, discord_message_id TEXT
);

-- 기반 3단계: 메모리 계층 + 검색 (user_memories 확장)
ALTER TABLE user_memories
  ADD COLUMN tier TEXT DEFAULT 'longterm',    -- longterm | daily
  ADD COLUMN embedding vector(1536),
  ADD COLUMN recall_count INT DEFAULT 0,
  ADD COLUMN last_recalled_at TIMESTAMPTZ;

-- 자율 4단계: cron + 5단계: task 원장
CREATE TABLE cron_jobs (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT, schedule TEXT, kind TEXT,
  payload JSONB, channel_id TEXT, tz TEXT, enabled BOOL DEFAULT true,
  next_run_at TIMESTAMPTZ, last_run_status TEXT
);
CREATE TABLE agent_tasks (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT, requester_id TEXT, channel_id TEXT,
  kind TEXT, status TEXT,                 -- queued|running|succeeded|failed|timed_out|cancelled|lost
  payload JSONB, result JSONB, created_at TIMESTAMPTZ, ended_at TIMESTAMPTZ
);
```
