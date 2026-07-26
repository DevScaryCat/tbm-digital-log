// app/api/org/checkout/route.ts — 안전관리자 회사 플랜 결제 (좌석 수 × 4,900 즉시 청구)
// 기존 /api/payments/billing-key 를 재사용하지 않는 이유(검증 F1):
// 그 라우트는 trial_used=false면 무조건 첫 달 무료 체험을 부여하고, 재구독 경로는 정적 plan
// 금액을 upsert한다. 회사 플랜은 체험 없음 + 좌석 총액 즉시 결제가 원칙이라 전용 라우트로 분리.
import { NextResponse } from "next/server";
import {
  getAdminClient,
  getUserFromRequest,
  getBillingKeyInfo,
  extractCardInfo,
  newPaymentId,
  subscriptionAllows,
  ORG_SEAT_PRICE,
} from "@/lib/portone";
import { chargeSubscription } from "@/lib/billing";
import { getOrgContext } from "@/lib/org";
import { paymentsEnabled } from "@/lib/utils";

export const runtime = "nodejs";
// 카카오페이 빌링키 전파 지연(발급 직후 조회가 UNAUTHORIZED)이 길어질 수 있어
// 검증 재시도 창을 넉넉히 잡는다. 재시도(~25s) + 청구까지 커버.
export const maxDuration = 60;

const MAX_SEATS = 100;

export async function POST(request: Request) {
  try {
    if (!paymentsEnabled()) {
      return NextResponse.json({ error: "결제 기능 준비 중입니다." }, { status: 403 });
    }
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const { billingKey, seatCount, orgName } = await request.json();
    const seats = Math.floor(Number(seatCount));
    const name = typeof orgName === "string" ? orgName.trim().slice(0, 60) : "";
    if (!billingKey) return NextResponse.json({ error: "billingKey가 없습니다." }, { status: 400 });
    if (!Number.isFinite(seats) || seats < 1 || seats > MAX_SEATS) {
      return NextResponse.json({ error: `좌석 수는 1~${MAX_SEATS} 사이로 선택해주세요.` }, { status: 400 });
    }
    if (!name) return NextResponse.json({ error: "회사명을 입력해주세요." }, { status: 400 });

    const admin = getAdminClient();

    // 역할 가드: 조직 하위 계정은 불가. 기존 개인 유료/체험 구독이 살아있는 계정도 불가(승격 미지원 — §3).
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "member") {
      return NextResponse.json({ error: "이미 조직에 소속된 계정입니다." }, { status: 400 });
    }
    const { data: existingSub } = await admin
      .from("subscriptions")
      .select("id, plan, status, current_period_end, billing_key")
      .eq("user_id", user.id)
      .maybeSingle();
    // 이미 유효한 회사 플랜이면 재결제 불가 — 같은 날 재호출 시 기간 리셋으로 청구가
    // 영구 중단되거나(멱등 skip), 다른 날엔 전액 이중 청구되는 구멍 차단 (리뷰 B/상)
    if (existingSub?.plan === "org" && subscriptionAllows(existingSub)) {
      return NextResponse.json(
        { error: "이미 회사 플랜을 이용 중입니다. 좌석 변경은 좌석 관리에서 해주세요." },
        { status: 400 }
      );
    }
    const personalActive =
      existingSub &&
      existingSub.plan !== "org" &&
      (existingSub.status === "active" ||
        existingSub.status === "trialing" ||
        existingSub.status === "past_due");
    if (personalActive) {
      return NextResponse.json(
        {
          error:
            "이 계정에는 개인 구독이 있습니다. 안전관리자 계정은 현장 데이터가 없는 새 계정으로 만들어주세요. (기존 현장 계정은 나중에 '기존 계정 편입'으로 붙일 수 있어요)",
        },
        { status: 400 }
      );
    }

    // 빌링키 검증 — 즉시 결제 경로라 낙관수용 불가(미검증 키로 청구하면 타인 카드 과금 위험).
    // 카카오페이는 발급 확정(issuedAt)까지 실측 ~50초가 걸려 조회가 UNAUTHORIZED로 뜬다.
    // 서버에서 다 기다리면 함수 타임아웃이라 여기선 ~12초만 보고, 나머지는 클라이언트가 폴링한다.
    let info = await getBillingKeyInfo(billingKey);
    const retryDelays = [1500, 2500, 3500, 4500];
    for (let i = 0; !info.ok && i < retryDelays.length; i++) {
      await new Promise((r) => setTimeout(r, retryDelays[i]));
      info = await getBillingKeyInfo(billingKey);
    }
    if (!info.ok) {
      const b = info.body as { message?: string; type?: string; pgCode?: string; pgMessage?: string } | null;
      if (b?.type === "UNAUTHORIZED") {
        // 재인증 없이 같은 빌링키로 재시도할 수 있도록 키를 함께 돌려준다
        return NextResponse.json(
          {
            error: "결제수단 확인이 아직 끝나지 않았어요. 잠시 후 '결제 다시 시도'를 눌러주세요.",
            retryableBillingKey: billingKey,
          },
          { status: 409 }
        );
      }
      const reason =
        [b?.pgCode, b?.pgMessage].filter(Boolean).join(" ") || b?.message || b?.type || `HTTP ${info.status}`;
      return NextResponse.json({ error: `빌링키 검증 실패: ${reason}` }, { status: 400 });
    }
    const keyCustomerId = (info.body as { customer?: { id?: string } })?.customer?.id;
    if (keyCustomerId && keyCustomerId !== user.id) {
      return NextResponse.json({ error: "본인 명의로 발급된 결제수단이 아닙니다." }, { status: 403 });
    }
    const cardInfo = extractCardInfo(info.body);

    const now = new Date();

    // 조직 upsert (재결제/재활성 포함 — owner_user_id unique)
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .upsert(
        { owner_user_id: user.id, name, seat_count: seats, pending_seat_count: null },
        { onConflict: "owner_user_id" }
      )
      .select()
      .single();
    if (orgErr || !org) {
      console.error("org upsert error:", orgErr);
      return NextResponse.json({ error: "조직 생성 실패" }, { status: 500 });
    }

    // 구독 upsert — 체험 없음, current_period_end=now로 두고 즉시 청구(성공 시 +1개월)
    const { data: sub, error: subErr } = await admin
      .from("subscriptions")
      .upsert(
        {
          user_id: user.id,
          plan: "org",
          pending_plan: null,
          status: "active",
          billing_key: billingKey,
          card_info: cardInfo,
          billing_key_verified: true,
          amount: seats * ORG_SEAT_PRICE,
          currency: "KRW",
          current_period_end: now.toISOString(),
          trial_used: true,
          failed_attempts: 0,
          canceled_at: null,
          updated_at: now.toISOString(),
        },
        { onConflict: "user_id" }
      )
      .select()
      .single();
    if (subErr || !sub) {
      console.error("org subscription upsert error:", subErr);
      return NextResponse.json({ error: "구독 저장 실패" }, { status: 500 });
    }

    // 초회 청구는 1회성 paymentId — 같은 날 해지→재가입 시 날짜 키 충돌 방지
    const charge = await chargeSubscription(admin, sub as any, {
      customerEmail: user.email ?? undefined,
      paymentIdOverride: newPaymentId("sub"),
    });
    if (!charge.ok) {
      // 첫 결제 실패 시 구독을 즉시 무효화 — past_due로 남기면 한 푼도 안 낸 owner가
      // cron 3회 실패까지 수일간 전 기능(하위 발급 포함)을 쓴다 (리뷰 B/상, "체험 없음" 원칙)
      await admin
        .from("subscriptions")
        .update({
          status: "canceled",
          canceled_at: now.toISOString(),
          current_period_end: now.toISOString(),
          billing_key: null,
          card_info: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", (sub as any).id);
      return NextResponse.json({ error: "결제에 실패했습니다. 카드를 확인해주세요." }, { status: 402 });
    }

    // 표시용 메타데이터 (분기 키 아님 — 진실은 organizations 테이블)
    try {
      await admin.auth.admin.updateUserById(user.id, {
        user_metadata: { role: "safety_manager", company_name: name },
      });
    } catch (e) {
      console.error("owner metadata update 실패(비치명):", e);
    }

    // 재활성 케이스: 강등돼 있던 하위 미러 복구 (멤버십이 남아있는 active 멤버).
    // 단, 강등 기간에 본인 카드로 개인 유료 구독을 살린 멤버는 덮어쓰지 않는다 —
    // 무단 덮어쓰기는 돈 낸 개인 구독을 환불 없이 소멸시킨다 (리뷰 B·authz/중)
    const { data: members } = await admin
      .from("org_members")
      .select("member_user_id")
      .eq("org_id", org.id)
      .eq("status", "active");
    for (const m of members ?? []) {
      const { data: memberSub } = await admin
        .from("subscriptions")
        .select("plan, status, current_period_end, billing_key")
        .eq("user_id", m.member_user_id)
        .maybeSingle();
      const personalPaidActive =
        memberSub &&
        memberSub.plan !== "org_seat" &&
        subscriptionAllows(memberSub);
      if (personalPaidActive) continue; // 본인 결제 유지 — detach/재편입은 좌석 관리에서 명시적으로
      await admin.from("subscriptions").upsert(
        {
          user_id: m.member_user_id,
          plan: "org_seat",
          status: "active",
          billing_key: null,
          card_info: null,
          amount: 0,
          currency: "KRW",
          current_period_end: null,
          failed_attempts: 0,
          canceled_at: null,
          updated_at: now.toISOString(),
        },
        { onConflict: "user_id" }
      );
    }

    return NextResponse.json({ success: true, orgId: org.id, charged: seats * ORG_SEAT_PRICE });
  } catch (e) {
    console.error("org checkout error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
