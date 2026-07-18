// app/sign/[sessionId]/page.tsx
"use client"

import { useState, useRef, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import SignatureCanvas from "react-signature-canvas"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, MessageSquarePlus } from "lucide-react"

// 근로자 의견·제안 폼 — 서명 완료 화면의 suggest 단계에서 사용.
// submit_worker_suggestion RPC(SECURITY DEFINER)가 열린 세션 검증·소유자 결정까지 처리하므로 익명(anon) 그대로 호출한다.
// 익명이 기본이며, 참석자가 실명을 선택한 경우에만 서명자 이름(p_author_name)을 함께 보낸다.
function SuggestionForm({ sessionId, signerName }: { sessionId: string; signerName: string }) {
    const [content, setContent] = useState("")
    const [anonymous, setAnonymous] = useState(true)
    const [sending, setSending] = useState(false)
    const [sentCount, setSentCount] = useState(0)

    const submit = async () => {
        const text = content.trim()
        if (text.length < 5) {
            alert("제안 내용을 5자 이상 입력해주세요.")
            return
        }
        setSending(true)
        try {
            const { error } = await supabase.rpc("submit_worker_suggestion", {
                p_session: sessionId,
                p_content: text,
                p_author_name: anonymous ? null : signerName,
            })
            if (error) {
                const msg = error.message.includes("SESSION_CLOSED")
                    ? "세션이 종료되어 제안을 보낼 수 없습니다."
                    : error.message.includes("TOO_MANY")
                        ? "이 세션의 제안 접수가 마감되었습니다."
                        : error.message.includes("NAME_TOO_LONG")
                            ? "이름이 너무 길어 실명으로 접수할 수 없습니다. 익명으로 보내주세요."
                            : "전송에 실패했습니다. 잠시 후 다시 시도해주세요."
                alert(msg)
                return
            }
            setContent("")
            setSentCount((n) => n + 1)
        } finally {
            setSending(false)
        }
    }

    return (
        <div className="rounded-[12px] border border-cur-hairline bg-cur-card p-4 space-y-3">
            <div role="group" aria-label="작성자 표시 방식" className="flex bg-cur-elevated p-0.5 rounded-[8px] gap-0.5">
                <button
                    aria-pressed={anonymous}
                    onClick={() => setAnonymous(true)}
                    className={cn(
                        "flex-1 h-12 text-[15px] font-bold rounded-[6px] transition-all",
                        anonymous ? "bg-cur-card shadow-sm text-cur-ink" : "text-cur-muted"
                    )}
                >
                    익명
                </button>
                <button
                    aria-pressed={!anonymous}
                    onClick={() => setAnonymous(false)}
                    className={cn(
                        "flex-1 h-12 text-[15px] font-bold rounded-[6px] transition-all",
                        !anonymous ? "bg-cur-card shadow-sm text-cur-ink" : "text-cur-muted"
                    )}
                >
                    실명
                </button>
            </div>
            {/* aria-live: 실명 전환 시 스크린리더에 접수 이름 안내 */}
            <div aria-live="polite">
                {!anonymous && (
                    <p className="text-[12px] text-cur-muted">&lsquo;{signerName}&rsquo; 이름으로 접수됩니다</p>
                )}
            </div>
            <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                maxLength={500}
                rows={5}
                placeholder="예: 2층 개구부 덮개가 파손되어 있습니다 / 휴게 공간에 식수가 부족합니다"
                className="w-full rounded-[8px] border border-cur-hairline bg-cur-canvas p-3 text-[15px] text-cur-ink placeholder:text-cur-muted-soft focus:outline-none focus:ring-1 focus:ring-cur-primary resize-none"
            />
            {sentCount > 0 && (
                <p className="text-[13px] font-medium text-cur-success flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" /> 접수되었습니다{sentCount > 1 ? ` (${sentCount}건)` : ""}. 더 남기실 수도 있어요.
                </p>
            )}
            <Button
                onClick={submit}
                disabled={sending || content.trim().length === 0}
                className="w-full h-12 text-[15px] font-bold bg-cur-primary hover:bg-cur-primary/90 text-cur-on-primary rounded-[8px]"
            >
                {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : anonymous ? "익명으로 보내기" : "이름으로 보내기"}
            </Button>
        </div>
    )
}

export default function SignPage() {
    const router = useRouter()
    const urlParams = useParams()
    const sessionId = urlParams.sessionId as string

    const [name, setName] = useState("")
    const [gender, setGender] = useState<"M" | "F">("M")
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [isSuccess, setIsSuccess] = useState(false)
    // 완료 화면 2단계: done(제출 완료 안내) → suggest(의견·제안 보내기)
    const [successView, setSuccessView] = useState<"done" | "suggest">("done")
    const [isExpired, setIsExpired] = useState(false)
    const [isLoading, setIsLoading] = useState(true)

    const sigCanvas = useRef<SignatureCanvas>(null)

    useEffect(() => {
        const checkSession = async () => {
            // 마커 테이블을 직접 조회하지 않고(=session_id 열거 방지) 단건 상태만 RPC로 확인.
            // 서버가 OPEN(30분 이내)만 'OPEN'으로, 그 외/없음은 만료로 판정한다.
            const { data, error } = await supabase.rpc('session_status', { p: sessionId })
            if (error) console.error('session_status error:', error)
            if (data !== 'OPEN') {
                setIsExpired(true)
            }
            setIsLoading(false)
        }
        checkSession()
    }, [sessionId])

    const handleSubmit = async () => {
        if (!name.trim()) {
            alert("이름을 입력해주세요.")
            return
        }

        if (!sigCanvas.current || sigCanvas.current.isEmpty()) {
            alert("서명을 진행해주세요.")
            return
        }

        setIsSubmitting(true)

        try {
            // 무계정(anon) 서명: 스토리지에 직접 업로드하지 않고 base64를 그대로 pending에 저장한다.
            //  - private 버킷 anon 업로드(upsert 존재확인 SELECT) RLS 문제 회피
            //  - 소유자 실시간 수집 화면에 서명 이미지가 즉시 표시됨(base64)
            //  - 실제 스토리지 업로드는 소유자가 마감(저장) 시 authenticated로 수행(uploadBase64ToStorage)
            const signatureData = sigCanvas.current.toDataURL("image/png")

            const { error } = await supabase
                .from('tbm_pending_signatures')
                .insert({
                    session_id: sessionId,
                    name: name.trim(),
                    gender,
                    signature: signatureData
                })

            if (error) throw error

            setIsSuccess(true)
        } catch (error: any) {
            console.error(error)
            alert("서명 제출에 실패했습니다: " + error.message)
        } finally {
            setIsSubmitting(false)
        }
    }

    if (isLoading) {
        return (
            <div className="min-h-[100dvh] flex flex-col items-center justify-center p-6 bg-cur-canvas">
                <Loader2 className="w-10 h-10 text-cur-muted animate-spin" />
            </div>
        )
    }

    if (isExpired) {
        return (
            <div className="min-h-[100dvh] flex flex-col items-center justify-center p-6 bg-cur-canvas">
                <div className="bg-red-100 p-6 rounded-full mb-6">
                    <span className="text-4xl">⏱️</span>
                </div>
                <h1 className="text-2xl font-bold text-cur-ink mb-2">만료된 서명 링크입니다</h1>
                <p className="text-cur-body text-center mb-8">안전보건 교육(TBM) 서명 기간이 종료되어 더 이상 서명할 수 없습니다.<br />이 창을 닫아주세요.</p>
                <Button
                    variant="outline"
                    onClick={() => {
                        window.close()
                    }}
                    className="w-full max-w-sm h-14 text-lg border-cur-hairline-strong"
                >
                    창 닫기
                </Button>
            </div>
        )
    }

    if (isSuccess) {
        if (successView === "suggest") {
            return (
                <div className="min-h-[100dvh] bg-cur-canvas p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] flex flex-col max-w-md mx-auto">
                    <button
                        onClick={() => setSuccessView("done")}
                        className="self-start h-12 flex items-center gap-1 text-[15px] font-semibold text-cur-muted -ml-2 px-2 rounded-[8px]"
                    >
                        <ChevronLeft className="w-5 h-5" /> 뒤로
                    </button>
                    <h1 className="text-2xl font-bold text-cur-ink mt-1 mb-5">의견·제안 보내기</h1>
                    <SuggestionForm sessionId={sessionId} signerName={name.trim()} />
                    <div className="mt-auto pt-6">
                        <Button
                            onClick={() => {
                                window.close()
                            }}
                            className="w-full h-14 text-lg bg-cur-ink hover:bg-cur-ink/90"
                        >
                            닫기
                        </Button>
                    </div>
                </div>
            )
        }
        return (
            <div className="min-h-[100dvh] flex flex-col items-center justify-center p-6 bg-cur-canvas">
                <CheckCircle2 className="w-24 h-24 text-cur-success mb-6 animate-in zoom-in" />
                <h1 className="text-2xl font-bold text-cur-ink mb-2">서명 제출 완료</h1>
                <p className="text-cur-body text-center mb-8">안전보건 교육(TBM) 서명이 정상적으로 등록되었습니다.</p>
                <button
                    onClick={() => setSuccessView("suggest")}
                    className="w-full max-w-sm mb-6 flex items-center gap-3 rounded-[12px] border border-cur-hairline bg-cur-card p-4 text-left transition-transform active:scale-[0.98]"
                >
                    <MessageSquarePlus className="w-6 h-6 text-cur-primary shrink-0" />
                    <span className="flex-1 min-w-0">
                        <span className="block text-[15px] font-bold text-cur-ink">현장 의견·제안 남기기</span>
                        <span className="block text-[12px] text-cur-muted">익명 또는 이름으로 · 선택사항</span>
                    </span>
                    <ChevronRight className="w-5 h-5 text-cur-muted-soft shrink-0" />
                </button>
                <Button
                    onClick={() => {
                        window.close()
                    }}
                    className="w-full max-w-sm h-14 text-lg bg-cur-ink hover:bg-cur-ink/90"
                >
                    닫기
                </Button>
            </div>
        )
    }

    return (
        <div className="min-h-[100dvh] bg-cur-canvas p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] flex flex-col max-w-md mx-auto relative  bg-white overflow-hidden">
            <div className="text-center py-6 border-b">
                <h1 className="text-2xl font-black tracking-tight text-cur-ink">TBM 참석자 서명</h1>
                <p className="text-cur-muted mt-2 text-sm">정보를 입력하고 서명해 주세요</p>
            </div>

            <div className="p-4 space-y-6 flex-1 flex flex-col">
                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label className="text-base text-cur-body">이름</Label>
                        <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="성명 (정자로 입력)"
                            className="h-14 text-lg font-bold border-2 border-cur-hairline focus-visible:ring-slate-900"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label className="text-base text-cur-body">성별</Label>
                        <div className="flex bg-cur-elevated p-1.5 rounded-xl border border-cur-hairline">
                           <button
                                onClick={() => setGender('M')}
                                className={cn(
                                    "flex-1 py-3 text-base font-bold rounded-lg transition-all",
                                    gender === 'M' ? "bg-white text-blue-600  transform scale-[1.02]" : "text-cur-muted"
                                )}
                            >
                                남
                            </button>
                            <button
                                onClick={() => setGender('F')}
                                className={cn(
                                    "flex-1 py-3 text-base font-bold rounded-lg transition-all",
                                    gender === 'F' ? "bg-white text-pink-600  transform scale-[1.02]" : "text-cur-muted"
                                )}
                            >
                                여
                            </button>
                        </div>
                    </div>

                    <div className="space-y-2 flex-1 flex flex-col min-h-[300px]">
                        <div className="flex justify-between items-center">
                            <Label className="text-base text-cur-body">서명</Label>
                            <Button variant="ghost" size="sm" onClick={() => sigCanvas.current?.clear()} className="h-8 px-2 text-cur-muted">
                                다시 쓰기
                            </Button>
                        </div>
                        <div className="border-2 border-cur-hairline-strong rounded-2xl bg-cur-canvas flex-1 shadow-inner relative overflow-hidden" style={{ touchAction: "none" }}>
                            <SignatureCanvas
                                ref={sigCanvas}
                                canvasProps={{ className: "w-full h-full absolute inset-0" }}
                                backgroundColor="rgba(0,0,0,0)"
                                clearOnResize={false}
                            />
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
                                <span className="text-2xl font-bold tracking-widest rotate-[-15deg]">서명 공간</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="pt-6 pb-6">
                    <Button
                        onClick={handleSubmit}
                        disabled={isSubmitting}
                        className="w-full h-16 text-xl font-bold bg-cur-ink hover:bg-cur-ink/80 text-white rounded-2xl  transition-transform active:scale-95 flex items-center justify-center gap-2"
                    >
                        {isSubmitting ? (
                            <><Loader2 className="w-6 h-6 animate-spin" /> 제출 중...</>
                        ) : (
                            "서명 완료 및 제출"
                        )}
                    </Button>
                </div>
            </div>
        </div>
    )
}
