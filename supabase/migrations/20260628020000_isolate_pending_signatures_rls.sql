-- 서명(PII) 격리: 로그인 유저가 남의 세션 서명을 전량 조회/삭제할 수 있던 qual=true 정책을 세션 소유권으로 스코프.
-- session_id는 소유자 기기의 랜덤 UUID. 소유자가 OPEN_SESSION 마커에 user_id를 남기고, 그 세션의 실제 서명만 접근.
-- 상태 마커(OPEN_SESSION/CLOSED_SESSION)는 비민감(이름='OPEN_SESSION', 서명='init')이라 조회 공개 유지 → 무계정 서명 페이지 동작.
-- 선행조건: 앱이 OPEN_SESSION insert 시 user_id를 기록하도록 배포 완료(커밋 2fdc79b).

ALTER TABLE public.tbm_pending_signatures ADD COLUMN IF NOT EXISTS user_id uuid;

-- 내가 연 서명 세션 id 목록 (SECURITY DEFINER로 RLS 재귀 회피, STABLE로 문장당 1회 평가)
CREATE OR REPLACE FUNCTION public.my_signing_sessions()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT session_id FROM public.tbm_pending_signatures
  WHERE name = 'OPEN_SESSION' AND user_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.my_signing_sessions() FROM public;
GRANT EXECUTE ON FUNCTION public.my_signing_sessions() TO authenticated;

-- SELECT(authenticated): 상태 마커는 누구나, 실제 서명은 세션 소유자만
DROP POLICY IF EXISTS pending_sig_select_authenticated ON public.tbm_pending_signatures;
CREATE POLICY pending_sig_select_authenticated ON public.tbm_pending_signatures
  FOR SELECT TO authenticated
  USING (
    name IN ('OPEN_SESSION', 'CLOSED_SESSION')
    OR session_id IN (SELECT public.my_signing_sessions())
  );

-- DELETE(authenticated): 세션 소유자만 (기존 qual=true 제거)
DROP POLICY IF EXISTS auth_can_delete_pending_signatures ON public.tbm_pending_signatures;
CREATE POLICY pending_sig_delete_authenticated ON public.tbm_pending_signatures
  FOR DELETE TO authenticated
  USING (session_id IN (SELECT public.my_signing_sessions()));
