// app/api/org/members/bulk/route.ts — 현장 계정 일괄 발급
// 아이디 시드 + 개수 + 공용 초기 비밀번호로 site01, site02… 를 한 번에 만든다.
// 현장명·현장담당자·새 비밀번호는 현장담당자 본인이 첫 로그인 온보딩에서 입력한다(must_set_password).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows, isBillablePlan } from "@/lib/portone";
import { getOrgContext, orgSeatMirrorRow } from "@/lib/org";
import { resolveOrgSeatAccountingByOwner } from "@/lib/orgSeats";
import {
  chargeProratedAccount,
  resolveSeatCharge,
  getStoreSeatCapacity,
  CAPACITY_FULL_MESSAGE,
} from "@/lib/billing";

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
    // source 포함: resolveSeatCharge·chargeProratedAccount가 스토어(구글·애플) 소유주로 분기할 때
    // source를 다시 조회하지 않게 한다(구 셀렉트가 undefined를 넘겨 gseat 주기 키 선점이 빠지던 자리)
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, user_id, status, plan, current_period_end, billing_key, source, store_seat_capacity")
      .eq("user_id", user.id)
      .maybeSingle();
    // isBillablePlan: grandfather(영구 무료·카드 등록 불가)에게 좌석을 열면 무과금 좌석이 된다
    // (members 라우트와 동일한 규율 — 사유는 lib/portone.ts isBillablePlan 주석)
    if (!sub || !subscriptionAllows(sub) || !isBillablePlan((sub as any).plan)) {
      return NextResponse.json(
        { error: "현재 요금제로는 현장 계정을 추가할 수 없어요. 구독을 먼저 확인해주세요." },
        { status: 402 }
      );
    }

    // 청구 자격 선검사 — 계정을 만들기 **전에**. (invites 라우트 53-55행과 같은 자리)
    // 없으면 계정 생성 → 좌석 점유(claim_org_seat) → 결제 실패 → rollback 순서를 타는데,
    // rollback은 deleteUser·org_members·subscriptions 3단이라 부분 실패하면 청구되지 않는
    // 활성 좌석(유령 좌석)이 남아 다음 주기부터 존재하지 않는 계정 몫이 과금된다.
    //
    // 조건을 손으로 옮겨 적지 않고 실제 청구와 **같은 함수**를 dry-run으로 부른다(검수 2026-08-10).
    // 손으로 적었을 때는 결제수단 유무만 베꼈고, 주기 만료(past_due — subscriptionAllows가 통과시키는
    // 상태의 정의 자체가 current_period_end 경과다) 거절이 빠져 유령 좌석 창이 그대로 열려 있었다.
    // resolveSeatCharge는 조회만 한다(.select뿐 — PG 호출도, payments 기록도 없다).
    //
    // ⚠️ count를 1로 고정하면 안 된다(2026-08-10 정원제 도입). 종전 주석은 "count는 금액에만
    // 쓰이고 거절 판정에는 영향이 없다"고 단언했는데, 스토어 정원제가 생기면서 **거짓이 되었다**:
    // 정원 5·현재 4계정인 감독자가 한 번에 10개를 요청하면 count=1 검사는 통과한다.
    // 그래서 본문 파싱을 이 게이트보다 **앞으로** 옮기고 실제 개수로 판정한다.
    // (게이트 자체의 위치는 그대로 — 조직 생성보다 먼저여야 legacy 요금이 보호된다)
    const body = await request.json().catch(() => ({}));
    const stem = String(body.stem ?? "").trim().toLowerCase();
    const count = Math.floor(Number(body.count));
    const password = String(body.password ?? "");
    // 현장명은 감독자가 발급 시점에 정한다(Chris) — 순서대로 계정에 배정.
    // 비면 종전대로 아이디를 임시 표시명으로 두고 담당자 첫 로그인에서 받는다.
    const siteNames: string[] = Array.isArray(body.siteNames)
      ? body.siteNames.map((n: unknown) => String(n ?? "").trim()).filter((n: string) => n.length > 0)
      : [];
    if (!/^[a-z0-9][a-z0-9_]{1,11}$/.test(stem)) {
      return NextResponse.json({ error: "아이디 시작 문자는 영문·숫자 2~12자로 입력해주세요." }, { status: 400 });
    }
    if (!Number.isFinite(count) || count < 1 || count > MAX_BULK) {
      return NextResponse.json({ error: `한 번에 1~${MAX_BULK}개까지 만들 수 있어요.` }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "초기 비밀번호는 8자 이상으로 입력해주세요." }, { status: 400 });
    }

    const gate = await resolveSeatCharge(admin, sub as any, { count, seatsClaimed: false });
    if (!gate.ok) {
      return NextResponse.json({ error: gate.error ?? "결제에 실패했습니다.", reason: gate.reason }, { status: 402 });
    }
    // 좌석 점유(claim_org_seat)에 넘길 정원 — 여기가 최종 방어선이다(advisory lock 안에서 센다).
    // 위 게이트를 두 요청이 동시에 통과해도 초과 점유 자체가 불가능해진다.
    const seatCapacity = await getStoreSeatCapacity(admin, sub as any);

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
            // 감독자가 정한 현장명이 있으면 그걸로 확정 — 없으면 아이디를 임시 표시명으로
            full_name: siteNames[created.length] || loginId,
            company_name: siteNames[created.length] || loginId,
            role: "site_supervisor",
            must_set_password: true,
            // 문서 출력 형식은 회사 공통 양식 — 감독자 값 복사 (첫 로그인 형식 선택 생략)
            ...(ownerFormat ? { preferred_export_format: ownerFormat } : {}),
            ...ownerProfile,
          },
        });
        if (userErr || !createdUser?.user) {
          // 유출 비밀번호 차단(HIBP) 422 — 배치 전체가 같은 초기 비밀번호라 continue하면
          // 후보 아이디만 소진하며 헛돌고 '빈 아이디 부족' 오답이 된다. 즉시 중단·구체 안내.
          if (/weak|easy to guess|pwned/i.test(userErr?.message ?? "")) {
            throw new Error("너무 흔한 비밀번호예요. 숫자·문자를 섞어 다른 초기 비밀번호를 정해주세요.");
          }
          // 중복 아이디는 메시지·코드로만 판정 — '422 전부 중복' 판정은 위 케이스를 삼켰다(2026-08-17 QA)
          if (
            userErr?.message?.includes("already registered") ||
            (userErr as { code?: string } | null)?.code === "email_exists"
          ) {
            continue;
          }
          throw new Error(userErr?.message || "계정 생성 실패");
        }

        const { data: claim, error: claimErr } = await admin.rpc("claim_org_seat", {
          p_org: org.id,
          p_member: createdUser.user.id,
          p_capacity: seatCapacity,
        });
        if (claimErr || claim !== "ok") {
          await admin.auth.admin.deleteUser(createdUser.user.id);
          throw new Error(
            claim === "over_capacity" ? CAPACITY_FULL_MESSAGE : "현장 배정에 실패했습니다."
          );
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

      // 미러 구독 (org_seat 0원) — 4겹 게이트 통과용.
      // 행 모양은 복원 경로(lib/org.ts orgSeatMirrorRow)와 **같은 것**을 쓴다 — 두 곳에 손으로
      // 적으면 한쪽만 바뀌어 어긋난다(스토어 잔재 청산이 정확히 그렇게 빠졌던 자리다).
      const now = new Date().toISOString();
      for (const c of created) {
        const { error: subErr } = await admin
          .from("subscriptions")
          .upsert(orgSeatMirrorRow(c.userId, now), { onConflict: "user_id" });
        if (subErr) console.error("bulk mirror sub upsert error:", c.loginId, subErr);
      }

      // 표시용 계정 수 동기화 — 청구 단위(1 + 청구 대상 좌석)와 같은 수를 쓴다.
      // ctx.memberIds로 세면 자가 스토어 결제자까지 포함돼 청구서와 다른 숫자가 화면에 남는다.
      const acc = await resolveOrgSeatAccountingByOwner(admin, user.id);
      const accountCount = 1 + (acc?.billableSeats ?? created.length);
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
