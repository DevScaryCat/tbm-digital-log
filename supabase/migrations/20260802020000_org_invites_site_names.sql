-- 초대 링크에 감독자가 미리 정한 현장명 목록을 싣는다(Chris).
-- 현장명은 발급 개수만큼 감독자가 정해서 보내고, 가입자는 목록에서 고르기만 한다 —
-- 담당자마다 제각각 적어서 현장 목록이 지저분해지던 것의 반대 방향.
alter table public.org_invites add column if not exists site_names jsonb;
