# lishibot AI 개선 브리프 — OpenClaw 설계 참고

> 목적: lishibot의 AI 에이전트 기능을 OpenClaw(상주 에이전트 프레임워크) 설계를 참고해 한 단계 끌어올린다.
> 이 문서 하나로 바로 착수할 수 있게 정리했다. 작성: 코하루(현 OpenClaw 상주 에이전트) / 2026-07-10.

---

## 0. 프로젝트 기본 정보

- **작업 위치**: `/home/ubuntu/lishibot` (main 브랜치, GitHub `litsyneko/lishiBot`)
- **빌드/배포**: `pnpm build` → `pm2 restart lishibot` (프로세스명 `lishibot`, node dist). 로그: `pm2 logs lishibot`
- **정본 문서**: `tudo-agent-plan.md`(설계) / `tudo-agent-progress.md`(진행 로그, 충돌 시 우선). AI 증축 D-1~D-17 기록됨.
- **DB**: Supabase Postgres 전용. 마이그레이션 자동 러너 없음(수동 Supabase 적용). 코드는 테이블 없어도 RAM fallback으로 살아야 하는 규율 유지.
- **핵심 소스 디렉토리**: `src/features/ai/` (providerCore, conversationStore, serverProfile, memoryStore, systemPrompt, tools/), `src/modules/AiMentionExtension.ts`(멘션·답장·cron·heartbeat·승인 핸들러 진입점)
- **모델**: Gemini + OpenCode Zen 체인. 서브에이전트/워크플로 사용 시 `model: 'sonnet'` 선호(리시 지침).

## 1. 현재 상태 — 이미 OpenClaw 뼈대를 닮은 부분 (재작업 불필요)

lishibot AI는 이미 OpenClaw의 핵심 골격을 상당 부분 의도적으로 닮게 지어졌다. 아래는 **건드리지 말 것**(잘 돌아감):

- **세션 영속**: `guild:channel:user` 키, Postgres write-through + RAM fallback, 부팅 복원, daily 롤오버/idle 만료 (`conversationStore.ts`)
- **승인 게이트**: danger 도구는 Component V2 카드로 사람 승인. L3 권한 재검, 거부 기록, 5분 TTL, 결정 후 3초 카드 자동 제거. 위험도 동적 판정(`roleRisk.ts`)
- **자율성**: standing orders + cron(예약 등록·실행·취소, 샌드박스) + heartbeat(기본 OFF, 5중 게이트) — OpenClaw automation 모델과 결이 같음
- **소울(정체성)**: 서버별 소울/컨셉/채널용도/지침을 모든 AI 턴에 주입 (`serverProfile.formatServerContextForPrompt`)
- **권한 인지**: 요청자 세부 권한을 프롬프트에 주입(`permissionSummary.ts`)
- **도구**: 디스코드 조작 다수 + 대량 삭제(`bulk_delete_messages`)

→ 즉 "구조를 갈아엎는" 개선이 아니라, **깊이가 얕은 3개 축**을 OpenClaw 참고로 키우는 게 핵심.

## 2. 개선 3축 (OpenClaw 참고)

OpenClaw 문서 루트: `/home/ubuntu/.nvm/versions/node/v24.11.0/lib/node_modules/openclaw/docs` (미러: https://docs.openclaw.ai). 아래 개념 문서는 `docs/concepts/`.

### 축 1. 기억의 깊이 — 메모리 계층·회상·dreaming (최우선, 임팩트 최대)

- **현재 문제**: `memoryStore.ts`의 `save_memory`가 평면(flat) 저장뿐. 계층·의미검색·자동 정리 없음. "전에 말한 걸 진짜로 활용"하는 수준이 얕다.
- **OpenClaw 참고**:
  - `concepts/memory-builtin.md` — 기본 메모리 백엔드: 키워드(FTS5/BM25) + 벡터 + 하이브리드 검색
  - `concepts/memory-search.md` — 임베딩 기반 의미 검색(워딩 달라도 관련 노트 회수)
  - `concepts/active-memory.md` — 메인 응답 **전에** 관련 기억을 주입하는 blocking 서브에이전트(수동적 저장을 넘어 능동적 회상)
  - `concepts/dreaming.md` — 백그라운드 기억 통합(light/deep/REM 단계 + Dream Diary), 단기 신호를 장기로 승격. opt-in.
- **lishibot 착수 방향**:
  1. 메모리를 계층화: 단기(세션/일자) → 장기 승격 기준 정의
  2. 의미 검색: Supabase `pgvector` 확장 + 임베딩(곡/사실 청크). 새 마이그레이션 필요(벡터 컬럼/테이블)
  3. `recall` 도구 신설(또는 프롬프트 주입 단계에서 능동 회상) — active-memory 모델
  4. dreaming 배치: heartbeat/cron 인프라 재활용해 야간에 단기→장기 승격(기존 자율성 인프라와 붙음)
- **손볼 곳**: `memoryStore.ts`, 새 마이그레이션(pgvector), 프롬프트 주입부(`sessionReply.ts`/`messageCreate.ts`/`serverProfile.ts`), 도구 등록(`toolRegistry.ts`)
- **주의**: 이미 `tudo-agent-plan.md §2`에 "스스로 성장" 축(메모리 tier·active recall·dreaming)으로 예고돼 있음. 착수 전 리시와 범위 합의.

### 축 2. 컨텍스트 보존 — compaction (체감 개선 가장 빠름)

- **현재 문제**: 대화가 길어지거나 답장으로 넘어가면 tool 결과를 240자로 **자르는 게 전부**(`conversationStore.ts`의 `MAX_TOOL_HISTORY_FIELD_LENGTH`, `formatToolHistoryForPrompt`). 중요 정보가 절단으로 유실됨.
- **실증 버그**: 음악 재생 시 `search_music` 결과의 URL이 240자 절단으로 유실 → AI가 재생 못 하고 "링크 달라"고 함(D-17에서 uri 노출로 우회했지만 근본은 절단 문제).
- **OpenClaw 참고**:
  - `concepts/compaction.md` — 긴 대화를 요약으로 압축해 context window 유지(자르는 게 아니라 요약)
  - `concepts/context-engine.md` — 컨텍스트 조립·compaction·서브에이전트 경계 관리(pluggable)
- **lishibot 착수 방향**: 단순 절단 대신 (a) 요약 압축, (b) 중요 필드(uri, id 등) 보존 우선순위, (c) 오래된 tool 결과는 요약하고 최근은 원문 유지
- **손볼 곳**: `conversationStore.ts` (`formatToolHistoryForPrompt`, 절단 로직), 필요 시 요약용 경량 모델 호출

### 축 3. 작업 분해 — 서브에이전트 위임 (큰 변경, 신중)

- **현재 문제**: `providerCore.runGenerate`의 단일 턴 maxSteps 루프로 모든 걸 처리. "서버 싹 정리해줘" 같은 대형/다단계 요청에서 한 루프가 과부하.
- **OpenClaw 참고**:
  - `concepts/multi-agent.md` — 격리된 에이전트(각자 workspace/state/session)
  - `concepts/delegate-architecture.md`, `concepts/parallel-specialist-lanes.md` — 위임/병렬 전문 레인
- **lishibot 착수 방향**: 큰 작업을 하위 작업으로 분해해 순차/병렬 실행하는 오케스트레이션 계층. **단, 기존 단일 턴 흐름을 크게 건드리는 변경이라 1·2번 안정화 후 착수 권장.**
- **손볼 곳**: 신규 오케스트레이션 계층(providerCore 위), 승인 게이트/권한 전파 재사용

## 3. 권장 우선순위

1. **축 2 (compaction)** — 실사용 버그(맥락 유실) 직결, 체감 빠름, 변경 범위 작음. **먼저 하면 좋음.**
2. **축 1 (메모리 깊이)** — 임팩트 최대지만 pgvector·마이그레이션·dreaming까지라 범위 큼. 리시와 스코프 합의 필수.
3. **축 3 (작업 분해)** — 가장 크고 위험. 1·2 안정화 후.

(원 분석에서 "실속 순서 1→2→3"으로 봤으나, 실사용 버그 감소 체감은 축 2가 제일 빠름. 착수 순서는 리시 결정.)

## 4. 작업 규율 (반드시 준수)

- **커밋**: AI 관련 파일만 골라 스테이징. 워킹트리에 무관한 대규모 미커밋 변경(activityLevels/economy/moderation/music 등 60+개)이 섞여 있으니 `git add`로 개별 지정. `package.json`/`pnpm-lock`은 의존성이 섞여 별도 정리 커밋. 커밋 메시지 끝에 `Co-Authored-By` 관례 있음.
- **마이그레이션**: 자동 러너 없음 → 수동 Supabase 적용. 코드는 테이블 없어도 RAM fallback으로 죽지 않아야 함.
- **배포 검증**: `pnpm build`(tsc) + `pnpm lint` exit 0 확인 → `pm2 restart lishibot` → 부팅 로그로 세션 로드/커맨드 sync/에러 확인.
- **customId 충돌 맵**: `aiApproval:` `aiOnboarding:` `agentcfg:` `agentcfgModal:` (AI) · `ctrl:`(Music) · `drop_`(Reward) · `serverlog:`(ServerLog) · `dropcfg:`(경제)
- **UX 문구는 전부 한국어.** 에이전트 정체성(소울/서버이해/자율성)을 잊지 말 것 — 단순 설정봇이 아니라 상주 에이전트.
- **정본 갱신**: 작업하면 `tudo-agent-progress.md`에 D-18~ 항목으로 기록.

## 5. 참고 — 미완으로 남은 별건

- **음악 "변경 vs 추가"**: 재생 중 "X로 변경/바꿔줘" 요청 시 `play_music`이 교체가 아니라 대기열 추가만 함(`musicTool.ts` play_music은 항상 `queue.add`). 즉시 교체 방법 존재(`controllerInteraction.ts:120` `player.play({ clientTrack })`, `player.skip()` 참고). play_music에 `now`/`replace` 파라미터 추가 + "변경" 의도 매핑으로 해결 가능. (이 브리프 3축과는 별개 버그픽스)
