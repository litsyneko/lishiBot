// 유튜브 제목 일부에는 \[ 같은 마크다운 이스케이프가 문자 그대로 포함된다.
// 임베드 제목은 디스코드가 마크다운을 처리하지 않아 백슬래시가 그대로 보이므로
// 표시 직전에 이스케이프를 되돌린다.
export function displayTrackTitle(title: string): string {
  return title.replace(/\\([[\]()~`>#+\-=|{}.!])/g, '$1')
}
