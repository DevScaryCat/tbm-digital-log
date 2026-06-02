// app/tbm-minutes/page.tsx
"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { useRequireSubscription } from "@/lib/useSubscription"
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
import { Mic, CheckCircle2, Plus, Trash2, PenTool, Loader2, Save, CalendarIcon, Clock, RefreshCw, Send, Pause, Play, QrCode, Copy, Upload } from "lucide-react"
import { v4 as uuidv4 } from "uuid"
import { QRCodeCanvas } from "qrcode.react"

interface SpeechRecognitionEvent {
    resultIndex: number
    results: {
        length: number
        [key: number]: {
            isFinal: boolean
            [key: number]: {
                transcript: string
            }
        }
    }
}

interface SpeechRecognitionErrorEvent {
    error: string
}

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
    useRequireSubscription()
    const [isLoading, setIsLoading] = useState(true)
    const [isSaving, setIsSaving] = useState(false)
    const [step, setStep] = useState(1)
    const [savedLogId, setSavedLogId] = useState<string | null>(null)
    const [sessionId, setSessionId] = useState<string | null>(null)

    const [isRecording, setIsRecording] = useState(false)
    const isRecordingRef = useRef(false)
    const recognitionRef = useRef<SpeechRecognition | null>(null)
    const [accumulatedTranscript, setAccumulatedTranscript] = useState("")
    const [recordingCount, setRecordingCount] = useState(0)

    const [recordingTime, setRecordingTime] = useState(0)
    const sessionStartTimeRef = useRef<number | null>(null);
    const accumulatedTimeRef = useRef<number>(0);
    const MAX_RECORDING_TIME = 1200;

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
                        setIsRecording(false);
                        isRecordingRef.current = false;
                        if (recognitionRef.current) {
                            recognitionRef.current.stop();
                        }
                        alert("최대 녹음 시간(20분)에 도달했습니다. 녹음이 자동 종료되었습니다.");
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
    }, [isRecording]);

    // 화면이 백그라운드/잠금되면 녹음을 자동 일시정지 (잠긴 시간이 타이머에 누적되는 것 방지)
    useEffect(() => {
        const handleVisibility = () => {
            if (document.hidden && isRecordingRef.current) {
                setIsRecording(false);
                isRecordingRef.current = false;
                if (recognitionRef.current) recognitionRef.current.stop();
                setRecordingCount(prev => prev + 1);
            }
        };
        document.addEventListener("visibilitychange", handleVisibility);
        window.addEventListener("pagehide", handleVisibility);
        return () => {
            document.removeEventListener("visibilitychange", handleVisibility);
            window.removeEventListener("pagehide", handleVisibility);
        };
    }, []);

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60).toString().padStart(2, '0');
        const s = (seconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }



    const [isProcessingSTT, setIsProcessingSTT] = useState(false)
    const [isProcessingAI, setIsProcessingAI] = useState(false)

    const [isSignOpen, setIsSignOpen] = useState(false)
    const [currentSignTarget, setCurrentSignTarget] = useState<{ type: 'participant' | 'leader', id?: number } | null>(null)
    const [leaderSignature, setLeaderSignature] = useState<string | null>(null)
    const [guideTab, setGuideTab] = useState<'guide' | 'script'>('guide')
    const sigCanvas = useRef<SignatureCanvas>(null)

    const [isConfirmationOpen, setIsConfirmationOpen] = useState(false)
    const [hasAgreedToDisclaimer, setHasAgreedToDisclaimer] = useState(false)
    const confirmationSigCanvas = useRef<SignatureCanvas>(null)
    const savingRef = useRef(false)

    const getCurrentTime = () => {
        const now = new Date()
        return now.toTimeString().slice(0, 5)
    }

    const [formData, setFormData] = useState<TBMMinutesData>({
        date: new Date(),
        startTime: getCurrentTime(),
        endTime: getCurrentTime(),
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

            const { data: lastMinute } = await supabase
                .from('tbm_minutes')
                .select('location, created_at')
                .eq('user_id', session.user.id)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()

            const { data: lastLog } = await supabase
                .from('tbm_logs')
                .select('location, created_at')
                .eq('user_id', session.user.id)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()

            let lastLocation = "현장 지정구역";
            const minTime = lastMinute?.created_at ? new Date(lastMinute.created_at).getTime() : 0;
            const logTime = lastLog?.created_at ? new Date(lastLog.created_at).getTime() : 0;
            
            if (minTime > 0 || logTime > 0) {
                lastLocation = minTime > logTime ? lastMinute!.location : lastLog!.location;
            }

            setFormData(prev => ({
                ...prev,
                location: lastLocation,
                leaderName: session.user.user_metadata.full_name || session.user.email?.split("@")[0] || ""
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
            // 언마운트 시 음성인식 정리 (마이크 누수 / onend 재시작 루프 방지)
            isRecordingRef.current = false;
            try { recognitionRef.current?.stop(); } catch {}
            const currentSession = sessionIdRef.current;
            const currentStep = stepRef.current;
            if (currentSession && currentStep !== 5) {
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
        if (step === 3) {
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
        }
        if (currentStep === 3) {
            const validParticipants = formData.participants.filter(p => p.name.trim() !== "" || p.signature);
            if (validParticipants.length === 0) return "최소 1명 이상의 참석자 서명이 필요합니다.";
            const missingSign = validParticipants.find(p => !p.signature);
            if (missingSign) return `${missingSign.name || '참석자'} 님의 서명이 누락되었습니다.`;
            if (validParticipants.some(p => !p.name.trim())) return "참석자 이름을 모두 입력해주세요.";
        }
        if (currentStep === 4) {
            if (!formData.processName.trim()) return "공정(종)명을 입력해주세요.";
            if (!formData.workName.trim()) return "작업명을 입력해주세요.";
            if (!formData.workContent.trim()) return "금일 작업 내용을 입력해주세요.";
        }
        return null;
    }

    const handleNext = () => {
        const errorMsg = validateStep(step);
        if (errorMsg) { alert(errorMsg); return; }
        setStep(prev => Math.min(5, prev + 1));
    }

    const uploadBase64ToStorage = async (base64Data: string, bucket: string, pathPrefix: string): Promise<string> => {
        if (!base64Data || typeof base64Data !== 'string') return "";
        if (!base64Data.startsWith('data:')) return base64Data;

        const res = await fetch(base64Data);
        const blob = await res.blob();
        const ext = base64Data.split(';')[0].split('/')[1] || 'png';
        const fileName = `${pathPrefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${ext}`;

        const { error: uploadError } = await supabase.storage
            .from(bucket)
            .upload(fileName, blob, {
                contentType: blob.type,
                upsert: true
            });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
            .from(bucket)
            .getPublicUrl(fileName);

        return publicUrl;
    }

    const saveToDatabase = async (confirmationSigBase64: string) => {
        const errorMsg = validateStep(3) || validateStep(4);
        if (errorMsg) { alert(errorMsg); return; }

        setIsSaving(true)
        try {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) throw new Error("로그인 필요")

            let leaderSignatureUrl = null;
            if (confirmationSigBase64) {
                leaderSignatureUrl = await uploadBase64ToStorage(confirmationSigBase64, 'signatures', 'leader');
            }

            const { data: logData, error: logError } = await supabase
                .from('tbm_minutes')
                .insert({
                    user_id: session.user.id,
                    date: formData.date ? format(formData.date, "yyyy-MM-dd") : new Date().toISOString().split('T')[0],
                    start_time: formData.startTime,
                    end_time: getCurrentTime(),
                    location: formData.location,
                    process_name: formData.processName,
                    work_name: formData.workName,
                    work_content: formData.workContent,
                    leader_title: formData.leaderTitle,
                    leader_name: formData.leaderName,
                    leader_signature: leaderSignatureUrl,
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
            const participantsData = [];
            for (const p of validParticipantsForDB) {
                let sigUrl = p.signature;
                if (p.signature && p.signature.startsWith('data:')) {
                    sigUrl = await uploadBase64ToStorage(p.signature, 'signatures', 'minute-participant');
                }
                participantsData.push({
                    minutes_id: logData.id,
                    name: p.name,
                    signature: sigUrl
                });
            }

            if(participantsData.length > 0) {
                const { error: partError } = await supabase.from('tbm_minutes_participants').insert(participantsData)
                if (partError) {
                    // 참가자 저장 실패 시 방금 생성한 회의록을 롤백(고아/중복 방지)
                    await supabase.from('tbm_minutes').delete().eq('id', logData.id)
                    throw partError
                }
            }

            if (sessionId) {
                await supabase.from('tbm_pending_signatures').delete().eq('session_id', sessionId);
                await supabase.from('tbm_pending_signatures').insert({
                    session_id: sessionId, name: "CLOSED_SESSION", gender: "M", signature: "expired"
                })
            }

            setSavedLogId(logData.id)
            setStep(5)

        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : "알 수 없는 오류"
            alert("저장 실패: " + errorMessage)
        } finally {
            setIsSaving(false)
        }
    }

    const requestAIMinutes = async (text: string) => {
        if (!text) return;
        setIsProcessingAI(true)
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const res = await fetch('/api/ai/minutes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
                body: JSON.stringify({ text })
            })
            const data = await res.json()

            if (res.ok) {
                setFormData(prev => ({
                    ...prev,
                    processName: data.processName || prev.processName,
                    workName: data.workName || prev.workName,
                    workContent: data.workContent || prev.workContent,
                    hazards: Array.isArray(data.hazards) ? data.hazards : [],
                    instructions: data.instructions || "",
                    safetyPhrase: data.safetyPhrase || prev.safetyPhrase
                }))
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


    const stopRecording = () => {
        setIsRecording(false)
        isRecordingRef.current = false
        if (recognitionRef.current) {
            recognitionRef.current.stop()
        }
        setRecordingCount(prev => prev + 1)
    }

    const startRecording = async () => {
        const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
        if (/KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line|DaumApps/i.test(ua)) {
            alert("카카오톡·네이버 등 인앱 브라우저에서는 음성 녹음이 동작하지 않습니다.\n우측 상단 메뉴에서 'Safari/Chrome으로 열기'를 눌러 외부 브라우저로 진행해주세요.");
            return;
        }
        const SpeechRecognition = (window as unknown as CustomWindow).SpeechRecognition || (window as unknown as CustomWindow).webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert("현재 브라우저가 무료 음성 인식을 지원하지 않습니다. (Chrome, Safari 최신 버전 권장)");
            return;
        }

        try {
            const recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = 'ko-KR';

            recognition.onresult = (event: SpeechRecognitionEvent) => {
                let finalTranscript = '';
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (event.results[i].isFinal) {
                        finalTranscript += event.results[i][0].transcript + ' ';
                    }
                }
                if (finalTranscript) {
                    setAccumulatedTranscript(prev => prev + finalTranscript);
                }
            };

            recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
                console.error("Speech recognition error:", event.error);
                if (event.error === 'network' || event.error === 'not-allowed') {
                    stopRecording();
                    alert("Chrome, Safari 브라우저에서만 사용 가능합니다.");
                }
            };

            recognition.onend = () => {
                if (isRecordingRef.current) {
                    setTimeout(() => {
                        if (isRecordingRef.current) {
                            try {
                                recognition.start();
                            } catch (e) {
                            }
                        }
                    }, 500);
                }
            };

            recognition.start();
            recognitionRef.current = recognition;
            setIsRecording(true);
            isRecordingRef.current = true;
            setFormData(prev => ({ ...prev, startTime: getCurrentTime() }));
        } catch (err) {
            console.error(err);
            alert("마이크/음성인식 권한이 필요합니다.");
        }
    }

    const submitRecording = async () => {
        if (!accumulatedTranscript.trim()) { alert("인식된 음성이 없습니다."); return; }
        
        setIsProcessingSTT(true)
        setStep(3)
        
        setTimeout(() => {
            setIsProcessingSTT(false)
            requestAIMinutes(accumulatedTranscript)
        }, 500)
    }

    const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return;

        const isLocal = typeof window !== "undefined" && (
            window.location.hostname === "localhost" || 
            window.location.hostname === "127.0.0.1"
        );
        if (!isLocal) {
            alert("개발 환경에서만 사용 가능한 기능입니다.");
            return;
        }

        setIsProcessingSTT(true)
        setStep(3)
        
        try {
            const formData = new FormData()
            formData.append("file", file)

            const { data: { session } } = await supabase.auth.getSession()
            const res = await fetch("/api/ai/stt", {
                method: "POST",
                headers: { Authorization: `Bearer ${session?.access_token}` },
                body: formData,
            })

            const data = await res.json()
            if (res.ok && data.transcript) {
                setAccumulatedTranscript(data.transcript)
                requestAIMinutes(data.transcript)
            } else {
                alert("음성 인식 실패: " + (data.error || "알 수 없는 오류"))
            }
        } catch (err) {
            console.error(err)
            alert("음성 인식 중 네트워크 오류 발생")
        } finally {
            setIsProcessingSTT(false)
        }
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

    const handleConfirmAndSave = async () => {
        if (!hasAgreedToDisclaimer) {
            alert("법적 책임을 확인하고 동의란에 체크해주셔야 저장이 가능합니다.")
            return
        }
        if (!confirmationSigCanvas.current || confirmationSigCanvas.current.isEmpty()) {
            alert("최종 확인 서명을 작성해주세요.")
            return
        }
        if (isSaving || savingRef.current) return
        savingRef.current = true
        const sigBase64 = confirmationSigCanvas.current.toDataURL()
        setIsConfirmationOpen(false)
        try {
            await saveToDatabase(sigBase64)
        } finally {
            savingRef.current = false
        }
    }

    const addParticipant = () => setFormData(prev => ({ ...prev, participants: [...prev.participants, { id: Date.now(), name: "", gender: "M", signature: null }] }))
    const updateParticipant = (id: number, field: keyof Participant, value: Participant[keyof Participant]) => setFormData(prev => ({ ...prev, participants: prev.participants.map(p => p.id === id ? { ...p, [field]: value } as Participant : p) }))
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
                    <Button variant="outline" className="w-full justify-start text-left font-normal text-[16px] h-12 border-cur-hairline rounded-[8px] bg-cur-card hover:bg-cur-elevated">
                        <Clock className="mr-2 h-5 w-5 text-cur-muted" />
                        <span className="text-cur-ink font-medium">{value}</span>
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 rounded-[12px] border-cur-hairline shadow-[0_4px_24px_rgba(0,0,0,0.08)]" align="start">
                    <div className="flex h-48 bg-cur-card rounded-[12px] overflow-hidden">
                        <ScrollArea className="w-20 border-r border-cur-hairline">
                            <div className="flex flex-col p-1">
                                {hours.map((hour) => (
                                    <Button key={hour} variant="ghost" className={cn("justify-center rounded-[8px] h-10 text-[14px]", h === hour ? "bg-cur-primary text-cur-on-primary font-semibold hover:bg-cur-primary hover:text-cur-on-primary" : "text-cur-ink hover:bg-cur-elevated")} onClick={() => onChange(`${hour}:${m}`)}>{hour}시</Button>
                                ))}
                            </div>
                        </ScrollArea>
                        <ScrollArea className="w-20">
                            <div className="flex flex-col p-1">
                                {minutes.map((minute) => (
                                    <Button key={minute} variant="ghost" className={cn("justify-center rounded-[8px] h-10 text-[14px]", m === minute ? "bg-cur-primary text-cur-on-primary font-semibold hover:bg-cur-primary hover:text-cur-on-primary" : "text-cur-ink hover:bg-cur-elevated")} onClick={() => onChange(`${h}:${minute}`)}>{minute}분</Button>
                                ))}
                            </div>
                        </ScrollArea>
                    </div>
                </PopoverContent>
            </Popover>
        )
    }

    if (isLoading) return <div className="min-h-screen flex justify-center items-center bg-cur-canvas"><Loader2 className="animate-spin w-10 h-10 text-cur-ink" /></div>

    const tbmGuideBox = (
        <div className="w-full text-left border border-cur-hairline rounded-[12px] overflow-hidden shadow-sm mb-6">
            <div className="flex border-b border-cur-hairline">
                <button onClick={() => setGuideTab('guide')} className={`flex-1 py-2 text-[13px] font-bold transition-colors ${guideTab === 'guide' ? 'bg-cur-primary text-cur-on-primary' : 'bg-cur-elevated text-cur-muted hover:bg-cur-canvas'}`}>TBM 가이드</button>
                <button onClick={() => setGuideTab('script')} className={`flex-1 py-2 text-[13px] font-bold transition-colors ${guideTab === 'script' ? 'bg-cur-primary text-cur-on-primary' : 'bg-cur-elevated text-cur-muted hover:bg-cur-canvas'}`}>대본 예시</button>
            </div>
            <div className="p-4 bg-cur-canvas-soft text-[13px] leading-relaxed max-h-[200px] overflow-y-auto">
                {guideTab === 'guide' ? (
                    <div className="space-y-3">
                        <p className="font-semibold text-cur-ink mb-2">TBM(Tool Box Meeting)은 아래 순서에 따라 진행해주시고, 작업지시서, 위험성평가를 참고해주세요.</p>
                        <div><span className="font-bold text-cur-primary">1. 오늘의 작업내용</span><br /><span className="text-cur-muted">당일 수행 예정인 작업(일상·비일상 작업 포함)과 관련 유해·위험요인을 사전에 공유하고 협의한다.</span></div>
                        <div><span className="font-bold text-cur-primary">2. 작업내용별 위험요인 및 대책(근로자 참여 위험성평가)</span><br /><span className="text-cur-muted">유해·위험요인에 대해 제거 → 대체 → 공학적 개선 → 관리적 대책 → 개인보호구 적용 순으로 우선순위를 고려하여 대책을 검토한다.</span></div>
                        <div><span className="font-bold text-cur-primary">3. 작업 시작 전 확인사항</span><br /><span className="text-cur-muted">• 개인별 건강상태 이상 여부 확인<br/>• 개인보호구 착용 상태 점검<br/>• 안전구호 제창(AI 추천 활용 가능)</span></div>
                    </div>
                ) : (
                    <div className="text-cur-muted whitespace-pre-wrap leading-relaxed text-[14px]">
                        안녕하십니까, 금일 TBM을 시작하겠습니다.<br /><br />
                        먼저 건강 상태를 확인하겠습니다. 오늘 몸이 안 좋으시거나 전날 음주 등으로 작업에 무리가 있으신 분 계십니까? 네, 특이사항 없는 것으로 확인했습니다.<br /><br />
                        오늘 진행할 공종은 '철근 조립 및 거푸집 설치' 작업이며, 장소는 B동 2층 슬라브 구역입니다.<br />
                        각자 맡은 구역과 역할을 다시 한번 확인해 주시기 바랍니다.<br /><br />
                        오늘의 주요 위험 요인과 안전 대책입니다.<br />
                        첫째, 고소작업 중 추락 위험이 있습니다. 반드시 안전대 부착 설비를 확인해 주십시오.<br />
                        둘째, 크레인 인양 시 충돌 위험이 있으니 인양 반경 내 출입을 금지합니다.<br /><br />
                        마지막으로 안전모 턱끈을 단단히 조여주시고 안전화 착용 상태를 확인해 주십시오. 작업 중 이상 징후가 발견되면 즉시 관리자에게 보고해 주시기 바랍니다.<br /><br />
                        그럼 다 같이 안전 구호 제창하고 TBM을 마치겠습니다.<br />
                        <span className="font-bold">"안전! 좋아! 좋아! 좋아!"</span>
                    </div>
                )}
            </div>
        </div>
    )

    return (
        <div className="bg-cur-canvas min-h-screen sm:py-8 flex sm:block items-center justify-center font-sans text-cur-ink">
            <div className="max-w-lg w-full mx-auto bg-cur-card sm:shadow-none sm:rounded-[12px] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border border-cur-hairline mb-[env(safe-area-inset-bottom)] overflow-hidden">
                <div className="p-4 bg-cur-card border-b border-cur-hairline sticky top-0 z-50">
                    <TBMHeader title="TBM 회의록 작성" />
                </div>

                <div className="p-6 space-y-8 flex-1 pb-12 bg-cur-canvas-soft">
                    
                    {step === 1 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-[20px] font-semibold text-cur-ink flex items-center gap-2 tracking-tight">
                                <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">1</span> 일반 정보
                            </h2>
                            <div className="space-y-5 bg-cur-card p-5 rounded-[12px] border border-cur-hairline shadow-none">
                                <div className="space-y-2">
                                    <Label className="text-[14px] font-semibold text-cur-ink">TBM 일자</Label>
                                    <Popover>
                                        <PopoverTrigger asChild>
                                            <Button variant={"outline"} className={cn("h-12 w-full justify-start text-left font-normal text-[15px] border-cur-hairline rounded-[8px] hover:bg-cur-elevated", !formData.date && "text-cur-muted")}>
                                                <CalendarIcon className="mr-2 h-5 w-5 text-cur-muted" />
                                                <span className={cn(formData.date ? "text-cur-ink font-medium" : "text-cur-muted")}>
                                                    {formData.date ? format(formData.date, "yyyy년 MM월 dd일 (EEE)", { locale: ko }) : "날짜 선택"}
                                                </span>
                                            </Button>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-auto p-0 rounded-[12px] border-cur-hairline shadow-[0_4px_24px_rgba(0,0,0,0.08)]" align="center">
                                            <Calendar mode="single" locale={ko} selected={formData.date} onSelect={(date) => setFormData(prev => ({ ...prev, date }))} initialFocus className="p-3" />
                                        </PopoverContent>
                                    </Popover>
                                </div>

                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <Label className="text-[14px] font-semibold text-cur-ink">교육/회의 시작 시간</Label>
                                        <span className="text-[11px] text-cur-muted">녹음 시작 시 자동 갱신 (조작 불가)</span>
                                    </div>
                                    <Input 
                                        value={formData.startTime} 
                                        disabled 
                                        className="h-12 text-[15px] border-cur-hairline rounded-[8px] bg-cur-canvas font-medium text-cur-ink opacity-100 disabled:opacity-100 disabled:bg-cur-elevated" 
                                    />
                                </div>

                                <div className="space-y-2"><Label className="text-[14px] font-semibold text-cur-ink">TBM 장소</Label><Input name="location" value={formData.location} onChange={handleChange} className="h-12 text-[15px] border-cur-hairline rounded-[8px] bg-cur-card font-medium text-cur-ink focus-visible:ring-1 focus-visible:ring-cur-primary" /></div>


                            </div>
                        </div>
                    )}

                    {step === 2 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-[20px] font-semibold text-cur-ink flex items-center gap-2 tracking-tight">
                                <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">2</span> 회의 진행 및 녹음
                            </h2>
                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] p-6 text-center flex flex-col items-center justify-center min-h-[400px] shadow-none relative">
                                {isRecording ? (
                                    <div className="w-full flex flex-col items-center space-y-8 animate-in fade-in duration-300">
                                        {tbmGuideBox}
                                        <div className="w-full text-left border border-cur-info/30 rounded-[12px] bg-cur-info/5 p-4 max-h-[200px] overflow-y-auto shadow-inner">
                                            <p className="text-[13px] font-bold text-cur-info mb-2 flex items-center gap-2"><span className="w-2 h-2 bg-cur-info rounded-full animate-pulse"></span>실시간 음성 인식 중...</p>
                                            <p className="text-[14px] text-cur-ink leading-relaxed break-keep font-medium">
                                                {accumulatedTranscript || <span className="text-cur-muted">음성을 듣고 있습니다. 마이크에 대고 회의를 진행해 주세요...</span>}
                                            </p>
                                        </div>
                                        <div className="bg-cur-error/5 text-cur-error border border-cur-error/20 px-4 py-2 rounded-full font-semibold text-[13px] flex items-center gap-2 shadow-sm whitespace-nowrap overflow-hidden">
                                            <span className="w-2.5 h-2.5 bg-cur-error rounded-full animate-ping shrink-0"></span>
                                            회의 녹음 중 {recordingCount > 0 && `(${recordingCount + 1}회차)`}
                                            <span className="ml-2 font-mono shrink-0 font-bold">{formatTime(recordingTime)} / 20:00</span>
                                        </div>
                                        <Button onClick={stopRecording} className="w-32 h-32 rounded-full shadow-[0_8px_24px_rgba(207,45,86,0.2)] bg-cur-error hover:bg-cur-error/80 flex flex-col items-center justify-center gap-2 mt-4 shrink-0 transition-transform active:scale-95">
                                            <Pause className="w-10 h-10 text-cur-on-primary" />
                                            <span className="text-cur-on-primary font-bold text-[16px]">일시정지</span>
                                        </Button>
                                    </div>
                                ) : recordingCount > 0 ? (
                                    <div className="w-full flex flex-col items-center space-y-6 animate-in fade-in duration-300">
                                        <div className="w-full text-left border border-cur-hairline rounded-[12px] bg-cur-canvas p-4 max-h-[200px] overflow-y-auto opacity-80">
                                            <p className="text-[13px] font-bold text-cur-muted mb-2">현재까지 인식된 내용</p>
                                            <p className="text-[14px] text-cur-ink leading-relaxed break-keep font-medium">
                                                {accumulatedTranscript || <span className="text-cur-muted">인식된 음성이 없습니다.</span>}
                                            </p>
                                        </div>
                                        <div className="bg-amber-50 text-amber-700 border border-amber-200 px-4 py-2 rounded-full font-semibold text-[13px] flex items-center gap-2 shadow-sm whitespace-nowrap overflow-hidden">
                                            <Pause className="w-4 h-4 shrink-0" /> 녹음 일시정지 · {recordingCount}회
                                            <span className="ml-2 font-mono shrink-0 font-bold">{formatTime(recordingTime)} / 20:00</span>
                                        </div>
                                        <div className="w-full space-y-3">
                                            <Button onClick={startRecording} className="w-full h-14 text-[16px] font-semibold bg-cur-primary hover:bg-cur-card text-cur-on-primary shadow-[0_4px_12px_rgba(0,0,0,0.1)] rounded-[12px] transition-transform active:scale-95"><Play className="mr-2 w-5 h-5" /> 이어서 녹음</Button>
                                        </div>
                                        <p className="text-[13px] text-cur-muted-soft font-medium leading-relaxed mt-4">
                                            추가 녹음이 필요하면 &quot;이어서 녹음&quot;을,<br />회의를 마치려면 하단의 &quot;AI 요약&quot; 버튼을 누르세요.
                                        </p>
                                    </div>
                                ) : (
                                    <div className="w-full flex flex-col items-center space-y-8 animate-in zoom-in duration-300">
                                        {tbmGuideBox}
                                        <div className="bg-cur-primary text-cur-on-primary px-5 py-2 rounded-full font-semibold text-[13px] shadow-sm tracking-wide">TBM 회의 녹음 시작</div>
                                        <Button onClick={startRecording} className="w-40 h-40 rounded-full shadow-[0_12px_32px_rgba(0,0,0,0.15)] bg-cur-ink hover:bg-cur-ink/90 flex flex-col items-center justify-center gap-3 shrink-0 transition-transform active:scale-95">
                                            <Mic className="w-14 h-14 text-cur-on-primary" />
                                            <span className="text-cur-on-primary font-bold text-[18px]">회의 시작</span>
                                        </Button>

                                        {typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && (
                                            <div className="flex flex-col items-center space-y-2">
                                                <input
                                                    type="file"
                                                    accept="audio/*"
                                                    onChange={handleAudioUpload}
                                                    id="audio-upload"
                                                    className="hidden"
                                                />
                                                <Label
                                                    htmlFor="audio-upload"
                                                    className="flex items-center gap-2 px-4 py-2 border border-cur-hairline rounded-[8px] bg-cur-card text-cur-ink cursor-pointer hover:bg-cur-elevated transition-colors text-[13px] font-semibold"
                                                >
                                                    <Upload className="w-4 h-4 text-cur-primary" />
                                                    개발자 오디오 파일 업로드 (STT 테스트)
                                                </Label>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                            <p className="text-[13px] text-cur-muted-soft font-medium leading-relaxed bg-cur-canvas p-3.5 rounded-[12px] border border-cur-hairline text-center">
                                💡 참석자와 함께 위험요인, 대책, 안전구호를 협의해주세요. AI가 자동으로 회의록 양식에 맞게 요약해 줍니다.<br/>
                                <span className="text-[12px] text-cur-error block mt-1.5 font-bold tracking-tight">※ Chrome, Safari 브라우저 권장. 스마트폰 화면이 꺼지면 녹음이 중단될 수 있으니 화면을 켜두세요.</span>
                            </p>
                        </div>
                    )}

                    {step === 4 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-[20px] font-semibold text-cur-ink flex items-center gap-2 tracking-tight">
                                <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">4</span> 요약본 확인 및 수정
                            </h2>
                            
                            {(isProcessingSTT || isProcessingAI) ? (
                                <div className="bg-cur-card border border-cur-hairline rounded-[12px] p-12 text-center flex flex-col items-center justify-center shadow-sm">
                                    <Loader2 className="w-12 h-12 text-cur-ink animate-spin mb-4" />
                                    <p className="text-[18px] font-semibold text-cur-ink">
                                        {isProcessingSTT ? "음성을 텍스트로 변환 중..." : "AI가 회의록을 작성 중입니다..."}
                                    </p>
                                    <p className="text-[14px] text-cur-muted-soft font-medium mt-2">참석자 서명을 미리 진행하시면 AI 처리 후 결과가 표시됩니다.</p>
                                </div>
                            ) : (
                                <>
                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden shadow-none">
                                <div className="bg-cur-canvas border-b border-cur-hairline px-4 py-3 font-bold text-cur-ink text-[14px]">
                                    ■ 공정 및 작업명
                                </div>
                                <div className="p-4 grid grid-cols-2 gap-4">
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-[13px] font-bold text-cur-ink">공정(종)명</Label>
                                        <Input name="processName" value={formData.processName} onChange={handleChange} className="h-10 text-[14px] font-medium border-cur-hairline focus-visible:ring-cur-primary focus-visible:ring-1" />
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-[13px] font-bold text-cur-ink">작업명</Label>
                                        <Input name="workName" value={formData.workName} onChange={handleChange} className="h-10 text-[14px] font-medium border-cur-hairline focus-visible:ring-cur-primary focus-visible:ring-1" />
                                    </div>
                                </div>
                            </div>

                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden shadow-none">
                                <div className="bg-cur-canvas border-b border-cur-hairline px-4 py-3 font-bold text-cur-ink text-[14px]">
                                    ■ 금일 작업 내용
                                </div>
                                <div className="p-4">
                                    <textarea
                                        name="workContent"
                                        value={formData.workContent}
                                        onChange={handleChange}
                                        className="w-full p-3 border border-cur-hairline rounded-[10px] h-20 text-[15px] bg-cur-card resize-none focus:outline-none focus:border-cur-primary focus:ring-1 focus:ring-cur-primary font-medium text-cur-ink shadow-sm"
                                        placeholder="AI가 요약한 작업 내용을 확인하고 수정하세요."
                                    />
                                </div>
                            </div>

                            <div className="bg-cur-card border border-amber-200 rounded-[12px] overflow-hidden shadow-none">
                                <div className="bg-amber-50 border-b border-amber-200 px-4 py-3 font-bold flex justify-between items-center text-amber-800 text-[14px]">
                                    <span>■ 근로자 참여 위험성평가</span>
                                    <Button size="sm" onClick={addHazard} variant="ghost" className="h-7 px-2.5 hover:bg-amber-100 bg-cur-card border border-amber-200 shadow-sm rounded-[6px] text-amber-800"><Plus className="w-3.5 h-3.5 mr-1" /> 요인 추가</Button>
                                </div>
                                <div className="p-4 space-y-4 bg-amber-50/50">
                                    {formData.hazards.length === 0 && <p className="text-[13px] text-cur-muted text-center py-4 font-medium">도출된 위험요인이 없습니다.</p>}
                                    {formData.hazards.map((hazard, idx) => (
                                        <div key={idx} className="bg-cur-card p-4 border border-amber-200 rounded-[12px] shadow-sm space-y-4 relative">
                                            <button onClick={() => removeHazard(idx)} className="absolute top-2.5 right-2.5 text-cur-error/70 hover:text-cur-error bg-cur-error/5 p-1.5 rounded-[6px]"><Trash2 className="w-4 h-4" /></button>
                                            <div className="flex flex-col gap-1.5">
                                                <Label className="text-[13px] text-amber-800 font-bold">잠재 유해위험요인</Label>
                                                <textarea 
                                                    value={hazard.factor} 
                                                    onChange={(e) => updateHazard(idx, "factor", e.target.value)} 
                                                    className="w-full min-h-[64px] p-3 rounded-[8px] border border-amber-200 bg-cur-card text-[14px] focus:outline-none focus:ring-1 focus:ring-amber-400 font-medium resize-y shadow-sm leading-relaxed"
                                                    rows={2}
                                                />
                                            </div>
                                            <div className="flex gap-3 items-start">
                                                <div className="flex flex-col gap-1.5 w-24 shrink-0">
                                                    <Label className="text-[13px] text-amber-800 font-bold">위험성</Label>
                                                    <select 
                                                        value={hazard.level} 
                                                        onChange={(e) => updateHazard(idx, "level", e.target.value)} 
                                                        className="w-full h-11 rounded-[8px] border border-amber-200 bg-cur-card px-2 text-[14px] focus:outline-none focus:ring-1 focus:ring-amber-400 font-medium shadow-sm"
                                                    >
                                                        <option value="상">상</option>
                                                        <option value="중">중</option>
                                                        <option value="하">하</option>
                                                        <option value="상중하">복합</option>
                                                    </select>
                                                </div>
                                                <div className="flex flex-col gap-1.5 flex-1">
                                                    <Label className="text-[13px] text-amber-800 font-bold">대책(제거/대체/통제)</Label>
                                                    <textarea 
                                                        value={hazard.measure} 
                                                        onChange={(e) => updateHazard(idx, "measure", e.target.value)} 
                                                        className="w-full min-h-[64px] p-3 rounded-[8px] border border-amber-200 bg-cur-card text-[14px] focus:outline-none focus:ring-1 focus:ring-amber-400 font-medium resize-y shadow-sm leading-relaxed"
                                                        rows={2}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden shadow-none">
                                <div className="bg-cur-canvas border-b border-cur-hairline px-4 py-3 font-bold text-cur-ink text-[14px]">
                                    ■ 작업 시작전 확인사항
                                </div>
                                <div className="p-4 space-y-4">
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-[13px] font-bold text-cur-ink">개인별 건강상태 이상 유무</Label>
                                        <Input name="healthCheck" value={formData.healthCheck} onChange={handleChange} className="bg-amber-50 text-amber-800 border-amber-200 font-medium h-10" />
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-[13px] font-bold text-cur-ink">개인 보호구 착용 상태</Label>
                                        <Input name="ppeCheck" value={formData.ppeCheck} onChange={handleChange} className="bg-amber-50 text-amber-800 border-amber-200 font-medium h-10" />
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-[13px] font-bold text-cur-info">안전구호 제창 (AI 추천)</Label>
                                        <Input name="safetyPhrase" value={formData.safetyPhrase} onChange={handleChange} className="font-bold border-cur-info/20 bg-cur-info/5 text-cur-info h-10" />
                                    </div>
                                </div>
                            </div>

                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden shadow-none">
                                <div className="bg-cur-canvas border-b border-cur-hairline px-4 py-3 font-bold text-cur-ink text-[14px]">
                                    ■ 작업 시작전 협의 및 지시사항
                                </div>
                                <div className="p-4">
                                    <textarea
                                        name="instructions"
                                        value={formData.instructions}
                                        onChange={handleChange}
                                        className="w-full p-3 border border-cur-hairline rounded-[10px] h-32 text-[15px] bg-cur-card resize-none focus:outline-none focus:border-cur-primary focus:ring-1 focus:ring-cur-primary font-medium text-cur-ink shadow-sm"
                                    />
                                </div>
                            </div>
                                </>
                            )}
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <div className="flex justify-between items-center">
                                <h2 className="text-[20px] font-semibold text-cur-ink flex items-center gap-2 tracking-tight">
                                    <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">3</span> 참석자 명단 <span className="text-[14px] font-medium text-cur-muted bg-cur-card px-2 py-0.5 rounded-[6px] border border-cur-hairline ml-1">{formData.participants.length}명</span>
                                </h2>
                                <Button size="sm" onClick={addParticipant} className="bg-cur-card border border-cur-hairline text-cur-ink hover:bg-cur-canvas h-8 px-3 rounded-[6px] text-[12px] font-semibold shadow-sm"><Plus className="w-3.5 h-3.5 mr-1" /> 추가</Button>
                            </div>

                            <div className="bg-cur-info/5 border border-cur-info/20 rounded-[12px] p-5 flex flex-col items-center justify-center text-center space-y-4 shadow-none">
                                <div className="flex items-center gap-2 text-cur-info font-bold text-[15px]"><QrCode className="w-5 h-5" /> 팀원 스마트폰으로 서명받기</div>
                                {sessionId && (
                                    <div className="bg-cur-card p-3.5 rounded-[12px] shadow-sm border border-cur-hairline">
                                        <QRCodeCanvas value={typeof window !== "undefined" ? `${window.location.origin}/tbm/sign/${sessionId}` : ""} size={150} level={"H"} />
                                    </div>
                                )}
                                <p className="text-[13px] text-cur-info font-medium leading-relaxed">위 QR을 보여주거나 아래 링크를 카톡으로 보내세요.</p>
                                <Button variant="outline" onClick={() => { if (typeof window !== "undefined" && sessionId) { navigator.clipboard.writeText(`${window.location.origin}/tbm/sign/${sessionId}`); alert("복사 완료!"); } }} className="bg-cur-card border-cur-info/30 text-cur-info hover:bg-cur-info/10 h-10 rounded-[8px] font-semibold text-[13px] px-5"><Copy className="w-4 h-4 mr-2" /> 링크 복사</Button>
                            </div>

                            <div className="space-y-3">
                                {formData.participants.map((p, idx) => (
                                    <div key={p.id} className="bg-cur-card p-4 border border-cur-hairline rounded-[12px] shadow-none flex flex-col gap-3 transition-all hover:border-cur-hairline">
                                        <div className="flex items-center gap-3">
                                            <div className="w-7 h-7 bg-cur-canvas rounded-[6px] flex items-center justify-center font-bold text-cur-muted text-[12px] shrink-0">{idx + 1}</div>
                                            <Input placeholder="이름을 입력하세요" className="flex-1 h-10 text-[15px] font-bold border-0 border-b border-cur-hairline rounded-none px-1 focus-visible:ring-0 focus-visible:border-cur-primary" value={p.name} onChange={(e) => updateParticipant(p.id, "name", e.target.value)} />
                                            <Button size="icon" variant="ghost" className="text-cur-error/70 hover:text-cur-error hover:bg-cur-error/5 h-8 w-8 rounded-[6px]" onClick={() => removeParticipant(p.id)}><Trash2 className="w-4 h-4" /></Button>
                                        </div>
                                        <div className="flex gap-3 mt-1">
                                            <div className="flex bg-cur-canvas p-1 rounded-[8px] shrink-0">
                                                <button onClick={() => updateParticipant(p.id, "gender", "M")} className={cn("px-4 py-1.5 text-[13px] font-bold rounded-[6px] transition-all", p.gender === 'M' ? 'bg-cur-card text-cur-ink shadow-sm' : 'text-cur-muted hover:text-cur-ink')}>남</button>
                                                <button onClick={() => updateParticipant(p.id, "gender", "F")} className={cn("px-4 py-1.5 text-[13px] font-bold rounded-[6px] transition-all", p.gender === 'F' ? 'bg-cur-card text-cur-ink shadow-sm' : 'text-cur-muted hover:text-cur-ink')}>여</button>
                                            </div>
                                            <div className="flex-1" onClick={() => openSignModal({ type: 'participant', id: p.id })}>
                                                {p.signature ? <div className="h-10 bg-cur-success/5 border border-[#86efac] rounded-[8px] flex items-center justify-center overflow-hidden"><img src={p.signature} className="h-[120%] object-contain" /></div> : <Button variant="outline" className="w-full h-10 border-dashed text-cur-muted font-medium text-[13px] border-cur-hairline rounded-[8px] hover:bg-cur-elevated">내 폰으로 직접 받기</Button>}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {step === 5 && (
                        <div className="flex flex-col items-center justify-center h-[50vh] animate-in zoom-in duration-300">
                            <div className="w-20 h-20 bg-cur-success/5 rounded-full flex items-center justify-center mb-6 shadow-sm">
                                <CheckCircle2 className="w-10 h-10 text-[#16a34a]" />
                            </div>
                            <h2 className="text-[24px] font-bold text-cur-ink mb-2 tracking-tight">저장 완료</h2>
                            <p className="text-[14px] text-cur-muted-soft text-center mb-10 font-medium">안전가이드라인 TBM 회의록 작성이 완료되었습니다.</p>
                            <div className="w-full max-w-xs space-y-3">
                                <Button variant="outline" onClick={() => router.push('/')} className="w-full h-12 text-[14px] font-semibold border-cur-hairline text-cur-ink rounded-[10px] bg-cur-card hover:bg-cur-elevated">메인 화면으로</Button>
                            </div>
                        </div>
                    )}

                </div>

                {step < 5 && (
                    <div className="bg-cur-card border-t border-cur-hairline p-4 flex gap-3 shadow-[0_-4px_24px_rgba(0,0,0,0.02)] sticky bottom-0 z-50 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:rounded-b-[24px]">
                        {step > 1 && (
                            <Button variant="outline" onClick={() => setStep(prev => Math.max(1, prev - 1))} className="flex-1 h-14 text-[15px] font-semibold border-cur-hairline text-cur-ink rounded-[10px] hover:bg-cur-elevated">이전</Button>
                        )}
                        {step < 4 ? (
                            <Button 
                                onClick={step === 2 ? submitRecording : handleNext} 
                                disabled={step === 2 && (isRecording || recordingCount === 0)}
                                className="flex-[2] h-14 text-[16px] font-bold bg-cur-ink hover:bg-cur-ink/90 text-cur-on-primary rounded-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.1)] transition-transform active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
                            >
                                {step === 2 ? "AI 요약" : "다음 단계"}
                            </Button>
                        ) : (
                            <Button onClick={() => setIsConfirmationOpen(true)} disabled={isSaving} className="flex-[2] h-14 text-[16px] font-bold bg-[#16a34a] hover:bg-[#15803d] text-cur-on-primary rounded-[10px] shadow-[0_4px_12px_rgba(22,163,74,0.2)] transition-transform active:scale-[0.98]">
                                {isSaving ? <Loader2 className="animate-spin w-5 h-5 mr-2" /> : <Save className="mr-2 w-5 h-5" />} 완료 및 저장
                            </Button>
                        )}
                    </div>
                )}
            </div>

            <Dialog open={isSignOpen} onOpenChange={setIsSignOpen}>
                <DialogContent showCloseButton={true} className="max-w-md w-[calc(100%-2rem)] h-[70vh] max-h-[70vh] flex flex-col p-0 gap-0 rounded-[20px] overflow-hidden border-cur-hairline shadow-[0_8px_32px_rgba(0,0,0,0.1)]">
                    <DialogHeader className="p-4 border-b border-cur-hairline bg-cur-card shrink-0"><DialogTitle className="text-center text-[18px] font-bold text-cur-ink tracking-tight">서명해 주세요</DialogTitle></DialogHeader>
                    <div className="p-5 flex-1 bg-cur-elevated min-h-0 flex flex-col">
                        <div className="border border-cur-hairline rounded-[12px] bg-cur-card flex-1 shadow-none overflow-hidden relative" style={{ touchAction: "none" }}>
                            <SignatureCanvas ref={sigCanvas} canvasProps={{ className: "w-full h-full absolute inset-0" }} />
                        </div>
                    </div>
                    <DialogFooter className="flex-row gap-3 border-t border-cur-hairline bg-cur-card p-4 shrink-0">
                        <Button variant="outline" onClick={() => sigCanvas.current?.clear()} className="flex-1 h-12 text-[15px] font-semibold border-cur-hairline text-cur-ink rounded-[10px] hover:bg-cur-elevated">지우기</Button>
                        <Button onClick={saveSignature} className="flex-1 h-12 text-[15px] font-bold bg-cur-ink text-cur-on-primary rounded-[10px] hover:bg-cur-ink/90">입력 완료</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={isConfirmationOpen} onOpenChange={setIsConfirmationOpen}>
                <DialogContent showCloseButton={true} className="max-w-md w-[calc(100%-2rem)] h-[85vh] max-h-[85vh] flex flex-col p-0 gap-0 rounded-[20px] overflow-hidden border-cur-hairline shadow-[0_8px_32px_rgba(0,0,0,0.1)]">
                    <DialogHeader className="p-4 border-b border-cur-hairline bg-cur-card shrink-0">
                        <DialogTitle className="text-center text-[18px] font-bold text-cur-ink tracking-tight">작성 내용 확인 및 서명</DialogTitle>
                    </DialogHeader>
                    <div className="p-5 flex-1 bg-cur-canvas-soft overflow-y-auto space-y-5">
                        <div className="bg-cur-card p-4 rounded-[12px] border border-cur-hairline text-[14px] leading-relaxed text-cur-ink space-y-3 shadow-sm">
                            <p className="font-bold text-cur-primary flex items-center gap-1.5">
                                💡 AI 요약본 확인 안내
                            </p>
                            <p className="text-cur-muted font-medium">
                                본 TBM 회의록의 작업 내용 및 위험요인, 지시사항 등은 AI 요약 기술을 기반으로 생성된 초안을 바탕으로 작성되었습니다.
                            </p>
                            <p className="font-semibold text-cur-ink bg-cur-elevated p-3 rounded-[8px] border border-cur-hairline">
                                AI가 작성한 요약본은 참고용 초안입니다. 최종 저장하기 전에 내용이 실제 현장 상황과 맞는지 꼭 확인하고 수정해 주세요. 최종 기록된 내용에 대한 확인 책임은 작성자에게 있습니다.
                            </p>
                        </div>

                        <label className="flex items-start gap-3 p-3 bg-cur-card border border-cur-hairline rounded-[10px] cursor-pointer shadow-none">
                            <input
                                type="checkbox"
                                checked={hasAgreedToDisclaimer}
                                onChange={(e) => setHasAgreedToDisclaimer(e.target.checked)}
                                className="w-5 h-5 rounded border-cur-hairline text-cur-primary focus:ring-cur-primary accent-cur-primary shrink-0 mt-0.5"
                            />
                            <span className="text-[14px] font-bold text-cur-ink leading-snug">
                                위 안내 사항을 확인하였으며, 기록된 내용을 최종 검토하였습니다.
                            </span>
                        </label>

                        <div className="flex flex-col flex-1 min-h-[180px] bg-cur-card border border-cur-hairline rounded-[12px] p-3 space-y-2">
                            <span className="text-[13px] font-bold text-cur-ink">최종 작성자 서명</span>
                            <div className="border border-cur-hairline rounded-[8px] bg-cur-canvas flex-1 overflow-hidden relative" style={{ touchAction: "none" }}>
                                <SignatureCanvas ref={confirmationSigCanvas} canvasProps={{ className: "w-full h-full absolute inset-0" }} />
                            </div>
                        </div>
                    </div>
                    <DialogFooter className="flex-row gap-3 border-t border-cur-hairline bg-cur-card p-4 shrink-0">
                        <Button variant="outline" onClick={() => confirmationSigCanvas.current?.clear()} className="flex-1 h-12 text-[15px] font-semibold border-cur-hairline text-cur-ink rounded-[10px] hover:bg-cur-elevated">지우기</Button>
                        <Button onClick={handleConfirmAndSave} className="flex-1 h-12 text-[15px] font-bold bg-[#16a34a] text-cur-on-primary rounded-[10px] hover:bg-[#15803d]">동의 및 저장</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
