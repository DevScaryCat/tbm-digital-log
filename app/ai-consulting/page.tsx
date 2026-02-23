"use client"

import { useState, useRef } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Mic, StopCircle, Loader2, ArrowLeft, Zap, FileText, CheckCircle, Upload, TrendingUp, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"

export default function AIConsultingPage() {
    const router = useRouter()

    // 녹음 관련 상태
    const [isRecording, setIsRecording] = useState(false)
    const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
    const audioChunks = useRef<Blob[]>([])
    const fileInputRef = useRef<HTMLInputElement>(null)

    // 진행 상태
    const [isProcessingSTT, setIsProcessingSTT] = useState(false)
    const [isProcessingAI, setIsProcessingAI] = useState(false)
    const [isSaving, setIsSaving] = useState(false)

    // 데이터 상태
    const [transcript, setTranscript] = useState("")
    const [aiResult, setAiResult] = useState<any>(null)

    // 1. 오디오 처리 및 STT 요청 (Deepgram)
    const processAudioBlob = async (blob: Blob) => {
        const file = new File([blob], "idea_recording.webm", { type: blob.type })
        setIsProcessingSTT(true)
        setTranscript("")
        setAiResult(null)

        try {
            const formData = new FormData()
            formData.append("file", file)

            const res = await fetch('/api/stt', { method: 'POST', body: formData })
            const data = await res.json()

            if (!res.ok) throw new Error(data.error || "음성 인식 실패")

            if (data.transcript) {
                setTranscript(data.transcript)
                await requestAIPatentEvaluation(data.transcript) // STT 성공 시 바로 특허 분석 요청
            } else {
                alert("음성이 인식되지 않았습니다. 다시 말씀해주세요.")
            }
        } catch (e: any) {
            console.error(e)
            alert("음성 처리 오류: " + e.message)
        } finally {
            setIsProcessingSTT(false)
        }
    }

    // 2. AI 특허/컨설팅 분석 요청
    const requestAIPatentEvaluation = async (text: string) => {
        setIsProcessingAI(true)
        try {
            const res = await fetch('/api/ai/patent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            })
            const data = await res.json()

            if (res.ok) {
                setAiResult(data)
            } else {
                alert("AI 분석 오류: " + (data.error || "알 수 없는 오류"))
            }
        } catch (e) {
            console.error(e)
            alert("AI 서버 연결 실패")
        } finally {
            setIsProcessingAI(false)
        }
    }

    // 파일 업로드 핸들러
    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setIsProcessingSTT(true)
        setTranscript("")
        setAiResult(null)

        try {
            const formData = new FormData()
            formData.append("file", file)
            const res = await fetch('/api/stt', { method: 'POST', body: formData })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            if (data.transcript) {
                setTranscript(data.transcript)
                await requestAIPatentEvaluation(data.transcript)
            }
        } catch (e: any) {
            alert("파일 처리 오류: " + e.message)
        } finally {
            setIsProcessingSTT(false)
            if (fileInputRef.current) fileInputRef.current.value = ""
        }
    }

    // 녹음 시작/종료 토글
    const toggleRecording = async () => {
        if (isRecording) {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop()
                setIsRecording(false)
            }
        } else {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                alert("마이크를 지원하지 않습니다. 파일을 업로드해주세요.")
                return
            }
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
                const recorder = new MediaRecorder(stream)
                audioChunks.current = []

                recorder.ondataavailable = (event) => {
                    if (event.data.size > 0) audioChunks.current.push(event.data)
                }

                recorder.onstop = () => {
                    const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' })
                    processAudioBlob(audioBlob)
                    stream.getTracks().forEach(track => track.stop())
                }

                recorder.start()
                setMediaRecorder(recorder)
                setIsRecording(true)
            } catch (err) {
                alert("마이크 권한이 필요합니다.")
            }
        }
    }

    // DB 자산화 (저장) 함수 임시 구현
    const handleSaveAsset = () => {
        setIsSaving(true)
        // 실제 Supabase DB(예: ideas 테이블)에 저장하는 로직이 들어갈 곳
        setTimeout(() => {
            setIsSaving(false)
            alert("지식 자산 DB에 성공적으로 저장되었습니다! 🚀")
            setAiResult(null)
            setTranscript("")
        }, 1000)
    }

    return (
        <div className="min-h-screen bg-slate-100 flex flex-col items-center pb-20">
            <div className="w-full max-w-md bg-white min-h-screen shadow-2xl relative flex flex-col">

                {/* 상단 헤더 */}
                <div className="p-4 flex items-center border-b bg-white sticky top-0 z-10">
                    <Button variant="ghost" size="icon" onClick={() => router.push('/')} className="mr-2">
                        <ArrowLeft className="w-6 h-6" />
                    </Button>
                    <div className="flex items-center gap-2">
                        <Zap className="w-5 h-5 text-purple-600" />
                        <h1 className="text-xl font-bold text-slate-800">AI 특허/컨설팅 모드</h1>
                    </div>
                </div>

                <div className="flex-1 flex flex-col p-6 space-y-6">

                    <div className="text-center space-y-2 mt-2">
                        <h2 className="text-2xl font-extrabold text-slate-900">현장의 대화를 자산으로</h2>
                        <p className="text-slate-500 text-sm">
                            작업 방식 개선 아이디어나 회의 내용을 녹음하세요.<br />AI가 특허 가능성을 평가하고 명세서 초안을 써드립니다.
                        </p>
                    </div>

                    {/* 중앙 마이크 버튼 영역 */}
                    <div className="flex flex-col items-center justify-center py-8">
                        <div className="relative">
                            {isRecording && (
                                <div className="absolute inset-0 bg-purple-500 rounded-full animate-ping opacity-30 scale-150"></div>
                            )}
                            <Button
                                onClick={toggleRecording}
                                disabled={isProcessingSTT || isProcessingAI}
                                className={cn(
                                    "w-32 h-32 rounded-full flex items-center justify-center transition-all duration-500 shadow-2xl relative z-10",
                                    isRecording ? "bg-purple-600 hover:bg-purple-700" : "bg-slate-900 hover:bg-slate-800"
                                )}
                            >
                                {isProcessingSTT || isProcessingAI ? (
                                    <Loader2 className="w-12 h-12 text-white animate-spin" />
                                ) : isRecording ? (
                                    <StopCircle className="w-16 h-16 text-white" />
                                ) : (
                                    <Mic className="w-16 h-16 text-white" />
                                )}
                            </Button>
                        </div>

                        <div className="mt-8 text-center h-10">
                            <span className="text-lg font-bold text-slate-700">
                                {isProcessingSTT ? "음성 데이터 추출 중..." : isProcessingAI ? "AI 변리사가 분석 중입니다..." : isRecording ? "대화를 녹음 중입니다..." : "터치하여 아이디어 말하기"}
                            </span>
                        </div>

                        {!isRecording && !isProcessingSTT && !isProcessingAI && (
                            <div className="mt-4">
                                <input type="file" ref={fileInputRef} className="hidden" accept="audio/*, .m4a, .mp3, .wav" onChange={handleFileUpload} />
                                <Button variant="outline" onClick={() => fileInputRef.current?.click()} className="text-slate-500 rounded-full border-slate-300">
                                    <Upload className="w-4 h-4 mr-2" /> 음성/회의 파일 업로드
                                </Button>
                            </div>
                        )}
                    </div>

                    {/* AI 분석 결과 보고서 UI */}
                    {aiResult && (
                        <div className="animate-in fade-in slide-in-from-bottom-8 duration-700 space-y-6">

                            {/* 특허 가능성 스코어 카드 */}
                            <Card className="bg-gradient-to-br from-indigo-900 to-purple-900 text-white border-0 shadow-lg overflow-hidden relative">
                                <div className="absolute top-0 right-0 p-4 opacity-10">
                                    <TrendingUp className="w-32 h-32" />
                                </div>
                                <CardHeader className="pb-2 relative z-10">
                                    <CardTitle className="text-indigo-200 text-sm font-bold flex items-center gap-2">
                                        <CheckCircle className="w-4 h-4" /> AI 진단 결과
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="relative z-10 flex items-end justify-between">
                                    <div>
                                        <p className="text-sm font-medium mb-1">특허 등록 가능성</p>
                                        <div className="flex items-baseline gap-1">
                                            <span className="text-5xl font-black">{aiResult.patentabilityScore}</span>
                                            <span className="text-xl font-bold text-indigo-300">%</span>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        {aiResult.patentabilityScore >= 80 ? (
                                            <span className="bg-green-500/20 text-green-300 px-3 py-1 rounded-full text-sm font-bold border border-green-500/50">출원 강력 권장</span>
                                        ) : aiResult.patentabilityScore >= 50 ? (
                                            <span className="bg-yellow-500/20 text-yellow-300 px-3 py-1 rounded-full text-sm font-bold border border-yellow-500/50">아이디어 보완 필요</span>
                                        ) : (
                                            <span className="bg-red-500/20 text-red-300 px-3 py-1 rounded-full text-sm font-bold border border-red-500/50">기존 유사 특허 존재 확률 높음</span>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>

                            {/* 명세서 초안 카드 */}
                            <Card className="shadow-md border-slate-200">
                                <CardHeader className="bg-slate-50 border-b pb-4">
                                    <CardTitle className="text-lg leading-snug">
                                        <span className="text-xs font-bold text-purple-600 block mb-1">발명의 명칭</span>
                                        {aiResult.title}
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="p-0 divide-y divide-slate-100">
                                    <div className="p-5 space-y-2 hover:bg-slate-50 transition-colors">
                                        <div className="flex items-center gap-2 text-slate-800 font-bold">
                                            <div className="w-1.5 h-4 bg-purple-500 rounded-full"></div> 배경 기술 및 문제점
                                        </div>
                                        <p className="text-slate-600 text-sm leading-relaxed pl-3">{aiResult.background}</p>
                                    </div>
                                    <div className="p-5 space-y-2 hover:bg-slate-50 transition-colors">
                                        <div className="flex items-center gap-2 text-slate-800 font-bold">
                                            <div className="w-1.5 h-4 bg-blue-500 rounded-full"></div> 핵심 해결 방안 (Idea)
                                        </div>
                                        <p className="text-slate-600 text-sm leading-relaxed pl-3">{aiResult.coreIdea}</p>
                                    </div>
                                    <div className="p-5 space-y-2 hover:bg-slate-50 transition-colors">
                                        <div className="flex items-center gap-2 text-slate-800 font-bold">
                                            <div className="w-1.5 h-4 bg-emerald-500 rounded-full"></div> 기대 효과
                                        </div>
                                        <p className="text-slate-600 text-sm leading-relaxed pl-3">{aiResult.effect}</p>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* 컨설턴트 피드백 */}
                            <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 shadow-sm">
                                <div className="flex items-center gap-2 font-bold text-amber-800 mb-2">
                                    <AlertCircle className="w-5 h-5" /> 전문가 피드백 (Next Step)
                                </div>
                                <p className="text-amber-900 text-sm leading-relaxed">
                                    {aiResult.consultingFeedback}
                                </p>
                            </div>

                            {/* 데이터 자산화 버튼 */}
                            <Button
                                onClick={handleSaveAsset}
                                disabled={isSaving}
                                className="w-full h-14 bg-slate-900 hover:bg-slate-800 text-white text-lg font-bold rounded-xl shadow-lg mt-4"
                            >
                                {isSaving ? <Loader2 className="animate-spin mr-2" /> : <FileText className="mr-2" />}
                                사내 지식 자산으로 등록하기
                            </Button>

                        </div>
                    )}

                </div>
            </div>
        </div>
    )
}