// lib/org.ts — 2계층(안전관리자/관리감독자) 역할 판정의 단일 소스.
// 진실의 원천은 DB (organizations.owner_user_id / org_members) 한 곳이다.
// user_metadata.role은 표시용일 뿐 분기 키로 쓰지 않는다 (카카오 가입자는 메타데이터가 없음).
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getAdminClient, subscriptionAllows } from "./portone";
import { resolveOrgSeatAccounting, type SeatState } from "./orgSeats";
import { mirrorDemotedAt, orgLapseTiming, orgLapsedAt, type LapsePhase } from "./orgGrace";
import { kstDay } from "./orgNotices";

export type OrgKind = "owner" | "member" | "solo";

export interface OrgInfo {
  id: string;
  name: string;
  ownerUserId: string;
  seatCount: number;
  pendingSeatCount: number | null;
}

export interface OrgMemberSummary {
  userId: string;
  siteName: string;      // user_metadata.company_name (현장명)
  managerName: string;   // user_metadata.full_name (현장담당자)
  /** user_metadata.worker_type — 법정 정기교육 의무시간 분기 키(사무직 6h / 그 외 12h) */
  workerType: string;
  /** 실제 로그인 아이디 — 발급 계정(@tbm.com)은 @ 앞부분, 그 외는 이메일 전체 */
  loginId: string;
  status: "active" | "detached";
  joinedAt: string;
  /**
   * 좌석 회계 상태(active 멤버만). 판정은 DB 뷰(org_seat_states)가 하고 여기는 나른다.
   * - seat        : 회사가 요금을 내고 좌석을 제공한다
   * - self_store  : 본인이 스토어에 직접 결제 중 → 회사 청구·정원에서 제외
   * - grandfather : 영구 무료 → 청구·정원에서 제외
   * detached 멤버는 회계 대상이 아니라 null.
   */
  seatState: SeatState | null;
  /** 미러 구독이 실제로 살아 있는가(active 멤버만). 감독자 화면의 '잠김' 진단용 */
  mirrorAlive: boolean;
}

/**
 * 회사 구독이 끊긴 뒤의 상세. **orgLapsed=true일 때만 존재한다.**
 *
 * "유예 중 / 유예 후"는 두 번째 불리언이 아니라 phase 하나가 가른다(불리언 두 개는 반드시
 * 어긋난다). 남은 일수도 서버가 계산해 내려준다 — 앱·웹은 규칙을 베끼지 않고 이 값을 그린다.
 */
export interface OrgLapseInfo {
  orgId: string;
  orgName: string;
  ownerUserId: string;
  lapsedAt: string | null;
  /** lapsedAt + ORG_GRACE_DAYS. lapsedAt이 없으면(앵커 미상) null */
  graceEndsAt: string | null;
  phase: LapsePhase;
  /** ceil, 0..7. null이면 아직 앵커를 못 찾았다 → 화면은 "결제를 확인하는 중"으로 연다 */
  daysLeft: number | null;
  /** 이 멤버가 마지막으로 '감독자에게 알리기'를 누른 시각 */
  lastPingAt: string | null;
  /** 오늘 아직 안 눌렀다 */
  canPingNow: boolean;
}

export interface OrgContext {
  kind: OrgKind;
  org?: OrgInfo;
  /** owner일 때: active 하위 현장 user id 목록 (데이터 접근 검증에 사용) */
  memberIds?: string[];
  /** member일 때: 소속 조직 구독이 유효한지. 무효면 kind는 'solo'로 강등되고 이 플래그만 남는다 */
  orgLapsed?: boolean;
  /** orgLapsed=true일 때의 상세(유예 단계·남은 일수·알리기 가능 여부). 순수 추가 필드다. */
  orgLapse?: OrgLapseInfo;
  /**
   * kind==='member'인데 **본인 좌석만** 죽어 있다(좌석 카드 3회 실패·정원 부족 복원 보류·자가복구 실패).
   * 회사 구독은 유효하므로 orgLapse는 없다 — "회사에서 결제하던 이용권이 종료됐어요"는 거짓이다.
   * 판정은 app/api/org/context 라우트가 채운다(그 라우트가 이미 자가복구를 시도하고 결과를 안다).
   */
  seatLocked?: boolean;
  /** kind==='member'일 때의 좌석 회계 상태. self_store면 본인이 직접 결제 중이다. */
  seatState?: SeatState | null;
  /** 이 계정 앞으로 온 미사용 편입(attach) 초대 */
  pendingAttach?: { inviteId: string; token: string; orgId: string; orgName: string } | null;
}

/**
 * userId의 조직 역할을 판정한다.
 * - owner: organizations.owner_user_id에 존재
 * - member: org_members(status=active)에 존재하고 소속 조직의 상위 구독이 유효
 * - solo: 둘 다 아님 (상위 구독이 무효면 member도 solo로 강등 — 시나리오 2와 동일 화면)
 */
export async function getOrgContext(userId: string, adminClient?: SupabaseClient): Promise<OrgContext> {
  const admin = adminClient ?? getAdminClient();

  // ① owner?
  const { data: ownOrg } = await admin
    .from("organizations")
    .select("id, name, owner_user_id, seat_count, pending_seat_count")
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (ownOrg) {
    const { data: members } = await admin
      .from("org_members")
      .select("member_user_id")
      .eq("org_id", ownOrg.id)
      .eq("status", "active");
    return {
      kind: "owner",
      org: toOrgInfo(ownOrg),
      memberIds: (members ?? []).map((m) => m.member_user_id as string),
    };
  }

  // ② member? (+ 상위 구독 유효성 → 무효면 solo 강등)
  const { data: membership } = await admin
    .from("org_members")
    .select("org_id, status, joined_at, organizations!inner(id, name, owner_user_id, seat_count, pending_seat_count)")
    .eq("member_user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const pendingAttach = await findPendingAttach(admin, userId);
  if (membership) {
    const org = toOrgInfo((membership as any).organizations);
    // canceled_at을 함께 읽는다 — 카드 3회 실패 경로는 current_period_end를 전진시키지 않아서
    // 만료일만으로는 "실제로 막힌 순간"을 알 수 없다(lib/orgGrace.ts orgLapsedAt 주석 참조).
    const { data: ownerSub } = await admin
      .from("subscriptions")
      .select("status, current_period_end, billing_key, canceled_at")
      .eq("user_id", org.ownerUserId)
      .maybeSingle();
    if (subscriptionAllows(ownerSub)) {
      return { kind: "member", org, pendingAttach };
    }

    // ⚠️ 회사 구독이 무효여도 **본인 이용이 잠기지 않는 멤버**가 있다:
    //    자가 결제자(self_store — 스토어 또는 본인 카드)와 grandfather(영구 무료).
    //    이들에게 유예 판정을 내리면 아무것도 잠기지 않은 채 "회사 구독이 확인되지 않아요 ·
    //    새 기록 작성과 AI 분석이 잠겼어요"라는 **거짓말**을 보고, 동시에 kind가 'member'가
    //    아니게 되면서 /account의 자가결제자 카드(회사에 결제 요청 · 회사 연결 끊기)와
    //    헤더의 '구독 및 결제' 잠금 해제가 통째로 사라진다 — 돈을 내는 사람이 자기 구독
    //    관리 수단을 잃는다(2026-08-13 검수).
    //    판정은 "본인 구독이 유효한데 그것이 회사 미러가 아니다" 하나다. 미러(plan='org_seat')가
    //    아직 살아 있는 경우는 제외한다 — 그건 접혀야 할 좌석이지 본인 구독이 아니다.
    const mine = await readOwnSub(admin, userId);
    if (
      mine &&
      mine.plan !== "org_seat" &&
      subscriptionAllows({
        status: mine.status ?? undefined,
        current_period_end: mine.current_period_end,
        billing_key: mine.billing_key,
      })
    ) {
      return { kind: "member", org, pendingAttach };
    }

    return {
      kind: "solo",
      orgLapsed: true,
      orgLapse: await buildOrgLapse(admin, userId, org, ownerSub, {
        mine,
        joinedAt: (membership as { joined_at?: string | null }).joined_at ?? null,
      }),
      pendingAttach,
    };
  }

  // ③ solo
  return { kind: "solo", pendingAttach };
}

/** 본인 구독 행 — 유예 판정·앵커 폴백이 함께 쓴다(같은 행을 두 번 읽지 않는다) */
interface OwnSubRow {
  plan?: string | null;
  status?: string | null;
  current_period_end?: string | null;
  billing_key?: string | null;
  updated_at?: string | null;
}

async function readOwnSub(admin: SupabaseClient, userId: string): Promise<OwnSubRow | null> {
  try {
    const { data } = await admin
      .from("subscriptions")
      .select("plan, status, current_period_end, billing_key, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    return (data as OwnSubRow | null) ?? null;
  } catch (e) {
    console.error("readOwnSub 실패", e);
    return null;
  }
}

/**
 * 유예 상세 조립. **유예 상태일 때만** 불린다(정상 경로에 왕복이 붙지 않는다).
 *
 * 앵커 체인 — 마지막 단계는 반드시 값을 내야 한다:
 *   ① 감독자 구독(orgLapsedAt)
 *   ② 본인 구독 행의 강등 시각(coalesce(current_period_end, updated_at))
 *   ③ 소속 시작 시각(org_members.joined_at)
 *
 * ③이 없으면 phase가 영원히 'grace'(daysLeft=null)로 굳는다. 종전에는 그것이 **막다른 길**
 * 이었다 — 개인 결제 문(phase='ended')이 영영 안 열렸기 때문이다(2026-08-13 검수). 그 문은
 * 2026-08-11 폐지됐으므로 지금 앵커가 없어서 잃는 것은 **감독자 재촉 메일 D0/D3/D6의 타이밍**
 * 하나다(현장 계정 화면은 어차피 남은 일수를 그리지 않는다 — lib/orgGrace.ts 상단).
 * 여전히 앵커는 찾을 수 있는 한 찾는다: 알림이 안 나가면 감독자가 사실을 모른다.
 * ③까지 못 찾는 경우에만 종전 폴백(daysLeft=null)으로 떨어지고, 그때는 관측 로그를 남긴다.
 */
async function buildOrgLapse(
  admin: SupabaseClient,
  memberUserId: string,
  org: OrgInfo,
  ownerSub: { status?: string | null; current_period_end?: string | null; billing_key?: string | null; canceled_at?: string | null } | null,
  ctx: { mine: OwnSubRow | null; joinedAt: string | null } = { mine: null, joinedAt: null }
): Promise<OrgLapseInfo> {
  let anchor = orgLapsedAt(ownerSub);
  if (!anchor && ctx.mine?.plan === "org_seat" && ctx.mine.status === "active") {
    // 미러가 **아직 살아 있다** = 이 사람은 바로 지금 막히는 중이다(GET /api/org/context가
    // 같은 요청에서 강등한다). 그 행의 updated_at을 앵커로 쓰면 미러가 발급된 옛 날짜가
    // 잡혀 유예 7일이 통째로 소급 소멸한다.
    anchor = new Date().toISOString();
  }
  if (!anchor && ctx.mine) {
    // ② 감독자 행에 앵커가 없는 경우(구독 행 자체가 없음 / 좌석 카드 3회 실패로 미러만 접힘).
    // 본인 행이 "내가 실제로 막힌 순간"이라 더 정확하다. 종전에는 plan='org_seat' &&
    // status='canceled'인 미러 행만 봤는데, 미러가 아닌 무효 행(만료된 monthly_pro 등)을 가진
    // 멤버가 통째로 빠져 ③ 없이는 영구 'grace'로 굳었다.
    anchor = mirrorDemotedAt(ctx.mine);
  }
  if (!anchor && ctx.joinedAt) {
    // ③ 최후 앵커. 실제 차단 시각보다 이르지만(= 재촉 메일이 조금 일찍 끝난다) 앵커 없음보다 낫다.
    anchor = mirrorDemotedAt({ current_period_end: ctx.joinedAt });
    console.warn("ORG_LAPSE_ANCHOR_FALLBACK_JOINED_AT", { orgId: org.id, memberUserId });
  }
  if (!anchor) {
    console.error("ORG_LAPSE_ANCHOR_MISSING", { orgId: org.id, memberUserId });
  }

  const timing = orgLapseTiming(anchor);
  let lastPingAt: string | null = null;
  let canPingNow = true;
  try {
    // '알리기'는 하루 1회다. 판정 근거는 오늘자 dedupe_key 행의 존재 하나 —
    // 라우트(POST /api/org/ping-owner)의 unique 충돌과 같은 키를 본다(규칙 사본 금지).
    const { data: pings } = await admin
      .from("org_notices")
      .select("created_at, dedupe_key")
      .eq("org_id", org.id)
      .eq("kind", "member_ping")
      .eq("actor_user_id", memberUserId)
      .order("created_at", { ascending: false })
      .limit(1);
    const last = (pings ?? [])[0] as { created_at: string; dedupe_key: string } | undefined;
    if (last) {
      lastPingAt = last.created_at;
      canPingNow = last.dedupe_key !== pingDedupeKey(org.id, memberUserId);
    }
  } catch (e) {
    // 조회 실패로 버튼을 잠그지 않는다 — 서버가 어차피 충돌로 막는다
    console.error("buildOrgLapse: ping 조회 실패", e);
  }

  return {
    orgId: org.id,
    orgName: org.name,
    ownerUserId: org.ownerUserId,
    lapsedAt: timing.lapsedAt,
    graceEndsAt: timing.graceEndsAt,
    phase: timing.phase,
    daysLeft: timing.daysLeft,
    lastPingAt,
    canPingNow,
  };
}

/** '알리기' 하루 1회 멱등 키. 라우트와 조회가 같은 함수를 쓴다. */
export function pingDedupeKey(orgId: string, memberUserId: string, when: Date = new Date()): string {
  return `ping:${orgId}:${memberUserId}:${kstDay(when)}`;
}

/** 감독자가 대상 현장에 접근할 권한이 있는지 (회사관리 화면 서버 라우트 공용 검증).
 *  감독자 본인도 하나의 현장이므로 self는 항상 허용한다 — 빼면 회사관리에서
 *  자기 현장 카드를 눌렀을 때만 403이 나는 구멍이 생긴다. */
export async function assertOwnerOfMember(
  ownerUserId: string,
  memberUserId: string,
  adminClient?: SupabaseClient
): Promise<boolean> {
  if (ownerUserId === memberUserId) return true;
  const ctx = await getOrgContext(ownerUserId, adminClient);
  return ctx.kind === "owner" && (ctx.memberIds ?? []).includes(memberUserId);
}

/** owner의 하위 현장 목록(현장명·현장담당자 포함). 좌석 관리·관제 대시보드용 */
export async function listOrgMembers(orgId: string, adminClient?: SupabaseClient): Promise<OrgMemberSummary[]> {
  const admin = adminClient ?? getAdminClient();
  const { data: rows } = await admin
    .from("org_members")
    .select("member_user_id, status, joined_at")
    .eq("org_id", orgId)
    .order("joined_at", { ascending: true });
  // 좌석 회계 상태는 뷰에서 한 번에 가져온다(멤버마다 subscriptions를 다시 읽지 않는다).
  // 이 조회가 실패해도 목록은 보여준다 — 배지가 빠질 뿐, 관리 화면이 통째로 죽는 쪽이 더 나쁘다.
  let seatByUser = new Map<string, { seatState: SeatState; mirrorAlive: boolean }>();
  try {
    const acc = await resolveOrgSeatAccounting(admin, orgId);
    seatByUser = new Map(acc.rows.map((r) => [r.userId, { seatState: r.seatState, mirrorAlive: r.mirrorAlive }]));
  } catch (e) {
    console.error("listOrgMembers: 좌석 회계 조회 실패(배지 생략)", e);
  }
  // 메타데이터 조회를 병렬 배치로 — 순차 호출이면 현장 100곳에서 이 함수 하나가
  // 수십 초를 먹는다 (현장 수 상한이 없는 과금 모델이라 대량 케이스가 정상 경로다).
  const list = (rows ?? []) as { member_user_id: string; status: string; joined_at: string }[];
  const out: OrgMemberSummary[] = [];
  const CHUNK = 20;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const metas = await Promise.all(
      chunk.map((r) =>
        admin.auth.admin
          .getUserById(r.member_user_id)
          .then((u) => ({
            meta: (u.data?.user?.user_metadata ?? {}) as Record<string, unknown>,
            email: String(u.data?.user?.email ?? ""),
          }))
          .catch(() => ({ meta: {} as Record<string, unknown>, email: "" }))
      )
    );
    chunk.forEach((r, j) => {
      const email = metas[j].email;
      out.push({
        userId: r.member_user_id,
        siteName: String(metas[j].meta.company_name ?? ""),
        managerName: String(metas[j].meta.full_name ?? ""),
        workerType: String(metas[j].meta.worker_type ?? ""),
        // 감독자가 비번 재설정·전달 시 어느 아이디인지 알아야 한다 — 발급 계정은 가짜 도메인을 떼고 아이디만
        loginId: email.endsWith("@tbm.com") ? email.slice(0, -"@tbm.com".length) : email,
        status: r.status as "active" | "detached",
        joinedAt: r.joined_at,
        seatState: seatByUser.get(r.member_user_id)?.seatState ?? null,
        mirrorAlive: seatByUser.get(r.member_user_id)?.mirrorAlive ?? false,
      });
    });
  }
  return out;
}

/**
 * 조직 강등/해지 시 하위 미러 구독 동기화 — 모든 detach·해지 경로가 이 함수를 거친다.
 * 미러 행을 남겨두면 org_seat/active/0원이 영구 무료 Pro가 되므로 canceled로 접는다.
 * 예외: 편입 전 grandfather(영구 무료)였던 계정은 그 지위를 복원한다 (§9.3, 리뷰 K).
 *
 * ⚠️ 여기서 접힌 좌석이 **어떻게 돌아오는지**를 코드로 확인할 수 있어야 한다("다음 경로가
 * 자연히 처리한다"는 앞선 실패의 원인이었다). 복귀 경로는 셋이고 전부 같은 뷰를 본다:
 *   ① /api/cron/charge-subscriptions 의 '미러 복원 스윕'(매일) — 상위 구독이 유효한 조직을 훑어
 *      seat_state='seat' && mirror_alive=false 를 되살린다. 정원 여유분만큼만 복원한다.
 *   ② /api/payments/billing-key (감독자 재결제 직후) · lib/billing.ts chargeGoogleOwnerSeats(좌석 청구 성공)
 *   ③ /api/org/context GET (소속 계정이 앱을 켠 순간) — 본인 구독 무효 + 조직 구독 유효일 때 1회
 * 자가 스토어 결제자는 스토어 구독이 죽는 순간(RTDN 또는 reconcile-store-subs 크론이 확정)
 * 뷰에서 self_store → seat 로 넘어와 ①이 자동으로 좌석을 돌려준다 — 사용자가 할 일은 없다.
 */
export async function cancelOrgSeatMirrors(
  memberUserIds: string[],
  adminClient?: SupabaseClient
): Promise<void> {
  if (memberUserIds.length === 0) return;
  const admin = adminClient ?? getAdminClient();
  const now = new Date().toISOString();

  const toCancel: string[] = [];
  for (const id of memberUserIds) {
    let prevPlan: string | null = null;
    try {
      const { data: u } = await admin.auth.admin.getUserById(id);
      // ⚠️ app_metadata만 믿는다 — user_metadata는 클라이언트가 supabase.auth.updateUser({data})로
      //    직접 쓸 수 있어, 아무나 prev_plan='grandfather'를 심고 편입→해제만 하면 영구 무료를
      //    자가 발급할 수 있다(2026-08-10 적대적 검수 발견, lib/grandfather.ts와 같은 규율).
      prevPlan = String((u?.user?.app_metadata as any)?.prev_plan ?? "") || null;
    } catch { /* 메타데이터 조회 실패 → 일반 강등 */ }
    if (prevPlan === "grandfather") {
      await admin
        .from("subscriptions")
        .update({ plan: "grandfather", status: "active", amount: 0, current_period_end: null, updated_at: now })
        .eq("user_id", id)
        .eq("plan", "org_seat");
    } else {
      toCancel.push(id);
    }
  }
  if (toCancel.length > 0) {
    await admin
      .from("subscriptions")
      .update({ status: "canceled", current_period_end: now, updated_at: now })
      .in("user_id", toCancel)
      .eq("plan", "org_seat");
  }
}

/**
 * 미러 구독 upsert 시 함께 비우는 스토어 잔재.
 *
 * 미러를 쓰는 시점은 곧 "이 사람에게 스토어가 더는 청구하지 않는다"고 확정한 시점이다
 * (org_seat_states가 self_store를 이미 걸러냈다). 잔재를 남기면 그 구독의 RTDN이 이 행을 찾아
 * status·current_period_end·amount를 덮어써 좌석 멤버가 조용히 잠긴다 — 미러의 안전성이
 * 무관한 파일(RTDN 핸들러)의 UPDATE 필드 목록에 매달리게 된다(2026-08-10 검수).
 * app/api/payments/billing-key/route.ts의 STORE_FIELDS_CLEARED와 같은 규율이다.
 */
const MIRROR_STORE_FIELDS_CLEARED = {
  source: "portone",
  store_purchase_token: null,
  store_product_id: null,
  store_base_plan_id: null,
  store_seat_capacity: null,
  store_pending_seat_capacity: null,
} as const;

/** 미러 구독 한 건의 표준 형태 — 복원(lib/org.ts)과 편입(app/api/org/attach)이 같은 모양을 쓴다 */
export function orgSeatMirrorRow(userId: string, nowIso: string) {
  return {
    user_id: userId,
    plan: "org_seat",
    pending_plan: null,
    status: "active",
    billing_key: null,
    card_info: null,
    amount: 0,
    currency: "KRW",
    current_period_end: null,
    trial_used: true,
    failed_attempts: 0,
    canceled_at: null,
    updated_at: nowIso,
    ...MIRROR_STORE_FIELDS_CLEARED,
  };
}

/**
 * 조직의 좌석 미러를 실제 회계 상태에 맞춘다 (감독자 재결제·좌석 청구 성공·복원 스윕 공용).
 *
 * 대상 선정은 **뷰 하나**가 한다: seat_state='seat' 이면서 mirror_alive=false 인 멤버.
 *   · 자가 스토어 결제자(self_store)는 제외된다 — 그 사람의 구독 행을 덮으면 스토어가 계속
 *     본인에게 청구하는 채로 감독자 카드에서도 좌석 몫이 나가는 이중청구가 된다.
 *     같은 회계에서 감독자 청구액·정원도 그 사람을 빼므로, "미러만 건너뛰고 요금은 그대로"가
 *     구조적으로 불가능하다.
 *   · grandfather(영구 무료)도 제외된다 — 미러를 씌우면 영구 무료 지위가 행에서 사라진다.
 *     이들은 청구에서도 함께 빠진다(제공하지 않는 좌석에 청구하지 않는다).
 *   · plan이 'org_seat'가 **아닌** 행(자기 구독이 죽은 뒤 monthly_pro로 남은 행, 구독 행이
 *     아예 없는 계정)도 mirror_alive=false라 후보에 들어온다. 종전의 `.eq(plan,'org_seat')`
 *     필터로는 영영 안 잡혀 '되돌아올 길이 없는' 막다른 길을 만들던 자리다.
 *
 * 멤버마다 돌던 getUserById(prev_plan) 조회는 없앴다 — 뷰가 grandfather를 이미 판정하고,
 * 이 함수는 결제 직후(maxDuration=30s) 경로에서 돈다.
 *
 * @param opts.only 이 id들로만 좁힌다(정원 여유분만 복원하는 크론 스윕 등).
 */
export async function restoreOrgSeatMirrors(
  orgId: string,
  adminClient?: SupabaseClient,
  opts: { only?: string[] } = {}
): Promise<{ restored: number; skipped: number; failed: number }> {
  const admin = adminClient ?? getAdminClient();
  const acc = await resolveOrgSeatAccounting(admin, orgId);
  const onlySet = opts.only ? new Set(opts.only) : null;
  const targets = acc.rows
    .filter((r) => r.seatState === "seat" && !r.mirrorAlive)
    .filter((r) => !onlySet || onlySet.has(r.userId))
    .map((r) => r.userId);
  // 회계에서 빠진 사람 수 — 호출부가 로그·집계할 수 있게 돌려준다(조용한 스킵을 남기지 않는다)
  const skipped = acc.selfPaidIds.length + acc.grandfatherIds.length;

  // (2026-08-13) 종전 여기에 SELF_PAID_PORTONE_SEAT_OVERWRITE 경보가 있었다 — 유예가 끝난 뒤
  // 멤버가 웹에서 카드(PortOne)로 직접 결제하면 seat_state가 여전히 'seat'이라 아래 upsert가
  // 그 사람의 유료 구독 행을 0원 미러로 덮어쓰던 자리다. 경보만 남기고 파괴는 그대로였다.
  // 이제 판정 자체를 고쳤다: public.is_self_paid가 본인 카드 구독도 자가결제로 인정하므로
  // 그 사람은 뷰에서 self_store로 빠지고, **청구·정원·미러 세 곳이 함께** 그를 제외한다.
  // 즉 여기 후보에 애초에 들어오지 않는다 — 가드를 덧붙일 자리가 아니라 없어진 문제다.

  const now = new Date().toISOString();
  let restored = 0;
  let failed = 0;
  for (const id of targets) {
    const { error } = await admin
      .from("subscriptions")
      .upsert(orgSeatMirrorRow(id, now), { onConflict: "user_id" });
    if (error) {
      // 한 건 실패로 나머지를 포기하지 않는다 — 남은 사람은 다음 크론 스윕이 다시 시도한다
      console.error("미러 구독 복원 실패:", id, error);
      failed++;
      continue;
    }
    restored++;
  }
  return { restored, skipped, failed };
}

/** 하위 1명 detach: 멤버십 detached + 미러 구독 canceled (원자성은 순서로 보장 — 미러 먼저) */
export async function detachOrgMember(memberUserId: string, adminClient?: SupabaseClient): Promise<void> {
  const admin = adminClient ?? getAdminClient();
  await cancelOrgSeatMirrors([memberUserId], admin);
  await admin
    .from("org_members")
    .update({ status: "detached", detached_at: new Date().toISOString() })
    .eq("member_user_id", memberUserId);
}

/** 사용자 실이메일 (org 보고서 발송용) — user_metadata.real_email + 인증 시각 */
export async function getVerifiedRealEmail(user: User | null): Promise<string | null> {
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const email = typeof meta.real_email === "string" ? meta.real_email : null;
  const verified = typeof meta.real_email_verified_at === "string" && meta.real_email_verified_at.length > 0;
  return email && verified ? email : null;
}

/** 이 계정이 회사를 소유(=감독자)하는지. 통합 이후 '작성 차단' 용도가 아니라
 *  회사관리 화면·과금 계정 수 계산의 판정용으로만 쓴다. */
export async function isOrgOwner(userId: string, adminClient?: SupabaseClient): Promise<boolean> {
  const admin = adminClient ?? getAdminClient();
  const { data } = await admin
    .from("organizations")
    .select("id")
    .eq("owner_user_id", userId)
    .maybeSingle();
  return !!data;
}

/**
 * 보고서·AI 분석 라우트 공용 대상 판정 (§4-C 매트릭스 집행).
 * - member: 차단 (보고서·설정·AI 분석은 안전관리자/단독 전용 — 메뉴 숨김만으론 URL 직접 접근이 뚫림)
 * - owner + targetUserId: 우리 조직 active 하위인지 검증 후 그 현장을 대상 데이터로
 * - solo(또는 owner가 대상 미지정): 본인
 */
export async function resolveReportTarget(
  userId: string,
  targetUserId: unknown,
  adminClient?: SupabaseClient
): Promise<
  | { ok: true; targetId: string; kind: OrgKind; targetSiteName: string | null }
  | { ok: false; status: number; error: string }
> {
  const admin = adminClient ?? getAdminClient();
  const ctx = await getOrgContext(userId, admin);
  if (ctx.kind === "member") {
    return {
      ok: false,
      status: 403,
      error: "조직 소속 계정입니다. 보고서·AI 분석은 회사 안전관리자가 관리합니다.",
    };
  }
  const target = typeof targetUserId === "string" && targetUserId ? targetUserId : null;
  // 감독자 본인도 현장 하나다 — 대상 미지정이면 본인 현장을 대상으로 삼는다.
  // (구 구현은 여기서 400을 냈다. 관리 전용 계정 시절엔 본인에게 데이터가 없어서
  //  AI 한도가 영원히 0으로 남는 무제한 호출 구멍을 막으려던 것인데, 이제 본인도
  //  자기 행을 쓰므로 한도가 정상적으로 카운트된다.)
  if (target && target !== userId) {
    if (ctx.kind !== "owner" || !(ctx.memberIds ?? []).includes(target)) {
      return { ok: false, status: 403, error: "우리 조직의 현장 계정이 아닙니다." };
    }
    let siteName: string | null = null;
    try {
      const { data: u } = await admin.auth.admin.getUserById(target);
      siteName = String((u?.user?.user_metadata as any)?.company_name ?? "") || null;
    } catch { /* 무시 */ }
    return { ok: true, targetId: target, kind: ctx.kind, targetSiteName: siteName };
  }
  return { ok: true, targetId: userId, kind: ctx.kind, targetSiteName: null };
}

function toOrgInfo(row: any): OrgInfo {
  return {
    id: row.id as string,
    name: row.name as string,
    ownerUserId: row.owner_user_id as string,
    seatCount: Number(row.seat_count) || 1,
    pendingSeatCount: row.pending_seat_count == null ? null : Number(row.pending_seat_count),
  };
}

async function findPendingAttach(admin: SupabaseClient, userId: string) {
  const { data } = await admin
    .from("org_invites")
    .select("id, token, org_id, expires_at, organizations!inner(name)")
    .eq("kind", "attach")
    .eq("target_user_id", userId)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    inviteId: data.id as string,
    token: data.token as string,
    orgId: data.org_id as string,
    orgName: String((data as any).organizations?.name ?? ""),
  };
}
