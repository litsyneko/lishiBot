# Discord Guild Onboarding API 조사 (lishibot 적용 사전 조사)

> 목적: 추후 lishibot에 "디스코드 서버 온보딩 설정을 봇으로 조회/수정" 기능을 붙이기 위한 사전 조사.
> 출처: discord.js / discord-api-types 스펙(공식 개발자 문서 페이지는 현재 404/SPA라 라이브러리 타입으로 확정). discord.js 14.26 지원 확인.
> 작성: 코하루 / 2026-07-10. **구현은 추후** — 지금은 사용법 파악·확인 단계.

## 1. REST 엔드포인트

- **GET** `/guilds/{guild.id}/onboarding` — 온보딩 설정 조회
- **PUT** `/guilds/{guild.id}/onboarding` — 온보딩 설정 수정
- 권한: **MANAGE_GUILD + MANAGE_ROLES 둘 다** 필요
- ⚠️ PUT은 **전체 교체(replace)**. 부분 수정이 아니라 통째로 덮어씀 → 반드시 **조회 → 병합 → 저장** 패턴으로. 안 그러면 기존 프롬프트/설정 유실.

## 2. Onboarding 객체 (APIGuildOnboarding)

- `guild_id`
- `prompts` — 온보딩 질문 배열 (아래 4)
- `default_channel_ids` — 신규 멤버에게 기본 노출할 채널 id 배열
- `enabled` (boolean) — 온보딩 활성화 여부
- `mode` — 제약 계산 방식 (아래 3)

## 3. mode (GuildOnboardingMode)

- `0` ONBOARDING_DEFAULT — **기본 채널만** 활성화 제약에 계산
- `1` ONBOARDING_ADVANCED — **기본 채널 + 질문** 모두 제약에 계산

## 4. Prompt (APIGuildOnboardingPrompt)

- `id`
- `type` — `0` MULTIPLE_CHOICE / `1` DROPDOWN
- `options` — 선택지 배열 (아래 5)
- `title` — 질문 제목
- `single_select` (boolean) — 단일 선택만 허용?
- `required` (boolean) — 필수 응답?
- `in_onboarding` (boolean) — 온보딩 흐름에 노출? (false면 역할/채널 메뉴에만)

## 5. Prompt Option (APIGuildOnboardingPromptOption)

- `id`
- `title`, `description`
- `emoji` — 선택지 이모지
- `role_ids` — 이 선택 시 **부여할 역할** id 배열
- `channel_ids` — 이 선택 시 **접근 줄 채널** id 배열

→ 즉 "관심사 고르면 역할/채널 자동 지급"이 role_ids/channel_ids로 표현됨. 풀문의 게임·관심 역할 자동화가 여기에 해당.

## 6. discord.js 사용법 (14.26)

```ts
// 조회
const onboarding = await guild.fetchOnboarding() // GuildOnboarding

// 수정 (GuildOnboardingEditOptions)
await guild.editOnboarding({
  enabled: true,
  mode: GuildOnboardingMode.Default, // or .Advanced
  defaultChannels: ['channelId', ...],
  prompts: [
    {
      // GuildOnboardingPromptData
      id,               // 기존 프롬프트 수정 시 id 유지, 신규는 생략/임시
      title: '관심사를 골라주세요',
      type: GuildOnboardingPromptType.MultipleChoice, // or .Dropdown
      singleSelect: false,
      required: false,
      inOnboarding: true,
      options: [
        {
          title: '배틀그라운드',
          description: '...',
          emoji: '🎮',
          roles: ['roleId'],      // role_ids
          channels: ['channelId'] // channel_ids
        },
      ],
    },
  ],
  reason: '온보딩 갱신',
})
```

- 편집 옵션(GuildOnboardingEditOptions): `defaultChannels`, `enabled`, `prompts`, `mode`, `reason`
- 프롬프트 편집(GuildOnboardingPromptData): `id`, `title`, `type`, `singleSelect`, `required`, `inOnboarding`, `options`

## 7. 활성화 제약 (개요 — 구현 시 재확인 필요)

- **커뮤니티 서버**여야 온보딩 사용 가능(풀문은 커뮤니티라 충족).
- 온보딩을 켜려면(enabled=true) 기본 채널·프롬프트 **최소 요건** 충족 필요 — 대략 "기본 채널 여러 개 + @everyone이 볼/쓸 수 있는 채널 최소 개수". 요건 미달이면 enable 실패(400).
- 정확 수치는 공식 문서 페이지 복구되면 재확인(현재 404). 조회(GET)는 제약 없음.

## 8. lishibot 적용 방향 (추후)

- 신규 도구/명령어: `온보딩 조회`(fetchOnboarding) + `온보딩 수정`(editOnboarding)
- **조회→병합→저장** 필수(PUT 전체 교체 특성) — 기존 프롬프트 유실 방지
- **danger 분류(승인 게이트)** 권장 — 온보딩은 신규 유입 경험을 좌우, 잘못되면 가입 흐름이 막힘
- 권한 체크: ManageGuild + ManageRoles (봇·요청자 둘 다)
- 풀문 케이스: 관심사 프롬프트 옵션의 role_ids로 게임·관심 역할 자동 지급 흐름을 봇이 관리 가능
