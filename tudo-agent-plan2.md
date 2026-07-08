# tudo-agent-plan2 — 디스코드 "손" 채우기 + 계획-구현 갭 메우기

> 작성: 2026-07-09 (KST)
> 배경: `#에이전트대화` 채널 원문(841개 메시지) 재검토 결과, 리시가 **가장 반복해서 강조한
>       "디스코드 모든 기능"(발화 198·614)과 콕 집어 지시한 "임베드 생성"(297)**이 미구현으로
>       확인됨. 뇌(안전·세션·자율·서버이해)는 계획대로 섰으나 "손"(콘텐츠 도구)이 절반이다.
> 정본: 이 문서는 tudo-agent-plan.md(초기 설계)의 **후속 실행 계획**. 진행은 tudo-agent-progress.md에 기록.

---

## 0. 리시 요구 원문 근거 (채널 재검토)

- 198: "진짜 에이전트처럼 만들어봐. **디스코드의 기능은 모두 넣어주면 좋겠어**"
- 614: "디스코드의 **모든 기능**을 할수있게 해야한다는게 **매우 중요**"
- 297: "메시지작성, **임베드 작성**할 줄 알아야 한다. 임베드 생성도 같이 넣자 너희처럼"
- 356: 승인 카드에 "**변경 전/후**, **위험도**" 명시
- 467: "AI가 자신의 **구조**를 알고 있어야 함" (self model + state)
- 503: "필요한 작업 **완료 후 어떻게 할지**" (finalize)
- 504: "채널이 제거되면 세션은?" (orphaned)
- 669: 온보딩 "**이 서버에서 다시 보지 않기**"(영구) 버튼

---

## 1. 갭 인벤토리 (디스코드 기능 매트릭스)

**완비(✅ 관리 계열)**: 채널·카테고리·역할·모더레이션·음성·멤버조회·닉네임·서버정보

**빠짐(❌ 콘텐츠·상호작용 계열)** — 이번 계획 대상:
| 영역 | 현재 | 없는 것 |
|---|---|---|
| 메시지 | 전송·읽기 | 수정·삭제·핀·반응·검색 |
| 임베드 | 없음 | 생성·전송·템플릿 |
| 스레드 | 수정·읽기 | 생성·답글·보관·잠금 |
| 포럼 | 채널생성·목록·읽기 | 포스트 작성·답글·태그·닫기 |
| 참여 | 없음 | 투표·이벤트·웹훅·이모지/스티커 업로드·공지 |

**계획-구현 갭(에이전트 완결성)**: finalize(작업 완료 처리)·세션 상태머신·채널 orphaned(channelDelete)·감사로그·승인카드 변경전후/위험도·온보딩 5번째 버튼·self model state 주입·허용유저 게이트(죽은 필드)

---

## 2. 실행 단계 (리시 강조 순)

### Phase 1 — 콘텐츠 핵심 (리시 최우선: 임베드 + 메시지)
- **신규 `embedTools.ts`**: `draft_embed`(info, 초안만 보여줌·전송 안 함) / `send_embed`(warning, 지정 채널 전송). title/description/fields/color/footer/author/thumbnail/image/timestamp. 자연어→임베드.
- **신규 `messageTools.ts`**: `edit_message`(warning), `delete_message`(danger — 되돌리기 불가), `pin_message`/`unpin_message`(warning), `react_message`(info), `search_messages`(info, 채널 내 키워드).
- 검증: build/lint + 실제 전송/삭제 스모크.

### Phase 2 — 스레드·포럼 쓰기
- **`threadTools.ts` 확장**: `create_thread`(warning), `reply_thread`(info), `archive_thread`/`lock_thread`(warning).
- **`forumTools.ts` 확장**: `create_forum_post`(warning, 제목+본문+태그), `reply_forum_post`(info), `close_forum_post`(warning).

### Phase 3 — 참여 기능
- 투표 `create_poll`(warning) / 이벤트 `create_event`(warning)·`list_events`(info) / 웹훅 `create_webhook`(danger)·`send_webhook` / 이모지 `list_emojis`(info)·`upload_emoji`(warning) / 스티커 `upload_sticker`(warning).

### Phase 4 — 에이전트 완결성 (계획-구현 갭)
- **finalize**: 작업 완료 후 결과 요약 + 변경 대상 + 실패/스킵 + 감사로그 + 세션 `done`.
- **세션 상태머신**: `Session`에 `status` 필드(active/waiting_approval/waiting_event/done/failed/orphaned/cancelled).
- **채널 orphaned**: `channelDelete` 리스너 → 해당 채널 세션 orphaned + pending 승인 취소 + 로그.
- **감사로그**: 승인/거부/실행을 `agent_audit_log`(신규 마이그레이션 023) 또는 기존 로그에 기록.

### Phase 5 — 디테일 보정
- 승인 카드에 "변경 전/후 요약 + 위험도" 표기(356).
- 온보딩 "이 서버에서 다시 보지 않기"(영구) 버튼 추가 → 5버튼(669).
- self model: AI 프롬프트에 "내 capabilities 목록 + 현재 state" 주입(467).
- **허용유저 게이트 살리기**: `allowedUsers`가 저장만 되고 안 읽힘 → 실제 접근 판정에 연결(안전 구멍).
- (선택) intent router: 채널 성격(작업방/잡담방) 판단.

---

## 3. 원칙
- 기존 `ToolDefinition` 패턴 재사용 → `toolRegistry` 등록 + `toolNameMap`(한글명) 추가.
- **danger 도구는 승인 게이트 자동 통과**(delete_message, create_webhook 등). warning/info는 즉시.
- `send_embed`/`send_webhook` 등 공개 발송은 채널 확인 + 위험도 신중.
- 한국어 UX. 각 Phase build/lint 통과 → pm2 재배포 → 스모크.
- 커밋은 **AI 파일만** 골라 스테이징(무관 대규모 미커밋과 분리). package.json은 별도.

---

## 4. 진행 체크리스트
- [x] Phase 1: embedTools + messageTools — 임베드(draft_embed/send_embed) + 메시지(edit/delete/pin/unpin/react/search) 8종. build/lint·pm2 배포 완료 (2026-07-09)
- [ ] Phase 2: 스레드/포럼 쓰기
- [ ] Phase 3: 투표/이벤트/웹훅/이모지/스티커
- [ ] Phase 4: finalize + 상태머신 + orphaned + 감사로그
- [ ] Phase 5: 승인카드 필드 + 온보딩 버튼 + self model + 허용유저 게이트
