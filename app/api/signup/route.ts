import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { phoneAuthEnabled, normalizePhone, isTrialTestPhone } from "@/lib/phoneAuth";
import { PLANS, subscriptionAllows, isBillablePlan } from "@/lib/portone";
import { isStoreSource } from "@/lib/billing";
import { sendRealEmailVerification, isValidEmail } from "@/lib/emailVerification";
import { consentMetaPatch, recordConsent } from "@/lib/consent";
import { EXPORT_FORMATS } from "@/lib/exportFormats";
import { markHash, usedTrialBeforeWithdrawal } from "@/lib/withdrawal";

export async function POST(request: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: "서버 설정 오류 (Supabase)" }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { id, password, siteName, industry, workCategory, workerType, exportFormat, phone, verificationId, inviteToken, realEmail, managerName, mode, agreedToTerms } = await request.json();

    if (!id || !password || !siteName) {
      return NextResponse.json({ error: "모든 필드를 입력해주세요." }, { status: 400 });
    }

    // 동의는 계정이 만들어지기 전에 막는다 — 동의 없는 계정이 생기면 사후 회수가 불가능하다.
    // 초대 가입(/join)도 예외가 아니다: 좌석을 회사가 결제할 뿐 계정 주체는 본인이라
    // 동의 원장이 비면 개인정보 수집 근거가 없다. 현재 호출부는 /join 하나뿐이고 이미 보낸다.
    const consented = agreedToTerms === true;
    if (!consented) {
      return NextResponse.json({ error: "약관에 동의해주세요." }, { status: 400 });
    }

    // ── 조직 초대 가입(관리감독자, 시나리오 1) — 초대 토큰 검증 ─────────
    // 초대 경로는 개인 구독 upsert·휴대폰 무료체험(trial_redemptions)을 만들지 않고(§3 3-skip),
    // 좌석 점유 + org_seat 미러 구독으로 대체한다.
    let invite: { id: string; org_id: string } | null = null;
    // 감독자가 스토어 정원제(seats-NN)면 좌석 점유 시 정원을 강제한다. NULL이면 상한 없음(웹 카드).
    let inviteOwnerCapacity: number | null = null;
    let inviteOwnerFormat: string | null = null; // 회사 공통 문서 형식 — 감독자 값을 복사
    let inviteOwnerProfile: Record<string, unknown> = {}; // 회사 공통 근로자 구분·업종·공종 — 감독자 값이 가입자 입력보다 우선
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
        .select("status, plan, current_period_end, billing_key, source, store_seat_capacity")
        .eq("user_id", ownerId)
        .maybeSingle();
      // subscriptionAllows로 판정 — 수제 status 나열은 trialing(무료체험 감독자)을 빠뜨려
      // 체험 중 초대 링크 가입이 전부 400으로 죽었다. 체험 중 현장 추가는 무청구가 맞다.
      // isBillablePlan: 초대 링크 가입도 좌석을 하나 만드는 경로다 — grandfather(영구 무료·
      // 카드 등록 불가) 감독자 밑으로는 무과금 좌석이 되므로 막는다(org/attach와 동일 게이트)
      const ownerOk = ownerSub && subscriptionAllows(ownerSub) && isBillablePlan((ownerSub as any).plan);
      if (!ownerOk) {
        return NextResponse.json(
          { error: "회사의 구독이 유효하지 않습니다. 회사 감독자에게 문의하세요." },
          { status: 400 },
        );
      }
      if (realEmail !== undefined && String(realEmail).trim() && !isValidEmail(String(realEmail).trim())) {
        return NextResponse.json({ error: "이메일 형식이 올바르지 않습니다." }, { status: 400 });
      }
      invite = { id: inv.id, org_id: inv.org_id };
      // 정원 판정은 좌석 점유(claim_org_seat) 안에서 한다 — 여기서 미리 세면 두 명이 동시에
      // 가입할 때 둘 다 통과한다. 링크 발급 시점과 가입 시점의 정원이 다를 수 있어서도 그렇다.
      // 정원은 **스토어 출처일 때만** 존재한다 — 스토어를 떠난 계정에 남은 죽은 정원을 상한으로
      // 쓰면 웹 카드 감독자의 초대 가입이 막힌다(lib/billing.ts getStoreSeatCapacity와 같은 기준).
      inviteOwnerCapacity = isStoreSource((ownerSub as { source?: string | null }).source)
        ? (((ownerSub as { store_seat_capacity?: number | null }).store_seat_capacity ?? null) as number | null)
        : null;
      try {
        const { data: ownerUser } = await supabaseAdmin.auth.admin.getUserById(ownerId);
        const om = (ownerUser?.user?.user_metadata ?? {}) as Record<string, unknown>;
        inviteOwnerFormat = String(om.preferred_export_format ?? "") || null;
        inviteOwnerProfile = {
          ...(om.worker_type ? { worker_type: om.worker_type } : {}),
          ...(om.industry ? { industry: om.industry } : {}),
          ...(om.work_category ? { work_category: om.work_category } : {}),
        };
      } catch { inviteOwnerFormat = null; }
    }

    // 업종/공종: 데이터 분석용 프로필(선택 목록 외 임의 값 방지, 최대 40자 — KSIC 분류명 수용)
    const industryStr = typeof industry === "string" ? industry.trim().slice(0, 40) : "";
    const workCategoryStr = typeof workCategory === "string" ? workCategory.trim().slice(0, 40) : "";

    // 근로자 구분: 교육시간 산정용 — 화이트리스트 외 값·누락이면 기본값(현장 근로자)
    const WORKER_TYPES = ["현장 근로자 (비사무직)", "사무직 / 판매직"];
    const workerTypeStr = WORKER_TYPES.includes(workerType) ? workerType : "현장 근로자 (비사무직)";

    // 출력 형식: 화이트리스트 밖이면 저장하지 않는다 — 키가 없으면 읽는 쪽이 기본값(PDF)으로
    // 폴백하므로, 쓰레기 값을 심어 문서 생성 분기를 깨뜨리는 것보다 낫다.
    const exportFormatStr = EXPORT_FORMATS.some((f) => f.value === exportFormat) ? (exportFormat as string) : "";

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
    // 단독 가입 실이메일(보고서 수신용) — 형식 오류는 계정 생성 전에 막는다.
    // 초대 경로는 위 invite 블록에서 이미 같은 검증을 통과했다.
    if (!invite && realEmailStr && !isValidEmail(realEmailStr)) {
      return NextResponse.json({ error: "이메일 형식이 올바르지 않습니다." }, { status: 400 });
    }
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
        // 보고서 수신용 실이메일 — 인증 전이므로 real_email만 심는다(verified_at은 /verify-email에서).
        // 초대 경로는 자체 수집(sendRealEmailVerification)이 기록하므로 여기서 겹쳐 쓰지 않는다.
        ...(!invite && realEmailStr ? { real_email: realEmailStr } : {}),
        // 동의 캐시는 생성 시점에 함께 심는다 — 별도 updateUserById는 전체 치환이라
        // 방금 넣은 프로필을 통째로 날릴 위험이 있다.
        ...(consented ? consentMetaPatch() : {}),
        // 단독 가입은 위저드에서 고른 값 — 아래 초대 상속보다 먼저 둬야 감독자 값이 이긴다
        ...(exportFormatStr ? { preferred_export_format: exportFormatStr } : {}),
        // 초대 가입은 회사 공통 문서 형식을 상속 (첫 로그인 형식 선택 생략)
        ...(invite && inviteOwnerFormat ? { preferred_export_format: inviteOwnerFormat } : {}),
        // 근로자 구분·업종·공종도 회사 공통 — 가입자가 직접 입력한 값보다 감독자 값이 우선
        ...(invite ? inviteOwnerProfile : {}),
      },
    });

    if (userError) {
      // 이미 가입된 이메일 오류 처리
      if (userError.message.includes("already registered") || userError.status === 422) {
         return NextResponse.json({ error: "이미 존재하는 아이디입니다." }, { status: 400 });
      }
      return NextResponse.json({ error: userError.message }, { status: 400 });
    }

    // 동의 증빙 원장(consents). 계정은 이미 만들어졌으므로 여기서 throw가 새어나가면
    // 바깥 catch가 500을 던져 "가입 실패로 보이지만 계정은 존재하는" 상태가 된다.
    if (consented && user?.user) {
      let recorded = false;
      try {
        recorded = await recordConsent(supabaseAdmin, user.user.id, {
          source: "signup",
          ip: (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null,
          userAgent: request.headers.get("user-agent"),
        });
      } catch (e) {
        console.error("consent record error:", e);
      }
      if (!recorded) {
        // 원장이 비었는데 metadata 캐시만 남으면 게이트가 "동의 완료"로 보고 닫혀,
        // 증빙 0건인 계정이 재동의를 영영 요구받지 못한다 — 캐시를 걷어내 다음 로그인에
        // ConsentGate가 다시 받게 한다(가입 자체는 막지 않는다).
        try {
          const meta = { ...(user.user.user_metadata ?? {}) } as Record<string, unknown>;
          delete meta.terms_version;
          delete meta.privacy_version;
          delete meta.terms_agreed_at;
          await supabaseAdmin.auth.admin.updateUserById(user.user.id, { user_metadata: meta });
        } catch (e) {
          console.error("consent cache rollback error:", e);
        }
      }
    }

    // ── 조직 초대 가입: 좌석 점유 + 미러 구독 (개인 구독·무료체험 없음) ──
    if (invite && user?.user) {
      const { data: claim, error: claimErr } = await supabaseAdmin.rpc("claim_org_seat", {
        p_org: invite.org_id,
        p_member: user.user.id,
        p_capacity: inviteOwnerCapacity,
      });
      if (claimErr || claim !== "ok") {
        // 좌석 실패 → 방금 만든 계정 롤백 (다회용 링크라 초대 자체는 살려둔다)
        await supabaseAdmin.auth.admin.deleteUser(user.user.id);
        const msg =
          claim === "no_seat"
            ? "조직에 남은 좌석이 없습니다. 안전관리자에게 좌석 추가를 요청하세요."
            : claim === "over_capacity"
              ? "회사의 현장 계정 정원이 가득 찼습니다. 회사 감독자에게 문의하세요."
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

    // ── 무료체험 개시 (단독 가입 전용) ────────────────────────────────
    // 게이트가 꺼져 있어도(솔라피 미설정) 체험을 발급한다. 구독행이 없으면 가입 직후
    // /start-trial로 되돌려보내져 방금 끝낸 가입 화면을 한 번 더 통과하게 된다.
    let trialStarted = false;
    let emailVerificationSent = false;
    if (user?.user) {
      // 번호 1회 제한은 게이트가 켜져 있을 때만 — 꺼져 있으면 검증할 번호 자체가 없다.
      // 번호 소진(unique)이 최종 관문: 동시 가입 레이스에서도 한 번호는 한 번만 성공한다.
      if (verifiedOtpId && normalizedPhone) {
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
      }

      // 카드 없는 Pro 1개월 체험 — billing_key null이라 cron 과금 대상에서 자동 제외되고,
      // 만료 후에는 게이트(subscriptionAllows/isAllowed)가 결제 등록으로 유도한다.
      //
      // 탈퇴 후 재가입 체험 차단(2026-08-14): 이전 탈퇴 계정의 해시 표식과 대조 —
      // 일치하면 가입은 그대로 진행하되 구독 행을 만료 상태로 만든다(체험 없음).
      // trial_redemptions(번호 소진)는 게이트가 켜져 있을 때만 작동해, 게이트가 꺼진
      // 지금은 이 표식이 유일한 재수령 방벽이다.
      const trialDenied = await usedTrialBeforeWithdrawal(supabaseAdmin, {
        phoneHash: normalizedPhone ? markHash(normalizedPhone) : null,
        // 로그인 합성 이메일(`id@tbm.com`)이 핵심이다 — 탈퇴 표식의 auth 이메일과 이것이
        // 대조돼야 같은 아이디 재가입이 잡힌다(2026-08-16 QA: realEmail만 보던 종전 대조는
        // 표식과 교집합이 없어 완전 무동작이었다)
        emailHashes: [markHash(fullEmailId), ...(realEmailStr ? [markHash(realEmailStr)] : [])],
      });
      const now = new Date();
      const trialEnd = new Date(now);
      trialEnd.setMonth(trialEnd.getMonth() + 1);
      if (trialDenied) trialEnd.setTime(now.getTime());
      const pro = PLANS.monthly_pro;
      const { error: subErr } = await supabaseAdmin.from("subscriptions").upsert(
        {
          user_id: user.user.id,
          plan: pro.id,
          status: trialDenied ? "canceled" : "trialing",
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

      // 실이메일 인증 메일(주간·월간·분석 보고서 수신용) — 초대 경로와 동일 호출.
      // 번호 소진 롤백(위 409)보다 뒤에 두는 이유: 삭제될 계정에 인증 메일을 보내면 안 된다.
      // 발송 실패는 가입을 막지 않는다 — 여기서 throw가 새면 계정은 있는데 응답만 500이 된다.
      if (realEmailStr) {
        try {
          const proto = request.headers.get("x-forwarded-proto") || "https";
          const host = request.headers.get("host");
          const r = await sendRealEmailVerification(
            supabaseAdmin,
            user.user.id,
            realEmailStr,
            host ? `${proto}://${host}` : undefined,
          );
          emailVerificationSent = r.ok;
          if (!r.ok) console.error("signup 실이메일 인증 메일 발송 실패:", r.error);
        } catch (e) {
          console.error("signup 실이메일 인증 메일 발송 실패:", e);
        }
      }
    }

    return NextResponse.json({ success: true, trialStarted, emailVerificationSent });
  } catch (error: any) {
    console.error("Signup Error:", error);
    return NextResponse.json({ error: "회원가입 처리 중 서버 오류가 발생했습니다." }, { status: 500 });
  }
}
