import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { phoneAuthEnabled, normalizePhone, isTrialTestPhone } from "@/lib/phoneAuth";
import { PLANS } from "@/lib/portone";
import { sendRealEmailVerification, isValidEmail } from "@/lib/emailVerification";

export async function POST(request: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: "서버 설정 오류 (Supabase)" }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { id, password, siteName, industry, workCategory, workerType, phone, verificationId, inviteToken, realEmail, managerName, mode } = await request.json();

    if (!id || !password || !siteName) {
      return NextResponse.json({ error: "모든 필드를 입력해주세요." }, { status: 400 });
    }


    // ── 조직 초대 가입(관리감독자, 시나리오 1) — 초대 토큰 검증 ─────────
    // 초대 경로는 개인 구독 upsert·휴대폰 무료체험(trial_redemptions)을 만들지 않고(§3 3-skip),
    // 좌석 점유 + org_seat 미러 구독으로 대체한다.
    let invite: { id: string; org_id: string } | null = null;
    if (inviteToken) {
      const { data: inv } = await supabaseAdmin
        .from("org_invites")
        .select("id, org_id, kind, expires_at, used_at, organizations!inner(owner_user_id)")
        .eq("token", String(inviteToken))
        .eq("kind", "link")
        .maybeSingle();
      if (!inv || new Date(inv.expires_at) <= new Date()) {
        return NextResponse.json(
          { error: "초대 링크가 유효하지 않거나 만료되었습니다. 안전관리자에게 재발급을 요청하세요." },
          { status: 400 },
        );
      }
      // 상위 구독이 유효해야 가입 가능
      const ownerId = (inv as any).organizations?.owner_user_id as string;
      const { data: ownerSub } = await supabaseAdmin
        .from("subscriptions")
        .select("status, current_period_end, billing_key")
        .eq("user_id", ownerId)
        .maybeSingle();
      const ownerOk =
        ownerSub &&
        (ownerSub.status === "active" ||
          ownerSub.status === "past_due" ||
          (ownerSub.status === "canceled" &&
            ownerSub.current_period_end &&
            new Date(ownerSub.current_period_end) > new Date()));
      if (!ownerOk) {
        return NextResponse.json(
          { error: "조직의 구독이 유효하지 않습니다. 안전관리자에게 문의하세요." },
          { status: 400 },
        );
      }
      if (realEmail !== undefined && String(realEmail).trim() && !isValidEmail(String(realEmail).trim())) {
        return NextResponse.json({ error: "이메일 형식이 올바르지 않습니다." }, { status: 400 });
      }
      invite = { id: inv.id, org_id: inv.org_id };
    }

    // 업종/공종: 데이터 분석용 프로필(선택 목록 외 임의 값 방지, 최대 40자 — KSIC 분류명 수용)
    const industryStr = typeof industry === "string" ? industry.trim().slice(0, 40) : "";
    const workCategoryStr = typeof workCategory === "string" ? workCategory.trim().slice(0, 40) : "";

    // 근로자 구분: 교육시간 산정용 — 화이트리스트 외 값·누락이면 기본값(현장 근로자)
    const WORKER_TYPES = ["현장 근로자 (비사무직)", "사무직 / 판매직"];
    const workerTypeStr = WORKER_TYPES.includes(workerType) ? workerType : "현장 근로자 (비사무직)";

    if (!/^[a-z0-9_]{3,20}$/.test(id)) {
      return NextResponse.json({ error: "아이디는 영문 소문자·숫자·밑줄 3~20자로 입력해주세요." }, { status: 400 });
    }

    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json({ error: "비밀번호는 8자 이상 입력해주세요." }, { status: 400 });
    }

    // ── 휴대폰인증(무료체험 게이트) — 기능이 켜져 있으면 필수 ─────────────
    // 켜져 있지 않으면(솔라피 키 미설정) 기존 흐름 그대로: 인증 없이 가입 → 카드 등록 시 체험.
    const normalizedPhone = normalizePhone(phone);
    let verifiedOtpId: string | null = null;
    if (phoneAuthEnabled()) {
      if (!normalizedPhone || typeof verificationId !== "string" || !verificationId) {
        return NextResponse.json({ error: "휴대폰 인증을 완료해주세요." }, { status: 400 });
      }
      const { data: otp } = await supabaseAdmin
        .from("phone_otps")
        .select("id, phone, verified, consumed, created_at")
        .eq("id", verificationId)
        .maybeSingle();
      const fresh = otp && Date.now() - new Date(otp.created_at).getTime() < 30 * 60_000;
      if (!otp || !otp.verified || otp.consumed || otp.phone !== normalizedPhone || !fresh) {
        return NextResponse.json({ error: "휴대폰 인증이 유효하지 않습니다. 다시 인증해주세요." }, { status: 400 });
      }
      verifiedOtpId = otp.id;
    }

    const fullEmailId = `${id}@tbm.com`;

    // 유저 생성 (Admin API 사용: 가상 이메일이라 이메일 인증을 우회하기 위해 email_confirm=true 처리)
    const managerNameStr = typeof managerName === "string" ? managerName.trim().slice(0, 30) : "";
    const realEmailStr = typeof realEmail === "string" ? realEmail.trim() : "";
    const { data: user, error: userError } = await supabaseAdmin.auth.admin.createUser({
      email: fullEmailId,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: invite ? managerNameStr || siteName : siteName,
        company_name: siteName,
        role: invite ? "site_supervisor" : "user", // 표시용 — 분기 키는 DB(org_members)
        // 데이터 가공/통계용 프로필 (2026-07 가입 위저드부터 수집 — 기존 유저는 없음)
        industry: industryStr || null,
        work_category: workCategoryStr || null,
        worker_type: workerTypeStr,
        phone: verifiedOtpId ? normalizedPhone : null,
        phone_verified_at: verifiedOtpId ? new Date().toISOString() : null,
      },
    });

    if (userError) {
      // 이미 가입된 이메일 오류 처리
      if (userError.message.includes("already registered") || userError.status === 422) {
         return NextResponse.json({ error: "이미 존재하는 아이디입니다." }, { status: 400 });
      }
      return NextResponse.json({ error: userError.message }, { status: 400 });
    }

    // ── 조직 초대 가입: 좌석 점유 + 미러 구독 (개인 구독·무료체험 없음) ──
    if (invite && user?.user) {
      const { data: claim, error: claimErr } = await supabaseAdmin.rpc("claim_org_seat", {
        p_org: invite.org_id,
        p_member: user.user.id,
      });
      if (claimErr || claim !== "ok") {
        // 좌석 실패 → 방금 만든 계정 롤백 (다회용 링크라 초대 자체는 살려둔다)
        await supabaseAdmin.auth.admin.deleteUser(user.user.id);
        const msg =
          claim === "no_seat"
            ? "조직에 남은 좌석이 없습니다. 안전관리자에게 좌석 추가를 요청하세요."
            : "좌석 배정에 실패했습니다. 잠시 후 다시 시도해주세요.";
        return NextResponse.json({ error: msg }, { status: 409 });
      }

      // 휴대폰 인증은 소진 처리하되 무료체험(trial_redemptions)은 만들지 않는다 —
      // 좌석 결제와 무관한 Pro 체험 이중 발급 차단 + 과거 체험 번호 반장의 409 차단 방지 (검증 §3)
      if (verifiedOtpId) {
        await supabaseAdmin.from("phone_otps").update({ consumed: true }).eq("id", verifiedOtpId);
      }

      const nowIso = new Date().toISOString();
      const { error: mirrorErr } = await supabaseAdmin.from("subscriptions").upsert(
        {
          user_id: user.user.id,
          plan: "org_seat",
          status: "active",
          billing_key: null,
          amount: 0,
          currency: "KRW",
          current_period_end: null,
          trial_used: true,
          failed_attempts: 0,
          updated_at: nowIso,
        },
        { onConflict: "user_id" },
      );
      if (mirrorErr) console.error("invite signup mirror sub error:", mirrorErr);

      // 실이메일 인증 메일 (매달 1일 월간 보고서 수신용) — 실패해도 가입은 성공, 배너로 재시도
      let emailSent = false;
      if (realEmailStr) {
        const proto = request.headers.get("x-forwarded-proto") || "https";
        const host = request.headers.get("host");
        const r = await sendRealEmailVerification(
          supabaseAdmin,
          user.user.id,
          realEmailStr,
          host ? `${proto}://${host}` : undefined,
        );
        emailSent = r.ok;
      }

      return NextResponse.json({ success: true, joinedOrg: true, emailVerificationSent: emailSent });
    }

    // ── 무료체험 개시 (휴대폰인증 완료 시에만 · 단독 가입 전용) ──────────
    // 번호 소진(unique)이 최종 관문: 동시 가입 레이스에서도 한 번호는 한 번만 성공한다.
    let trialStarted = false;
    if (verifiedOtpId && normalizedPhone && user?.user) {
      // 테스트 번호는 소진 기록을 남기지 않아 같은 번호로 반복 가입·체험 테스트가 가능하다.
      if (!isTrialTestPhone(normalizedPhone)) {
        const { error: redeemErr } = await supabaseAdmin
          .from("trial_redemptions")
          .insert({ phone: normalizedPhone, user_id: user.user.id });

        if (redeemErr) {
          // 이미 소진된 번호(레이스 등) → 방금 만든 계정 롤백 후 명확히 안내
          await supabaseAdmin.auth.admin.deleteUser(user.user.id);
          return NextResponse.json(
            { error: "이 번호로는 무료체험을 이미 사용했습니다. 로그인 후 결제수단을 등록해 이용해주세요." },
            { status: 409 },
          );
        }
      }

      await supabaseAdmin.from("phone_otps").update({ consumed: true }).eq("id", verifiedOtpId);

      // 카드 없는 Pro 1개월 체험 — billing_key null이라 cron 과금 대상에서 자동 제외되고,
      // 만료 후에는 게이트(subscriptionAllows/isAllowed)가 결제 등록으로 유도한다.
      const now = new Date();
      const trialEnd = new Date(now);
      trialEnd.setMonth(trialEnd.getMonth() + 1);
      const pro = PLANS.monthly_pro;
      const { error: subErr } = await supabaseAdmin.from("subscriptions").upsert(
        {
          user_id: user.user.id,
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
        console.error("trial subscription upsert error:", subErr);
        // 계정은 유효하므로 실패해도 가입 자체는 성공 처리(수동 복구 가능) — 다만 로그로 남긴다.
      } else {
        trialStarted = true;
      }
    }

    return NextResponse.json({ success: true, trialStarted });
  } catch (error: any) {
    console.error("Signup Error:", error);
    return NextResponse.json({ error: "회원가입 처리 중 서버 오류가 발생했습니다." }, { status: 500 });
  }
}
