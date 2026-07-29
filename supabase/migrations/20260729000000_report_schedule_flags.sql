-- 보고서 발송 주기: 월간·주간을 동시에 켤 수 있게 (기존 report_frequency 단일 선택 대체)
-- report_send_monthly: 매월 1일 지난달 종합 (기본 on — 기존 동작 유지)
-- report_send_weekly:  매주 report_weekday 요일에 지난 7일 종합 (기본 off)
-- report_weekday 컬럼은 20260628010000에서 이미 추가됨 (0=일 .. 6=토, 기본 1=월)
alter table public.subscriptions
  add column if not exists report_send_monthly boolean not null default true,
  add column if not exists report_send_weekly  boolean not null default false;

-- 기존 report_frequency='weekly' 사용자를 새 플래그로 이관 (있었다면)
update public.subscriptions
  set report_send_weekly = true, report_send_monthly = false
  where report_frequency = 'weekly';
