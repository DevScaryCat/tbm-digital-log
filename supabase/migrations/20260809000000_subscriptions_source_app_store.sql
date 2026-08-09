-- 애플 인앱결제(App Store) 구독을 subscriptions.source 값으로 허용한다. (2026-08-09 적용 완료)
--
-- 컬럼은 구글과 공유한다:
--   store_purchase_token ← 애플 originalTransactionId (구독 identity.
--                          subscriptions_store_purchase_token_key 부분 유일 인덱스가 계정 간 재사용을 막는다)
--   store_product_id     ← 애플 productId
--
-- status 체크제약(trialing/active/past_due/canceled)은 건드리지 않는다 —
-- 회수는 'canceled' + current_period_end를 과거로 박아 표현하는 기존 규칙을 그대로 따른다.
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_source_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_source_check
  CHECK (source = ANY (ARRAY['portone'::text, 'google_play'::text, 'app_store'::text]));
