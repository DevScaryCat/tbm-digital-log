"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import SignatureCanvas from "react-signature-canvas"
import { format } from "date-fns"
import { ko } from "date-fns/locale"
import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Mic, CheckCircle2, Plus, Trash2, PenTool, Loader2, Save, CalendarIcon, Clock, RefreshCw, Send, Pause, Play, QrCode, Copy } from "lucide-react"
import { v4 as uuidv4 } from "uuid"
import { QRCodeCanvas } from "qrcode.react"

// 타입 정의
interface Participant {
    id: number
    name: string
    gender: "M" | "F"
    signature: string | null
}

interface Hazard {
    factor: string
    level: string
    measure: string
}

interface TBMMinutesData {
    date: Date | undefined
    startTime: string
    endTime: string
    location: string
    processName: string
    workName: string
    workContent: string
    leaderTitle: string
    leaderName: string
    healthCheck: string
    ppeCheck: string
    safetyPhrase: string
    instructions: string
    hazards: Hazard[]
    participants: Participant[]
}

export default function TBMMinutesPage() {
    const router = useRouter()
    const [isLoading, setIsLoading] = useState(true)
    const [isSaving, setIsSaving] = useState(false)
    const [step, setStep] = useState(1)
    const [savedLogId, setSavedLogId] = useState<string | null>(null)
    const [sessionId, setSessionId] = useState<string | null>(null)

    // 녹음 관련 상태
    const [isRecording, setIsRecording] = useState(false)
    const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
    const audioChunks = useRef<Blob[]>([])
    const [accumulatedBlobs, setAccumulatedBlobs] = useState<Blob[]>([])
    const [recordingCount, setRecordingCount] = useState(0)

    const [recordingTime, setRecordingTime] = useState(0)
    const sessionStartTimeRef = useRef<number | null>(null);
    const accumulatedTimeRef = useRef<number>(0);
    const MAX_RECORDING_TIME = 1200; // 20 minutes in seconds

    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isRecording) {
            if (!sessionStartTimeRef.current) {
                sessionStartTimeRef.current = Date.now();
            }

            interval = setInterval(() => {
                if (sessionStartTimeRef.current) {
                    const now = Date.now();
                    const elapsed = Math.floor((now - sessionStartTimeRef.current) / 1000);
                    const total = accumulatedTimeRef.current + elapsed;
                    setRecordingTime(total);

                    if (total >= MAX_RECORDING_TIME) {
                        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                            mediaRecorder.stop();
                            setIsRecording(false);
                            alert("최대 녹음 시간(20분)에 도달했습니다. 녹음이 자동 종료되었습니다.");
                        }
                    }
                }
            }, 1000);
        } else {
            if (sessionStartTimeRef.current) {
                const now = Date.now();
                const elapsed = Math.floor((now - sessionStartTimeRef.current) / 1000);
                accumulatedTimeRef.current += elapsed;
                sessionStartTimeRef.current = null;
                setRecordingTime(accumulatedTimeRef.current);
            }
        }
        return () => clearInterval(interval);
    }, [isRecording, mediaRecorder]);

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60).toString().padStart(2, '0');
        const s = (seconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }

    const fileInputRef = useRef<HTMLInputElement>(null)

    const [isProcessingSTT, setIsProcessingSTT] = useState(false)
    const [isProcessingAI, setIsProcessingAI] = useState(false)

    const [isSignOpen, setIsSignOpen] = useState(false)
    const [currentSignTarget, setCurrentSignTarget] = useState<{ type: 'participant' | 'leader', id?: number } | null>(null)
    const [leaderSignature, setLeaderSignature] = useState<string | null>(null)
    const sigCanvas = useRef<SignatureCanvas>(null)

    const getCurrentTime = () => {
        const now = new Date()
        return now.toTimeString().slice(0, 5)
    }

    const [formData, setFormData] = useState<TBMMinutesData>({
        date: new Date(),
        startTime: getCurrentTime(),
        endTime: getCurrentTime(), // 초기엔 시작시간과 동일하게 둠 (저장 시 갱신)
        location: "현장 지정구역",
        processName: "",
        workName: "",
        workContent: "",
        leaderTitle: "반장",
        leaderName: "",
        healthCheck: "해당없음",
        ppeCheck: "안전모, 안전화",
        safetyPhrase: "안전제일!",
        instructions: "",
        hazards: [],
        participants: [{ id: 1, name: "", gender: "M", signature: null }],
    })

    const hours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0'))
    const minutes = ["00", "10", "20", "30", "40", "50"]

    useEffect(() => {
        const initPage = async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) { router.push("/"); return; }

            setFormData(prev => ({
                ...prev,
                leaderName: session.user.user_metadata.full_name || session.user.email?.split("@")[0] || "",
                startTime: getCurrentTime()
            }))
            setIsLoading(false)
        }
        initPage()
    }, [router])

    const sessionIdRef = useRef(sessionId);
    const stepRef = useRef(step);

    useEffect(() => {
        sessionIdRef.current = sessionId;
        stepRef.current = step;
    }, [sessionId, step]);

    useEffect(() => {
        return () => {
            const currentSession = sessionIdRef.current;
            const currentStep = stepRef.current;
            if (currentSession && currentStep !== 5) {
                console.log("Abandoning session (unmount): ", currentSession);
                try {
                    supabase.from('tbm_pending_signatures').insert({
                        session_id: currentSession,
                        name: "CLOSED_SESSION",
                        gender: "M",
                        signature: "abandoned"
                    }).then();
                } catch {}
            }
        };
    }, []);

    useEffect(() => {
        if (step === 4) { // 명단 스텝이 4입니다
            let currentSessionId = sessionId;
            if (!currentSessionId) {
                currentSessionId = uuidv4();
                setSessionId(currentSessionId);

                supabase.from('tbm_pending_signatures').insert({
                    session_id: currentSessionId,
                    name: "OPEN_SESSION",
                    gender: "M",
                    signature: "init"
                }).then();
            }

            const channel = supabase.channel(`public:tbm_pending_signatures:${currentSessionId}`)
                .on(
                    'postgres_changes',
                    { event: 'INSERT', schema: 'public', table: 'tbm_pending_signatures', filter: `session_id=eq.${currentSessionId}` },
                    (payload) => {
                        const newSignature = payload.new;
                        setFormData(prev => {
                            if (newSignature.name === "OPEN_SESSION" || newSignature.name === "CLOSED_SESSION") return prev;

                            const participants = [...prev.participants];
                            participants.push({
                                id: Date.now() + Math.random(),
                                name: newSignature.name,
                                gender: newSignature.gender as "M" | "F",
                                signature: newSignature.signature
                            });
                            return { ...prev, participants };
                        });
                    }
                )
                .subscribe();

            return () => { supabase.removeChannel(channel); }
        }
    }, [step, sessionId]);

    const validateStep = (currentStep: number) => {
        if (currentStep === 1) {
            if (!formData.date) return "TBM 일시를 선택해주세요.";
            if (!formData.location) return "TBM 장소를 입력해주세요.";
            if (!formData.leaderName) return "TBM 리더 성명을 입력해주세요.";
            if (!leaderSignature) return "TBM 리더 서명을 완료해주세요.";
            if (!formData.processName) return "공정명을 입력해주세요.";
        }
        if (currentStep === 3) {
            // 내용 확인 단계 검증 (필수는 아니지만 경고 가능)
        }
        if (currentStep === 4) {
            const validParticipants = formData.participants.filter(p => p.name.trim() !== "" || p.signature);
            if (validParticipants.length === 0) return "최소 1명 이상의 참석자 서명이 필요합니다.";
            const missingSign = validParticipants.find(p => !p.signature);
            if (missingSign) return `${missingSign.name || '참석자'} 님의 서명이 누락되었습니다.`;
            if (validParticipants.some(p => !p.name.trim())) return "참석자 이름을 모두 입력해주세요.";
        }
        return null;
    }

    const handleNext = () => {
        const errorMsg = validateStep(step);
        if (errorMsg) { alert(errorMsg); return; }
        setStep(prev => Math.min(5, prev + 1));
    }

    const saveToDatabase = async () => {
        const errorMsg = validateStep(4);
        if (errorMsg) { alert(errorMsg); return; }

        setIsSaving(true)
        try {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) throw new Error("로그인 필요")

            const { data: logData, error: logError } = await supabase
                .from('tbm_minutes')
                .insert({
                    user_id: session.user.id,
                    date: formData.date ? format(formData.date, "yyyy-MM-dd") : new Date().toISOString().split('T')[0],
                    start_time: formData.startTime,
                    end_time: getCurrentTime(), // 저장 시점 시간
                    location: formData.location,
                    process_name: formData.processName,
                    work_name: formData.workName,
                    work_content: formData.workContent,
                    leader_title: formData.leaderTitle,
                    leader_name: formData.leaderName,
                    leader_signature: leaderSignature,
                    health_check: formData.healthCheck,
                    ppe_check: formData.ppeCheck,
                    safety_phrase: formData.safetyPhrase,
                    instructions: formData.instructions,
                    hazards: formData.hazards
                })
                .select()
                .single()

            if (logError) throw logError

            const validParticipantsForDB = formData.participants.filter(p => p.name.trim() !== "" || p.signature);
            const participantsData = validParticipantsForDB.map(p => ({
                minutes_id: logData.id,
                name: p.name,
                signature: p.signature
            }))

            if(participantsData.length > 0) {
                const { error: partError } = await supabase.from('tbm_minutes_participants').insert(participantsData)
                if (partError) throw partError
            }

            if (sessionId) {
                await supabase.from('tbm_pending_signatures').delete().eq('session_id', sessionId);
                await supabase.from('tbm_pending_signatures').insert({
                    session_id: sessionId, name: "CLOSED_SESSION", gender: "M", signature: "expired"
                })
            }

            setSavedLogId(logData.id)
            setStep(5)

        } catch (e: any) {
            alert("저장 실패: " + e.message)
        } finally {
            setIsSaving(false)
        }
    }

    const requestAIMinutes = async (text: string) => {
        if (!text) return;
        setIsProcessingAI(true)
        try {
            const res = await fetch('/api/ai/minutes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            })
            const data = await res.json()

            if (res.ok) {
                setFormData(prev => ({
                    ...prev,
                    workContent: data.workContent || prev.workContent,
                    hazards: data.hazards || [],
                    instructions: data.instructions || "",
                    safetyPhrase: data.safetyPhrase || prev.safetyPhrase
                }))
                setStep(3);
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

    const processAudioBlob = async (blob: Blob) => {
        const file = new File([blob], "recording.webm", { type: blob.type })
        setIsProcessingSTT(true)

        try {
            const formData = new FormData()
            formData.append("file", file)

            const res = await fetch('/api/stt', { method: 'POST', body: formData })
            const data = await res.json()

            if (!res.ok) throw new Error(data.error || "음성 인식 실패")

            if (data.transcript) {
                requestAIMinutes(data.transcript)
            } else {
                alert("음성이 인식되지 않았습니다. 다시 녹음해주세요.")
            }
        } catch (e: any) {
            console.error(e)
            alert("음성 처리 오류: " + e.message)
        } finally {
            setIsProcessingSTT(false)
        }
    }

    const stopRecording = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop()
            setIsRecording(false)
        }
    }

    const startRecording = async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert("현재 브라우저가 마이크를 지원하지 않습니다.")
            return
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            const recorder = new MediaRecorder(stream)
            audioChunks.current = []
            recorder.ondataavailable = (event) => { if (event.data.size > 0) audioChunks.current.push(event.data) }
            recorder.onstop = () => {
                const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' })
                setAccumulatedBlobs(prev => [...prev, audioBlob])
                setRecordingCount(prev => prev + 1)
                stream.getTracks().forEach(track => track.stop())
            }
            recorder.start()
            setMediaRecorder(recorder)
            setIsRecording(true)
        } catch (err) {
            console.error(err)
            alert("마이크 권한이 필요합니다.")
        }
    }

    const submitRecording = async () => {
        if (accumulatedBlobs.length === 0) { alert("녹음된 내용이 없습니다."); return; }
        const mergedBlob = new Blob(accumulatedBlobs, { type: 'audio/webm' })
        processAudioBlob(mergedBlob)
    }

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setFormData(prev => ({ ...prev, [e.target.name]: e.target.value })) }
    const openSignModal = (target: { type: 'participant' | 'leader', id?: number }) => { setCurrentSignTarget(target); setIsSignOpen(true) }

    const saveSignature = () => {
        if (sigCanvas.current && currentSignTarget) {
            const dataURL = sigCanvas.current.toDataURL()
            if (currentSignTarget.type === 'participant' && currentSignTarget.id) {
                setFormData(prev => ({ ...prev, participants: prev.participants.map(p => p.id === currentSignTarget.id ? { ...p, signature: dataURL } : p) }))
            } else { setLeaderSignature(dataURL) }
            setIsSignOpen(false)
        }
    }

    const addParticipant = () => setFormData(prev => ({ ...prev, participants: [...prev.participants, { id: Date.now(), name: "", gender: "M", signature: null }] }))
    const updateParticipant = (id: number, field: keyof Participant, value: any) => setFormData(prev => ({ ...prev, participants: prev.participants.map(p => p.id === id ? { ...p, [field]: value } : p) }))
    const removeParticipant = (id: number) => { if (formData.participants.length > 1) setFormData(prev => ({ ...prev, participants: prev.participants.filter(p => p.id !== id) })) }

    const addHazard = () => setFormData(prev => ({ ...prev, hazards: [...prev.hazards, { factor: "", level: "중", measure: "" }] }))
    const updateHazard = (idx: number, field: string, value: string) => {
        const newHazards = [...formData.hazards];
        newHazards[idx] = { ...newHazards[idx], [field]: value };
        setFormData(prev => ({ ...prev, hazards: newHazards }));
    }
    const removeHazard = (idx: number) => {
        const newHazards = formData.hazards.filter((_, i) => i !== idx);
        setFormData(prev => ({ ...prev, hazards: newHazards }));
    }

    const CustomTimePicker = ({ value, onChange }: { value: string, onChange: (val: string) => void }) => {
        const [h, m] = value.split(':')
        return (
            <Popover>
                <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start text-left font-normal text-lg h-12 border-slate-300">
                        <Clock className="mr-2 h-5 w-5 text-slate-500" />
                        {value}
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                    <div className="flex h-48">
                        <ScrollArea className="w-20 border-r">
                            <div className="flex flex-col p-2">
                                {hours.map((hour) => (
                                    <Button key={hour} variant="ghost" className={cn("justify-center", h === hour && "bg-slate-100 font-bold")} onClick={() => onChange(`${hour}:${m}`)}>{hour}시</Button>
                                ))}
                            </div>
                        </ScrollArea>
                        <ScrollArea className="w-20">
                            <div className="flex flex-col p-2">
                                {minutes.map((minute) => (
                                    <Button key={minute} variant="ghost" className={cn("justify-center", m === minute && "bg-slate-100 font-bold")} onClick={() => onChange(`${h}:${minute}`)}>{minute}분</Button>
                                ))}
                            </div>
                        </ScrollArea>
                    </div>
                </PopoverContent>
            </Popover>
        )
    }

    if (isLoading) return <div className="min-h-screen flex justify-center items-center"><Loader2 className="animate-spin w-10 h-10 text-slate-500" /></div>

    return (
        <div className="bg-slate-50 min-h-screen sm:py-8 flex sm:block items-center justify-center">
            <div className="max-w-lg w-full mx-auto bg-white sm:shadow-2xl sm:rounded-[2rem] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border mb-[env(safe-area-inset-bottom)]">
                <div className="p-4 bg-white border-b sticky top-0 z-50 sm:rounded-t-[2rem]">
                    <TBMHeader title="TBM 회의록 작성" />
                </div>

                <div className="p-4 space-y-6 flex-1 pb-12">
                    
                    {/* STEP 1: 기본 정보 */}
                    {step === 1 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                                <span className="bg-slate-900 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">1</span> 일반 정보
                            </h2>
                            <div className="space-y-4">
                                <div className="space-y-1.5">
                                    <Label>TBM 일자</Label>
                                    <Popover>
                                        <PopoverTrigger asChild>
                                            <Button variant={"outline"} className={cn("h-12 w-full justify-start text-left font-normal text-lg border-slate-300", !formData.date && "text-muted-foreground")}>
                                                <CalendarIcon className="mr-2 h-5 w-5" />
                                                {formData.date ? format(formData.date, "yyyy년 MM월 dd일 (EEE)", { locale: ko }) : <span>날짜 선택</span>}
                                            </Button>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-auto p-0" align="center">
                                            <Calendar mode="single" locale={ko} selected={formData.date} onSelect={(date) => setFormData(prev => ({ ...prev, date }))} initialFocus />
                                        </PopoverContent>
                                    </Popover>
                                </div>

                                <div className="space-y-1.5">
                                    <div className="flex justify-between">
                                        <Label>교육/회의 시작 시간</Label>
                                        <Button variant="ghost" size="sm" className="h-6 px-1 text-slate-500" onClick={() => setFormData(prev => ({ ...prev, startTime: getCurrentTime() }))}>
                                            <RefreshCw className="w-3 h-3 mr-1" /> 현시간
                                        </Button>
                                    </div>
                                    <CustomTimePicker value={formData.startTime} onChange={(val) => setFormData(prev => ({ ...prev, startTime: val }))} />
                                </div>

                                <div className="space-y-1.5"><Label>TBM 장소</Label><Input name="location" value={formData.location} onChange={handleChange} className="h-12 text-lg border-slate-300" /></div>
                                
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-1.5"><Label>공정명</Label><Input name="processName" placeholder="예: 철근공사" value={formData.processName} onChange={handleChange} className="h-12 text-lg border-slate-300" /></div>
                                    <div className="space-y-1.5"><Label>작업명</Label><Input name="workName" placeholder="예: 철근 조립" value={formData.workName} onChange={handleChange} className="h-12 text-lg border-slate-300" /></div>
                                </div>
                                <div className="space-y-1.5"><Label>작업내용 (상세)</Label><Input name="workContent" value={formData.workContent} onChange={handleChange} className="h-12 text-lg border-slate-300" /></div>

                                <div className="pt-4 border-t border-slate-200">
                                    <Label className="mb-2 block">TBM 리더 정보</Label>
                                    <div className="flex gap-2 mb-2">
                                        <Input name="leaderTitle" value={formData.leaderTitle} onChange={handleChange} className="h-12 text-lg w-1/3 border-slate-300" placeholder="직책" />
                                        <Input name="leaderName" value={formData.leaderName} onChange={handleChange} className="h-12 text-lg flex-1 border-slate-300" placeholder="성명" />
                                    </div>
                                    {leaderSignature ? (
                                        <div onClick={() => openSignModal({ type: 'leader' })} className="h-14 border border-green-500 bg-green-50 rounded-lg flex items-center justify-center cursor-pointer relative overflow-hidden"><img src={leaderSignature} alt="서명" className="h-full object-contain" /><div className="absolute right-2 bottom-1 text-xs text-green-700 font-bold bg-white/80 px-1 rounded">리더 서명 완료</div></div>
                                    ) : (
                                        <Button variant="outline" className="w-full h-14 border-dashed border-2 border-slate-300 text-slate-500 text-lg hover:bg-slate-50" onClick={() => openSignModal({ type: 'leader' })}><PenTool className="mr-2 h-5 w-5" /> 리더 서명하기</Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* STEP 2: 회의 진행 및 녹음 */}
                    {step === 2 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                                <span className="bg-slate-900 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">2</span> 회의 진행 및 녹음
                            </h2>
                            <div className="bg-slate-50 border-2 border-slate-200 rounded-2xl p-6 text-center flex flex-col items-center justify-center min-h-[400px] shadow-inner relative">
                                {(isProcessingSTT || isProcessingAI) ? (
                                    <div className="w-full flex flex-col items-center space-y-6 animate-in fade-in duration-300">
                                        <Loader2 className="w-16 h-16 text-slate-500 animate-spin" />
                                        <p className="text-lg font-bold text-slate-700">
                                            {isProcessingSTT ? "음성을 텍스트로 변환 중..." : "AI가 회의록을 작성 중입니다..."}
                                        </p>
                                    </div>
                                ) : isRecording ? (
                                    <div className="w-full flex flex-col items-center space-y-8 animate-in fade-in duration-300">
                                        {/* 안전구호 제창 안내 */}
                                        <div className="bg-blue-100 text-blue-800 border border-blue-200 px-6 py-4 rounded-xl font-bold w-full text-center shadow-sm">
                                            <div className="text-sm text-blue-600 mb-1">📢 안전구호 제창을 함께 해주세요</div>
                                            <div className="text-2xl">{formData.safetyPhrase}</div>
                                        </div>

                                        <div className="bg-red-100 text-red-600 border border-red-200 px-4 py-2 rounded-full font-bold text-sm flex items-center gap-2 shadow-sm whitespace-nowrap overflow-hidden">
                                            <span className="w-3 h-3 bg-red-600 rounded-full animate-ping shrink-0"></span>
                                            회의 녹음 중 {recordingCount > 0 && `(${recordingCount + 1}회차)`}
                                            <span className="ml-2 font-mono shrink-0">{formatTime(recordingTime)} / 30:00</span>
                                        </div>
                                        <Button onClick={stopRecording} className="w-32 h-32 rounded-full shadow-xl bg-red-500 hover:bg-red-600 flex flex-col items-center justify-center gap-2 mt-4 shrink-0">
                                            <Pause className="w-12 h-12 text-white" />
                                            <span className="text-white font-extrabold text-lg">일시정지</span>
                                        </Button>
                                    </div>
                                ) : recordingCount > 0 ? (
                                    <div className="w-full flex flex-col items-center space-y-6 animate-in fade-in duration-300">
                                        <div className="bg-blue-100 text-blue-800 border border-blue-200 px-6 py-4 rounded-xl font-bold w-full text-center shadow-sm">
                                            <div className="text-sm text-blue-600 mb-1">📢 안전구호 제창을 함께 해주세요</div>
                                            <div className="text-2xl">{formData.safetyPhrase}</div>
                                        </div>

                                        <div className="bg-orange-100 text-orange-700 border border-orange-200 px-4 py-2 rounded-full font-bold text-sm flex items-center gap-2 shadow-sm whitespace-nowrap overflow-hidden">
                                            <Pause className="w-4 h-4 shrink-0" /> 녹음 일시정지 · {recordingCount}회
                                            <span className="ml-2 font-mono shrink-0">{formatTime(recordingTime)} / 30:00</span>
                                        </div>
                                        <div className="w-full space-y-3">
                                            <Button onClick={startRecording} className="w-full h-16 text-lg bg-slate-900 text-white"><Play className="mr-2 w-6 h-6" /> 이어서 녹음</Button>
                                            <Button onClick={submitRecording} className="w-full h-16 text-lg bg-green-600 text-white font-bold"><Send className="mr-2 w-6 h-6" /> 회의 종료 (AI 문서화)</Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="w-full flex flex-col items-center space-y-8 animate-in zoom-in duration-300">
                                        <div className="bg-blue-100 text-blue-800 border border-blue-200 px-6 py-4 rounded-xl font-bold w-full text-center shadow-sm">
                                            <div className="text-sm text-blue-600 mb-1">📢 안전구호 제창을 함께 해주세요</div>
                                            <div className="text-2xl">{formData.safetyPhrase}</div>
                                        </div>

                                        <div className="bg-slate-900 text-white px-4 py-2 rounded-full font-bold text-sm shadow-md">TBM 회의 녹음 시작</div>
                                        <Button onClick={startRecording} className="w-40 h-40 rounded-full shadow-2xl bg-slate-900 flex flex-col gap-3 shrink-0">
                                            <Mic className="w-16 h-16 text-white" />
                                            <span className="text-white font-extrabold text-xl">회의 시작</span>
                                        </Button>
                                    </div>
                                )}
                            </div>
                            <p className="text-sm text-slate-500 leading-relaxed bg-blue-50 p-3 rounded-xl border border-blue-100 text-center shadow-sm">
                                💡 참석자와 함께 위험요인, 대책, 안전구호를 협의해주세요. AI가 자동으로 회의록 양식에 맞게 요약해 배사합니다.
                            </p>
                        </div>
                    )}

                    {/* STEP 3: 내용 확인 및 수정 */}
                    {step === 3 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                                <span className="bg-slate-900 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">3</span> 요약본 확인 및 수정
                            </h2>
                            
                            {/* 작업 내용 확인 영역 */}
                            <div className="bg-white border-2 border-slate-200 rounded-xl overflow-hidden shadow-sm">
                                <div className="bg-slate-100 border-b border-slate-200 px-4 py-2 font-bold text-slate-800">
                                    ■ 금일 작업 내용
                                </div>
                                <div className="p-3">
                                    <textarea
                                        name="workContent"
                                        value={formData.workContent}
                                        onChange={handleChange}
                                        className="w-full p-3 border border-slate-200 rounded-lg h-20 text-base resize-none focus:outline-none focus:border-slate-400 focus:ring-1 focus:ring-slate-400"
                                        placeholder="AI가 요약한 작업 내용을 확인하고 수정하세요."
                                    />
                                </div>
                            </div>

                            {/* 근로자 참여 위험성평가 영역 */}
                            <div className="bg-white border-2 border-orange-200 rounded-xl overflow-hidden shadow-sm">
                                <div className="bg-orange-50 border-b-2 border-orange-200 px-4 py-2 font-bold flex justify-between items-center text-orange-900">
                                    <span>■ 근로자 참여 위험성평가</span>
                                    <Button size="sm" onClick={addHazard} variant="ghost" className="h-7 px-2 hover:bg-orange-200"><Plus className="w-4 h-4 mr-1" /> 요인 추가</Button>
                                </div>
                                <div className="p-3 space-y-4 bg-orange-50/30">
                                    {formData.hazards.length === 0 && <p className="text-sm text-slate-400 text-center py-4">도출된 위험요인이 없습니다.</p>}
                                    {formData.hazards.map((hazard, idx) => (
                                        <div key={idx} className="bg-white p-3 border border-slate-200 rounded-lg shadow-sm space-y-3 relative">
                                            <button onClick={() => removeHazard(idx)} className="absolute top-2 right-2 text-red-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                                            <div>
                                                <Label className="text-xs text-orange-700 font-bold">잠재 유해위험요인</Label>
                                                <Input value={hazard.factor} onChange={(e) => updateHazard(idx, "factor", e.target.value)} className="h-9 mt-1" />
                                            </div>
                                            <div className="flex gap-2">
                                                <div className="w-1/3">
                                                    <Label className="text-xs text-orange-700 font-bold">위험성</Label>
                                                    <select 
                                                        value={hazard.level} 
                                                        onChange={(e) => updateHazard(idx, "level", e.target.value)} 
                                                        className="w-full h-9 mt-1 rounded-md border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                                                    >
                                                        <option value="상">상</option>
                                                        <option value="중">중</option>
                                                        <option value="하">하</option>
                                                        <option value="상중하">상중하 (복합)</option>
                                                    </select>
                                                </div>
                                                <div className="w-2/3">
                                                    <Label className="text-xs text-orange-700 font-bold">대책(제거/대체/통제)</Label>
                                                    <Input value={hazard.measure} onChange={(e) => updateHazard(idx, "measure", e.target.value)} className="h-9 mt-1" />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* 작업 시작전 확인사항 영역 */}
                            <div className="bg-white border-2 border-slate-200 rounded-xl overflow-hidden shadow-sm">
                                <div className="bg-slate-100 border-b border-slate-200 px-4 py-2 font-bold text-slate-800">
                                    ■ 작업 시작전 확인사항
                                </div>
                                <div className="p-3 space-y-3">
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-xs font-bold text-slate-600">개인별 건강상태 이상 유무</Label>
                                        <Input name="healthCheck" value={formData.healthCheck} onChange={handleChange} className="bg-yellow-50 text-slate-800 border-yellow-200" />
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-xs font-bold text-slate-600">개인 보호구 착용 상태</Label>
                                        <Input name="ppeCheck" value={formData.ppeCheck} onChange={handleChange} className="bg-yellow-50 text-slate-800 border-yellow-200" />
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-xs font-bold text-slate-600 text-blue-700">안전구호 제창 (AI 추천)</Label>
                                        <Input name="safetyPhrase" value={formData.safetyPhrase} onChange={handleChange} className="font-bold border-blue-200 text-blue-800" />
                                    </div>
                                </div>
                            </div>

                            {/* 협의 및 지시사항 영역 */}
                            <div className="bg-white border-2 border-slate-200 rounded-xl overflow-hidden shadow-sm">
                                <div className="bg-slate-100 border-b border-slate-200 px-4 py-2 font-bold text-slate-800">
                                    ■ 작업 시작전 협의 및 지시사항
                                </div>
                                <div className="p-3">
                                    <textarea
                                        name="instructions"
                                        value={formData.instructions}
                                        onChange={handleChange}
                                        className="w-full p-3 border border-slate-200 rounded-lg h-32 text-base resize-none focus:outline-none focus:border-slate-400 focus:ring-1 focus:ring-slate-400"
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* STEP 4: 명단 */}
                    {step === 4 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <div className="flex justify-between items-center">
                                <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                                    <span className="bg-slate-900 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">4</span> 참석자 명단 ({formData.participants.length}명)
                                </h2>
                                <Button size="sm" onClick={addParticipant} className="bg-slate-900"><Plus className="w-4 h-4" /> 추가</Button>
                            </div>

                            <div className="bg-blue-50 border-2 border-blue-200 rounded-2xl p-4 flex flex-col items-center text-center space-y-3">
                                <div className="flex items-center gap-2 text-blue-800 font-bold mb-1"><QrCode className="w-5 h-5" /> 팀원 스마트폰으로 서명받기</div>
                                {sessionId && (
                                    <div className="bg-white p-3 rounded-xl shadow-sm border border-slate-200">
                                        <QRCodeCanvas value={typeof window !== "undefined" ? `${window.location.origin}/tbm/sign/${sessionId}` : ""} size={140} level={"H"} />
                                    </div>
                                )}
                                <p className="text-sm text-blue-700 font-medium">위 QR을 보여주거나 아래 링크를 카톡으로 보내세요.</p>
                                <Button variant="outline" onClick={() => { if (typeof window !== "undefined" && sessionId) { navigator.clipboard.writeText(`${window.location.origin}/tbm/sign/${sessionId}`); alert("복사 완료!"); } }} className="bg-white border-blue-300 text-blue-700"><Copy className="w-4 h-4 mr-2" /> 링크 복사</Button>
                            </div>

                            <div className="space-y-3">
                                {formData.participants.map((p, idx) => (
                                    <div key={p.id} className="bg-white p-3 border border-slate-200 rounded-xl shadow-sm flex flex-col gap-3">
                                        <div className="flex items-center gap-2">
                                            <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center font-bold text-slate-500 text-sm">{idx + 1}</div>
                                            <Input placeholder="이름" className="flex-1 h-10 text-lg font-bold border-0 border-b rounded-none px-1 focus-visible:ring-0" value={p.name} onChange={(e) => updateParticipant(p.id, "name", e.target.value)} />
                                            <Button size="icon" variant="ghost" className="text-red-400" onClick={() => removeParticipant(p.id)}><Trash2 className="w-5 h-5" /></Button>
                                        </div>
                                        <div className="flex gap-2">
                                            <div className="flex-1" onClick={() => openSignModal({ type: 'participant', id: p.id })}>
                                                {p.signature ? <div className="h-10 bg-green-50 border border-green-500 rounded-lg flex items-center justify-center"><img src={p.signature} className="h-full object-contain" /></div> : <Button variant="outline" className="w-full h-10 border-dashed text-slate-400">내 폰으로 직접 받기</Button>}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* STEP 5: 완료 */}
                    {step === 5 && (
                        <div className="flex flex-col items-center justify-center h-[60vh] animate-in zoom-in duration-300">
                            <CheckCircle2 className="w-24 h-24 text-blue-600 mb-6" />
                            <h2 className="text-2xl font-bold text-slate-900 mb-2">저장 완료!</h2>
                            <p className="text-slate-500 text-center mb-8">안전가이드라인 TBM 회의록 작성이 완료되었습니다.</p>
                            <div className="w-full space-y-3 px-4">
                                <Button variant="outline" onClick={() => router.push('/')} className="w-full h-14 text-lg border-slate-300">메인 화면으로 이동</Button>
                            </div>
                        </div>
                    )}

                </div>

                {/* 하단 버튼 */}
                {step < 5 && (
                    <div className="bg-white border-t p-4 flex gap-3 shadow-[0_-10px_20px_-5px_rgba(0,0,0,0.05)] sticky bottom-0 z-50 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:rounded-b-[2rem]">
                        <Button variant="outline" onClick={() => setStep(prev => Math.max(1, prev - 1))} disabled={step === 1} className="flex-1 h-16 text-lg border-slate-300">이전</Button>
                        {step < 4 ? (
                            <Button onClick={handleNext} className="flex-[2] h-16 text-xl bg-slate-900 text-white font-bold transition-transform active:scale-95">다음 단계</Button>
                        ) : (
                            <Button onClick={saveToDatabase} disabled={isSaving} className="flex-[2] h-16 text-xl bg-blue-600 text-white font-bold transition-transform active:scale-95">
                                {isSaving ? <Loader2 className="animate-spin w-6 h-6 mr-2" /> : <Save className="mr-2 w-6 h-6" />} 완료 및 저장
                            </Button>
                        )}
                    </div>
                )}
            </div>

            {/* 서명 Dialog */}
            <Dialog open={isSignOpen} onOpenChange={setIsSignOpen}>
                <DialogContent showCloseButton={true} className="max-w-lg w-[calc(100%-2rem)] h-[80vh] max-h-[80vh] flex flex-col p-0 gap-0">
                    <DialogHeader className="p-4 border-b shrink-0"><DialogTitle className="text-center text-xl">서명해 주세요</DialogTitle></DialogHeader>
                    <div className="p-4 flex-1 bg-slate-50 min-h-0">
                        <div className="border-2 border-slate-300 rounded-xl bg-white h-full shadow-inner" style={{ touchAction: "none" }}>
                            <SignatureCanvas ref={sigCanvas} canvasProps={{ className: "w-full h-full" }} />
                        </div>
                    </div>
                    <DialogFooter className="flex-row gap-3 border-t bg-white p-4 shrink-0">
                        <Button variant="outline" onClick={() => sigCanvas.current?.clear()} className="flex-1 h-12 text-lg">지우기</Button>
                        <Button onClick={saveSignature} className="flex-1 h-12 text-lg bg-slate-900 text-white">확인</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
