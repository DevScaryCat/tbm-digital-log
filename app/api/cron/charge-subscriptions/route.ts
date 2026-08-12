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
import { cancelOrgSeatMirrors } from "@/lib/org";
import { resolveOrgSeatAccounting } from "@/lib/orgSeats";
import { OWNER_SEAT_SUB_COLUMNS, restoreOrgSeats, type OwnerSeatSub } from "@/lib/seatRestore";
import { daysSinceLapse, orgLapseTiming, orgLapsedAt } from "@/lib/orgGrace";
import { buildNoticeMail, kstDay, notify, retryFailedEmails, type OrgNoticeKind } from "@/lib/orgNotices";
import { fetchAllRows } from "@/lib/fetchAllRows";

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
      /** 청구를 시도조차 하지 않은 회차(빌링키 전파 지연 등) — 실패 지표를 오염시키지 않는다 */
      chargeSkipped: 0,
      mirrorsDemoted: 0,
      googleSeatPaid: 0,
      googleSeatFailed: 0,
      grandfatherRestored: 0,
      /** 정원제인데 실계정이 정원을 넘은 행 수 — 0이 아니면 즉시 원인을 봐야 한다 */
      capacityOver: 0,
      /** 미러 복원 스윕이 실제로 되살린 좌석 수 */
      mirrorsRestored: 0,
      /** 본인 스토어 구독으로 사는 좌석 수 — 청구·정원에서 빠진 사람들. 0이 아니면 관측 대상 */
      selfPaidSeats: 0,
      /** 정원이 모자라 이번 회차에 복원을 보류한 좌석 수 — 0이 아니면 감독자 조치가 필요하다 */
      restoreDeferredOverCapacity: 0,
      /** 유예·좌석잠김 알림으로 새로 만든 인앱 알림 수 */
      lapseNoticesCreated: 0,
      lapseEmailsSent: 0,
      lapseEmailsFailed: 0,
      /** 실패한 메일을 이번 회차에 재시도해 성공시킨 수 */
      lapseEmailsRetried: 0,
      /** 조회 예외로 이번 회차를 건너뛴 건수 (다음 실행이 다시 시도) */
      errors: 0,
    };
    // 이번 회차에 카드 결제가 실패한 감독자 — 아래 조직 스윕에서 org를 이미 읽으므로
    // 여기서 조직을 다시 조회하지 않고 그때 알림을 만든다(라운드트립을 늘리지 않는다).
    const failedOwnerPayments = new Map<string, string>();
    for (const sub of (due || []) as SubscriptionRow[]) {
      results.processed++;
      try {
        const r = await chargeSubscription(admin, sub);
        // ⚠️ ok=false를 전부 '결제 실패'로 세면 안 된다. lib/billing.ts는 빌링키 전파 지연
        // (감독자가 방금 카드를 등록한 **정상 경로**)에서 status='skipped'를 돌려주는데,
        // 청구를 시도조차 하지 않은 그 회차에 "결제가 실패했어요 · 현장 계정이 잠깁니다" 메일이
        // 카드 등록 직후라는 가장 나쁜 타이밍에 도착했다(2026-08-13 검수).
        if (r.ok) results.paid++;
        else if (r.status === "failed") {
          results.failed++;
          failedOwnerPayments.set(sub.user_id, r.paymentId);
        } else {
          results.chargeSkipped++;
        }
      } catch (e) {
        // 좌석 회계 조회 실패 등은 **금액을 결정하기 전에** 던진다 — 부분 상태가 남지 않는다.
        // 실패 카운터(failed_attempts)를 올리지 않고 다음 실행에 맡긴다: DB가 한 번 흔들린 것이
        // 3회 실패 해지로 굳으면 안 된다.
        results.errors++;
        console.error("cron charge threw — skipping this run", { subId: sub.id, error: e });
      }
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
          try {
            const r = await chargeGoogleOwnerSeats(admin, sub);
            if (r.status === "paid") results.googleSeatPaid++;
            else if (r.status === "failed") results.googleSeatFailed++;
            // skipped(이미 결제·좌석 없음·키 검증 대기)는 집계하지 않는다 — 매일 대부분이 스킵이다
          } catch (e) {
            results.errors++;
            console.error("cron google-seat charge threw — skipping this run", { subId: sub.id, error: e });
          }
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

        for (const s of caps) {
          const orgId = orgByOwner.get(s.user_id as string);
          if (!orgId) continue;
          try {
            // 수작업 집계(3회 조회 + Set 조합)를 좌석 회계 한 번으로 접었다.
            // '쓰고 있는 계정' = 감독자 본인 + **미러가 살아 있는 청구 대상 좌석**(aliveSeats).
            // 자격 상한(1 + billableSeats)과 유일하게 다른 자리이며, 그 차이는 뷰의
            // mirror_alive 한 컬럼으로만 갈린다 — 규칙을 여기서 다시 적지 않는다.
            const acc = await resolveOrgSeatAccounting(admin, orgId);
            const used = 1 + acc.aliveSeats;
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
          } catch (e) {
            results.errors++;
            console.error("cron capacity report threw", { orgId, error: e });
          }
        }
      }
    }

    // ── 미러 복원 스윕 (자가 결제자의 **되돌아올 길**) ─────────────────────
    // 이 스윕이 없으면 "한 번 좌석에서 빠진 사람은 영영 못 돌아온다"가 된다.
    // 종전의 복원 경로는 전부 `.eq(plan,'org_seat')`로 접힌 행만 골라, 자가 결제 기간 동안
    // plan이 monthly_pro로 남은 계정과 구독 행이 아예 없는 계정을 후보에서 통째로 빼먹었다.
    // 여기서는 후보를 뷰(seat_state='seat' && mirror_alive=false)가 고른다 — 두 경우 다 잡힌다.
    //
    // 자가 결제자의 스토어 구독이 만료·해지·환불되면 RTDN(즉시) 또는 reconcile-store-subs
    // 크론(≤24h)이 status='canceled'를 박고, 그 순간 뷰가 self_store → seat 로 넘긴다.
    // 그 다음 이 스윕(≤24h)이 좌석을 되돌린다. 사용자가 할 일은 없다.
    {
      // 조직 목록은 **전량** 훑는다. 종전 .limit(500)은 정렬도 없어 '어떤 500개'가 뽑히는지
      // 정의되지 않았고, 그 밖의 조직은 좌석 복원도 D0/D3/D6 알림도 영원히 못 받았다
      // (조용히 잘려서 results 어디에도 드러나지 않았다). 접기는 전량인데 되살리기만 500이라
      // 비대칭이기도 했다. PostgREST 1000행 절단 대응은 이 저장소의 기존 패턴을 쓴다.
      const orgList = await fetchAllRows<{ id: string; name: string; owner_user_id: string }>((from, to) =>
        admin.from("organizations").select("id, name, owner_user_id").order("id", { ascending: true }).range(from, to)
      );
      // 소유주 구독을 한 번에 읽는다(조직마다 왕복을 붙이지 않는다).
      // canceled_at·failed_attempts는 유예 앵커와 '좌석 청구 소진' 판정에 쓴다 — 빠지면
      // orgLapsedAt이 카드 3회 실패 경로에서 엉뚱한 날짜를 앵커로 잡는다.
      // 컬럼 목록은 lib/seatRestore.ts가 정의한다(두 곳에 손으로 적지 않는다).
      const ownerIds = orgList.map((o) => o.owner_user_id);
      const ownerSubs = ownerIds.length
        ? await fetchAllRows<OwnerSeatSub>((from, to) =>
            admin.from("subscriptions").select(OWNER_SEAT_SUB_COLUMNS).in("user_id", ownerIds).order("user_id", { ascending: true }).range(from, to)
          )
        : [];
      const subByOwner = new Map<string, OwnerSeatSub>();
      for (const s of ownerSubs) if (s.user_id) subByOwner.set(s.user_id, s);

      // 알림 한 건. 실패해도 청구·복원 스윕을 멈추지 않는다(알림은 부수 효과다).
      const emit = async (
        org: { id: string; name: string; owner_user_id: string },
        kind: OrgNoticeKind,
        dedupeKey: string,
        opts: { lapsedAt?: string | null; memberCount?: number; graceEndsLabel?: string | null; withMail?: boolean } = {}
      ) => {
        try {
          const r = await notify({
            admin,
            orgId: org.id,
            ownerUserId: org.owner_user_id,
            kind,
            dedupeKey,
            lapsedAt: opts.lapsedAt ?? null,
            mail:
              opts.withMail === false
                ? null
                : buildNoticeMail(kind, {
                    orgName: org.name,
                    memberCount: opts.memberCount,
                    graceEndsLabel: opts.graceEndsLabel ?? null,
                  }),
          });
          if (r.created) results.lapseNoticesCreated++;
          // 중복(정상)과 실패를 구분한다 — 종전에는 둘 다 created=false라 기록조차 안 된
          // 알림이 조용히 묻혔다
          if (r.error) results.errors++;
          if (r.emailStatus === "sent") results.lapseEmailsSent++;
          if (r.emailStatus === "failed") results.lapseEmailsFailed++;
        } catch (e) {
          console.error("cron notice emit threw", { orgId: org.id, kind, error: e });
        }
      };

      // 조직마다 좌석 회계를 한 번만 읽고 아래 유예 알림 스윕이 재사용한다
      // (종전에는 같은 org를 두 루프가 각각 조회했다 — iad1↔서울 왕복이 두 배였다).
      const accByOrg = new Map<string, Awaited<ReturnType<typeof resolveOrgSeatAccounting>>>();

      for (const org of orgList) {
        const ownerSub = subByOwner.get(org.owner_user_id);

        // 카드 결제가 이번 회차에 실패한 감독자에게 즉시 1통. 주기 결제 ID를 키에 넣어
        // 같은 주기의 재시도가 매일 메일을 보내지 않게 한다.
        const failedPaymentId = failedOwnerPayments.get(org.owner_user_id);
        if (failedPaymentId) {
          await emit(org, "charge_failed", `chargefail:${org.owner_user_id}:${failedPaymentId}`);
        }

        try {
          // 복원 판정은 **lib/seatRestore.ts 한 곳**이 한다 — 좌석 카드 3회 소진과 정원 부족을
          // 여기서 다시 적지 않는다. GET /api/org/context의 자가복구가 같은 함수를 부르므로,
          // 크론이 건너뛴 좌석을 앱 실행 한 번이 되살리던 우회가 구조적으로 불가능해졌다.
          const r = await restoreOrgSeats(admin, { id: org.id, ownerUserId: org.owner_user_id }, ownerSub);
          if (r.accounting) {
            accByOrg.set(org.id, r.accounting);
            results.selfPaidSeats += r.accounting.selfPaidIds.length;
            for (const uid of r.accounting.selfPaidIds) {
              // STORE_CAPACITY_OVER와 같은 규율 — 수가 0이 아니면 즉시 관측된다
              console.warn("SELF_PAID_SEAT", { orgId: org.id, memberUserId: uid });
            }
          }
          results.mirrorsRestored += r.restored;

          if (r.blocked === "seat_charge_exhausted") {
            // 스토어 감독자의 **좌석 카드**가 3회 실패한 상태. 본인 스토어 구독은 멀쩡해
            // 다른 화면은 전부 침묵하므로, 이 알림이 감독자가 사실을 아는 유일한 통로다.
            console.error("SEAT_CHARGE_EXHAUSTED", { orgId: org.id, ownerUserId: org.owner_user_id });
            await emit(org, "seat_locked", `seatlock:${org.id}:${kstDay()}`);
          } else if (r.blocked === "over_capacity") {
            results.restoreDeferredOverCapacity += r.deferred;
            console.error("SEAT_RESTORE_DEFERRED_OVER_CAPACITY", {
              orgId: org.id,
              ownerUserId: org.owner_user_id,
              capacity: r.capacity,
              pending: r.deferred,
            });
            // 종전엔 console.error뿐이라 감독자도 멤버도 몰랐다. 멤버 쪽에는 seatLocked
            // 진단 화면이, 감독자 쪽에는 이 알림이 짝으로 간다.
            await emit(org, "seat_locked", `seatlock:${org.id}:${kstDay()}`, { memberCount: r.deferred });
          } else if (r.blocked === "owner_lapsed") {
            // ⚠️ 무과금 구간 봉합(2026-08-13 검수). 종전 강등 스윕은 status='canceled'인
            // 감독자만 훑어서, subscriptionAllows의 STALE 백스톱(status는 active인데 만료가
            // 14일 넘게 과거)에 걸린 조직은 **영영** 걸리지 않았다 — fail-open이었다.
            // 되살리기와 접기가 이제 같은 판정(subscriptionAllows) 하나를 공유한다.
            const acc = r.accounting ?? (await resolveOrgSeatAccounting(admin, org.id));
            accByOrg.set(org.id, acc);
            const alive = acc.rows.filter((x) => x.seatState === "seat" && x.mirrorAlive).map((x) => x.userId);
            if (alive.length > 0) {
              await cancelOrgSeatMirrors(alive, admin);
              results.mirrorsDemoted += alive.length;
              console.warn("ORG_LAPSE_SEATS_FOLDED", { orgId: org.id, seats: alive.length });
            }
          }
        } catch (e) {
          results.errors++;
          console.error("cron mirror restore sweep threw", { orgId: org.id, error: e });
        }
      }

      // ── 유예 알림 스윕 (D0 · D3 · D6) ──────────────────────────────────
      // 새 크론을 만들지 않는다 — vercel.json을 건드리지 않고, 위에서 이미 읽어둔
      // orgList / subByOwner를 그대로 재사용한다.
      //
      // 유예는 무료 사용 기간이 아니라 감독자가 결제를 되살릴 **결정 기간**이다. 그 사이
      // 현장 계정에게는 개인 결제를 들이밀지 않으므로, 감독자가 사실을 아는 것이 유일한 출구다.
      for (const org of orgList) {
        const ownerSub = subByOwner.get(org.owner_user_id);
        const lapsedAt = orgLapsedAt(ownerSub);
        if (!lapsedAt) continue;
        try {
          // 알릴 대상 = **실제로 잠기는 현장**뿐이다. 종전엔 acc.rows.length(활성 멤버 전체)로
          // 세서, 멤버가 전원 self_store(본인 결제)·grandfather(영구무료)인 조직에도
          // "현장 계정 N곳의 새 기록 작성과 AI 분석이 잠겼어요"가 나갔다 — 그 사람들은 잠기지 않는다.
          const acc = accByOrg.get(org.id) ?? (await resolveOrgSeatAccounting(admin, org.id));
          if (acc.seatIds.length === 0) continue;

          const days = daysSinceLapse(lapsedAt);
          const timing = orgLapseTiming(lapsedAt);
          const graceEndsLabel = timing.graceEndsAt
            ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" })
                .format(new Date(timing.graceEndsAt))
            : null;

          // 크론이 하루 이상 멈췄다 재개하면 임계 셋이 한 번에 도달한다. 단계는 전부 만들되
          // (기록은 남아야 한다) **이메일은 가장 늦은 단계 하나만** 보낸다 — 같은 사건으로
          // 세 통이 동시에 날아가면 그 자체가 사고로 읽힌다.
          const ALL_STAGES: { kind: OrgNoticeKind; at: number }[] = [
            { kind: "lapse_d0", at: 0 },
            { kind: "lapse_d3", at: 3 },
            { kind: "lapse_d6", at: 6 },
          ];
          const stages = ALL_STAGES.filter((s) => days >= s.at);
          const latest = stages.length > 0 ? stages[stages.length - 1]!.kind : null;

          for (const stage of stages) {
            await emit(org, stage.kind, `lapse:${org.id}:${lapsedAt}:${stage.kind.slice(-2)}`, {
              lapsedAt,
              memberCount: acc.seatIds.length,
              graceEndsLabel,
              withMail: stage.kind === latest,
            });
          }
        } catch (e) {
          results.errors++;
          console.error("cron lapse notice sweep threw", { orgId: org.id, error: e });
        }
      }

      // 발송 실패한 메일 재시도(같은 행·같은 dedupe_key → 중복 발송 구조적 불가).
      // 본문은 저장하지 않으므로 kind + 회사명으로 다시 만든다.
      try {
        const orgById = new Map(orgList.map((o) => [o.id, o]));
        const r = await retryFailedEmails(admin, (row) => {
          const org = orgById.get(row.org_id);
          if (!org) return null;
          return buildNoticeMail(row.kind, { orgName: org.name });
        });
        results.lapseEmailsRetried += r.sent;
        results.lapseEmailsFailed += r.failed;
      } catch (e) {
        console.error("cron notice email retry threw", e);
      }
    }

    // ── 강등 reconciliation 스윕은 위 조직 루프로 흡수됐다 (2026-08-13) ────────
    // 종전에는 여기서 status='canceled'인 감독자만 훑었다. 그 판정은 subscriptionAllows보다
    // 좁아서, STALE 백스톱(status는 active인데 만료가 14일 넘게 과거)에 걸린 조직은 접기
    // 그물에 **영영** 걸리지 않았다 — 되살리기는 subscriptionAllows로 막으면서 접기는
    // status로만 하던 비대칭이 곧 fail-open이었다.
    // 이제 같은 루프에서 restoreOrgSeats(…).blocked === 'owner_lapsed'가 접기까지 담당한다.
    // 접는 단위도 org_members active 전체가 아니라 좌석 회계(seat 상태 + 미러 살아 있음)라,
    // 자가 결제자·영구무료의 행을 건드릴 여지가 없다.

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
