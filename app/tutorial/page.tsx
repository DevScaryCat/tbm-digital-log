// app/tutorial/page.tsx — 가입 직후 1분 튜토리얼
// 두 경로, 같은 도착지: ① 30초 대본 낭독(실제 STT→AI 파이프라인) ② 예시로 바로 보기(사전 계산, 비용 0)
// 어느 쪽이든 "완성된 회의록"을 1분 안에 목격시키는 것이 목표. 건너뛰기는 항상 노출.
// 로그인 없이도 열람 가능(기본 건설업 샘플) — tutorial_seen_at 저장만 세션 필요.
"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { supabase } from "@/lib/supabaseClient"
import { AlertCircle, ChevronLeft, ChevronRight, Eye, FileText, Loader2, Mic, Square } from "lucide-react"
import { cn } from "@/lib/utils"
import { getTutorialSample, type TutorialHazard, type TutorialSample } from "@/lib/tutorialSamples"

// tbm-minutes와 동일한 최소 Web Speech API 타입
interface SpeechRecognitionEvent {
    resultIndex: number
    results: { length: number; [key: number]: { isFinal: boolean; [key: number]: { transcript: string } } }
}
interface SpeechRecognitionErrorEvent { error: string }
interface SpeechRecognition {
    continuous: boolean
    interimResults: boolean
    lang: string
    onresult: (event: SpeechRecognitionEvent) => void
    onerror: (event: SpeechRecognitionErrorEvent) => void
    onend: () => void
    start: () => void
    stop: () => void
}
interface CustomWindow extends Window {
    SpeechRecognition?: new () => SpeechRecognition
    webkitSpeechRecognition?: new () => SpeechRecognition
}

interface ResultData {
    processName: string
    workName: string
    workContent: string
    instructions: string
    hazards: TutorialHazard[]
}

const MAX_DEMO_SECONDS = 90

const LEVEL_BADGE: Record<string, string> = {
    "상": "bg-cur-error/10 text-cur-error",
    "중": "bg-cur-primary/10 text-cur-primary",
    "하": "bg-cur-success/10 text-cur-success",
}

export default function TutorialPage() {
    const router = useRouter()
    const [view, setView] = useState<"intro" | "record" | "result">("intro")
    const [sample, setSample] = useState<TutorialSample>(() => getTutorialSample(null))
    const [result, setResult] = useState<ResultData | null>(null)
    const [source, setSource] = useState<"sample" | "record">("sample")
    const [hasSession, setHasSession] = useState(false)

    // 녹음 상태
    const [isRecording, setIsRecording] = useState(false)
    const [seconds, setSeconds] = useState(0)
    const [transcript, setTranscript] = useState("")
    const [interim, setInterim] = useState("")
    const [aiLoading, setAiLoading] = useState(false)
    const [errorMsg, setErrorMsg] = useState<string | null>(null)

    const recognitionRef = useRef<SpeechRecognition | null>(null)
    const manualStopRef = useRef(false)
    const transcriptRef = useRef("")
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    useEffect(() => {
        ;(async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (session) {
                setHasSession(true)
                setSample(getTutorialSample(session.user.user_metadata?.industry))
            }
        })()
        return () => {
            manualStopRef.current = true
            try { recognitionRef.current?.stop() } catch {}
            if (timerRef.current) clearInterval(timerRef.current)
        }
    }, [])

    // 완료/건너뛰기 공통 — 다시 안 보이게 표시하고 이동 (실패해도 이동은 한다)
    const markSeenAndGo = async () => {
        if (hasSession) {
            try { await supabase.auth.updateUser({ data: { tutorial_seen_at: new Date().toISOString() } }) } catch {}
        }
        router.push(hasSession ? "/" : "/login")
    }

    const stopRecognition = () => {
        manualStopRef.current = true
        try { recognitionRef.current?.stop() } catch {}
        recognitionRef.current = null
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
        setIsRecording(false)
        setInterim("")
    }

    const startRecording = () => {
        const SR = (window as unknown as CustomWindow).SpeechRecognition || (window as unknown as CustomWindow).webkitSpeechRecognition
        if (!SR) {
            setErrorMsg("이 브라우저는 음성 인식을 지원하지 않아요. 아래 버튼으로 완성된 예시를 바로 볼 수 있어요.")
            return
        }
        setErrorMsg(null)
        setTranscript("")
        transcriptRef.current = ""
        setInterim("")
        setSeconds(0)
        manualStopRef.current = false

        const rec = new SR()
        rec.continuous = true
        rec.interimResults = true
        rec.lang = "ko-KR"
        rec.onresult = (event) => {
            let interimText = ""
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const r = event.results[i]
                if (r.isFinal) transcriptRef.current += r[0].transcript + " "
                else interimText += r[0].transcript
            }
            setTranscript(transcriptRef.current)
            setInterim(interimText)
        }
        rec.onerror = (event) => {
            if (event.error === "not-allowed" || event.error === "service-not-allowed") {
                setErrorMsg("마이크 사용 권한이 필요해요. 브라우저 주소창의 권한 설정을 확인해 주세요.")
                stopRecognition()
            }
            // no-speech 등은 onend의 자동 재시작에 맡긴다
        }
        rec.onend = () => {
            if (!manualStopRef.current && recognitionRef.current === rec) {
                try { rec.start() } catch { /* 재시작 실패 시 사용자가 완료를 누르면 됨 */ }
            }
        }
        recognitionRef.current = rec
        rec.start()
        setIsRecording(true)
        timerRef.current = setInterval(() => {
            setSeconds((s) => {
                if (s + 1 >= MAX_DEMO_SECONDS) { finishRecording(); return s + 1 }
                return s + 1
            })
        }, 1000)
    }

    const finishRecording = () => {
        stopRecognition()
        const text = transcriptRef.current.trim()
        if (text.length < 20) {
            setErrorMsg("음성이 거의 인식되지 않았어요. 조용한 곳에서 다시 읽어보시거나, 완성된 예시를 바로 볼 수도 있어요.")
            return
        }
        runAi(text)
    }

    const runAi = async (text: string) => {
        setAiLoading(true)
        setErrorMsg(null)
        try {
            const res = await fetch("/api/ai/minutes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || "요약에 실패했습니다.")
            const hazards: TutorialHazard[] = (Array.isArray(data.hazards) ? data.hazards : []).map((h: { factor?: string; level?: string; measure?: string }) => ({
                factor: h.factor ?? "",
                level: h.level === "상" || h.level === "하" ? h.level : "중",
                measure: h.measure ?? "",
            }))
            setResult({
                processName: data.processName ?? "",
                workName: data.workName ?? "",
                workContent: data.workContent ?? "",
                instructions: data.instructions ?? "",
                hazards,
            })
            setSource("record")
            setView("result")
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : "요약에 실패했습니다. 완성된 예시를 바로 볼 수도 있어요.")
        } finally {
            setAiLoading(false)
        }
    }

    const showSampleResult = () => {
        stopRecognition()
        setErrorMsg(null)
        setResult({
            processName: sample.processName,
            workName: sample.workName,
            workContent: sample.workContent,
            instructions: sample.instructions,
            hazards: sample.hazards,
        })
        setSource("sample")
        setView("result")
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-cur-canvas p-4 font-sans text-cur-ink">
            <div className="w-full max-w-md">

                {view === "intro" && (
                    <div className="bg-cur-card border border-cur-hairline rounded-[24px] shadow-[0_1px_3px_rgba(0,0,0,0.04)] px-6 py-10 sm:px-8 space-y-8">
                        <div className="text-center space-y-3">
                            <h1 className="text-[26px] font-semibold text-cur-ink tracking-[-0.78px] leading-tight">말하면, 서류가 됩니다</h1>
                            <p className="text-[15px] text-cur-body font-medium leading-relaxed">
                                안전톡톡이 회의록을 어떻게 만들어주는지<br />1분만 보여드릴게요.
                            </p>
                        </div>

                        <div className="space-y-3">
                            <button
                                type="button"
                                onClick={() => { setErrorMsg(null); setView("record") }}
                                className="w-full flex items-center gap-4 p-4 rounded-[12px] border border-cur-hairline bg-cur-card text-left hover:bg-cur-elevated active:bg-cur-elevated transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                            >
                                <span className="w-12 h-12 shrink-0 rounded-[12px] bg-cur-primary/10 flex items-center justify-center">
                                    <Mic className="w-6 h-6 text-cur-primary" />
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[16px] font-semibold text-cur-ink">30초만 말해보기</span>
                                    <span className="block text-[13px] text-cur-body mt-0.5 leading-snug">화면의 대본을 따라 읽으면 AI가 바로 회의록을 만들어드려요</span>
                                </span>
                                <ChevronRight className="w-5 h-5 shrink-0 text-cur-muted-soft" />
                            </button>

                            <button
                                type="button"
                                onClick={showSampleResult}
                                className="w-full flex items-center gap-4 p-4 rounded-[12px] border border-cur-hairline bg-cur-card text-left hover:bg-cur-elevated active:bg-cur-elevated transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                            >
                                <span className="w-12 h-12 shrink-0 rounded-[12px] bg-cur-elevated flex items-center justify-center">
                                    <Eye className="w-6 h-6 text-cur-ink" />
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[16px] font-semibold text-cur-ink">예시로 먼저 보기</span>
                                    <span className="block text-[13px] text-cur-body mt-0.5 leading-snug">녹음 없이 완성된 회의록 예시를 바로 보여드려요</span>
                                </span>
                                <ChevronRight className="w-5 h-5 shrink-0 text-cur-muted-soft" />
                            </button>
                        </div>

                        <div className="text-center space-y-1.5">
                            <button
                                type="button"
                                onClick={markSeenAndGo}
                                className="text-[14px] font-medium text-cur-muted hover:text-cur-ink underline underline-offset-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[4px]"
                            >
                                건너뛰고 시작하기
                            </button>
                            <p className="text-[12px] text-cur-muted-soft">나중에 홈에서 언제든 볼 수 있어요</p>
                        </div>
                    </div>
                )}

                {view === "record" && (
                    <div className="bg-cur-card border border-cur-hairline rounded-[24px] shadow-[0_1px_3px_rgba(0,0,0,0.04)] px-6 py-8 sm:px-8 space-y-6">
                        <div className="space-y-2">
                            <button
                                type="button"
                                onClick={() => { stopRecognition(); setErrorMsg(null); setView("intro") }}
                                className="inline-flex items-center gap-1 text-[13px] font-medium text-cur-muted hover:text-cur-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[4px]"
                            >
                                <ChevronLeft className="w-4 h-4" /> 처음으로
                            </button>
                            <h2 className="text-[22px] font-semibold text-cur-ink tracking-[-0.44px]">이 대본을 따라 읽어보세요</h2>
                            <p className="text-[14px] text-cur-body">아침 조회에서 말하듯 편하게 읽으시면 돼요. ({sample.industry} 예시)</p>
                        </div>

                        <div className="rounded-[12px] bg-cur-canvas p-5">
                            <p className="text-[17px] leading-[1.8] text-cur-ink font-medium">{sample.script}</p>
                        </div>

                        {errorMsg && (
                            <div className="flex items-start gap-2 p-4 text-[14px] font-medium text-cur-error bg-cur-error/5 rounded-[8px] border border-cur-error/20">
                                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                                <span>{errorMsg}</span>
                            </div>
                        )}

                        {aiLoading ? (
                            <div className="flex flex-col items-center gap-3 py-4">
                                <Loader2 className="w-8 h-8 text-cur-primary animate-spin" />
                                <p className="text-[15px] font-medium text-cur-body">AI가 회의록을 만들고 있어요…</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {!isRecording ? (
                                    <Button
                                        type="button"
                                        onClick={startRecording}
                                        className="w-full h-14 text-[16px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px] font-medium transition-transform active:scale-[0.98]"
                                    >
                                        <Mic className="w-5 h-5 mr-1" /> {transcript ? "다시 읽기" : "녹음 시작"}
                                    </Button>
                                ) : (
                                    <Button
                                        type="button"
                                        onClick={finishRecording}
                                        className="w-full h-14 text-[16px] bg-cur-error hover:bg-cur-error/90 text-white rounded-[8px] font-medium transition-transform active:scale-[0.98]"
                                    >
                                        <Square className="w-4 h-4 mr-1.5 fill-current" /> 다 읽었어요 ({Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")})
                                    </Button>
                                )}

                                {(transcript || interim) && (
                                    <p className="text-[13px] text-cur-muted leading-relaxed px-1 max-h-24 overflow-y-auto" aria-live="polite">
                                        {transcript}
                                        <span className="text-cur-muted-soft">{interim}</span>
                                    </p>
                                )}

                                <button
                                    type="button"
                                    onClick={showSampleResult}
                                    className="w-full text-center text-[13px] font-medium text-cur-muted hover:text-cur-ink underline underline-offset-4 transition-colors py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[4px]"
                                >
                                    녹음 없이 완성된 예시만 볼래요
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {view === "result" && result && (
                    <div className="space-y-4">
                        <div className="bg-cur-card border border-cur-hairline rounded-[24px] shadow-[0_1px_3px_rgba(0,0,0,0.04)] px-6 py-8 sm:px-8 space-y-5">
                            <div className="space-y-2">
                                <span className={cn(
                                    "inline-block text-[12px] font-bold px-2.5 py-1 rounded-full",
                                    source === "sample" ? "bg-cur-elevated text-cur-body" : "bg-cur-success/10 text-cur-success"
                                )}>
                                    {source === "sample" ? `예시 화면 · ${sample.industry}` : "방금 읽으신 내용으로 만든 결과예요"}
                                </span>
                                <h2 className="text-[22px] font-semibold text-cur-ink tracking-[-0.44px]">이런 회의록이 완성돼요</h2>
                                <p className="text-[14px] text-cur-body">체험 결과는 저장되지 않아요. 실제 문서에는 참석자 서명까지 들어갑니다.</p>
                            </div>

                            {/* 문서 미리보기 */}
                            <div className="relative rounded-[12px] border border-cur-hairline-strong bg-cur-card overflow-hidden">
                                <p aria-hidden className="pointer-events-none select-none absolute inset-0 flex items-center justify-center text-[64px] font-bold text-cur-ink/[0.04] -rotate-12 tracking-widest">예시</p>
                                <div className="px-4 py-3 border-b border-cur-hairline text-center">
                                    <p className="text-[15px] font-bold text-cur-ink tracking-[0.3px]">TBM 회의록</p>
                                </div>
                                <div className="divide-y divide-cur-hairline text-[13px]">
                                    <div className="flex px-4 py-2.5">
                                        <span className="w-16 shrink-0 text-cur-muted font-medium">공정명</span>
                                        <span className="text-cur-ink font-medium">{result.processName}</span>
                                    </div>
                                    <div className="flex px-4 py-2.5">
                                        <span className="w-16 shrink-0 text-cur-muted font-medium">작업명</span>
                                        <span className="text-cur-ink font-medium">{result.workName}</span>
                                    </div>
                                    <div className="flex px-4 py-2.5">
                                        <span className="w-16 shrink-0 text-cur-muted font-medium">작업내용</span>
                                        <span className="text-cur-ink font-medium leading-snug">{result.workContent}</span>
                                    </div>
                                    <div className="px-4 py-3 space-y-2.5">
                                        <p className="text-[12px] font-semibold text-cur-muted uppercase tracking-[0.6px]">위험성평가</p>
                                        {result.hazards.map((h, i) => (
                                            <div key={i} className="space-y-0.5">
                                                <div className="flex items-center gap-2">
                                                    <span className={cn("shrink-0 text-[11px] font-bold px-1.5 py-0.5 rounded-[6px]", LEVEL_BADGE[h.level] ?? LEVEL_BADGE["중"])}>{h.level}</span>
                                                    <span className="text-cur-ink font-medium leading-snug">{h.factor}</span>
                                                </div>
                                                <p className="text-cur-body pl-[34px] leading-snug">→ {h.measure}</p>
                                            </div>
                                        ))}
                                    </div>
                                    {result.instructions && (
                                        <div className="flex px-4 py-2.5">
                                            <span className="w-16 shrink-0 text-cur-muted font-medium">협의사항</span>
                                            <span className="text-cur-ink font-medium leading-snug">{result.instructions}</span>
                                        </div>
                                    )}
                                    <div className="flex px-4 py-2.5 items-center">
                                        <span className="w-16 shrink-0 text-cur-muted font-medium">참석자</span>
                                        <span className="text-cur-muted-soft font-medium">근로자들이 QR코드로 서명해요</span>
                                    </div>
                                </div>
                            </div>

                            {/* 실제 사용 4단계 */}
                            <div className="rounded-[12px] bg-cur-canvas p-4">
                                <p className="text-[13px] font-semibold text-cur-ink mb-2">실제 사용은 딱 4단계</p>
                                <ol className="flex items-center gap-1 text-[12px] font-medium text-cur-body">
                                    {["녹음", "검토", "서명", "출력"].map((step, i) => (
                                        <li key={step} className="flex items-center gap-1">
                                            <span className="flex items-center gap-1 bg-cur-card border border-cur-hairline rounded-full px-2.5 py-1">
                                                <span className="text-cur-muted">{i + 1}</span> {step}
                                            </span>
                                            {i < 3 && <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft" />}
                                        </li>
                                    ))}
                                </ol>
                            </div>

                            <div className="space-y-2.5 pt-1">
                                <Button
                                    type="button"
                                    onClick={markSeenAndGo}
                                    className="w-full h-14 text-[16px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px] font-medium transition-transform active:scale-[0.98]"
                                >
                                    <FileText className="w-5 h-5 mr-1" /> 시작하기
                                </Button>
                                {source === "sample" && (
                                    <button
                                        type="button"
                                        onClick={() => { setErrorMsg(null); setView("record") }}
                                        className="w-full text-center text-[13px] font-medium text-cur-muted hover:text-cur-ink underline underline-offset-4 transition-colors py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[4px]"
                                    >
                                        내 목소리로도 해볼래요 (30초)
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
