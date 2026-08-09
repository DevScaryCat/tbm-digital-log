// lib/org.ts — 2계층(안전관리자/관리감독자) 역할 판정의 단일 소스.
// 진실의 원천은 DB (organizations.owner_user_id / org_members) 한 곳이다.
// user_metadata.role은 표시용일 뿐 분기 키로 쓰지 않는다 (카카오 가입자는 메타데이터가 없음).
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getAdminClient, subscriptionAllows } from "./portone";

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
}

export interface OrgContext {
  kind: OrgKind;
  org?: OrgInfo;
  /** owner일 때: active 하위 현장 user id 목록 (데이터 접근 검증에 사용) */
  memberIds?: string[];
  /** member일 때: 소속 조직 구독이 유효한지. 무효면 kind는 'solo'로 강등되고 이 플래그만 남는다 */
  orgLapsed?: boolean;
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
    .select("org_id, status, organizations!inner(id, name, owner_user_id, seat_count, pending_seat_count)")
    .eq("member_user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const pendingAttach = await findPendingAttach(admin, userId);
  if (membership) {
    const org = toOrgInfo((membership as any).organizations);
    const { data: ownerSub } = await admin
      .from("subscriptions")
      .select("status, current_period_end, billing_key")
      .eq("user_id", org.ownerUserId)
      .maybeSingle();
    if (subscriptionAllows(ownerSub)) {
      return { kind: "member", org, pendingAttach };
    }
    return { kind: "solo", orgLapsed: true, pendingAttach };
  }

  // ③ solo
  return { kind: "solo", pendingAttach };
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
      });
    });
  }
  return out;
}

/**
 * 조직 강등/해지 시 하위 미러 구독 동기화 — 모든 detach·해지 경로가 이 함수를 거친다.
 * 미러 행을 남겨두면 org_seat/active/0원이 영구 무료 Pro가 되므로 canceled로 접는다.
 * 예외: 편입 전 grandfather(영구 무료)였던 계정은 그 지위를 복원한다 (§9.3, 리뷰 K).
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
 * 감독자가 다시 결제했을 때 활성 소속 현장의 미러 구독을 되살린다.
 *
 * 해지 시 cancelOrgSeatMirrors는 미러만 접고 org_members는 active로 남겨둔다(복구용).
 * 재결제 때 이걸 호출하지 않으면 "요금은 계정 수만큼 내는데 그 현장들은 여전히 잠겨 있는"
 * 상태가 된다 — 청구액과 실제 사용 가능 계정 수가 어긋나면 안 된다.
 * grandfather 복원 대상(prev_plan)은 건드리지 않는다 — 그쪽은 영구 무료가 맞다.
 */
export async function restoreOrgSeatMirrors(
  memberUserIds: string[],
  adminClient?: SupabaseClient
): Promise<void> {
  if (memberUserIds.length === 0) return;
  const admin = adminClient ?? getAdminClient();
  const now = new Date().toISOString();
  for (const id of memberUserIds) {
    let prevPlan: string | null = null;
    try {
      const { data: u } = await admin.auth.admin.getUserById(id);
      // ⚠️ app_metadata만 믿는다 — user_metadata는 클라이언트가 supabase.auth.updateUser({data})로
      //    직접 쓸 수 있어, 아무나 prev_plan='grandfather'를 심고 편입→해제만 하면 영구 무료를
      //    자가 발급할 수 있다(2026-08-10 적대적 검수 발견, lib/grandfather.ts와 같은 규율).
      prevPlan = String((u?.user?.app_metadata as any)?.prev_plan ?? "") || null;
    } catch { /* 메타데이터 조회 실패 → 일반 미러로 복원 */ }
    if (prevPlan === "grandfather") continue;
    const { error } = await admin
      .from("subscriptions")
      .upsert(
        {
          user_id: id,
          plan: "org_seat",
          status: "active",
          billing_key: null,
          card_info: null,
          amount: 0,
          currency: "KRW",
          current_period_end: null,
          trial_used: true,
          failed_attempts: 0,
          canceled_at: null,
          updated_at: now,
        },
        { onConflict: "user_id" }
      );
    if (error) console.error("미러 구독 복원 실패:", id, error);
  }
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
