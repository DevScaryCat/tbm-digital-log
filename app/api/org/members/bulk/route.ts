// app/api/org/members/bulk/route.ts — 현장 계정 일괄 발급
// 아이디 시드 + 개수 + 공용 초기 비밀번호로 site01, site02… 를 한 번에 만든다.
// 현장명·담당자·새 비밀번호는 담당자 본인이 첫 로그인 온보딩에서 입력한다(must_set_password).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows, isProPlan } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { chargeProratedAccount } from "@/lib/billing";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BULK = 20;

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const admin = getAdminClient();
    let ctx = await getOrgContext(user.id, admin);

    if (ctx.kind === "member") {
      return NextResponse.json(
        { error: "소속 현장 계정은 현장 관리를 할 수 없습니다. 회사 감독자에게 문의하세요." },
        { status: 403 }
      );
    }

    // 구독 검사가 조직 생성보다 먼저 — legacy 요금 보호 순서 규칙 (members 라우트와 동일)
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, user_id, status, plan, current_period_end, billing_key")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!sub || !subscriptionAllows(sub) || !isProPlan((sub as any).plan)) {
      return NextResponse.json(
        { error: "현재 요금제로는 현장 계정을 추가할 수 없어요. 구독을 먼저 확인해주세요." },
        { status: 402 }
      );
    }

    if (ctx.kind === "solo" && !ctx.orgLapsed) {
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      const name = String(meta.company_name ?? "").trim() || String(meta.full_name ?? "").trim() || "우리 회사";
      const { error: orgErr } = await admin
        .from("organizations")
        .upsert({ owner_user_id: user.id, name, seat_count: 1, pending_seat_count: null }, { onConflict: "owner_user_id" });
      if (orgErr) {
        console.error("org lazy-create error (bulk):", orgErr);
        return NextResponse.json({ error: "회사 생성에 실패했습니다." }, { status: 500 });
      }
      ctx = await getOrgContext(user.id, admin);
    }
    if (ctx.kind !== "owner" || !ctx.org) {
      return NextResponse.json({ error: "회사 정보를 확인할 수 없습니다." }, { status: 500 });
    }
    const org = ctx.org;

    const body = await request.json().catch(() => ({}));
    const stem = String(body.stem ?? "").trim().toLowerCase();
    const count = Math.floor(Number(body.count));
    const password = String(body.password ?? "");
    if (!/^[a-z0-9][a-z0-9_]{1,11}$/.test(stem)) {
      return NextResponse.json({ error: "아이디 시작 문자는 영문·숫자 2~12자로 입력해주세요." }, { status: 400 });
    }
    if (!Number.isFinite(count) || count < 1 || count > MAX_BULK) {
      return NextResponse.json({ error: `한 번에 1~${MAX_BULK}개까지 만들 수 있어요.` }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "초기 비밀번호는 8자 이상으로 입력해주세요." }, { status: 400 });
    }

    // 연번은 01부터 비어있는 번호를 찾아 배정 — 이미 쓰는 아이디는 건너뛴다
    // 문서 출력 형식·근로자 구분·업종·공종은 회사 공통 — 감독자 값을 복사 (members 라우트와 동일)
    const ownerMeta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const ownerFormat = String(ownerMeta.preferred_export_format ?? "") || null;
    const ownerProfile = {
      ...(ownerMeta.worker_type ? { worker_type: ownerMeta.worker_type } : {}),
      ...(ownerMeta.industry ? { industry: ownerMeta.industry } : {}),
      ...(ownerMeta.work_category ? { work_category: ownerMeta.work_category } : {}),
    };
    const created: { userId: string; loginId: string }[] = [];
    const rollback = async () => {
      for (const c of created) {
        try { await admin.auth.admin.deleteUser(c.userId); } catch { /* 정리 실패는 로그만 */ }
      }
      await admin.from("org_members").delete().in("member_user_id", created.map((c) => c.userId));
      await admin.from("subscriptions").delete().in("user_id", created.map((c) => c.userId));
    };

    try {
      for (let n = 1; n <= 99 && created.length < count; n++) {
        const loginId = `${stem}${String(n).padStart(2, "0")}`;
        // 이미 존재하는 아이디는 건너뛰고 다음 번호로
        const { data: existingId } = await admin.rpc("find_user_id_by_login_email", {
          p_email: `${loginId}@tbm.com`,
        });
        if (existingId) continue;

        const { data: createdUser, error: userErr } = await admin.auth.admin.createUser({
          email: `${loginId}@tbm.com`,
          password,
          email_confirm: true,
          user_metadata: {
            // 현장명은 담당자가 첫 로그인 때 정한다 — 그때까지 아이디를 임시 표시명으로
            full_name: loginId,
            company_name: loginId,
            role: "site_supervisor",
            must_set_password: true,
            // 문서 출력 형식은 회사 공통 양식 — 감독자 값 복사 (첫 로그인 형식 선택 생략)
            ...(ownerFormat ? { preferred_export_format: ownerFormat } : {}),
            ...ownerProfile,
          },
        });
        if (userErr || !createdUser?.user) {
          if (userErr?.message?.includes("already registered") || userErr?.status === 422) continue;
          throw new Error(userErr?.message || "계정 생성 실패");
        }

        const { data: claim, error: claimErr } = await admin.rpc("claim_org_seat", {
          p_org: org.id,
          p_member: createdUser.user.id,
        });
        if (claimErr || claim !== "ok") {
          await admin.auth.admin.deleteUser(createdUser.user.id);
          throw new Error("현장 배정에 실패했습니다.");
        }
        created.push({ userId: createdUser.user.id, loginId });
      }

      if (created.length < count) {
        await rollback();
        return NextResponse.json(
          { error: `'${stem}01'부터 99까지 빈 아이디가 부족해요. 다른 시작 문자를 써주세요.` },
          { status: 409 }
        );
      }

      // 일할 청구 — 만든 계정 수만큼 한 번에 (체험 중엔 0원). 실패하면 전부 되돌린다.
      const charge = await chargeProratedAccount(admin, sub as any, {
        count: created.length,
        customerEmail: user.email ?? undefined,
      });
      if (!charge.ok) {
        await rollback();
        return NextResponse.json({ error: charge.error ?? "결제에 실패했습니다." }, { status: 402 });
      }

      // 미러 구독 (org_seat 0원) — 4겹 게이트 통과용
      const now = new Date().toISOString();
      for (const c of created) {
        const { error: subErr } = await admin.from("subscriptions").upsert(
          {
            user_id: c.userId,
            plan: "org_seat",
            status: "active",
            billing_key: null,
            card_info: null,
            amount: 0,
            currency: "KRW",
            current_period_end: null,
            trial_used: true,
            failed_attempts: 0,
            updated_at: now,
          },
          { onConflict: "user_id" }
        );
        if (subErr) console.error("bulk mirror sub upsert error:", c.loginId, subErr);
      }

      // 표시용 계정 수 동기화
      const accountCount = (ctx.memberIds ?? []).length + created.length + 1;
      await admin
        .from("organizations")
        .update({ seat_count: accountCount, pending_seat_count: null })
        .eq("id", org.id);

      return NextResponse.json({
        success: true,
        created: created.map((c) => c.loginId),
        charged: charge.charged,
      });
    } catch (e) {
      await rollback();
      console.error("bulk create error:", e);
      return NextResponse.json({ error: e instanceof Error ? e.message : "일괄 발급 실패" }, { status: 500 });
    }
  } catch (e) {
    console.error("bulk route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
