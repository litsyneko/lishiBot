# lishibot 에이전트 증축 — 세션 인계 요약

> 작성: 2026-07-08 (KST)
> 목적: 다음 AI가 현재 상태를 빠르게 파악하고 작업을 이어받기 위한 핸드오프 문서.
> 정본 문서: `tudo-agent-plan.md`(설계 청사진), `tudo-agent-progress.md`(진행 로그 — 충돌 시 우선).

---

## 1. 프로젝트 개요

- **봇**: FullMoon 디스코드 도우미 (코하루/칸나), 메인 길드 `1440598081648328816`
- **목표**: "기억상실증 걸린 반응형 에이전트"를 **진짜 에이전트**로 증축
- **범위**: 디스코드 내 작업만 (봇 코드 자체 수정, 프로젝트 외부 코드 작업 아님)
- **허용 유저**: 리시, 설연
- **UX 언어**: 전부 한국어
- **작업 위치**: `/home/ubuntu/lishibot` (main 브랜치, **전부 미커밋**)

---

## 2. 현재 완료 상태

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | `providerCore.ts` 추출 + `onStepEnd` 스텝 경계 | ✅ 완료 |
| 2 | `toolHistory` read 연결 (write-only 버그 해소) | ✅ 완료 |
| — | DB 마이그레이션 `021_ai_agent_sessions.sql` | ✅ 완료 (Supabase 수동 적용 필요) |
| 4 | 세션 DB write-through + `guild:channel:user` 채널 키 + RAM fallback | ✅ 완료 |
| 3 | 승인 게이트 (danger 도구 execute 래핑, V2 승인 카드+버튼) | ✅ 완료 + 적대 리뷰 통과 |
| 4a | 온보딩 (서버 프로필 로더 + 관리자 첫 진입 안내 + 거부 숨김) | ✅ 완료 |
| 5 | 한국어 명령어 (`/에이전트` 5종 + 승인 정책 DB 배선) | ✅ 완료 (progress D-5) |
| 6 | **자율성** (standing orders → cron → heartbeat) | ⏸ **다음 착수** |

---

## 3. 이번 세션에서 변경된 파일 목록

### 신규 생성

| 파일 | 역할 |
|---|---|
| `src/features/ai/approvalGate.ts` | danger 도구 보류 수집기 (`ProposalCollector`, UUID dedupe, APPROVAL_TTL_MS 5분) |
| `src/features/ai/serverProfile.ts` | 서버 프로필 로더 + RAM 캐시(10분 TTL). `getServerProfile` / `upsertServerProfile` / `ApprovalPolicy` 타입 |
| `src/features/ai/onboarding.ts` | 온보딩 상태 추적. `shouldShowOnboarding` / `dismissOnboarding` (2h/24h/next_chat, RAM-only) |
| `src/features/ai/onboardingCard.ts` | Components V2 온보딩 카드. customId: `aiOnboarding:start\|dismiss2h\|dismiss24h\|dismissChat:<guildId>` |

### 수정

| 파일 | 주요 변경 |
|---|---|
| `src/features/ai/tools/proposalCard.ts` | 죽은 `buildProposalEmbed`/`severityColor` 제거. V2 승인 카드 `buildApprovalCard`/`buildResolvedApprovalCard` 신설. customId `aiApproval:approve\|deny:<uuid>` |
| `src/features/ai/tools/toolTypes.ts` | 미사용 `ProposalInfo` 타입 제거 (ApprovalProposal로 대체됨) |
| `src/features/ai/conversationStore.ts` | `continueSession()` 신설 (롤오버 패치). `reviveSession` export 제거 (내부 전용) |
| `src/features/ai/sessionReply.ts` | `continueSession` 사용으로 전환 (롤오버 규율 준수) |
| `src/modules/AiMentionExtension.ts` | 승인 게이트 배선 + 온보딩 체크 + 두 개의 `@listener interactionCreate` 핸들러 추가 |

### 데이터 마이그레이션

| 파일 | 내용 |
|---|---|
| `data/migrations/021_ai_agent_sessions.sql` | `ai_sessions`, `ai_session_messages`, `server_profile` 테이블. **Supabase 대시보드에서 수동 적용 필요** |

---

## 4. 핵심 아키텍처 결정 (다음 AI가 알아야 할 것)

### 승인 게이트
- **danger 도구만 게이트** — warning/info는 즉시 실행
- **흐름**: 모델이 danger 도구 호출 → `collector.propose()`가 실행 없이 sentinel 반환(`success:true`, "보류했어요" 메시지) → generate 종료 후 `sendApprovalCards()`로 V2 카드 전송 → 버튼 클릭 → L3 권한 재검 → `toolDef.execute()` 실행 → `followUp` 결과 메시지
- **SDK 제약 이해 필수**: `generateText` 자율 멀티스텝 루프라 execute 안에서 사람 승인을 `await` 불가. "루프 내 보류 + 루프 밖 후속 실행" 구조가 유일하게 안전

### 세션
- 키: `guild:channel:user` (채널 분리)
- 만료 이원화: `session_started_at`(KST daily 롤오버) + `last_interaction_at`(idle 2h)
- DB 없으면 RAM fallback (42P01 에러 시 조용히 degraded)
- 쓰기: fire-and-forget + 세션별 직렬화 체인 (FK 위반 방지)

### 온보딩
- AI 응답을 막지 않음 — 추가 메시지로만 전송
- 거부 상태: RAM-only (의도적) — 봇 재시작 시 리셋, 미온보딩 서버에 계속 안내
- `start` 버튼 = `onboarded_at` DB 기록. 세부 세팅(컨셉·채널 용도)은 `/에이전트 설정` 단계에서
- `approval_policy` 타입은 준비됐으나 승인 게이트 동작은 아직 하드코딩 안전기본값

### 안전 기본값
- `server_profile` 없을 때: `dangerGate: 'admin_only'` (위험 도구 = 무조건 관리자 승인)
- DB 전체가 죽어도 RAM-only로 봇 생존

---

## 5. 다음 착수 — 6번 자율성

standing orders → cron → heartbeat 순. `tudo-agent-plan.md §2 기반 3` + `tudo-agent-progress.md §B` cron 샌드박스 원칙 참조.

### 5번 완료 요약 (상세: progress D-5)
- `/에이전트` 5종: `상태` / `설정_컨셉` / `설정_채널` / `설정_정책` / `세션_초기화` — 전부 `requireServerManager` + `guardServerManager`(CommandAccessError → ephemeral 안내) 게이트.
- 승인 게이트가 이제 `server_profile.approvalPolicy.dangerGate`를 읽음: `none`=게이트 우회 즉시 실행, `admin_only`(기본)=관리자/오너만 버튼 결정, `requester`=요청자 본인만. 승인 시점 L3 재검 유지.
- 전역 `applicationCommandInvokeError` 핸들러는 로그만 남김(사용자 무응답) — 새 명령어는 `guardServerManager`로 흡수. AdminExtension 기존 명령들은 여전히 bare-throw(무응답) 패턴이니 혼동 주의.

---

## 6. 주의사항

### 커밋
```bash
# 워킹트리에 AI 무관 대규모 미커밋 변경(activityLevels/moderation/economy 등 6천 줄+) 섞여 있음
# 반드시 AI 파일만 골라서 스테이징
git add src/features/ai/ src/modules/AiMentionExtension.ts data/migrations/021_ai_agent_sessions.sql
```

### 빌드·린트
```bash
cd /home/ubuntu/lishibot && pnpm build  # tsc
cd /home/ubuntu/lishibot && pnpm lint   # eslint
```

### DB 마이그레이션
`data/migrations/021_ai_agent_sessions.sql`을 Supabase 대시보드 SQL Editor에서 직접 실행.
(이 레포는 자동 마이그레이션 러너 없음. 코드는 테이블 없어도 RAM fallback으로 생존.)

### customId 충돌 맵
| prefix | Extension |
|---|---|
| `aiApproval:` | AiMentionExtension — 승인 버튼 |
| `aiOnboarding:` | AiMentionExtension — 온보딩 버튼 |
| `ctrl:` | MusicExtension |
| `drop_` | RewardExtension |
| `server_log_` | ServerLogExtension |

---

## 7. 핵심 파일 경로 빠른 참조

```
src/features/ai/
  providerCore.ts          — generateText 공통 코어, onStepEnd 관측
  conversationStore.ts     — 세션 RAM 캐시 + DB write-through
  approvalGate.ts          — danger 도구 보류 수집기
  serverProfile.ts         — server_profile DB 로더 + RAM 캐시
  onboarding.ts            — 온보딩 상태 추적 + 거부 숨김
  onboardingCard.ts        — V2 온보딩 카드 빌더
  permissions/
    permissionCheck.ts     — L3 권한 체크 (재사용할 것)
  tools/
    proposalCard.ts        — V2 승인 카드 빌더
    toolRegistry.ts        — 53개 도구 등록
    toolTypes.ts           — 타입 계약

src/modules/
  AiMentionExtension.ts    — 멘션/답장 진입점, 승인+온보딩 배선

data/migrations/
  021_ai_agent_sessions.sql — ai_sessions / ai_session_messages / server_profile
```
