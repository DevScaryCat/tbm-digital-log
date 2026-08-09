// lib/grandfather.ts — grandfather(영구 무료) 지위 복원 공용 헬퍼
//
// 왜 필요한가: grandfather 계정이 인앱결제(구글·애플)나 카드 구독을 하면 verify/billing-key가
// subscriptions.plan을 monthly_pro로 덮어쓴다. 그 순간 영구 무료 지위는 행에서 사라지고,
// 나중에 구독을 해지·환불·만료해도 돌아갈 자리가 없다 — 결제가 **편도문**이 된다.
// 결제 시점에 user_metadata.prev_plan='grandfather'를 남겨두고(attach가 쓰는 것과 같은 자리),
// 구독이 **확정적으로 끝나는** 지점에서 이 함수로 원래 행 형태를 되돌린다.
//
// 호출해도 되는 곳 = "지금 이 순간 이용권이 끝났다"가 확정된 곳만:
//   · 스토어 알림(RTDN·App Store Notifications)의 회수(revoked)·환불(voided) 분기
//   · reconcile-store-subs 크론의 회수 확정 분기
//   · 웹 해지에서 잔여 기간이 남지 않는 경우(환불로 즉시 종료 / 이미 만료)
//   · charge-subscriptions 크론의 '해지 + 기간 소진' 스윕
// 호출하면 안 되는 곳 = 해지 **예약**(잔여 유료 기간 있음). 되돌리면 이미 낸 기간을 뺏는다.
//
// 한도는 건드리지 않는다 — grandfather로 돌아가면 DB 트리거 enforce_tbm_monthly_limit이
// 다시 80/10/0(교육일지·회의록·AI분석)을 적용한다. 그것이 Chris 결정("무료는 유지, 한도는 그대로").

import { SupabaseClient } from "@supabase/supabase-js";

/**
 * 실 DB의 grandfather 8행이 공유하는 정확한 형태(2026-08-10 조회로 확인).
 * 복원 결과가 이 형태와 어긋나면 "무료인데 크론이 긁는" / "만료 개념이 생기는" 행이 된다.
 * report_* 설정 컬럼은 일부러 제외한다 — 사용자의 보고서 수신 설정을 결제 이력으로 초기화하면 안 된다.
 */
export const GRANDFATHER_ROW = {
  plan: "grandfather",
  status: "active",
  source: "portone",
  amount: 0,
  currency: "KRW",
  billing_key: null,
  billing_key_verified: true,
  card_info: null,
  trial_end: null,
  // null = 만료 개념 없음(영구). 크론들이 lte/lt 비교로 거르므로 이 행은 어떤 청구·스윕에도 걸리지 않는다.
  current_period_end: null,
  trial_used: true,
  canceled_at: null,
  pending_plan: null,
  failed_attempts: 0,
  store_product_id: null,
  store_purchase_token: null,
} as const;

/**
 * prev_plan이 grandfather인 계정의 구독 행을 영구 무료 형태로 되돌린다.
 *
 * 비치명: 실패해도 예외를 던지지 않는다(로그만). 이 함수 때문에 해지·환불 처리가 막히면
 * "환불은 됐는데 권한이 안 끊긴" 훨씬 나쁜 상태가 된다.
 *
 * @returns 실제로 복원했으면 true
 */
export async function restoreGrandfatherIfEligible(
  admin: SupabaseClient,
  userId: string
): Promise<boolean> {
  if (!userId) return false;

  let meta: Record<string, unknown> = {};
  try {
    const { data: u, error } = await admin.auth.admin.getUserById(userId);
    if (error || !u?.user) return false;
    meta = (u.user.user_metadata ?? {}) as Record<string, unknown>;
  } catch (e) {
    console.error("grandfather 복원: 메타데이터 조회 실패(무시)", userId, e);
    return false;
  }
  if (String(meta.prev_plan ?? "") !== "grandfather") return false;

  // 조직에 편입돼 있는 동안은 복원하지 않는다.
  // (a) attach는 개인 구독을 정산한 **뒤** 미러(org_seat)를 덮어쓴다 — 그 사이에 복원하면
  //     미러가 곧바로 덮여 무의미해지고, prev_plan만 소비돼 detach 복원(lib/org.ts
  //     cancelOrgSeatMirrors)이 되돌릴 근거를 잃는다.
  // (b) 소속 중 복원은 감독자가 좌석 요금을 내는 계정을 조용히 조직 밖으로 빼내는 것과 같다.
  // 소속이 끝날 때의 복원은 detach 쪽 소관이므로 prev_plan은 지우지 않고 그대로 남긴다.
  try {
    const { count } = await admin
      .from("org_members")
      .select("member_user_id", { count: "exact", head: true })
      .eq("member_user_id", userId)
      .eq("status", "active");
    if ((count ?? 0) > 0) return false;
  } catch (e) {
    // 소속 여부를 못 읽었으면 복원하지 않는다 — 잘못 복원하는 쪽이 되돌리기 어렵다
    console.error("grandfather 복원: 소속 조회 실패(복원 보류)", userId, e);
    return false;
  }

  const { data: updated, error: upErr } = await admin
    .from("subscriptions")
    .update({ ...GRANDFATHER_ROW, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    // 좌석 미러는 detach 로직(lib/org.ts)이 자기 규칙으로 다룬다 — 여기서 건드리면 이중 소유가 된다.
    // (attach의 미러 upsert가 store_purchase_token을 지우지 않으므로 스토어 알림이 org_seat 행에
    //  도달할 수 있다 — 위 소속 검사와 함께 이중으로 막는다)
    .neq("plan", "org_seat")
    .select("id");
  if (upErr) {
    console.error("grandfather 복원 실패(무시)", userId, upErr);
    return false;
  }
  if (!updated || updated.length === 0) return false;

  // 재사용 방지 — 복원에 성공한 뒤에만 지운다(실패하면 다음 확정 지점에서 다시 시도된다)
  try {
    await admin.auth.admin.updateUserById(userId, {
      user_metadata: { ...meta, prev_plan: null },
    });
  } catch (e) {
    console.error("grandfather 복원: prev_plan 정리 실패(복원 자체는 완료)", userId, e);
  }
  return true;
}
