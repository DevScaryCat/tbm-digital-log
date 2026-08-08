// app/api/billing/card/route.ts — 좌석 청구용 카드(빌링키) 등록 — 앱 구글 구독자용 진입점
//
// 구글 인앱 구독자의 본인 몫(4,900)은 구글이 받는다. 현장 계정(좌석)을 추가하려면
// 좌석 몫(N×3,900)을 청구할 카드가 필요해서, 앱이 그 자리에서 PortOne 빌링키를 발급받아
// 여기로 보낸다. 이 라우트는 빌링키·카드정보만 저장/교체한다 —
// 구독 상태·플랜·기간·source(google_play 유지)는 일절 건드리지 않는다.
// (포트원 결제 사용자가 호출해도 '결제수단 교체'(billing-key mode=update)와 동일해서 해가 없다)
import { NextResponse } from "next/server";
import {
  getAdminClient,
  getUserFromRequest,
  getBillingKeyInfo,
  deleteBillingKey,
  extractCardInfo,
} from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { paymentsEnabled } from "@/lib/utils";

export const runtime = "nodejs";
// 간편결제 빌링키 검증 재시도(백오프 ~9s)를 위해 실행시간 여유 확보 (billing-key 라우트와 동일)
export const maxDuration = 30;

const PROVIDER_LABEL: Record<string, string> = {
  card: "카드",
  kakaopay: "카카오페이",
  naverpay: "네이버페이",
  tosspay: "토스페이",
};

export async function POST(request: Request) {
  try {
    if (!paymentsEnabled()) {
      return NextResponse.json({ error: "결제 기능 준비 중입니다." }, { status: 403 });
    }
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const { billingKey, method } = (await request.json().catch(() => ({}))) as {
      billingKey?: unknown;
      method?: unknown;
    };
    if (typeof billingKey !== "string" || !billingKey.trim()) {
      return NextResponse.json({ error: "billingKey가 없습니다." }, { status: 400 });
    }

    // 1) 빌링키 발급 검증 (billing-key 라우트와 동일 관례 — 간편결제 전파 지연은 백오프 재시도)
    let info = await getBillingKeyInfo(billingKey);
    const retryDelays = [1500, 3000, 4500];
    for (let i = 0; !info.ok && i < retryDelays.length; i++) {
      await new Promise((r) => setTimeout(r, retryDelays[i]));
      info = await getBillingKeyInfo(billingKey);
    }
    // UNAUTHORIZED(전파 지연)는 낙관수용 → billing_key_verified=false로 저장하고
    // 첫 좌석 청구 직전 cron(chargeGoogleOwnerSeats)이 구글-안전 경로로 소유권을 재검증한다.
    let acceptedUnverified = false;
    if (!info.ok) {
      const b = info.body as
        | { message?: string; type?: string; pgCode?: string; pgMessage?: string }
        | null;
      if (b?.type === "UNAUTHORIZED") {
        acceptedUnverified = true;
        console.warn("billing/card verify UNAUTHORIZED after retries — accepting optimistically", {
          billingKey,
          method,
        });
      } else {
        const reason =
          [b?.pgCode, b?.pgMessage].filter(Boolean).join(" ") ||
          b?.message ||
          b?.type ||
          `HTTP ${info.status}`;
        console.error("billing/card verify failed:", { method, status: info.status, body: info.body });
        return NextResponse.json(
          { error: `빌링키 검증 실패: ${reason}`, detail: info.body },
          { status: 400 }
        );
      }
    }

    // 2) 소유권 검증 — 남의 빌링키를 제출해 타인 카드로 좌석 요금이 나가는 경로 차단
    const keyCustomerId = info.ok
      ? (info.body as { customer?: { id?: string } })?.customer?.id
      : undefined;
    if (keyCustomerId && keyCustomerId !== user.id) {
      console.warn("billing/card ownership mismatch", { keyCustomerId, userId: user.id });
      return NextResponse.json({ error: "본인 명의로 발급된 결제수단이 아닙니다." }, { status: 403 });
    }
    const cardInfo =
      extractCardInfo(info.body) ||
      (typeof method === "string" ? { provider: PROVIDER_LABEL[method] ?? method } : null);

    const admin = getAdminClient();

    // 소속 현장 계정 차단 — 미러 행(org_seat)에 카드가 붙으면 조용히 조직 과금 구조가 오염된다
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "member") {
      return NextResponse.json(
        { error: "소속 현장 계정입니다. 구독·결제는 회사 감독자가 관리합니다." },
        { status: 403 }
      );
    }

    const { data: existing } = await admin
      .from("subscriptions")
      .select("id, billing_key, source")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json(
        { error: "구독 정보가 없습니다. 먼저 구독을 시작해주세요." },
        { status: 404 }
      );
    }

    // 3) 다른 키로 교체 시 구키는 PG에서 폐기 — 실패해도 교체는 진행 (cancelSubscription 관례)
    if (existing.billing_key && existing.billing_key !== billingKey) {
      const del = await deleteBillingKey(existing.billing_key);
      if (!del.ok) {
        console.error("구 빌링키 PG측 폐기 실패(교체는 계속 진행):", del.status, del.body);
      }
    }

    // 4) 저장 — source는 바꾸지 않는다(google_play 유지). 좌석 청구 3회 실패로 멈춘 상태의
    //    복구 스위치가 failed_attempts 리셋이다(카드 재등록 = 재시도 의사 표시 → 다음 cron이 청구).
    const { error } = await admin
      .from("subscriptions")
      .update({
        billing_key: billingKey,
        card_info: cardInfo,
        billing_key_verified: !acceptedUnverified,
        failed_attempts: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) {
      console.error("billing/card update error:", error);
      return NextResponse.json({ error: "결제수단 등록 실패" }, { status: 500 });
    }

    return NextResponse.json({ success: true, cardInfo });
  } catch (e) {
    console.error("billing/card route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
