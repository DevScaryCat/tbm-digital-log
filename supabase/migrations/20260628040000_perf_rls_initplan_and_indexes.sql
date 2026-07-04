-- 성능: RLS 정책의 auth.uid()가 행마다 재평가되던 것을 (select auth.uid())로 1회 평가(initplan)로 개선.
-- + 자주 필터하는 컬럼에 누락 인덱스 추가.

-- 1) RLS initplan (monthly_reports, tbm_risk_assessments)
DROP POLICY IF EXISTS mr_select_own ON public.monthly_reports;
CREATE POLICY mr_select_own ON public.monthly_reports FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS ra_select_own ON public.tbm_risk_assessments;
CREATE POLICY ra_select_own ON public.tbm_risk_assessments FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS ra_insert_own ON public.tbm_risk_assessments;
CREATE POLICY ra_insert_own ON public.tbm_risk_assessments FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS ra_update_own ON public.tbm_risk_assessments;
CREATE POLICY ra_update_own ON public.tbm_risk_assessments FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS ra_delete_own ON public.tbm_risk_assessments;
CREATE POLICY ra_delete_own ON public.tbm_risk_assessments FOR DELETE USING ((select auth.uid()) = user_id);

-- 2) 누락 인덱스
-- 서명 세션: eq(session_id) 조회·realtime·RLS 함수(my_signing_sessions)가 사용하는데 pkey만 있었음
CREATE INDEX IF NOT EXISTS idx_pending_sig_session ON public.tbm_pending_signatures (session_id);
-- my_signing_sessions(): WHERE name='OPEN_SESSION' AND user_id=auth.uid()
CREATE INDEX IF NOT EXISTS idx_pending_sig_owner ON public.tbm_pending_signatures (user_id) WHERE name = 'OPEN_SESSION';
-- 로그/회의록: user_id + date 범위 조회(분석·리포트·대시보드·크론)가 (user_id)만 인덱스됨
CREATE INDEX IF NOT EXISTS idx_tbm_logs_user_date ON public.tbm_logs (user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_tbm_minutes_user_date ON public.tbm_minutes (user_id, date DESC);
