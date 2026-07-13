"use client"

import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"

export default function PrivacyPolicyPage() {
    const router = useRouter()

    return (
        <div className="min-h-screen bg-cur-canvas">
            <div className="max-w-2xl mx-auto bg-cur-card min-h-screen ">
                <div className="sticky top-0 z-10 bg-cur-card border-b p-4 flex items-center gap-3">
                    <Button variant="ghost" size="icon" onClick={() => router.back()}>
                        <ArrowLeft className="w-5 h-5" />
                    </Button>
                    <h1 className="text-lg font-bold text-cur-ink">개인정보처리방침</h1>
                </div>

                <div className="p-6 space-y-8 text-sm text-cur-body leading-relaxed">
                    <section>
                        <p className="text-cur-muted mb-4">시행일: 2026년 7월 13일 (이전 시행일: 2026년 7월 11일, 2026년 3월 6일)</p>
                        <p>
                            TBM 일지 서비스(이하 &quot;서비스&quot;)는 「개인정보 보호법」 제30조에 따라 정보주체의 개인정보를 보호하고
                            이와 관련한 고충을 신속하고 원활하게 처리할 수 있도록 하기 위하여 다음과 같이 개인정보 처리방침을 수립·공개합니다.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-cur-ink mb-3">제1조 (개인정보의 처리 목적)</h2>
                        <p className="mb-2">서비스는 다음의 목적을 위하여 개인정보를 처리합니다. 처리하고 있는 개인정보는 다음의 목적 이외의 용도로는 이용되지 않으며, 이용 목적이 변경되는 경우에는 「개인정보 보호법」 제18조에 따라 별도의 동의를 받는 등 필요한 조치를 이행할 예정입니다.</p>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>회원 가입 및 관리: 회원제 서비스 이용에 따른 본인확인, 개인식별, 가입의사 확인</li>
                            <li>휴대폰 본인확인 및 무료체험(1개월) 중복·부정 가입 방지</li>
                            <li>TBM(작업 전 안전점검) 일지 작성 및 관리</li>
                            <li>현장 제안 접수 및 처리</li>
                            <li>AI 컨설팅 서비스 제공</li>
                            <li>음성 인식 텍스트를 이용한 AI 요약·회의록 생성 및 서비스 품질 개선·통계 분석(비식별 처리)</li>
                            <li>서비스 이용 기록 분석 및 통계</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-cur-ink mb-3">제2조 (수집하는 개인정보의 항목)</h2>
                        <p className="mb-2">서비스는 다음의 개인정보 항목을 수집합니다.</p>
                        <div className="bg-cur-canvas rounded-lg p-4 space-y-3">
                            <div>
                                <p className="font-semibold text-cur-ink">필수 수집 항목</p>
                                <ul className="list-disc pl-5 mt-1 space-y-0.5">
                                    <li>카카오 로그인: 카카오 계정 식별자, 이메일(선택 제공 시), 닉네임</li>
                                    <li>일반 로그인: 이메일 주소, 비밀번호(암호화 저장)</li>
                                    <li>휴대폰 본인인증(무료체험 가입 시): 휴대전화번호</li>
                                    <li>서비스 이용: 소속 현장명(업체명), 업종·공종</li>
                                </ul>
                            </div>
                            <div>
                                <p className="font-semibold text-cur-ink">TBM 일지 작성 시 수집 항목</p>
                                <ul className="list-disc pl-5 mt-1 space-y-0.5">
                                    <li>참석자 이름, 성별, 서명(전자서명 이미지)</li>
                                    <li>교육실시자 이름 및 서명</li>
                                    <li>교육 현장 사진</li>
                                    <li>음성 인식 텍스트: 마이크 음성을 브라우저(Chrome/Safari) 내장 음성인식 기능으로 실시간 변환한 발화 내용(회의·교육 내용). 오디오 파일 자체는 서버에 저장하지 않으며, 변환된 텍스트를 일지와 함께 저장합니다. (이 과정에서 음성이 브라우저 제공사(구글/애플)로 전송될 수 있습니다)</li>
                                    <li>위치 정보(날씨 자동 조회 목적, 저장하지 않음)</li>
                                </ul>
                            </div>
                            <div>
                                <p className="font-semibold text-cur-ink">자동 수집 항목</p>
                                <ul className="list-disc pl-5 mt-1 space-y-0.5">
                                    <li>서비스 이용 기록, 접속 로그, IP 주소</li>
                                </ul>
                            </div>
                        </div>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-cur-ink mb-3">제3조 (개인정보의 처리 및 보유 기간)</h2>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>회원 정보: 회원 탈퇴 시까지 보유 후 즉시 파기</li>
                            <li>휴대전화번호(본인인증): 회원 탈퇴 시 파기. 단, 무료체험 중복·부정 가입 방지를 위해 체험 이용 이력(휴대전화번호)은 탈퇴 후에도 부정이용 방지 목적 달성에 필요한 기간 동안 별도 분리 보관합니다.</li>
                            <li>휴대폰 인증번호(OTP): 인증 완료 또는 유효시간(5분) 경과 시 즉시 폐기</li>
                            <li>TBM 일지 기록: 「산업안전보건법」에 따라 교육일지 보존 기간(3년) 동안 보관</li>
                            <li>음성 오디오 파일: 서버에 저장하지 않음(브라우저에서 텍스트로 변환 후 폐기)</li>
                            <li>음성 인식 텍스트: 작성된 일지 기록과 함께 보관(「산업안전보건법」 교육일지 보존기간 3년), 회원 탈퇴 시 관련 기록과 함께 파기</li>
                            <li>서비스 이용 기록: 「통신비밀보호법」에 따라 3개월 보관</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-cur-ink mb-3">제4조 (개인정보의 제3자 제공)</h2>
                        <p className="mb-2">서비스는 원칙적으로 이용자의 개인정보를 제3자에게 제공하지 않습니다. 다만, 다음의 경우에는 예외로 합니다.</p>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>이용자가 사전에 동의한 경우</li>
                            <li>법령의 규정에 의거하거나, 수사 목적으로 법령에 정해진 절차와 방법에 따라 수사기관의 요구가 있는 경우</li>
                        </ul>
                        <p className="mt-2 text-cur-muted">음성 인식 텍스트 등 개인정보를 제3자에게 제공하거나 판매·외부 재가공하려는 경우, 서비스는 사전에 제공받는 자·제공 목적·제공 항목·보유 기간을 고지하고 「개인정보 보호법」에 따라 별도의 명시적 동의를 받습니다. 동의하지 않아도 서비스 이용에는 제한이 없습니다.</p>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-cur-ink mb-3">제5조 (개인정보의 처리 위탁)</h2>
                        <div className="bg-cur-canvas rounded-lg p-4 space-y-2">
                            <div className="grid grid-cols-2 gap-2 text-xs">
                                <div className="font-semibold">수탁업체</div>
                                <div className="font-semibold">위탁 업무</div>
                                <div>Supabase Inc.</div>
                                <div>클라우드 인프라 운영, 사용자 인증, 데이터 저장</div>
                                <div>Anthropic PBC</div>
                                <div>AI 기반 음성 요약 및 텍스트 분석</div>
                                <div>카카오</div>
                                <div>소셜 로그인(카카오 계정 인증)</div>
                                <div>솔라피(Solapi)</div>
                                <div>휴대폰 문자(SMS) 본인인증번호 발송</div>
                            </div>
                        </div>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-cur-ink mb-3">제6조 (개인정보의 파기 절차 및 방법)</h2>
                        <ul className="list-disc pl-5 space-y-1">
                            <li><strong>파기 절차:</strong> 보유 기간이 경과하거나 처리 목적이 달성된 개인정보는 지체 없이 파기합니다.</li>
                            <li><strong>파기 방법:</strong> 전자적 파일 형태는 복구 불가능한 방법으로 영구 삭제하며, 종이 문서는 분쇄기 또는 소각으로 파기합니다.</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-cur-ink mb-3">제7조 (정보주체의 권리·의무 및 행사 방법)</h2>
                        <p className="mb-2">이용자는 개인정보주체로서 다음과 같은 권리를 행사할 수 있습니다.</p>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>개인정보 열람 요구</li>
                            <li>오류 등이 있을 경우 정정 요구</li>
                            <li>삭제 요구</li>
                            <li>처리정지 요구</li>
                        </ul>
                        <p className="mt-2">위 권리 행사는 서비스 관리자에게 이메일로 연락하여 요청할 수 있으며, 지체 없이 조치하겠습니다.</p>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-cur-ink mb-3">제8조 (개인정보의 안전성 확보 조치)</h2>
                        <p className="mb-2">서비스는 개인정보의 안전성 확보를 위해 다음과 같은 조치를 취하고 있습니다.</p>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>비밀번호 암호화 저장 및 전송 구간 SSL/TLS 적용</li>
                            <li>개인정보 접근 권한 최소화</li>
                            <li>접근 기록 보관 및 위·변조 방지</li>
                            <li>해킹 등에 대비한 보안 시스템 운영</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-cur-ink mb-3">제9조 (개인정보 보호책임자)</h2>
                        <div className="bg-cur-canvas rounded-lg p-4 space-y-1 text-sm">
                            <p>서비스는 개인정보 처리에 관한 업무를 총괄해서 책임지고, 개인정보 처리와 관련한 정보주체의 불만처리 및 피해구제 등을 위하여 아래와 같이 개인정보 보호책임자를 지정하고 있습니다.</p>
                            <p className="mt-2 font-semibold">개인정보 보호책임자: 서비스 운영팀</p>
                            <p>문의: 서비스 내 관리자 이메일로 연락</p>
                        </div>
                    </section>

                    <section>
                        <h2 className="text-base font-bold text-cur-ink mb-3">제10조 (개인정보 처리방침 변경)</h2>
                        <p>이 개인정보처리방침은 2026년 7월 13일부터 적용됩니다. (2026년 7월 13일 — 휴대폰 본인인증 도입에 따라 휴대전화번호 수집·보유 및 수탁업체(솔라피) 추가 / 2026년 7월 11일 — 음성 데이터 처리 방식을 &apos;오디오 삭제&apos;에서 &apos;음성 인식 텍스트 저장&apos;으로 변경) 변경 사항이 있을 경우 서비스 공지사항을 통해 고지합니다.</p>
                    </section>

                    <div className="pt-8 border-t text-center text-xs text-cur-muted-soft">
                        © 2026 TBM 일지 서비스. All rights reserved.
                    </div>
                </div>
            </div>
        </div>
    )
}
