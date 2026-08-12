// lib/orgGrace.ts — "회사 구독이 언제 끊겼는가"의 **유일한 정의**.
//
// 유예(grace)는 무료 사용 기간이 아니다. **결정 기간**이다(Chris 2026-08-11):
//   · 회사 구독이 무효가 되는 즉시 작성·AI는 잠긴다(기존 동작 그대로).
//   · 기존 기록 열람·출력은 계속 된다 — 법정 서류라 접근을 끊지 않는다.
//   · 7일은 감독자가 결제를 되살릴 시간이다. 그 사이 현장 계정에게 개인 결제를 들이밀지 않는다.
//
// ⚠️ **개인 결제 전환은 없다**(Chris 2026-08-11 2차 정정 — 종전 설계 번복).
//    7일이 지나도 문은 열리지 않는다. 감독자가 그만두면 그 계정들은 그냥 못 쓴다.
//    현장 계정이 회사 결제를 자기 카드로 대신 떠안는 경로를 우리가 만들지 않는다는 뜻이다.
//    그래서 phase가 가르는 것은 **문구뿐이다** — 'grace'는 "N일 남았어요", 'ended'는
//    "종료됐어요". 어느 쪽에서도 유일한 출구는 '감독자에게 알리기'(POST /api/org/ping-owner)
//    하나이고, 기록 열람·출력은 두 단계 모두 열려 있다. 어느 구간에도 무과금 사용은 없다.
//    (자가 결제자 — 조직에 붙기 전부터 본인이 구독 중이던 사람 — 는 애초에 orgLapse를 받지
//     않는 별개 경로다. /api/org/leave의 자격 판정도 그 사람들만 통과시킨다.)
//
// 이 파일은 **어떤 로컬 모듈도 import 하지 않는다** (lib/orgSeats.ts와 같은 순환 방지 규율).
// lib/portone.ts가 STALE_PERIOD_GRACE_MS를 여기서 가져다 쓴다 — 상수 사본을 만들지 않는다.

/** 감독자가 결제를 되살릴 수 있는 기간(일). 이 값을 화면에 손으로 다시 적지 말 것. */
export const ORG_GRACE_DAYS = 7;

/**
 * 상태 갱신이 멈춘 행을 걸러내는 유예 폭 (lib/portone.ts subscriptionAllows에서 이관).
 * 이 기간을 넘도록 만료가 방치된 행은 "권한이 있는 상태"가 아니라 "갱신이 고장난 상태"로 본다.
 * 2주로 잡은 이유: 정상 경로는 하루 단위로 갱신되므로 여유가 크고, 반대로 우리 크론·자격증명이
 * 망가져 fail-closed로 정상 결제자를 잠그기 전까지 알아채고 고칠 시간이 충분하다.
 * DB 쪽 같은 규율: is_store_self_paid의 `interval '14 days'` (migration 20260811000000).
 */
export const STALE_PERIOD_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 감독자 구독 행 중 유예 앵커 판정에 쓰는 필드만. select에 canceled_at을 반드시 포함할 것. */
export interface LapseAnchorSub {
  status?: string | null;
  current_period_end?: string | null;
  billing_key?: string | null;
  canceled_at?: string | null;
}

export type LapsePhase = "grace" | "ended";

export interface OrgLapseTiming {
  lapsedAt: string | null;
  graceEndsAt: string | null;
  phase: LapsePhase;
  /** ceil, 0..ORG_GRACE_DAYS. 앱·웹은 이 값을 그대로 그리고 스스로 계산하지 않는다. */
  daysLeft: number | null;
}

/**
 * 회사 구독이 **실제로 막힌 순간**. null이면 아직 안 끊겼다.
 *
 * ⚠️ current_period_end 하나만으로는 틀린다. 카드 3회 실패 경로는 실패해도 만료일을
 * 전진시키지 않는데(lib/billing.ts), past_due는 subscriptionAllows를 통과한다 —
 * cpe 이후 2일 동안 조직은 멀쩡히 살아 있다. cpe를 유예 시작으로 잡으면 아무도 막히지
 * 않은 2일을 유예에서 까먹어 실질 5일이 된다.
 *
 * max(cpe, canceled_at) 하나가 네 경로를 전부 맞춘다:
 *   · 카드 3회 실패      cpe=과거(원래 결제일) / canceled_at=3차 실패 시각 → canceled_at (실제 차단 시각)
 *   · 예약 해지          cpe=미래(잔여기간 끝)  / canceled_at=해지 누른 날  → cpe
 *   · 스토어 기간만료    cpe=만료일             / canceled_at=최초 관측일   → cpe
 *   · 갱신 유실 백스톱   cpe=과거               / canceled_at=null          → cpe+14d
 *     (백스톱은 subscriptionAllows가 false로 넘어가는 바로 그 순간과 같아야 한다)
 */
export function orgLapsedAt(sub: LapseAnchorSub | null | undefined, now: Date = new Date()): string | null {
  if (!sub) return null;
  const cpe = sub.current_period_end ? new Date(sub.current_period_end) : null;
  const cpeValid = cpe && !Number.isNaN(cpe.getTime()) ? cpe : null;

  if (sub.status === "canceled") {
    const canceledAt = sub.canceled_at ? new Date(sub.canceled_at) : null;
    const canceledValid = canceledAt && !Number.isNaN(canceledAt.getTime()) ? canceledAt : null;
    if (cpeValid && canceledValid) {
      return (cpeValid > canceledValid ? cpeValid : canceledValid).toISOString();
    }
    // 한쪽만 있으면 그것이 앵커다. 둘 다 없으면(구 데이터) 앵커를 지어내지 않는다 — 폴백으로 넘긴다.
    return (cpeValid ?? canceledValid)?.toISOString() ?? null;
  }

  // 백스톱: 갱신이 유실돼 상태만 살아 있는 행. subscriptionAllows가 false로 넘어가는 순간과 동일.
  if (cpeValid && now.getTime() - cpeValid.getTime() > STALE_PERIOD_GRACE_MS) {
    return new Date(cpeValid.getTime() + STALE_PERIOD_GRACE_MS).toISOString();
  }

  // 카드 없는 무료체험(휴대폰인증 가입)이 끝난 경우 — 체험 종료일이 곧 차단 시각이다.
  if (sub.status === "trialing" && !sub.billing_key && cpeValid && cpeValid <= now) {
    return cpeValid.toISOString();
  }

  return null;
}

/**
 * ② 폴백 앵커 — 감독자 행에 앵커가 없을 때 쓰는 "이 사람이 실제로 막힌 순간".
 *
 * cancelOrgSeatMirrors가 강등 시점에 current_period_end = now **와** updated_at = now를 함께
 * 쓰므로 coalesce(current_period_end, updated_at)가 그 순간이다. 새 컬럼이 필요 없고,
 * 감독자 앵커보다 오히려 정확하다(좌석 카드 3회 실패처럼 감독자 구독은 멀쩡한 경우까지 덮는다).
 */
export function mirrorDemotedAt(
  mirror: { current_period_end?: string | null; updated_at?: string | null } | null | undefined
): string | null {
  if (!mirror) return null;
  const raw = mirror.current_period_end ?? mirror.updated_at ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 유예 단계 계산. **불리언을 두 개 만들지 않는다** — "유예 중 / 유예 후"는 오직 phase가 가른다.
 * lapsedAt이 null(앵커를 못 찾음)이면 phase='grace' + daysLeft=null로 연다:
 * 화면은 "회사 결제를 확인하는 중"을 띄우고 개인 결제 문은 닫아 둔다. 작성은 이미 잠겨 있으므로
 * 이 폴백이 무과금 사용 구간을 만들지 않는다.
 */
export function orgLapseTiming(lapsedAt: string | null, now: Date = new Date()): OrgLapseTiming {
  if (!lapsedAt) {
    return { lapsedAt: null, graceEndsAt: null, phase: "grace", daysLeft: null };
  }
  const start = new Date(lapsedAt).getTime();
  const end = start + ORG_GRACE_DAYS * DAY_MS;
  const remainMs = end - now.getTime();
  const daysLeft = Math.min(ORG_GRACE_DAYS, Math.max(0, Math.ceil(remainMs / DAY_MS)));
  return {
    lapsedAt: new Date(start).toISOString(),
    graceEndsAt: new Date(end).toISOString(),
    phase: remainMs > 0 ? "grace" : "ended",
    daysLeft,
  };
}

/** 유예 시작 후 경과 일수(내림). 크론 알림 스윕의 D0/D3/D6 임계 판정용. */
export function daysSinceLapse(lapsedAt: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(lapsedAt).getTime()) / DAY_MS);
}
