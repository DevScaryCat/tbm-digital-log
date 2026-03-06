"use client"

import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"

export default function TermsOfServicePage() {
    const router = useRouter()

    return (
        <div className="min-h-screen bg-slate-50">
            <div className="max-w-2xl mx-auto bg-white min-h-screen shadow-lg">
                <div className="sticky top-0 z-10 bg-white border-b p-4 flex items-center gap-3">
                    <Button variant="ghost" size="icon" onClick={() => router.back()}>
                        <ArrowLeft className="w-5 h-5" />
                    </Button>
                    <h1 className="text-lg font-bold text-slate-900">서비스 이용약관</h1>
                </div>

                <div className="p-6 space-y-8 text-sm text-slate-700 leading-relaxed">
                    <section>
                        <p className="text-slate-500 mb-4">시행일: 2026년 3월 6일</p>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">제1조 (목적)</h2>
                        <p>이 약관은 TBM 일지 서비스(이하 &quot;서비스&quot;)가 제공하는 모든 서비스의 이용조건 및 절차, 이용자와 서비스의 권리·의무 및 책임사항, 기타 필요한 사항을 규정함을 목적으로 합니다.</p>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">제2조 (정의)</h2>
                        <ul className="list-disc pl-5 space-y-1">
                            <li><strong>&quot;서비스&quot;</strong>란 TBM(작업 전 안전점검) 일지 작성, 현장 제안, AI 컨설팅 등 서비스가 제공하는 모든 관련 서비스를 의미합니다.</li>
                            <li><strong>&quot;이용자&quot;</strong>란 이 약관에 동의하고 서비스를 이용하는 자를 말합니다.</li>
                            <li><strong>&quot;콘텐츠&quot;</strong>란 이용자가 서비스를 통해 작성·등록한 TBM 일지, 제안내용, 사진, 음성녹음, 서명 등 모든 자료를 말합니다.</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">제3조 (약관의 효력 및 변경)</h2>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>이 약관은 서비스 화면에 게시하거나 기타의 방법으로 이용자에게 공지함으로써 효력이 발생합니다.</li>
                            <li>서비스는 합리적인 사유가 발생할 경우 관련 법령에 위배되지 않는 범위에서 이 약관을 변경할 수 있으며, 변경된 약관은 공지사항을 통해 고지합니다.</li>
                            <li>이용자가 변경된 약관에 동의하지 않는 경우 서비스 이용을 중단하고 탈퇴할 수 있습니다.</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">제4조 (서비스의 제공)</h2>
                        <p className="mb-2">서비스는 다음의 기능을 제공합니다.</p>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>TBM(작업 전 안전점검) 일지 작성 및 관리</li>
                            <li>음성 녹음 기반 AI 자동 요약 기능</li>
                            <li>교육 참석자 전자서명 기능</li>
                            <li>현장 사진 촬영 및 첨부 기능</li>
                            <li>현장 제안(민원/위험요소) 접수 기능</li>
                            <li>AI 기반 특허 평가 및 컨설팅 기능</li>
                            <li>교육일지 공문서 양식 출력 기능</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">제5조 (이용자의 의무)</h2>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>이용자는 서비스 이용 시 관계 법령, 이 약관의 규정, 이용안내 및 주의사항을 준수하여야 합니다.</li>
                            <li>이용자는 타인의 개인정보를 부정하게 수집·이용하거나, 허위 정보를 등록해서는 안 됩니다.</li>
                            <li>이용자는 서비스를 이용하여 얻은 정보를 서비스의 사전 동의 없이 복제, 배포, 방송 등에 사용해서는 안 됩니다.</li>
                            <li>TBM 일지에 기재되는 참석자 정보(이름, 서명 등)는 해당 참석자 본인의 동의를 받은 후 입력해야 합니다.</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">제6조 (서비스의 책임)</h2>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>서비스는 관련 법령과 이 약관이 금지하거나 미풍양속에 반하는 행위를 하지 않으며, 계속적이고 안정적으로 서비스를 제공하기 위해 최선을 다합니다.</li>
                            <li>서비스는 이용자의 개인정보를 안전하게 관리하며, 개인정보처리방침에 따라 처리합니다.</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">제7조 (콘텐츠의 관리)</h2>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>이용자가 작성한 TBM 일지, 제안내용 등의 콘텐츠에 대한 책임은 이용자에게 있습니다.</li>
                            <li>서비스는 이용자의 콘텐츠가 관련 법령에 위반되는 경우 사전 통지 없이 해당 콘텐츠를 삭제하거나 접근을 제한할 수 있습니다.</li>
                            <li>AI가 생성한 요약 내용은 참고용이며, 최종 내용의 정확성은 이용자가 확인할 책임이 있습니다.</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">제8조 (서비스 이용의 제한 및 중지)</h2>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>서비스는 천재지변, 시스템 장애 등 불가항력적인 사유가 발생한 경우 서비스의 제공을 일시적으로 중단할 수 있습니다.</li>
                            <li>서비스는 이용자가 이 약관의 의무를 위반하거나 서비스의 정상적인 운영을 방해한 경우 서비스 이용을 제한하거나 중지할 수 있습니다.</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">제9조 (면책사항)</h2>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>서비스는 이용자의 귀책사유로 인한 서비스 이용 장애에 대해 책임을 지지 않습니다.</li>
                            <li>서비스는 이용자가 서비스를 통해 기대하는 이익을 얻지 못한 것에 대해 책임을 지지 않습니다.</li>
                            <li>AI 자동 요약 기능은 기술적 한계가 있으며, AI가 생성한 내용의 정확성을 보장하지 않습니다. 이용자는 반드시 내용을 확인하고 수정한 후 사용해야 합니다.</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">제10조 (분쟁 해결)</h2>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>서비스와 이용자 간에 발생한 분쟁에 대해서는 대한민국 법을 적용합니다.</li>
                            <li>서비스 이용으로 발생한 분쟁에 대한 소송은 민사소송법상의 관할법원에 제기합니다.</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-slate-900 mb-3">부칙</h2>
                        <p>이 약관은 2026년 3월 6일부터 시행합니다.</p>
                    </section>

                    <div className="pt-8 border-t text-center text-xs text-slate-400">
                        © 2026 TBM 일지 서비스. All rights reserved.
                    </div>
                </div>
            </div>
        </div>
    )
}
