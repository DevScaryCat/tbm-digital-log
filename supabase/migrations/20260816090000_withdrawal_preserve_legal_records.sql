-- 탈퇴가 법정 보존 데이터를 파기하지 못하게 (2026-08-16 QA CRITICAL 확정)
-- auth.users 삭제 시 payments(전자상거래법 5년)·subscriptions(청구 근거)·consents(동의 증빙)·
-- stt_usage(원가 집계)가 CASCADE로 통째 사라졌다. FK를 끊어 가명 데이터로 남긴다.
alter table payments drop constraint if exists payments_user_id_fkey;
alter table subscriptions drop constraint if exists subscriptions_user_id_fkey;
alter table consents drop constraint if exists consents_user_id_fkey;
alter table stt_usage drop constraint if exists stt_usage_user_id_fkey;
