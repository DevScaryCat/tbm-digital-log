// app/api/auth/claim-trial/route.ts — 기존 계정의 가입 마무리 + 무료체험 개시 (카카오·구 무인증 가입용)
// 아이디 가입 위저드는 가입 시점에 체험을 받지만, 카카오 OAuth와 인증 게이트가 꺼져 있던
// 시절의 가입자는 subscriptions 행 없이, 그리고 위저드가 받던 온보딩 값(업종·공종·근로자
// 구분·출력 형식·약관 동의) 없이 시작한다 — 랜딩의 "첫 달 무료" 약속이 그 경로에서만
// 깨졌고, 문서에는 카톡 닉네임이 업체명으로 인쇄됐다. 이 라우트가 위저드와 동일한
// 규칙(휴대폰 인증 + trial_redemptions 번호 1회)으로 그 공백을 한 번에 메운다.
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, PLANS } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { phoneAuthEnabled, normalizePhone, isTrialTestPhone } from "@/lib/phoneAuth";
import { EXPORT_FORMATS } from "@/lib/exportFormats";
import { isConsentCurrent, consentMetaPatch, recordConsent } from "@/lib/consent";

export const runtime = "nodejs";

// 가입 API·org/profile과 같은 화이트리스트 — 교육시간 산정 분기 키라 임의 값이 들어오면 안 된다
const WORKER_TYPES = ["현장 근로자 (비사무직)", "사무직 / 판매직"];

/**
 * 화면 진입 시점의 서버 기준 상태.
 * 동의 여부를 로컬 세션 스냅샷(getSession)으로 판정하면 토큰 갱신(~1시간)까지 낡은 값이라
 * 이미 동의한 사람에게 체크박스가 다시 뜬다. 클라이언트가 서버 전용 모듈(lib/consent →
 * nodemailer)을 import하지 않고도 정확히 판정하도록 여기서 내려준다.
 */
export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    return NextResponse.json({
      phoneEnabled: phoneAuthEnabled(),
      needsConsent: !isConsentCurrent(meta),
    });
  } catch (e) {
    console.error("claim-trial status error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const admin = getAdminClient();

    // 회사 소속 현장 계정은 감독자 구독으로 이용 — 개인 체험 대상 아님 (미러 구독 누락 복구는 수동)
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "member") {
      return NextResponse.json({ error: "회사 소속 계정은 감독자 구독으로 이용합니다." }, { status: 403 });
    }

    // 이미 구독 이력이 있으면 체험 대상이 아니다 — 만료 계정의 재체험 통로가 되면 안 된다.
    // 아래 프로필 커밋보다 **먼저** 봐야 한다: 화면에서는 도달할 수 없어도 이 API를 직접
    // POST하면 구독이 살아있는 계정의 현장명·업종이 덮어써진 뒤에야 409가 나간다.
    const { data: existing } = await admin
      .from("subscriptions")
      .select("user_id, status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ error: "이미 구독 정보가 있는 계정입니다." }, { status: 409 });
    }

    const body = await request.json().catch(() => ({}));
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;

    // 현장명 — 카카오 가입자는 비어 있어 문서·보고서 곳곳이 "현장"으로 나온다. 여기서 채운다.
    const companyName = typeof body.companyName === "string" ? body.companyName.trim().slice(0, 60) : "";
    if (!String(meta.company_name ?? "").trim() && !companyName) {
      return NextResponse.json({ error: "현장명(또는 업체명)을 입력해주세요." }, { status: 400 });
    }

    // 온보딩 값 — 분기 키(교육시간·출력 형식)는 화이트리스트 밖이면 아예 저장하지 않는다.
    // 여기서 400을 던지면 아래 "동의 먼저 커밋"이 무의미해지므로 조용히 버린다.
    const industry = typeof body.industry === "string" ? body.industry.trim().slice(0, 40) : "";
    const workCategory = typeof body.workCategory === "string" ? body.workCategory.trim().slice(0, 40) : "";
    const workerType = WORKER_TYPES.includes(body.workerType) ? (body.workerType as string) : "";
    const exportFormat = EXPORT_FORMATS.some((f) => f.value === body.exportFormat)
      ? (body.exportFormat as string)
      : "";

    // ── 동의·프로필을 체험 발급보다 먼저 커밋한다 ──
    // 예전 순서(번호 소진 검사 → 저장)에서는 409로 되돌아가는 순간 사용자가 입력한 동의와
    // 현장명이 통째로 사라져, 체험을 못 받은 계정은 매번 빈 화면에서 다시 시작해야 했다.
    // 체험 발급이 실패해도 동의 증빙과 프로필은 남아야 한다.
    // 아직 동의 이력이 없는 계정은 동의 없이 진행시키지 않는다 — 이 아래에서 휴대폰 번호가
    // 저장되고 체험이 발급되므로, 개인정보 수집이 동의보다 앞서면 안 된다(/api/signup과 동일 규칙).
    // 이미 동의한 계정은 화면에 체크박스가 뜨지 않아 agreedToTerms를 보내지 않으므로 통과시킨다.
    if (!isConsentCurrent(meta) && body.agreedToTerms !== true) {
      return NextResponse.json({ error: "약관에 동의해주세요." }, { status: 400 });
    }

    const recording = body.agreedToTerms === true && !isConsentCurrent(meta);
    let ledgerOk = false;
    if (recording) {
      // 증빙 원장이 캐시(metadata)보다 먼저 — 순서가 뒤집히면 원장이 비었는데 캐시만
      // "동의함"인 창이 생긴다. recordConsent는 실패해도 throw하지 않으므로 흐름은 이어진다.
      ledgerOk = await recordConsent(admin, user.id, {
        source: "claim-trial",
        // x-forwarded-for는 프록시 체인이라 최초 클라이언트 IP만 남긴다 (consent·signup과 동일 규칙)
        ip: (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null,
        userAgent: request.headers.get("user-agent"),
      });
    }

    // 메타데이터 보강 — admin update는 전체 치환이라 최신 값을 병합한다
    let committed: Record<string, unknown> = { ...meta };
    if (companyName) {
      committed.company_name = companyName;
      if (!String(meta.full_name ?? "").trim()) committed.full_name = companyName;
    }
    if (industry) committed.industry = industry;
    if (workCategory) committed.work_category = workCategory;
    if (workerType) committed.worker_type = workerType;
    if (exportFormat) committed.preferred_export_format = exportFormat;
    // 원장 기록이 실패하면 동의 캐시는 심지 않는다 — 증빙 0건인데 게이트만 닫혀
    // 재동의를 영영 못 받는 상태가 된다. 가입·체험은 그대로 진행하고(사용자를 막지 않는다)
    // 동의만 남겨 ConsentGate가 다음 진입 때 다시 받게 한다.
    if (recording && ledgerOk) committed = { ...committed, ...consentMetaPatch() };
    const { error: metaErr } = await admin.auth.admin.updateUserById(user.id, { user_metadata: committed });
    if (metaErr) {
      console.error("claim-trial metadata update error:", metaErr);
      return NextResponse.json({ error: "저장에 실패했습니다. 잠시 후 다시 시도해주세요." }, { status: 500 });
    }

    // 휴대폰 인증 — 가입 위저드와 동일 검증 (게이트가 꺼져 있으면 생략).
    // 번호 소진(trial_redemptions) 검사는 위 커밋 뒤에 남긴다 — 여기서 409로 끝나도
    // 동의·프로필은 저장돼 있어야 다음 진입이 빈 화면부터 다시 시작하지 않는다.
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

      // 인증 결과는 검증을 통과한 뒤에만 — 위 병합 결과에 얹어야 앞서 저장한 값이 지워지지 않는다
      committed = { ...committed, phone: normalizedPhone, phone_verified_at: new Date().toISOString() };
      await admin.auth.admin.updateUserById(user.id, { user_metadata: committed });
    }

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
