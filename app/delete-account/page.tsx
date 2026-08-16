// app/delete-account/page.tsx — Google Play 데이터 보안 양식의 '계정 삭제 URL'용 안내 페이지.
// Play 정책상 계정 생성이 있는 앱은 웹에서 접근 가능한 삭제 안내가 필요하다(2024~).
// 실제 삭제는 앱 안에서 이뤄진다(계정 → 회원탈퇴) — 이 페이지는 그 경로와 처리 내용을
// 로그인 없이 설명하는 정적 안내다. 웹 기능 개발 중단(2026-08-14) 예외: 스토어 컴플라이언스.
export const metadata = { title: "계정 삭제 안내 — 안톡" };

export default function DeleteAccountPage() {
    return (
        <div className="min-h-screen bg-cur-canvas px-5 py-12">
            <div className="mx-auto max-w-[560px] space-y-6">
                <h1 className="text-[24px] font-bold text-cur-ink">안톡 계정 삭제 안내</h1>
                <p className="text-[14px] leading-relaxed text-cur-body">
                    안톡(AnTok, kr.bitflip.tbm) 계정은 앱 안에서 직접 삭제할 수 있습니다.
                </p>

                <div className="rounded-xl border border-cur-hairline bg-cur-card p-5 space-y-2">
                    <h2 className="text-[15px] font-bold text-cur-ink">앱에서 삭제하기</h2>
                    <ol className="list-decimal pl-5 text-[14px] leading-relaxed text-cur-body space-y-1">
                        <li>안톡 앱 로그인 → 오른쪽 위 이름 → <b>구독 및 결제</b></li>
                        <li>화면 맨 아래 <b>회원탈퇴</b></li>
                        <li>안내를 확인하고 삭제를 확정</li>
                    </ol>
                </div>

                <div className="rounded-xl border border-cur-hairline bg-cur-card p-5 space-y-2">
                    <h2 className="text-[15px] font-bold text-cur-ink">삭제되는 데이터</h2>
                    <p className="text-[14px] leading-relaxed text-cur-body">
                        계정, TBM 회의록·안전보건교육일지·위험성 평가 등 작성 문서, 서명·현장 사진,
                        보고서 수신처, AI 사용 기록이 즉시 삭제되며 복구할 수 없습니다.
                    </p>
                    <h2 className="pt-2 text-[15px] font-bold text-cur-ink">보관되는 데이터</h2>
                    <p className="text-[14px] leading-relaxed text-cur-body">
                        결제·구독 기록은 전자상거래법에 따라 5년간 보존됩니다(계정과 분리된 형태).
                        무료체험 부정 재사용 방지를 위한 복원 불가능한 해시 표식이 1년간 보관됩니다.
                        약관 동의 증빙은 분쟁 대응을 위해 보존됩니다.
                    </p>
                    <p className="text-[13px] leading-relaxed text-cur-muted">
                        Google Play·App Store 정기 결제는 각 스토어에서 별도로 해지해야 합니다 —
                        계정을 삭제해도 스토어 구독은 자동으로 끊기지 않습니다.
                    </p>
                </div>

                <div className="rounded-xl border border-cur-hairline bg-cur-card p-5 space-y-2">
                    <h2 className="text-[15px] font-bold text-cur-ink">앱을 사용할 수 없는 경우</h2>
                    <p className="text-[14px] leading-relaxed text-cur-body">
                        가입 계정 정보(아이디 또는 카카오 계정, 휴대폰 번호)와 함께{" "}
                        <a href="mailto:qkymzh123@gmail.com" className="font-medium text-cur-primary underline">
                            qkymzh123@gmail.com
                        </a>
                        으로 삭제를 요청해 주세요. 본인 확인 후 처리해 드립니다.
                    </p>
                </div>
            </div>
        </div>
    );
}
