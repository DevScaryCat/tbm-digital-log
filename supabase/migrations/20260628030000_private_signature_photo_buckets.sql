-- 서명/사진 스토리지 비공개화: 인터넷 아무나 URL로 접근하던 public read 차단(HIGH).
-- 로그인 유저는 signed URL(createSignedUrl)로 렌더 → authenticated SELECT 허용, anon/public SELECT 제거, 버킷 private.
-- 선행조건: 앱 리포트 3곳이 저장된 public URL을 signed URL로 변환해 렌더하도록 배포됨(lib/storageSign).
-- 주의: public 역할 SELECT 정책이 남아있으면 버킷을 private로 바꿔도 anon이 signed URL을 발급할 수 있어 반드시 함께 제거.

-- 1) anon/public SELECT 정책 제거 (핵심)
DROP POLICY IF EXISTS "Public Access to signatures and photos" ON storage.objects;

-- 2) 로그인 유저만 객체 SELECT(=signed URL 발급)
DROP POLICY IF EXISTS "authenticated read signature/photo objects" ON storage.objects;
CREATE POLICY "authenticated read signature/photo objects" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id IN ('signatures', 'photos'));

-- 3) 버킷 비공개 (/object/public/ URL 무효화 → 이후에는 signed URL로만 접근)
UPDATE storage.buckets SET public = false WHERE id IN ('signatures', 'photos');
