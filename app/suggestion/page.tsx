"use client"

import { useState, useRef } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Mic, StopCircle, Loader2, ArrowLeft, CheckCircle2, Upload, AlertTriangle, Lightbulb, Wrench } from "lucide-react"
import { cn } from "@/lib/utils"

export default function SuggestionPage() {
    const router = useRouter()
    const [isRecording, setIsRecording] = useState(false)
    const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
    const audioChunks = useRef<Blob[]>([])
    const fileInputRef = useRef<HTMLInputElement>(null)

    const [isProcessingSTT, setIsProcessingSTT] = useState(false)
    const [isProcessingAI, setIsProcessingAI] = useState(false)

    const [transcript, setTranscript] = useState("")
    const [aiResult, setAiResult] = useState<any>(null)

    // 1. 오디오 처리 및 STT 요청 (Deepgram)
    const processAudioBlob = async (blob: Blob) => {
        const file = new File([blob], "suggestion.webm", { type: blob.type })
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
                await requestAIClassification(data.transcript) // STT 성공 시 바로 AI 분류 요청
            } else {
                alert("음성이 인식되지 않았습니다. 다시 크게 말씀해주세요.")
            }
        } catch (e: any) {
            console.error(e)
            alert("음성 처리 오류: " + e.message)
        } finally {
            setIsProcessingSTT(false)
        }
    }

    // 2. AI 분류 요청 (Claude)
    const requestAIClassification = async (text: string) => {
        setIsProcessingAI(true)
        try {
            const res = await fetch('/api/ai/classify', {
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

    // 파일 업로드 핸들러 (녹음 불가 환경 대비)
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
                await requestAIClassification(data.transcript)
            }
        } catch (e: any) {
            alert("파일 처리 오류: " + e.message)
        } finally {
            setIsProcessingSTT(false)
            if (fileInputRef.current) fileInputRef.current.value = ""
        }
    }

    // 녹음 시작/종료
    const toggleRecording = async () => {
        if (isRecording) {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop()
                setIsRecording(false)
            }
        } else {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                alert("현재 브라우저가 마이크를 지원하지 않습니다. 오디오 파일을 업로드해주세요.")
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

    // 카테고리별 UI 아이콘/색상 세팅
    const getCategoryConfig = (category: string) => {
        switch (category) {
            case "SAFETY": return { color: "text-red-600 bg-red-100", border: "border-red-500", icon: <AlertTriangle className="w-8 h-8 text-red-600" />, label: "긴급 안전요소" }
            case "INNOVATION": return { color: "text-purple-600 bg-purple-100", border: "border-purple-500", icon: <Lightbulb className="w-8 h-8 text-purple-600" />, label: "혁신/특허 제안" }
            default: return { color: "text-blue-600 bg-blue-100", border: "border-blue-500", icon: <Wrench className="w-8 h-8 text-blue-600" />, label: "일반 시설민원" }
        }
    }

    return (
        <div className="min-h-screen bg-slate-50 flex flex-col items-center">
            <div className="w-full max-w-md bg-white min-h-screen shadow-lg relative flex flex-col">

                {/* 상단 헤더 */}
                <div className="p-4 flex items-center border-b bg-white sticky top-0 z-10">
                    <Button variant="ghost" size="icon" onClick={() => router.push('/')} className="mr-2">
                        <ArrowLeft className="w-6 h-6" />
                    </Button>
                    <h1 className="text-xl font-bold text-slate-800">현장 제안함 (음성)</h1>
                </div>

                <div className="flex-1 flex flex-col p-6 space-y-8">

                    <div className="text-center space-y-2 mt-4">
                        <h2 className="text-2xl font-extrabold text-slate-900">무엇이든 말씀해주세요</h2>
                        <p className="text-slate-500">불편한 점, 위험한 곳, 새로운 아이디어를<br />말로 편하게 알려주시면 AI가 알아서 분류합니다.</p>
                    </div>

                    {/* 중앙 거대 마이크 버튼 */}
                    <div className="flex flex-col items-center justify-center flex-1 py-10">
                        <div className="relative">
                            {isRecording && (
                                <div className="absolute inset-0 bg-red-500 rounded-full animate-ping opacity-20 scale-150"></div>
                            )}
                            <Button
                                onClick={toggleRecording}
                                disabled={isProcessingSTT || isProcessingAI}
                                className={cn(
                                    "w-32 h-32 rounded-full flex items-center justify-center transition-all duration-300 shadow-2xl relative z-10",
                                    isRecording ? "bg-red-500 hover:bg-red-600" : "bg-emerald-500 hover:bg-emerald-600"
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
                        <div className="mt-6 text-lg font-bold text-slate-700 h-8">
                            {isProcessingSTT ? "음성을 텍스트로 변환 중..." : isProcessingAI ? "AI가 내용을 분석하고 있습니다..." : isRecording ? "녹음 중입니다... (터치하여 종료)" : "버튼을 눌러 말하기"}
                        </div>

                        {/* 파일 업로드 대체 */}
                        {!isRecording && !isProcessingSTT && !isProcessingAI && (
                            <div className="mt-8">
                                <input type="file" ref={fileInputRef} className="hidden" accept="audio/*, .m4a, .mp3, .wav" onChange={handleFileUpload} />
                                <Button variant="outline" onClick={() => fileInputRef.current?.click()} className="text-slate-500 rounded-full">
                                    <Upload className="w-4 h-4 mr-2" /> 직접 오디오 파일 올리기
                                </Button>
                            </div>
                        )}
                    </div>

                    {/* AI 분석 결과 카드 */}
                    {aiResult && (
                        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 pb-10">
                            <Card className={cn("border-l-8 shadow-md", getCategoryConfig(aiResult.category).border)}>
                                <CardContent className="p-5 space-y-4">
                                    <div className="flex items-center justify-between border-b pb-3">
                                        <div className={cn("px-3 py-1 rounded-full text-sm font-bold flex items-center gap-2", getCategoryConfig(aiResult.category).color)}>
                                            {getCategoryConfig(aiResult.category).icon}
                                            {getCategoryConfig(aiResult.category).label}
                                        </div>
                                        <span className="text-sm font-bold text-slate-500 bg-slate-100 px-2 py-1 rounded">담당: {aiResult.department}</span>
                                    </div>

                                    <div>
                                        <h3 className="text-xl font-extrabold text-slate-900 mb-2">{aiResult.title}</h3>
                                        <p className="text-slate-600 leading-relaxed bg-slate-50 p-3 rounded-lg border border-slate-100">{aiResult.summary}</p>
                                    </div>

                                    <div className="pt-2">
                                        <p className="text-xs text-slate-400 mb-1">원본 인식 내용:</p>
                                        <p className="text-sm text-slate-500 italic">"{transcript}"</p>
                                    </div>

                                    <Button className="w-full h-12 bg-slate-900 hover:bg-slate-800 text-white text-lg rounded-xl mt-4" onClick={() => {
                                        alert("성공적으로 담당 부서에 전송되었습니다!")
                                        setAiResult(null)
                                        setTranscript("")
                                    }}>
                                        <CheckCircle2 className="w-5 h-5 mr-2" /> 접수 완료하기
                                    </Button>
                                </CardContent>
                            </Card>
                        </div>
                    )}

                </div>
            </div>
        </div>
    )
}