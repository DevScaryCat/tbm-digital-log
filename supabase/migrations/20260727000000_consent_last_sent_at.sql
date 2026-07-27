-- 수신자 확인 메일 재발송 쿨다운용 타임스탬프.
-- 재발송 라우트가 이 값으로 60초 쿨다운을 건다 (임의 주소 폭탄은 별도로 '등록된 미승인 수신처'로 제한됨).
-- nullable — 기존 행은 null이라 첫 재발송은 통과하고 그 뒤부터 쿨다운이 걸린다.
alter table public.report_recipient_consents
  add column if not exists last_sent_at timestamptz;
