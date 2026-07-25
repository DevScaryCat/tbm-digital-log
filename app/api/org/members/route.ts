// app/api/org/members/route.ts — 하위 현장 계정 관리 (안전관리자 전용)
// GET   : 하위 목록 (현장명·담당자·상태)
// POST  : 직접 발급 (아이디/비번을 상위가 만들어 반장에게 전달 — 메인 경로)
// PATCH : 비밀번호 리셋 (담당자 교체 대응)
// DELETE: detach (좌석 해제 — 미러 구독 즉시 강등, 계정·데이터는 보존)
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows } from "@/lib/portone";
import { getOrgContext, listOrgMembers, detachOrgMember } from "@/lib/org";

export const runtime = "nodejs";

async function requireOwner(request: Request, opts: { requireValidSub?: boolean } = {}) {
  const user = await getUserFromRequest(request);
  if (!user) return { error: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) };
  const admin = getAdminClient();
  const ctx = await getOrgContext(user.id, admin);
  if (ctx.kind !== "owner" || !ctx.org) {
    return { error: NextResponse.json({ error: "안전관리자 계정만 접근할 수 있습니다." }, { status: 403 }) };
  }
  // 좌석 발급 등 쓰기 작업은 구독 유효성까지 요구 — 첫 결제 실패/해지 상태의 owner가
  // 무료 org_seat 미러를 계속 만들어내는 경로 차단 (리뷰 C)
  if (opts.requireValidSub) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("status, plan, current_period_end, billing_key")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!sub || sub.plan !== "org" || !subscriptionAllows(sub)) {
      return { error: NextResponse.json({ error: "회사 플랜 구독이 유효하지 않습니다. 결제를 먼저 완료해주세요." }, { status: 402 }) };
    }
  }
  return { user, admin, ctx, org: ctx.org };
}

export async function GET(request: Request) {
  const r = await requireOwner(request);
  if ("error" in r) return r.error;
  const members = await listOrgMembers(r.org.id, r.admin);
  return NextResponse.json({
    members,
    seatCount: r.org.seatCount,
    pendingSeatCount: r.org.pendingSeatCount,
  });
}

export async function POST(request: Request) {
  const r = await requireOwner(request, { requireValidSub: true });
  if ("error" in r) return r.error;
  const { admin, org } = r;
  try {
    const { loginId, password, siteName, managerName } = await request.json();
    const id = String(loginId ?? "").trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(id)) {
      return NextResponse.json({ error: "아이디는 영문 소문자·숫자·밑줄 3~20자로 입력해주세요." }, { status: 400 });
    }
    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json({ error: "비밀번호는 8자 이상 입력해주세요." }, { status: 400 });
    }
    const site = typeof siteName === "string" ? siteName.trim().slice(0, 60) : "";
    if (!site) return NextResponse.json({ error: "현장명을 입력해주세요." }, { status: 400 });
    const manager = typeof managerName === "string" ? managerName.trim().slice(0, 30) : "";

    // 계정 생성 — 초대/발급 경로는 개인 구독·휴대폰 무료체험을 만들지 않는다 (§3 signup 3-skip)
    const { data: created, error: userErr } = await admin.auth.admin.createUser({
      email: `${id}@tbm.com`,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: manager || site,
        company_name: site,
        role: "site_supervisor", // 표시용 — 분기 키는 DB org_members
      },
    });
    if (userErr || !created?.user) {
      if (userErr?.message?.includes("already registered") || userErr?.status === 422) {
        return NextResponse.json({ error: "이미 존재하는 아이디입니다." }, { status: 400 });
      }
      return NextResponse.json({ error: userErr?.message || "계정 생성 실패" }, { status: 400 });
    }

    // 좌석 점유 (advisory lock으로 레이스 방지)
    const { data: claim, error: claimErr } = await admin.rpc("claim_org_seat", {
      p_org: org.id,
      p_member: created.user.id,
    });
    if (claimErr || claim !== "ok") {
      await admin.auth.admin.deleteUser(created.user.id); // 좌석 실패 시 방금 만든 계정 롤백
      const msg = claim === "no_seat" ? "남은 좌석이 없습니다. 좌석을 추가해주세요." : "좌석 배정에 실패했습니다.";
      return NextResponse.json({ error: msg }, { status: 409 });
    }

    // 미러 구독 (org_seat, 0원) — 이 행이 있어야 4겹 게이트를 통과한다
    const now = new Date().toISOString();
    const { error: subErr } = await admin.from("subscriptions").upsert(
      {
        user_id: created.user.id,
        plan: "org_seat",
        status: "active",
        billing_key: null,
        card_info: null,
        amount: 0,
        currency: "KRW",
        current_period_end: null,
        trial_used: true, // 초대 경로는 무료체험 대상 아님 (이중 발급 차단)
        failed_attempts: 0,
        updated_at: now,
      },
      { onConflict: "user_id" }
    );
    if (subErr) console.error("member mirror sub upsert error:", subErr);

    return NextResponse.json({ success: true, userId: created.user.id, loginId: id });
  } catch (e) {
    console.error("member create error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const r = await requireOwner(request);
  if ("error" in r) return r.error;
  try {
    const { userId, newPassword } = await request.json();
    if (!(r.ctx.memberIds ?? []).includes(String(userId))) {
      return NextResponse.json({ error: "우리 조직의 현장 계정이 아닙니다." }, { status: 403 });
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return NextResponse.json({ error: "비밀번호는 8자 이상 입력해주세요." }, { status: 400 });
    }
    const { error } = await r.admin.auth.admin.updateUserById(String(userId), { password: newPassword });
    if (error) return NextResponse.json({ error: "비밀번호 변경 실패" }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("member password reset error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const r = await requireOwner(request);
  if ("error" in r) return r.error;
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");
  if (!userId || !(r.ctx.memberIds ?? []).includes(userId)) {
    return NextResponse.json({ error: "우리 조직의 현장 계정이 아닙니다." }, { status: 403 });
  }
  // detach: 미러 구독 강등 + 멤버십 detached. 계정·현장 데이터는 보존(법정 서류) — 계정 삭제는 제공하지 않음
  await detachOrgMember(userId, r.admin);
  return NextResponse.json({ success: true });
}
