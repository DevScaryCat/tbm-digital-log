// app/api/auth/claim-trial/route.ts — 기존 계정의 무료체험 개시 (카카오·구 무인증 가입용)
// 아이디 가입 위저드는 가입 시점에 체험을 받지만, 카카오 OAuth와 인증 게이트가 꺼져 있던
// 시절의 가입자는 subscriptions 행 없이 시작한다 — 랜딩의 "첫 달 무료" 약속이 그 경로에서만
// 깨졌다. 이 라우트가 로그인된 무구독 계정에 가입 위저드와 동일한 규칙(휴대폰 인증 +
// trial_redemptions 번호 1회)으로 카드 없는 1개월 체험을 발급한다.
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, PLANS } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { phoneAuthEnabled, normalizePhone, isTrialTestPhone } from "@/lib/phoneAuth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const admin = getAdminClient();

    // 이미 구독 이력이 있으면 대상이 아니다 — 만료 계정의 재체험 통로가 되면 안 된다
    const { data: existing } = await admin
      .from("subscriptions")
      .select("user_id, status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ error: "이미 구독 정보가 있는 계정입니다." }, { status: 409 });
    }

    // 회사 소속 현장 계정은 감독자 구독으로 이용 — 개인 체험 대상 아님 (미러 구독 누락 복구는 수동)
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "member") {
      return NextResponse.json({ error: "회사 소속 계정은 감독자 구독으로 이용합니다." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;

    // 현장명 — 카카오 가입자는 비어 있어 문서·보고서 곳곳이 "현장"으로 나온다. 여기서 채운다.
    const companyName = typeof body.companyName === "string" ? body.companyName.trim().slice(0, 60) : "";
    if (!String(meta.company_name ?? "").trim() && !companyName) {
      return NextResponse.json({ error: "현장명(또는 업체명)을 입력해주세요." }, { status: 400 });
    }

    // 휴대폰 인증 — 가입 위저드와 동일 검증 (게이트가 꺼져 있으면 생략)
    const normalizedPhone = normalizePhone(body.phone);
    let verifiedOtpId: string | null = null;
    if (phoneAuthEnabled()) {
      const verificationId = typeof body.verificationId === "string" ? body.verificationId : "";
      if (!normalizedPhone || !verificationId) {
        return NextResponse.json({ error: "휴대폰 인증을 완료해주세요." }, { status: 400 });
      }
      const { data: otp } = await admin
        .from("phone_otps")
        .select("id, phone, verified, consumed, created_at")
        .eq("id", verificationId)
        .maybeSingle();
      const fresh = otp && Date.now() - new Date(otp.created_at).getTime() < 30 * 60_000;
      if (!otp || !otp.verified || otp.consumed || otp.phone !== normalizedPhone || !fresh) {
        return NextResponse.json({ error: "휴대폰 인증이 유효하지 않습니다. 다시 인증해주세요." }, { status: 400 });
      }
      verifiedOtpId = otp.id;

      // 번호 소진(unique)이 최종 관문 — 가입 라우트와 달리 계정 롤백은 없다(기존 계정)
      if (!isTrialTestPhone(normalizedPhone)) {
        const { error: redeemErr } = await admin
          .from("trial_redemptions")
          .insert({ phone: normalizedPhone, user_id: user.id });
        if (redeemErr) {
          return NextResponse.json(
            { error: "이 번호로는 무료체험을 이미 사용했습니다. 결제수단을 등록하면 바로 이용할 수 있어요." },
            { status: 409 },
          );
        }
      }
      await admin.from("phone_otps").update({ consumed: true }).eq("id", verifiedOtpId);
    }

    // 메타데이터 보강 — admin update는 전체 치환이라 최신 값을 병합한다
    const patch: Record<string, unknown> = { ...meta };
    if (companyName) {
      patch.company_name = companyName;
      if (!String(meta.full_name ?? "").trim()) patch.full_name = companyName;
    }
    if (verifiedOtpId) {
      patch.phone = normalizedPhone;
      patch.phone_verified_at = new Date().toISOString();
    }
    await admin.auth.admin.updateUserById(user.id, { user_metadata: patch });

    // 카드 없는 Pro 1개월 체험 — 가입 위저드의 발급 블록과 동일 필드
    const now = new Date();
    const trialEnd = new Date(now);
    trialEnd.setMonth(trialEnd.getMonth() + 1);
    const pro = PLANS.monthly_pro;
    const { error: subErr } = await admin.from("subscriptions").upsert(
      {
        user_id: user.id,
        plan: pro.id,
        status: "trialing",
        billing_key: null,
        amount: pro.amount,
        currency: pro.currency,
        trial_end: trialEnd.toISOString(),
        current_period_end: trialEnd.toISOString(),
        trial_used: true,
        failed_attempts: 0,
        updated_at: now.toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (subErr) {
      console.error("claim-trial subscription upsert error:", subErr);
      return NextResponse.json({ error: "체험 개시에 실패했습니다. 잠시 후 다시 시도해주세요." }, { status: 500 });
    }

    return NextResponse.json({ success: true, trialEnd: trialEnd.toISOString() });
  } catch (e) {
    console.error("claim-trial error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
