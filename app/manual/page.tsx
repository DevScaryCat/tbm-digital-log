// app/manual/page.tsx — 안톡 사용설명서 (2026-08-16, Chris ④)
// 앱의 설명서/가이드 → '사용설명서' 탭이 여는 문서. 용도가 명확하다: 현장 담당자가
// 사장·본사에 "이게 뭐고 왜 결제해야 하는지" 보고할 때 그대로 내미는 한 장짜리 근거.
// 그래서 기능 나열보다 법적 의무 → 안톡이 대신하는 일 → 비용 순서로 쓴다.
// 브라우저 인쇄(→PDF 저장)를 전제로 한 정적 페이지 — 로그인 불필요.
export const metadata = { title: "안톡 사용설명서" };

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="space-y-2 break-inside-avoid">
        <h2 className="text-[17px] font-bold text-cur-ink border-b border-cur-hairline pb-1.5">{title}</h2>
        {children}
    </section>
);

export default function ManualPage() {
    return (
        <div className="min-h-screen bg-cur-canvas px-5 py-10 print:bg-white print:py-0">
            <div className="mx-auto max-w-[680px] space-y-8">
                <header className="space-y-2 border-b-2 border-cur-ink pb-5">
                    <p className="text-[13px] font-semibold tracking-wide text-cur-primary">사용설명서 · 도입 보고용</p>
                    <h1 className="text-[28px] font-bold text-cur-ink leading-tight">안톡 — 말하면, 서류가 됩니다</h1>
                    <p className="text-[14px] leading-relaxed text-cur-body">
                        안톡(AnTok)은 건설·물류 현장의 TBM(작업 전 안전회의)을 <b>녹음 한 번</b>으로
                        법정 서식 문서(TBM 회의록·안전보건교육일지)로 만들어주는 현장 안전관리 서비스입니다.
                    </p>
                </header>

                <Section title="1. 어떤 법적 의무를 대신하나요">
                    <ul className="list-disc pl-5 text-[14px] leading-relaxed text-cur-body space-y-1">
                        <li><b>산업안전보건법 제29조 정기 안전보건교육</b> — 근로자는 반기별 법정 교육시간(사무직 6시간·비사무직 12시간)을 이수해야 하며, 사업주는 그 실시 기록을 보존해야 합니다. 안톡은 매일의 TBM을 교육 기록으로 문서화하고 이수 시간을 자동 합산합니다.</li>
                        <li><b>중대재해처벌법 대응 증빙</b> — 사고 발생 시 "위험을 알리고 관리해 왔다"는 일상 기록이 핵심 증빙이 됩니다. 안톡의 회의록에는 음성 원문·참석자 서명·현장 사진이 함께 남습니다.</li>
                        <li><b>위험성평가 근로자 참여</b> — TBM에서 근로자들이 실제로 말한 위험요인이 기록으로 축적되어, 근로자가 참여한 위험성평가 근거 자료가 됩니다.</li>
                    </ul>
                </Section>

                <Section title="2. 사용 방법 — 하루 5분">
                    <ol className="list-decimal pl-5 text-[14px] leading-relaxed text-cur-body space-y-1">
                        <li>아침 TBM 시작 전, 앱에서 <b>녹음 버튼</b>을 누릅니다. (화면을 꺼도, 주머니에 넣어도 녹음은 이어집니다)</li>
                        <li>평소처럼 회의합니다 — 오늘 작업, 위험한 곳, 조심할 것.</li>
                        <li>끝나면 <b>AI 요약</b>을 누릅니다. 말한 내용이 회의록 서식(공정·위험요인·대책·지시사항)으로 정리됩니다.</li>
                        <li>참석자 서명은 <b>QR 코드</b>로 — 각자 자기 휴대폰에서 서명합니다. 종이를 돌릴 필요가 없습니다.</li>
                        <li>검토 화면에서 오탈자만 확인하고 저장하면 끝. 같은 방식으로 교육일지도 만들어집니다.</li>
                    </ol>
                    <p className="text-[13px] leading-relaxed text-cur-muted">
                        AI는 실제로 말한 내용만 정리합니다 — 말하지 않은 대책을 지어내지 않습니다.
                        저장 후에는 AI가 오늘 TBM의 점수와 "다음엔 이렇게 말해보세요" 피드백을 제공합니다.
                    </p>
                </Section>

                <Section title="3. 만들어지는 문서">
                    <ul className="list-disc pl-5 text-[14px] leading-relaxed text-cur-body space-y-1">
                        <li><b>TBM 회의록</b> — 공정·작업, 근로자 참여 위험요인·대책, 참석자 전자서명, 현장 사진, 음성 원문</li>
                        <li><b>안전보건교육일지</b> — 교육 내용·시간, 법정 교육시간 자동 합산</li>
                        <li><b>위험요인 분석</b> — 기간별 TBM에서 언급된 위험을 AI가 통합 정리</li>
                        <li><b>월간 종합 보고서</b> — 한 달 치 안전활동을 결재 서식으로, 지정 이메일로 자동 발송</li>
                    </ul>
                    <p className="text-[13px] text-cur-muted">출력 형식: 한글(HWP) · 워드(DOCX) · 엑셀(XLSX) · PDF</p>
                </Section>

                <Section title="4. 여러 현장 관리 (선택)">
                    <p className="text-[14px] leading-relaxed text-cur-body">
                        본사·안전관리자가 <b>현장마다 계정을 만들어 나눠주면</b>, 각 현장의 기록이 관리자 계정으로
                        모이고 월간 보고서도 전 현장 통합본으로 발송됩니다. 요금은 계정 수만큼 관리자에게 함께
                        청구되며, 현장 계정은 결제할 필요가 없습니다.
                    </p>
                </Section>

                <Section title="5. 요금">
                    <ul className="list-disc pl-5 text-[14px] leading-relaxed text-cur-body space-y-1">
                        <li><b>월 4,900원 / 계정</b> (부가세 포함) — 첫 달 무료 체험, 카드 등록 없이 시작</li>
                        <li>체험이 끝나도 자동 결제되지 않습니다 — 구독은 직접 결정합니다</li>
                        <li>모든 기능 포함: AI 회의록·교육일지, 월 보고서 자동 발송, 전 형식 출력</li>
                    </ul>
                </Section>

                <Section title="6. 보안과 개인정보">
                    <ul className="list-disc pl-5 text-[14px] leading-relaxed text-cur-body space-y-1">
                        <li>서명·현장 사진은 비공개 저장소에 보관되며, 링크 접근이 제한됩니다</li>
                        <li>음성은 텍스트 변환에만 사용하고, 제3자 AI 학습 제공을 차단합니다</li>
                        <li>약관·개인정보 동의는 증빙 원장으로 보존됩니다 · 자세한 내용: safetalk.kr/privacy</li>
                    </ul>
                </Section>

                <footer className="border-t border-cur-hairline pt-4 text-[13px] text-cur-muted space-y-1 print:break-inside-avoid">
                    <p><b className="text-cur-ink">안톡 (AnTok)</b> · 비트플립 (Bitflip)</p>
                    <p>Google Play에서 &quot;안톡&quot; 검색 · 문의 qkymzh123@gmail.com</p>
                    <p className="print:hidden text-cur-muted-soft">이 페이지는 브라우저 인쇄 기능으로 PDF 저장이 가능합니다 (Ctrl/⌘+P)</p>
                </footer>
            </div>
        </div>
    );
}
