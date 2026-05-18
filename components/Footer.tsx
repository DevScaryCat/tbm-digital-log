import Link from "next/link";

export function Footer() {
  return (
    <footer className="w-full text-center py-12 px-4 text-[13px] text-cur-muted bg-cur-canvas border-t border-cur-hairline font-sans">
      <div className="max-w-2xl mx-auto flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-center gap-3 font-semibold text-cur-ink">
          <Link href="/terms" className="hover:underline">이용약관 및 환불정책</Link>
          <span className="w-1 h-1 bg-cur-hairline rounded-full" />
          <Link href="/privacy" className="hover:underline">개인정보처리방침</Link>
          <span className="w-1 h-1 bg-cur-hairline rounded-full" />
          <Link href="/pricing" className="hover:underline">요금안내</Link>
        </div>

        <div className="text-cur-muted-soft leading-relaxed mt-2">
          <p>상호명: 비트플립(Bitflip.) | 대표자: 문경민</p>
          <p>사업자등록번호: 493-40-01338 | 통신판매업신고번호: 발급 예정</p>
          <p>사업장 소재지: 경기도 고양시 덕양구 꽃마을로 46, 13층 1313호</p>
          <p>고객센터: 010-6352-2968 | 이메일: devscarycat@icloud.com</p>
        </div>

        <div className="mt-4 text-[12px]">
          © {new Date().getFullYear()} EHS Friends (안전톡톡). All rights reserved.
        </div>
      </div>
    </footer>
  );
}
