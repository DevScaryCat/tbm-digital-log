import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";
import {
  chargeSubscription,
  chargeGoogleOwnerSeats,
  MAX_FAILED_ATTEMPTS,
  STORE_SOURCES,
  SubscriptionRow,
} from "@/lib/billing";
import { restoreGrandfatherIfEligible } from "@/lib/grandfather";

export const runtime = "nodejs";
// 청구 건이 몰리는 날 기본 타임아웃에 걸려 뒤쪽 구독이 누락되지 않도록 명시(월간 보고서 cron과 동일).
export const maxDuration = 300;

// Vercel Cron(매일): 결제일이 도래한 구독을 빌링키로 자동 과금
export async function POST(request: Request) {
  return run(request);
}
// Vercel Cron은 GET으로 호출됨
export async function GET(request: Request) {
  return run(request);
}

async function run(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") || "";
  const provided = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const admin = getAdminClient();
    const nowIso = new Date().toISOString();

    // 청구 대상: 체험/활성 상태 + 결제일 도래
    const { data: due, error } = await admin
      .from("subscriptions")
      .select("id, user_id, plan, pending_plan, billing_key, billing_key_verified, amount, status, current_period_end, failed_attempts")
      .in("status", ["trialing", "active", "past_due"])
      .lte("current_period_end", nowIso)
      .not("billing_key", "is", null)
      // 인앱결제 구독(google_play·app_store)의 **본인 몫**은 스토어가 청구·갱신한다 —
      // 우리 크론까지 긁으면 같은 달에 이중청구가 된다. 스토어 소유주의 **좌석 몫**(등록 카드 청구)은
      // 아래 별도 분기(chargeGoogleOwnerSeats)가 담당한다.
      // (source='portone'만 통과시키므로 애플 구독이 섞여도 여기서 자동으로 배제된다)
      .eq("source", "portone")
      .order("current_period_end", { ascending: true })
      .limit(200);

    if (error) {
      console.error("cron query error:", error);
      return NextResponse.json({ error: "조회 실패" }, { status: 500 });
    }

    const results = {
      processed: 0,
      paid: 0,
      failed: 0,
      mirrorsDemoted: 0,
      googleSeatPaid: 0,
      googleSeatFailed: 0,
      grandfatherRestored: 0,
      /** 정원제인데 실계정이 정원을 넘은 행 수 — 0이 아니면 즉시 원인을 봐야 한다 */
      capacityOver: 0,
    };
    for (const sub of (due || []) as SubscriptionRow[]) {
      results.processed++;
      const r = await chargeSubscription(admin, sub);
      if (r.ok) results.paid++;
      else results.failed++;
    }

    // ── 인앱 구독(구글·애플) 소유주의 좌석 몫 청구 ─────────────────────
    // 본인 몫(4,900)은 스토어가 받고, 등록 카드(PortOne 빌링키)로는 활성 좌석 × 3,900만 받는다.
    // 위 portone 쿼리(.eq source portone)가 이들을 건너뛰므로, 여기가 없으면 좌석이 무과금 누수.
    // 애플도 구조가 같다(스토어가 본인 몫, 우리 카드가 좌석 몫) → app_store를 함께 긁는다.
    // 결제일 도래(lte current_period_end) 조건을 쓸 수 없다 — 그 필드는 스토어가 갱신 때마다
    // 미래로 밀어주는 값이라, 대신 매일 전체를 훑고 주기 키(gseat_…) 멱등으로 1회/주기를 보장한다.
    {
      const { data: googleDue, error: gErr } = await admin
        .from("subscriptions")
        .select("id, user_id, plan, pending_plan, billing_key, billing_key_verified, amount, status, current_period_end, failed_attempts, source, store_seat_capacity")
        .in("source", STORE_SOURCES as unknown as string[])
        .not("billing_key", "is", null)
        // 스토어 정원제(seats-NN) 구독은 좌석 값까지 스토어가 받는다 — 카드로 또 긁으면 이중청구.
        // 기존 google_play 구독자는 이 값이 NULL로 남아 종전대로 여기서 좌석 몫이 청구된다.
        .is("store_seat_capacity", null)
        // trialing 제외: 체험 중 좌석 무료(포트원 관례와 동일) — 체험 종료로 스토어가 첫 정규 주기를
        // 열면(만료일 전진→새 주기 키) 그때 온전히 청구된다. canceled 제외: 끊긴 구독에 청구 금지.
        // past_due(구글 grace) 제외(검수 발견): grace 중 구글은 만료일을 grace 종료일로 연장해
        // 주는데(RTDN이 그대로 미러), 그 날짜 키로 좌석 전액을 청구한 뒤 결제가 회복되면
        // 만료일이 또 전진해 새 키로 전액이 **다시** 청구된다 — grace 회복마다 좌석 이중청구.
        // grace 창의 좌석 몫은 포기하고(≤수일), 회복 후 새 주기부터 청구하는 쪽이 안전하다.
        .eq("status", "active")
        // 만료가 지난 주기 정보로는 청구하지 않는다(RTDN 누락 등 갱신 미반영 방어)
        .gt("current_period_end", nowIso)
        // 3회 실패 후에는 중단 — 복구 스위치는 카드 재등록(/api/billing/card)의 카운터 리셋
        .lt("failed_attempts", MAX_FAILED_ATTEMPTS)
        .order("current_period_end", { ascending: true })
        .limit(200);
      if (gErr) {
        console.error("cron google-seat query error:", gErr);
      } else {
        for (const sub of (googleDue || []) as SubscriptionRow[]) {
          // 좌석 청구 실패가 소유주의 구글 구독 상태를 건드리지 않는 것은
          // chargeGoogleOwnerSeats가 보장한다(강등은 좌석 미러에만).
          const r = await chargeGoogleOwnerSeats(admin, sub);
          if (r.status === "paid") results.googleSeatPaid++;
          else if (r.status === "failed") results.googleSeatFailed++;
          // skipped(이미 결제·좌석 없음·키 검증 대기)는 집계하지 않는다 — 매일 대부분이 스킵이다
        }
      }
    }

    // ── 스토어 정원제 sanity 리포트 (관측 전용 — 아무것도 바꾸지 않는다) ──────
    // store_seat_capacity를 쓰는 순간 그 감독자의 카드 좌석 청구가 멈춘다(위 쿼리에서 제외).
    // 조건이 잘못 걸리면 정원제가 아닌 구독자까지 빠져 무과금 누수가 조용히 자란다.
    // '정원보다 실계정이 많은' 행을 매일 뽑아 즉시 관측되게 한다.
    //
    // ⚠️ '쓰고 있는 계정'은 org_members active가 아니라 **미러 구독이 살아 있는** 멤버다.
    // reconcileCapacitySeats는 정원 초과분의 미러(plan='org_seat')만 접고 org_members는 active로
    // 남긴다(정원을 다시 올리면 자동 복원하려는 의도된 설계). active 수로 세면 감액을 한 감독자가
    // 연결 해제를 할 때까지 매일 경보를 울려, 상시 켜진 경보가 진짜 누수를 가린다(2026-08-10 검수).
    // 질의도 행마다 2회에서 전체 3회로 접는다(고객 수에 선형으로 늘던 자리).
    {
      const { data: capRows } = await admin
        .from("subscriptions")
        .select("id, user_id, store_seat_capacity, store_base_plan_id")
        .not("store_seat_capacity", "is", null)
        .limit(500);
      const caps = ((capRows as any[]) || []);
      if (caps.length > 0) {
        const ownerIds = caps.map((s) => s.user_id as string);
        const { data: orgs } = await admin
          .from("organizations")
          .select("id, owner_user_id")
          .in("owner_user_id", ownerIds);
        const orgByOwner = new Map<string, string>();
        for (const o of ((orgs as any[]) || [])) orgByOwner.set(o.owner_user_id as string, o.id as string);

        const orgIds = [...orgByOwner.values()];
        const { data: mems } = orgIds.length
          ? await admin
              .from("org_members")
              .select("org_id, member_user_id")
              .in("org_id", orgIds)
              .eq("status", "active")
          : { data: [] as any[] };
        const memberRows = ((mems as any[]) || []);

        const alive = new Set<string>();
        if (memberRows.length > 0) {
          const { data: mirrors } = await admin
            .from("subscriptions")
            .select("user_id")
            .in("user_id", memberRows.map((m) => m.member_user_id as string))
            .eq("plan", "org_seat")
            .eq("status", "active");
          for (const m of ((mirrors as any[]) || [])) alive.add(m.user_id as string);
        }

        const usedByOrg = new Map<string, number>();
        for (const m of memberRows) {
          if (!alive.has(m.member_user_id as string)) continue; // 접힌 멤버 = 이미 이용 중단
          const k = m.org_id as string;
          usedByOrg.set(k, (usedByOrg.get(k) ?? 0) + 1);
        }

        for (const s of caps) {
          const orgId = orgByOwner.get(s.user_id as string);
          if (!orgId) continue;
          const used = 1 + (usedByOrg.get(orgId) ?? 0); // 감독자 본인 + 살아 있는 좌석
          if (used > Number(s.store_seat_capacity)) {
            results.capacityOver++;
            console.error("STORE_CAPACITY_OVER", {
              subId: s.id,
              userId: s.user_id,
              basePlanId: s.store_base_plan_id,
              capacity: s.store_seat_capacity,
              used,
            });
          }
        }
      }
    }

    // ── 강등 reconciliation 스윕 (§2, 검증 F6) ─────────────────────────
    // 상위(org) 구독이 어떤 경로로 canceled 되었든(3회 실패·수동 해지·재구독 실패),
    // 하위 미러(org_seat)가 유효 상태로 남아 있으면 영구 무료 Pro가 된다 → 매일 멱등 정리.
    {
      // plan 문자열이 아니라 '실제로 회사를 소유한 계정'에서 출발한다.
      // 단일 요금제 이후 감독자의 plan은 monthly_pro라, plan='org' 필터는 영구 no-op이 되어
      // 결제가 끊긴 감독자의 소속 현장이 무료로 계속 살아있는 구멍이 됐다.
      const { data: orgOwners } = await admin.from("organizations").select("owner_user_id");
      const ownerIds = ((orgOwners as any[]) || []).map((o) => o.owner_user_id as string);
      const { data: canceledOrgs } = ownerIds.length
        ? await admin
            .from("subscriptions")
            .select("user_id, current_period_end")
            .in("user_id", ownerIds)
            .eq("status", "canceled")
        : { data: [] as any[] };
      for (const o of (canceledOrgs as any[]) || []) {
        // 해지 후 잔여 이용기간이 남아 있으면(무환불 해지) 그 기간까지는 하위도 유지
        if (o.current_period_end && new Date(o.current_period_end) > new Date()) continue;
        const { data: org } = await admin
          .from("organizations")
          .select("id")
          .eq("owner_user_id", o.user_id)
          .maybeSingle();
        if (!org) continue;
        const { data: members } = await admin
          .from("org_members")
          .select("member_user_id")
          .eq("org_id", org.id)
          .eq("status", "active");
        const ids = ((members as any[]) || []).map((m) => m.member_user_id as string);
        if (ids.length === 0) continue;
        const { data: demoted } = await admin
          .from("subscriptions")
          .update({ status: "canceled", current_period_end: nowIso, updated_at: nowIso })
          .in("user_id", ids)
          .eq("plan", "org_seat")
          .neq("status", "canceled")
          .select("user_id");
        results.mirrorsDemoted += (demoted ?? []).length;
      }
    }

    // ── grandfather(영구 무료) 복원 스윕 ────────────────────────────────
    // 결제 전 grandfather였던 계정이 카드 구독을 해지하면, 잔여 유료 기간 동안은 그대로 두고
    // (해지 예약 시점에 되돌리면 이미 낸 기간을 뺏는다) **기간이 지난 뒤** 여기서 되돌린다.
    // 3회 결제 실패 해지(chargeSubscription)도 canceled + 지난 기간으로 남으므로 같은 그물에 걸린다.
    // 스토어(구글·애플) 구독은 이 스윕 대상이 아니다 — 회수 확정은 알림·reconcile 크론이 판정한다.
    {
      const { data: expired } = await admin
        .from("subscriptions")
        .select("user_id")
        .eq("status", "canceled")
        .eq("source", "portone")
        .not("plan", "in", "(grandfather,org_seat)")
        // 기간이 없는 행도 포함 — lte만 쓰면 NULL이 조용히 빠져(해지 시점 인라인 복원이 실패한
        // 계정이 여기) 어떤 그물에도 걸리지 않는다
        .or(`current_period_end.is.null,current_period_end.lte.${nowIso}`)
        .limit(100);
      for (const row of ((expired as any[]) || [])) {
        // 대상이 아니면(prev_plan 없음) 조회 한 번으로 끝난다 — 대부분의 행이 여기서 즉시 빠진다
        if (await restoreGrandfatherIfEligible(admin, row.user_id as string)) {
          results.grandfatherRestored++;
        }
      }
    }

    return NextResponse.json({ success: true, ...results });
  } catch (e: any) {
    console.error("cron route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
