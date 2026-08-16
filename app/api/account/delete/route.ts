// app/api/account/delete/route.ts — 회원탈퇴 (2026-08-14 Chris 승인 설계)
//
// 원칙:
// · 개인 데이터(문서·서명·사진·수신처·사용량)는 파기한다 — 개인정보보호법.
// · 결제·구독 기록은 남긴다 — 전자상거래법 5년 보존 의무. auth 사용자가 지워지면
//   user_id는 더 이상 사람과 연결되지 않는 가명 식별자다. 단 구독 행은 청구가 다시
//   돌지 않게 무력화한다(billing_key 소거·canceled).
// · 무료체험 재수령 방지 표식(전화·카카오·이메일 해시)을 1년 보관 — lib/withdrawal.ts.
// · 감독자(활성 현장 계정 보유)는 먼저 계정을 모두 내보내야 한다 — 솔로 전환과 동일 규칙.
// · 소속 현장 계정은 감독자가 관리한다(발급 계정의 임의 탈퇴는 회사 기록 파괴).
// · Google Play 구독은 우리가 해지할 수 없다 — 클라이언트가 확인 단계에서 안내한다.
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { extractMarks, recordWithdrawalMarks } from "@/lib/withdrawal";
import { isStoreSource } from "@/lib/billing";

export const runtime = "nodejs";
export const maxDuration = 60;

// public URL → storage 경로. 실패하면 null(그 파일은 남는다 — 베스트에포트).
function storagePath(url: string | null | undefined, bucket: string): string | null {
  if (!url) return null;
  const m = String(url).match(new RegExp(`/storage/v1/object/(?:public/)?${bucket}/(.+?)(?:\\?|$)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const admin = getAdminClient();
    const userId = user.id;

    const ctx = await getOrgContext(userId, admin);
    if (ctx.kind === "owner" && (ctx.memberIds?.length ?? 0) > 0) {
      return NextResponse.json(
        { error: "연결된 현장 계정이 있어 탈퇴할 수 없어요. 현장 계정 관리에서 모두 해제한 뒤 다시 시도해주세요." },
        { status: 409 },
      );
    }
    if (ctx.kind === "member") {
      return NextResponse.json(
        { error: "회사에서 발급한 계정입니다. 삭제는 회사 안전관리자(감독자)에게 요청해주세요." },
        { status: 403 },
      );
    }

    // identities는 세션 사용자에 없을 수 있다 — admin 조회로 확보(카카오 해시 재료)
    const { data: full } = await admin.auth.admin.getUserById(userId);
    const marks = extractMarks((full?.user ?? user) as Parameters<typeof extractMarks>[0]);

    const { data: sub } = await admin
      .from("subscriptions")
      .select("trial_used, source, status, billing_key")
      .eq("user_id", userId)
      .maybeSingle();

    // ── 자동갱신이 살아 있으면 구독 해지가 먼저다(2026-08-16 Chris) ──
    // 탈퇴했는데 결제만 계속되는 최악을 서버에서도 막는다(클라이언트 게이트의 이중화).
    // 카드 없는 체험(자동청구 없음)·해지된 구독은 바로 탈퇴할 수 있다.
    const liveSub = !!sub && ["active", "trialing", "past_due"].includes(sub.status);
    if (liveSub && isStoreSource(sub!.source)) {
      return NextResponse.json(
        { error: "스토어 정기 결제가 살아 있어요. Google Play(또는 App Store)에서 구독을 먼저 해지한 뒤 탈퇴해주세요 — 탈퇴해도 스토어 결제는 자동으로 끊기지 않습니다." },
        { status: 409 },
      );
    }
    if (liveSub && sub!.billing_key) {
      return NextResponse.json(
        { error: "구독이 진행 중이에요. 구독 및 결제에서 먼저 해지한 뒤 탈퇴해주세요." },
        { status: 409 },
      );
    }
    // 구독 행이 있었다면 체험은 쓴 것으로 본다(가입 시 체험 발급이 기본 경로) —
    // trial_used 플래그가 낡은 계정도 재수령은 막는 쪽이 안전하다.
    await recordWithdrawalMarks(admin, marks, !!sub);

    // ── 스토리지 파기 재료 수집 (행을 지우기 전에) ──
    const paths: { bucket: string; path: string }[] = [];
    const add = (url: string | null | undefined, bucket: string) => {
      const p = storagePath(url, bucket);
      if (p) paths.push({ bucket, path: p });
    };
    const { data: minutes } = await admin
      .from("tbm_minutes").select("id, leader_signature, photo_url").eq("user_id", userId);
    const minuteIds = (minutes ?? []).map((m) => m.id);
    for (const m of minutes ?? []) { add(m.leader_signature, "signatures"); add(m.photo_url, "photos"); }
    if (minuteIds.length) {
      const { data: parts } = await admin
        .from("tbm_minutes_participants").select("signature").in("minutes_id", minuteIds);
      for (const p of parts ?? []) add(p.signature, "signatures");
    }
    const { data: logs } = await admin
      .from("tbm_logs").select("id, instructor_signature, confirmation_signature, photo_url").eq("user_id", userId);
    const logIds = (logs ?? []).map((l) => l.id);
    for (const l of logs ?? []) {
      add(l.instructor_signature, "signatures"); add(l.confirmation_signature, "signatures"); add(l.photo_url, "photos");
    }
    if (logIds.length) {
      const { data: parts } = await admin
        .from("tbm_participants").select("signature").in("log_id", logIds);
      for (const p of parts ?? []) add(p.signature, "signatures");
    }

    // ── 개인 데이터 파기 — 자식(참석자) 먼저, 실패해도 계속(가능한 만큼 지운다) ──
    if (minuteIds.length) await admin.from("tbm_minutes_participants").delete().in("minutes_id", minuteIds);
    if (logIds.length) await admin.from("tbm_participants").delete().in("log_id", logIds);
    const wipe: [string, string][] = [
      ["tbm_minutes", "user_id"],
      ["tbm_logs", "user_id"],
      ["tbm_risk_assessments", "user_id"],
      ["tbm_pending_signatures", "user_id"],
      ["worker_suggestions", "user_id"],
      ["analysis_insights", "user_id"],
      ["monthly_reports", "user_id"],
      ["report_recipient_consents", "account_user_id"],
      ["ai_cache", "user_id"],
      ["email_verifications", "user_id"],
      ["password_reset_tokens", "user_id"],
    ];
    let wipeFailed = false;
    for (const [table, col] of wipe) {
      const { error } = await admin.from(table).delete().eq(col, userId);
      if (error) {
        wipeFailed = true;
        console.error(`withdrawal wipe ${table} error:`, error);
      }
    }
    // 파기 실패가 하나라도 있으면 비가역 단계(스토리지 삭제·deleteUser) 전에 멈춘다 —
    // 계속 가면 tbm_logs FK(NO ACTION) 잔존 행에 deleteUser가 실패해 "데이터는 지워졌는데
    // 계정은 남은" 반쪽 상태가 되고, 앱은 '탈퇴할 수 없어요'라는 반쪽 거짓말을 하게 된다
    // (2026-08-16 QA 확정). 표식은 이미 남았지만 재시도 append는 무해하다.
    if (wipeFailed) {
      return NextResponse.json(
        { error: "일부 기록 삭제에 실패했어요. 잠시 후 다시 시도해주세요 — 이미 삭제된 기록은 복구되지 않습니다." },
        { status: 500 },
      );
    }
    // 사용량(stt/ai_usage)·payments·consents(동의 증빙)·trial_redemptions(번호 소진)는 남긴다 —
    // 비용 정산·법정 보존·어뷰즈 방지 근거이고, auth 삭제 후엔 가명 데이터다.

    // 스토리지 파기 — 100개 단위(베스트에포트)
    const byBucket = new Map<string, string[]>();
    for (const { bucket, path } of paths) byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), path]);
    for (const [bucket, list] of byBucket) {
      for (let i = 0; i < list.length; i += 100) {
        const { error } = await admin.storage.from(bucket).remove(list.slice(i, i + 100));
        if (error) console.error(`withdrawal storage ${bucket} error:`, error);
      }
    }

    // 구독 무력화(행은 보존) — 크론이 다시 청구하지 않게. 스토어 토큰은 남긴다:
    // RTDN이 죽은 행을 갱신하는 건 무해하고, 지우면 환불 이벤트를 못 받는다.
    if (sub) {
      await admin.from("subscriptions").update({
        status: "canceled",
        billing_key: null,
        card_info: null,
        canceled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
    }

    // 마지막: auth 사용자 삭제 — 이 순간부터 로그인 불가, 남은 행은 가명 데이터
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) {
      console.error("withdrawal deleteUser error:", delErr);
      return NextResponse.json(
        { error: "계정 삭제에 실패했습니다. 잠시 후 다시 시도해주세요." },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("withdrawal error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
