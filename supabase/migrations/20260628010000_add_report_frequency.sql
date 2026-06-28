-- 자동 보고서: 주간/월간 발송 주기 선택 지원
-- report_frequency: 'monthly'(매달 report_send_day) | 'weekly'(매주 report_weekday)
-- report_weekday: 0=일 .. 6=토 (기본 1=월요일)
-- report_last_sent_on: 같은 날 중복 발송 방지 가드(KST 날짜)
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS report_frequency text NOT NULL DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS report_weekday int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS report_last_sent_on date;
