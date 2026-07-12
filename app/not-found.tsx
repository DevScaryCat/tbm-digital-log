import Link from "next/link"

// 존재하지 않는/만료된 경로 진입 시 한글 안내 (없으면 Next 기본 영문 404 노출)
export default function NotFound() {
    return (
        <div className="min-h-screen bg-cur-canvas flex items-center justify-center p-6">
            <div className="w-full max-w-sm bg-cur-card border border-cur-hairline rounded-2xl p-8 text-center shadow-[0_4px_12px_rgba(0,0,0,0.04)]">
                <div className="text-5xl font-bold text-cur-ink tracking-tight">404</div>
                <h1 className="mt-4 text-lg font-bold text-cur-ink">페이지를 찾을 수 없어요</h1>
                <p className="mt-2 text-sm text-cur-muted leading-relaxed">
                    주소가 바뀌었거나 만료된 링크일 수 있습니다.
                    <br />홈에서 다시 시작해 주세요.
                </p>
                <Link
                    href="/"
                    className="mt-6 inline-flex items-center justify-center w-full h-12 rounded-[10px] bg-cur-primary text-cur-on-primary text-[15px] font-bold hover:bg-cur-primary-active transition-colors"
                >
                    홈으로
                </Link>
            </div>
        </div>
    )
}
