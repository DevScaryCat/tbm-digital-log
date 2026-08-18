// lib/hazardKey.ts — 위험요인 문구를 "같은 위험인가" 판정용 키로 정규화한다.
//
// 왜 필요한가 (2026-08-19 Chris·검토자 지적: "중첩으로 잡히는 경우가 있더라"):
// 회의록의 위험요인은 AI가 뽑은 자유 문장이라 같은 위험이 표기만 바꿔 갈라진다.
// 집계가 완전일치 문자열이면 그때마다 별개 항목이 되어 키워드 칩·기인물 막대가 부풀었다.
// 특히 종전 dedupeHazards는 키가 `요인|등급|대책`이라, **같은 요인도 대책 문구가 한 글자만
// 달라지면 두 줄**이 됐다(다른 날 같은 위험을 다르게 적으면 매번 새 행).
//
// 규율 — **뜻이 비슷해 보인다고 다른 낱말을 합치지 않는다.**
//  · "안전모 미착용"과 "안전화 미착용"은 서로 다른 위험이다. 낱말 겹침 비율로 묶으면
//    이런 쌍이 조용히 하나로 뭉개진다. 통계가 거짓말하는 것보다 두 줄로 보이는 게 낫다.
//  · 그래서 여기서 합치는 것은 두 가지뿐이다:
//      (a) 표기만 다른 같은 문구 — 공백·구두점·끝에 붙는 일반어(위험/노출/주의…) 차이
//      (b) 한쪽이 다른 쪽에 통째로 들어 있는 경우 — "감전 위험" ⊂ "분전함 감전 위험"
//  · 뜻은 같은데 낱말이 다른 쌍("포름알데히드 흡입 노출" / "포름알데히드 화학물질 노출")은
//    **추출 단계에서 막는다** — app/api/ai/minutes/route.ts 프롬프트의 '쪼개지 말 것' 규칙.
//    이미 저장된 과거 기록은 그대로 두 줄로 남는다(문구를 사후에 고쳐 쓰지 않는다).
//
// ⚠️ 앱(tbm-app) `src/lib/hazardKey.ts`에 같은 파일이 있다. 한쪽만 고치면 화면과 보고서의
//    집계가 어긋난다 — 규칙을 바꾸면 반드시 양쪽을 같이 바꿀 것.

/** 끝에 붙어 뜻을 바꾸지 않는 일반어 — "추락 위험"과 "추락"은 같은 것을 가리킨다 */
const GENERIC_TAIL = /(위험성|위험|우려|주의|발생|가능성|노출)+$/;

/** 포함 병합의 최소 길이. 1글자는 아무 데나 들어가 오병합된다. */
const MIN_CONTAIN = 2;

/**
 * 포함 병합에서 **흡수되는 쪽이 되면 안 되는** 범용 낱말.
 * "작업"은 거의 모든 위험요인 문구에 들어 있어, 그대로 두면 "작업"이라는 한 줄이
 * 무관한 위험 여러 개 중 아무거나에 빨려 들어간다(감전·추락 같은 구체 명사와 다르다).
 */
const GENERIC_STEM = new Set([
  "작업", "현장", "공사", "이동", "사용", "점검", "관리", "안전", "기타", "설비", "장비", "기계",
]);

/** 위험요인 문구 → 집계 키. 빈 문자열이면 호출부가 원문을 키로 쓴다. */
export function hazardKey(factor: string): string {
  const bare = String(factor ?? "")
    .toLowerCase()
    .replace(/[\s·・,.'"“”‘’()[\]{}<>:;!?~\-–—/\\|]+/g, "");
  if (!bare) return "";
  const trimmed = bare.replace(GENERIC_TAIL, "");
  // 통째로 일반어인 문구("위험")는 깎으면 빈 문자열이 된다 — 원형을 살린다
  return trimmed.length >= 2 ? trimmed : bare;
}

/**
 * 2차 병합 — 짧은 키가 긴 키에 통째로 들어 있으면 긴 쪽(더 구체적인 문구)으로 합친다.
 * 살아남는 행이 더 구체적이어야 보고서가 "분전함 감전"이라 말하지 "감전"이라 말하지 않는다.
 */
export function mergeContainedKeys<T>(map: Map<string, T>, merge: (target: T, src: T) => void): void {
  // 짧은 것부터 — 긴 쪽으로 흡수시켜야 구체적인 문구가 남는다
  const keys = [...map.keys()].sort((a, b) => a.length - b.length);
  for (const k of keys) {
    if (k.length < MIN_CONTAIN || GENERIC_STEM.has(k)) continue;
    const src = map.get(k);
    if (!src) continue; // 앞선 회차에서 이미 흡수됨
    const host = keys.find((o) => o !== k && o.length > k.length && map.has(o) && o.includes(k));
    if (!host) continue;
    merge(map.get(host) as T, src);
    map.delete(k);
  }
}

/**
 * 위험요인 문구 목록 → 빈도 집계. 표시 문구는 **처음 나온 원문 그대로**다
 * (정규화 키는 공백이 없어 사람이 읽을 것이 못 된다).
 */
export function tallyHazardWords(factors: string[], limit = 8): { word: string; count: number }[] {
  const m = new Map<string, { word: string; count: number }>();
  for (const raw of factors) {
    const label = String(raw ?? "").trim();
    if (!label) continue;
    const key = hazardKey(label) || label;
    const cur = m.get(key);
    if (cur) cur.count += 1;
    else m.set(key, { word: label, count: 1 });
  }
  mergeContainedKeys(m, (target, src) => {
    target.count += src.count;
  });
  return [...m.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
