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
import { CheckCircle2, Loader2 } from "lucide-react"

export default function SignPage() {
    const router = useRouter()
    const urlParams = useParams()
    const sessionId = urlParams.sessionId as string

    const [name, setName] = useState("")
    const [gender, setGender] = useState<"M" | "F">("M")
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [isSuccess, setIsSuccess] = useState(false)
    const [isExpired, setIsExpired] = useState(false)
    const [isLoading, setIsLoading] = useState(true)

    const sigCanvas = useRef<SignatureCanvas>(null)

    useEffect(() => {
        const checkSession = async () => {
            const { data, error } = await supabase
                .from('tbm_pending_signatures')
                .select('name, created_at')
                .eq('session_id', sessionId)
                .in('name', ['OPEN_SESSION', 'CLOSED_SESSION'])
                .order('created_at', { ascending: false })
                .limit(1)

            if (!data || data.length === 0) {
                setIsExpired(true)
            } else if (data[0].name === 'CLOSED_SESSION') {
                setIsExpired(true)
            } else if (data[0].name === 'OPEN_SESSION') {
                const createdAt = new Date(data[0].created_at).getTime()
                const now = Date.now()
                const diffMinutes = (now - createdAt) / (1000 * 60)

                if (diffMinutes >= 30) {
                    setIsExpired(true)
                }
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
            const response = await fetch(signatureData)
            const blob = await response.blob()
            const fileName = `${sessionId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.png`
            const { error: uploadError } = await supabase.storage
                .from('signatures')
                .upload(fileName, blob, {
                    contentType: 'image/png',
                    upsert: true
                })

            if (uploadError) throw uploadError

            const { data: { publicUrl } } = supabase.storage
                .from('signatures')
                .getPublicUrl(fileName)

            const { error } = await supabase
                .from('tbm_pending_signatures')
                .insert({
                    session_id: sessionId,
                    name: name.trim(),
                    gender,
                    signature: publicUrl
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
        return (
            <div className="min-h-[100dvh] flex flex-col items-center justify-center p-6 bg-cur-canvas">
                <CheckCircle2 className="w-24 h-24 text-green-500 mb-6 animate-in zoom-in" />
                <h1 className="text-2xl font-bold text-cur-ink mb-2">서명 제출 완료</h1>
                <p className="text-cur-body text-center mb-8">안전보건 교육(TBM) 서명이 정상적으로 등록되었습니다.<br />이 창을 닫아주세요.</p>
                <Button
                    onClick={() => {
                        window.close()
                    }}
                    className="w-full max-w-sm h-14 text-lg bg-cur-ink"
                >
                    닫기
                </Button>
            </div>
        )
    }

    return (
        <div className="min-h-[100dvh] bg-cur-canvas p-4 pb-[env(safe-area-inset-bottom)] flex flex-col max-w-md mx-auto relative  bg-white overflow-hidden">
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

                <div className="pt-6">
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
