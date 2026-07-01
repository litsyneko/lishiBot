# AGENTS.md

이 디렉토리 한국어 중심 Discord 봇. 코드와 config가 README보다 항상 우선. 사양이 충돌하면 코드를 믿어라.

## 명령

```bash
pnpm dev      # ts-node --swc src (개발 실행)
pnpm build    # tsc (./dist 빌드)
pnpm start    # node dist (빌드 결과 실행, build 후에만)
pnpm lint     # eslint src --ignore-path .gitignore
```

패키지매니저는 `pnpm@8.3.1` 고정. `pnpm install` 후에만 작업.

## 테스트

테스트 없음. `pnpm test` 스크립트도 없다. 검증은 `pnpm lint` + `pnpm build` + 필요 시 직접 실행뿐. 테스트를 가정하거나 만들지 말 것.

## Config / 비밀

- `config.json`은 gitignored이며 live secrets 포함. 절대 읽지 말고, 출력/echo/로그/커밋하지 말 것.
- 환경변수 안 씀. `src/config.ts`는 `require('../config.json')`로만 로드. `process.env`는 src에 없다.
- `config.example.json`은 낡음. `economy.databasePath`를 예시로 들고 있지만 실제 Config 타입은 optional `supabase`만 가짐. 예시를 Config 진실로 쓰지 말 것.
- Config 값 필요하면 `src/config.ts`와 Config 타입 정의를 봐라. 값 자체는 말하지 말 것.

## 아키텍처

- 진입점 `src/index.ts`. GatewayIntentBits.MessageContent 포함.
- `src/structures/Client.ts`:
  - config.guilds 대상 application commands 활성화
  - owner 전용 `/reload` 등록
  - `loadAllModulesInDirectory(path.join(__dirname, '..', 'modules'))`로 모든 모듈 자동 로드
- 모듈은 `src/modules/*.ts`에 12개 파일. 새 모듈 추가해도 Client가 디렉토리를 스캔하므로 별도 등록 불필요.
- `src/modules`가 핵심 확장점.

## AI Provider 체인

`src/modules`의 `AiMentionExtension.buildProvider`:

1. `geminiApiKey` 있으면 Gemini 주 provider, 모델 `gemini-3.1-flash-lite`.
2. 추가로 provider가 `opencode-zen`이고 apiKey도 있으면 Gemini 주 + OpenCode Zen 폴백 체인.
3. Gemini 키는 없고 provider/apiKey만 있으면 OpenCode Zen 단독.
4. 둘 다 없으면 undefined (dry-run).

`aiProviderChain`은 provider 에러를 잡아 한국어 dry-run 텍스트로 반환. throw하지 않는다.

## Tool Registry

`toolRegistry`는 41개 도구를 `register(...)`로 수동 등록. AI 도구는 자동 로드 안 됨. 도구 추가하려면 레지스트리 파일 직접 수정.

## Data / Migrations

- `data/migrations/`에 SQL 파일 6개. Supabase SQL Editor에서 순서대로 실행.
- Supabase RPC/from 호출이 economy/music/soundboard/memory의 핵심.
- README는 migrations 2개라고 하지만 틀림. 실제 6개.

## Lavalink

별도 Java 프로세스, 포트 2333. `start.ps1`(Windows) / `start.sh`가 Lavalink 먼저 띄우고 봇 실행. Lavalink 없이 봇만 띄울 땐 `--no-lavalink` 또는 `-NoLavalink`.

## 한국어

- 한국어가 압도적. src 51개 파일에 한국어 매치 1083개. README도 한국어.
- `src/config/korea.ts`:
  - 타임존 `Asia/Seoul`
  - 로케일 `ko-KR`, 언어코드 `ko`
  - `formatWon`, `formatKoreanDateTime` 헬퍼
- 사용자 응답, 메시지, dry-run 텍스트는 한국어 우선.

## Discord 운영 메모

- 사용자가 패치노트 게시를 요청하면 `#📋║패치노트` 채널에 올린다. 임베드가 가능하면 임베드를 우선하고, 상황에 따라 일반 메시지로 정리해도 된다.

## 코드 스타일

- TypeScript: target ES2022, module commonjs, strict true.
- `experimentalDecorators` true, `emitDecoratorMetadata` true.
- outDir `./dist`, include `src`, exclude `node_modules`/`dist`.
- Prettier: `semi: false`, `singleQuote: true`, `@trivago/prettier-plugin-sort-imports`.
- ESLint: recommended + @typescript-eslint/recommended + `prettier/prettier` error. lint = 곧 포맷 규칙.
- 로그는 `src/utils/logger.ts` (winston 래퍼). `logger.info(category, message)` 형태 선호. console 직접 쓰지 말 것.
- 사용자 노출 에러는 `src/domain/errors.ts`의 `CommandAccessError(messageForUser)`.

## 생성 / 민감 경로 (gitignored 또는 생성물)

건드리지 말 것:

- `dist` (build 산출물)
- `node_modules`
- `lavalink`
- `.omo`
- `.env*`
- `data/*.db`
- `config.json`

## README 주의

README의 카운트는 낡음:

- modules: README 9 vs 실제 12
- AI tools: README 34 vs 실제 41
- migrations: README 2 vs 실제 6

충돌 시 코드/config 우선.

## 검증 가이드

- 변경 후 `pnpm lint` 먼저. 에러 없어야 통과.
- 실행 전 `pnpm build` 성공 확인.
- AI/모듈 변경은 봇을 직접 기동해 동작 확인.
- 커밋은 사용자가 명시적으로 요청할 때만. 자발적 커밋 금지.

## 핵심 원칙

1. config.json 절대 읽/출력/커밋 금지.
2. 테스트는 없다. lint와 실행으로 검증.
3. 새 모듈은 자동 로드. 새 AI 도구는 수동 등록.
4. 한국어 우선. 응답/메시지는 한국어.
5. README보다 코드가 우선.
