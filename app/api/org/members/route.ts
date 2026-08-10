// app/api/org/members/route.ts — 하위 현장 계정 관리 (안전관리자 전용)
// GET   : 하위 목록 (현장명·현장담당자·상태)
// POST  : 직접 발급 (아이디/비번을 상위가 만들어 반장에게 전달 — 메인 경로)
// PATCH : 비밀번호 리셋 (현장담당자 교체 대응)
// DELETE: detach (좌석 해제 — 미러 구독 즉시 강등, 계정·데이터는 보존)
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows, isBillablePlan } from "@/lib/portone";
import { getOrgContext, listOrgMembers, detachOrgMember } from "@/lib/org";
import { chargeProratedAccount, resolveSeatCharge } from "@/lib/billing";

export const runtime = "nodejs";

async function requireOwner(
  request: Request,
  opts: { requireValidSub?: boolean; createOrgIfMissing?: boolean } = {}
) {
  const user = await getUserFromRequest(request);
  if (!user) return { error: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) };
  const admin = getAdminClient();
  let ctx = await getOrgContext(user.id, admin);

  if (ctx.kind === "member") {
    return {
      error: NextResponse.json(
        { error: "소속 현장 계정은 현장 관리를 할 수 없습니다. 회사 감독자에게 문의하세요." },
        { status: 403 }
      ),
    };
  }

  // 구독 검사가 반드시 조직 생성보다 **먼저** 와야 한다.
  // 순서가 반대면 legacy(구 베이직 1,900·영구무료) 계정이 '현장 계정 만들기'를 누르는
  // 것만으로 organizations 행이 남고, resolveBillableAmount가 legacy 분기 앞에서
  // org 분기를 타 버려 재동의 없이 요금이 3,900으로 올라간다.
  let sub: { id: string; user_id: string; status: string; billing_key: string | null; current_period_end: string | null; source: string | null } | null = null;
  if (opts.requireValidSub) {
    // source 포함: 구글 인앱 소유주(source=google_play)는 좌석 일할청구가 구글 주기 키(gseat)를
    // 선점해야 cron 월청구와 이중청구가 안 된다 — chargeProratedAccount가 이 값으로 분기한다.
    // (subscriptionAllows·isBillablePlan은 source 무관이라 구글 구독자도 그대로 통과한다)
    const { data } = await admin
      .from("subscriptions")
      .select("id, user_id, status, plan, current_period_end, billing_key, source")
      .eq("user_id", user.id)
      .maybeSingle();
    // isProPlan이 아니라 isBillablePlan — 2026-08-10부터 grandfather(영구 무료)는 기능상 유료와
    // 동일하지만 **결제 수단을 등록할 수 없는** 계정이다. isProPlan으로 열면 grandfather가 감독자가
    // 되어 좌석이 무기한 무과금으로 늘어난다(좌석 청구 크론은 billing_key NOT NULL만 긁는다).
    if (!data || !subscriptionAllows(data) || !isBillablePlan((data as any).plan)) {
      return {
        error: NextResponse.json(
          { error: "현재 요금제로는 현장 계정을 추가할 수 없어요. 구독을 먼저 확인해주세요." },
          { status: 402 }
        ),
      };
    }
    // 청구 자격까지 여기서 끝낸다 — 아래 POST는 createUser → claim_org_seat 를 먼저 하고
    // 그 다음에야 chargeProratedAccount를 부른다. 결제수단이 없거나 주기가 만료된
    // (past_due — subscriptionAllows는 통과시킨다) 감독자가 여기를 지나가면 계정·좌석을
    // 만들어 놓고 402로 되돌리는 롤백 경로를 타고, 롤백이 부분 실패하면 청구되지 않는
    // 유령 좌석이 남는다. 실제 청구와 **같은 함수**를 dry-run으로 부른다(조회 전용).
    // 현재 화면은 bulk 라우트로만 발급하지만 이 엔드포인트도 살아 있는 인증 경로다.
    const gate = await resolveSeatCharge(admin, data as any, { count: 1, seatsClaimed: false });
    if (!gate.ok) {
      return { error: NextResponse.json({ error: gate.error ?? "결제에 실패했습니다." }, { status: 402 }) };
    }
    sub = data as any;
  }

  // 회사는 '첫 현장 계정을 만드는 순간' 생긴다 — 별도의 감독자 가입 절차가 없다.
  if (opts.createOrgIfMissing && ctx.kind === "solo" && !ctx.orgLapsed) {
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const name = String(meta.company_name ?? "").trim() || String(meta.full_name ?? "").trim() || "우리 회사";
    const { error: orgErr } = await admin
      .from("organizations")
      .upsert({ owner_user_id: user.id, name, seat_count: 1, pending_seat_count: null }, { onConflict: "owner_user_id" });
    if (orgErr) {
      console.error("org lazy-create error:", orgErr);
      return { error: NextResponse.json({ error: "회사 생성에 실패했습니다." }, { status: 500 }) };
    }
    ctx = await getOrgContext(user.id, admin);
  }

  // 아직 회사가 없는 단독 계정도 조회는 허용한다 — 화면이 "첫 현장을 만드세요"를
  // 보여줘야 하는데 여기서 403을 내면 그 화면으로 갈 방법이 사라진다.
  return { user, admin, ctx, org: ctx.org ?? null, sub };
}

export async function GET(request: Request) {
  const r = await requireOwner(request);
  if ("error" in r) return r.error;
  if (!r.org) return NextResponse.json({ members: [], seatCount: 1, pendingSeatCount: null });
  const members = await listOrgMembers(r.org.id, r.admin);
  return NextResponse.json({
    members,
    seatCount: r.org.seatCount,
    pendingSeatCount: r.org.pendingSeatCount,
  });
}

export async function POST(request: Request) {
  const r = await requireOwner(request, { requireValidSub: true, createOrgIfMissing: true });
  if ("error" in r) return r.error;
  const { admin, user } = r;
  const org = r.org!;
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
    // 문서 출력 형식·근로자 구분·업종·공종은 회사 공통 — 감독자 값을 복사해 첫 로그인 설정을 건너뛰게 한다
    const ownerMeta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const ownerFormat = String(ownerMeta.preferred_export_format ?? "") || null;
    const ownerProfile = {
      ...(ownerMeta.worker_type ? { worker_type: ownerMeta.worker_type } : {}),
      ...(ownerMeta.industry ? { industry: ownerMeta.industry } : {}),
      ...(ownerMeta.work_category ? { work_category: ownerMeta.work_category } : {}),
    };
    const { data: created, error: userErr } = await admin.auth.admin.createUser({
      email: `${id}@tbm.com`,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: manager || site,
        company_name: site,
        role: "site_supervisor", // 표시용 — 분기 키는 DB org_members
        // 감독자가 정한 초기 비밀번호를 본인이 바꾸게 한다 — 일괄 발급과 동작 통일.
        // 지금 화면에서는 이 분기에 닿지 않는다(발급 모달의 '직접 발급'도 bulk 라우트를 호출).
        // API를 직접 쓰는 경우를 위해 남겨둔다 — 지워도 UI는 안 바뀐다.
        must_set_password: true,
        ...(ownerFormat ? { preferred_export_format: ownerFormat } : {}),
        ...ownerProfile,
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
      await admin.auth.admin.deleteUser(created.user.id); // 실패 시 방금 만든 계정 롤백
      const msg = claim === "other_org" ? "이미 다른 회사에 소속된 계정입니다." : "현장 배정에 실패했습니다.";
      return NextResponse.json({ error: msg }, { status: 409 });
    }

    // 잔여기간 일할 청구 — 좌석 선구매가 없으므로 계정 발급 시점에 바로 받는다.
    // 결제가 실패하면 방금 만든 계정을 되돌린다(청구 없이 남는 무료 계정 방지).
    const charge = await chargeProratedAccount(admin, r.sub!, { customerEmail: user.email ?? undefined });
    if (!charge.ok) {
      // 롤백은 좌석(org_members)까지 — auth 계정만 지우면 claim_org_seat가 만든 active 행이
      // 유령 좌석으로 남아 resolveBillableAmount가 다음 청구부터 존재하지 않는 계정 몫을
      // 과금한다(검수 발견). bulk 라우트의 rollback과 동일하게 맞춘다.
      await admin.from("org_members").delete().eq("member_user_id", created.user.id);
      await admin.auth.admin.deleteUser(created.user.id);
      return NextResponse.json({ error: charge.error ?? "결제에 실패했습니다." }, { status: 402 });
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

    // 표시용 계정 수 동기화 — memberIds는 방금 추가한 현장 이전 스냅샷이라 +1, 감독자 본인까지 +1
    const accountCount = (r.ctx.memberIds ?? []).length + 2;
    await admin
      .from("organizations")
      .update({ seat_count: accountCount, pending_seat_count: null })
      .eq("id", org.id);

    return NextResponse.json({ success: true, userId: created.user.id, loginId: id, charged: charge.charged });
  } catch (e) {
    console.error("member create error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

// PATCH: 하위 계정 수정 — 비밀번호 리셋(newPassword) 또는 현장명·현장담당자 수정(siteName/managerName).
// 계정 발급자는 감독자이므로 표시 정보의 수정 권한도 감독자에게 있다 (Chris).
export async function PATCH(request: Request) {
  const r = await requireOwner(request);
  if ("error" in r) return r.error;
  if (!r.org) return NextResponse.json({ error: "회사 정보가 없습니다." }, { status: 404 });
  try {
    const { userId, newPassword, siteName, managerName } = await request.json();
    if (!(r.ctx.memberIds ?? []).includes(String(userId))) {
      return NextResponse.json({ error: "우리 조직의 현장 계정이 아닙니다." }, { status: 403 });
    }

    if (newPassword !== undefined) {
      if (typeof newPassword !== "string" || newPassword.length < 8) {
        return NextResponse.json({ error: "비밀번호는 8자 이상 입력해주세요." }, { status: 400 });
      }
      const { error } = await r.admin.auth.admin.updateUserById(String(userId), { password: newPassword });
      if (error) return NextResponse.json({ error: "비밀번호 변경 실패" }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (siteName !== undefined || managerName !== undefined) {
      const site = typeof siteName === "string" ? siteName.trim().slice(0, 60) : undefined;
      if (siteName !== undefined && !site) {
        return NextResponse.json({ error: "현장명을 입력해주세요." }, { status: 400 });
      }
      // admin update는 metadata 전체 치환 — 최신 값을 읽어 병합한다 (다른 키 유실 방지)
      const { data: u } = await r.admin.auth.admin.getUserById(String(userId));
      const meta = { ...((u?.user?.user_metadata ?? {}) as Record<string, unknown>) };
      if (site) meta.company_name = site;
      if (managerName !== undefined) {
        const manager = String(managerName).trim().slice(0, 30);
        // 현장담당자를 비우면 현장명을 표시명으로 (계정 생성 규칙과 동일)
        meta.full_name = manager || String(meta.company_name ?? "");
      }
      const { error } = await r.admin.auth.admin.updateUserById(String(userId), { user_metadata: meta });
      if (error) return NextResponse.json({ error: "정보 수정 실패" }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "변경할 항목이 없습니다." }, { status: 400 });
  } catch (e) {
    console.error("member patch error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const r = await requireOwner(request);
  if ("error" in r) return r.error;
  if (!r.org) return NextResponse.json({ error: "회사 정보가 없습니다." }, { status: 404 });
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");
  if (!userId || !(r.ctx.memberIds ?? []).includes(userId)) {
    return NextResponse.json({ error: "우리 조직의 현장 계정이 아닙니다." }, { status: 403 });
  }
  // detach: 미러 구독 강등 + 멤버십 detached. 계정·현장 데이터는 보존(법정 서류) — 계정 삭제는 제공하지 않음
  await detachOrgMember(userId, r.admin);
  return NextResponse.json({ success: true });
}
