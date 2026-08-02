-- 회의록에도 현장 사진 — 교육일지(tbm_logs.photo_url)와 같은 규약.
-- 값은 photos 버킷의 오브젝트 경로이며, 열람 시 서명 URL로 바꿔 내려준다(버킷 private).
alter table public.tbm_minutes add column if not exists photo_url text;
