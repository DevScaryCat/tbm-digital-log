"use client"

import { useState, useRef, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import SignatureCanvas from "react-signature-canvas"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { CheckCircle2, Loader2 } from "lucide-react"

export default function SignPage({ params }: { params: { sessionId: string } }) {
    const router = useRouter()
    const { sessionId } = params

    const [name, setName] = useState("")
    const [gender, setGender] = useState<"M" | "F">("M")
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [isSuccess, setIsSuccess] = useState(false)
    const [isExpired, setIsExpired] = useState(false)
    const [isLoading, setIsLoading] = useState(true)

    const sigCanvas = useRef<SignatureCanvas>(null)

    // 만료 여부 확인
    useEffect(() => {
        const checkSession = async () => {
            const { data, error } = await supabase
                .from('tbm_pending_signatures')
                .select('id')
                .eq('session_id', sessionId)
                .eq('name', 'CLOSED_SESSION')
                .limit(1)

            if (data && data.length > 0) {
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
            <div className="min-h-[100dvh] flex flex-col items-center justify-center p-6 bg-slate-50">
                <Loader2 className="w-10 h-10 text-slate-500 animate-spin" />
            </div>
        )
    }

    if (isExpired) {
        return (
            <div className="min-h-[100dvh] flex flex-col items-center justify-center p-6 bg-slate-50">
                <div className="bg-red-100 p-6 rounded-full mb-6">
                    <span className="text-4xl">⏱️</span>
                </div>
                <h1 className="text-2xl font-bold text-slate-900 mb-2">만료된 서명 링크입니다</h1>
                <p className="text-slate-600 text-center mb-8">안전보건 교육(TBM) 서명 기간이 종료되어 더 이상 서명할 수 없습니다.<br />이 창을 닫아주세요.</p>
                <Button
                    variant="outline"
                    onClick={() => {
                        window.close()
                    }}
                    className="w-full max-w-sm h-14 text-lg border-slate-300"
                >
                    창 닫기
                </Button>
            </div>
        )
    }

    if (isSuccess) {
        return (
            <div className="min-h-[100dvh] flex flex-col items-center justify-center p-6 bg-slate-50">
                <CheckCircle2 className="w-24 h-24 text-green-500 mb-6 animate-in zoom-in" />
                <h1 className="text-2xl font-bold text-slate-900 mb-2">서명 제출 완료</h1>
                <p className="text-slate-600 text-center mb-8">안전보건 교육(TBM) 서명이 정상적으로 등록되었습니다.<br />이 창을 닫아주세요.</p>
                <Button
                    onClick={() => {
                        // 모바일 브라우저 닫기 시도
                        window.close()
                    }}
                    className="w-full max-w-sm h-14 text-lg bg-slate-900"
                >
                    닫기
                </Button>
            </div>
        )
    }

    return (
        <div className="min-h-[100dvh] bg-slate-50 p-4 pb-[env(safe-area-inset-bottom)] flex flex-col max-w-md mx-auto relative shadow-xl bg-white overflow-hidden">
            <div className="text-center py-6 border-b">
                <h1 className="text-2xl font-black tracking-tight text-slate-900">TBM 참석자 서명</h1>
                <p className="text-slate-500 mt-2 text-sm">정보를 입력하고 서명해 주세요</p>
            </div>

            <div className="p-4 space-y-6 flex-1 flex flex-col">
                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label className="text-base text-slate-700">이름</Label>
                        <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="성명 (정자로 입력)"
                            className="h-14 text-lg font-bold border-2 border-slate-200 focus-visible:ring-slate-900"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label className="text-base text-slate-700">성별</Label>
                        <div className="flex bg-slate-100 p-1.5 rounded-xl border border-slate-200">
                            <button
                                onClick={() => setGender('M')}
                                className={cn(
                                    "flex-1 py-3 text-base font-bold rounded-lg transition-all",
                                    gender === 'M' ? "bg-white text-blue-600 shadow-md transform scale-[1.02]" : "text-slate-500"
                                )}
                            >
                                남
                            </button>
                            <button
                                onClick={() => setGender('F')}
                                className={cn(
                                    "flex-1 py-3 text-base font-bold rounded-lg transition-all",
                                    gender === 'F' ? "bg-white text-pink-600 shadow-md transform scale-[1.02]" : "text-slate-500"
                                )}
                            >
                                여
                            </button>
                        </div>
                    </div>

                    <div className="space-y-2 flex-1 flex flex-col min-h-[300px]">
                        <div className="flex justify-between items-center">
                            <Label className="text-base text-slate-700">서명</Label>
                            <Button variant="ghost" size="sm" onClick={() => sigCanvas.current?.clear()} className="h-8 px-2 text-slate-500">
                                다시 쓰기
                            </Button>
                        </div>
                        <div className="border-2 border-slate-300 rounded-2xl bg-slate-50 flex-1 shadow-inner relative overflow-hidden" style={{ touchAction: "none" }}>
                            <SignatureCanvas
                                ref={sigCanvas}
                                canvasProps={{ className: "w-full h-full absolute inset-0" }}
                                backgroundColor="rgba(0,0,0,0)"
                            />
                            {/* 안내 텍스트 표시 (서명이 비어있을 때) */}
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
                                <span className="text-2xl font-bold tracking-widest rotate-[-15deg]">서명 공간</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="pt-6">
                    <Button
                        onClick={handleSubmit}
                        disabled={isSubmitting}
                        className="w-full h-16 text-xl font-bold bg-slate-900 hover:bg-slate-800 text-white rounded-2xl shadow-xl transition-transform active:scale-95 flex items-center justify-center gap-2"
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
