-- seats-01 폐기 (설계 변경 2026-08-10) — 가산적 마이그레이션
--
-- 왜 없애나:
--   Play에서 **오퍼는 base plan에 소속**된다. 무료체험('free-trial') 오퍼는 legacy 'monthly'
--   base plan에 매달려 있다. seats-01을 만들어 진입 요금제로 쓰면 앱의 entryOffersOf가
--   seats-01 소속 오퍼만 남겨 trialOffer가 undefined가 되고, **신규 가입자가 첫 달 무료 없이
--   즉시 4,900원을 결제**한다 — 가드도 로그도 없는 조용한 오결제다.
--
-- 결정: 좌석 1개(감독자 혼자)는 기존 'monthly' base plan 그대로 쓴다(4,900원 + 무료체험).
--   스테퍼는 monthly(정원 1) → seats-02(2) → … → seats-30(30)으로 오르내린다.
--   창업자가 Play Console에 만들 요금제는 **seats-02 ~ seats-30 의 29개**다. seats-01은 만들지 않는다.
--
-- 먼저 비활성으로 내린 뒤(모든 조회가 active=true를 요구한다) 참조가 없을 때만 행을 지운다.
-- 혹시라도 이 base plan으로 결제된 구독이 있으면 행을 남겨 매핑 이력을 보존한다.
update public.store_products
   set active = false
 where platform = 'google_play' and base_plan_id = 'seats-01';

delete from public.store_products
 where platform = 'google_play'
   and base_plan_id = 'seats-01'
   and not exists (
     select 1 from public.subscriptions where store_base_plan_id = 'seats-01'
   );

-- ── monthly.seat_capacity 는 **NULL로 둔다**(설계 변경에도 불구하고) ─────────────────
--
-- 'monthly'가 의미상 정원 1의 진입 요금제가 된 것은 맞다. 그러나 이 표의 값을 1로 바꾸면
-- 그 값이 다음 verify/RTDN에서 subscriptions.store_seat_capacity=1로 확정되면서, 코드가
-- 아래 세 가지를 **자동으로** 한다 (app/api/billing/google/verify · rtdn · cron/charge-subscriptions):
--
--   ① lib/storePlans.ts reconcileCapacitySeats(capacity=1) → allowed=0 → 그 감독자의
--      활성 현장 미러가 **전부 접힌다**. 기존 카드 좌석 이용자의 현장이 조용히 잠긴다.
--   ② lib/billing.ts resolveBillableAmount의 정원 분기가 청구액을 0으로 못박고,
--      크론(chargeGoogleOwnerSeats)의 `.is('store_seat_capacity', null)` 필터에서도 빠진다
--      → 카드로 받던 좌석 몫(N×3,900)이 **무과금**이 된다.
--   ③ resolveSeatCharge의 정원 검사가 used(=1+활성좌석+요청분) > 1 로 걸려, 지금 Play Console에
--      seats-NN이 **하나도 없는 상태**에서 안드로이드 구독자 전원이 현장 계정을 한 개도
--      만들 수 없게 된다(스테퍼는 요금제가 없으면 숨는다 = 갈 곳도 없다).
--
-- 즉 값을 1로 바꾸는 순간, 요금제를 만들기도 전에 기존/신규 스토어 구독자의 좌석 경로가 끊긴다.
-- NULL로 두면 지금 동작(본인 몫 스토어 + 좌석 몫 카드)이 100% 보존되고, 감독자가 스테퍼로
-- seats-NN을 실제로 구매한 순간에만 정원제로 전환된다. 앱은 'capacity null = 정원 1'로 읽고,
-- 정원 1로 되돌아가는 '-' 대상 base plan은 앱이 아는 진입 요금제 id('monthly') 그대로다.
--
-- **1로 올릴 수 있는 날의 조건**(그때 별도 마이그레이션으로):
--   (a) Play Console에 seats-02~30이 활성으로 존재하고,
--   (b) 카드로 좌석을 쓰던 스토어 감독자가 없거나(또는 그들을 먼저 정원제로 이전했고),
--   (c) reconcileCapacitySeats가 접을 좌석이 없음을 확인한 뒤.

comment on column public.store_products.seat_capacity is
  '이 요금제가 파는 총 계정 수(감독자 본인 포함). organizations.seat_count 및 resolveBillableAmount의 accountCount와 같은 단위. NULL이면 정원제가 아니다 — legacy ''monthly''(진입 요금제, 의미상 정원 1)는 의도적으로 NULL이다: 1로 채우면 기존 카드 좌석 경로가 끊긴다(20260810120000 마이그레이션 주석 참조).';
