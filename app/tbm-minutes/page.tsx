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
import { MATRIX_DIMS, freqSevGrade, type MatrixScale } from "@/lib/riskMatrix"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Mic, CheckCircle2, Plus, Trash2, PenTool, Loader2, Save, CalendarIcon, Clock, RefreshCw, Send, Pause, Play, QrCode, Copy, Upload, FileText, Sparkles, BookOpen, ChevronDown } from "lucide-react"
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
    // 빈도강도법일 때만 채워짐 (상중하법이면 undefined)
    frequency?: number
    severity?: number
    risk?: number
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

// ─── step 4 공용 스타일 상수 (quiet-filled 편집 필드) ───
// 16px는 iOS 자동 줌 방지 임계 — 절대 내리지 말 것 (md:text-[16px]로 shadcn 기본 md:text-sm 무력화)
const FIELD_CLS = "h-12 w-full px-3 bg-cur-canvas border-0 shadow-none rounded-[8px] text-[16px] md:text-[16px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus:bg-cur-card focus:outline-none focus-visible:border-0 focus-visible:ring-1 focus-visible:ring-cur-primary"
const AREA_CLS = "w-full p-3 min-h-[64px] resize-y leading-relaxed bg-cur-canvas border-0 shadow-none rounded-[8px] text-[16px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus:bg-cur-card focus:ring-1 focus:ring-cur-primary focus:outline-none"
const SELECT_CLS = "h-12 w-full px-3 bg-cur-canvas border-0 rounded-[8px] text-[16px] font-medium text-cur-ink focus:bg-cur-card focus:ring-1 focus:ring-cur-primary focus:outline-none"
// 라벨은 값(16px ink)보다 조용하게 — 단 cur-muted(4.1:1)는 야외 현장 가독에 부족해 body(7:1) 사용
const LABEL_CLS = "text-[13px] font-medium text-cur-body"

// 등급색 매핑 헬퍼 — 좌측 보더 / 등급 배지 / 세그먼트 선택 텍스트 / 위험도 칩에서 공유
const LEVEL_STYLES: Record<string, { border: string; badge: string; seg: string }> = {
    "상": { border: "border-l-cur-error", badge: "bg-cur-error/10 text-cur-error", seg: "text-cur-error" },
    "중": { border: "border-l-cur-primary", badge: "bg-cur-primary/10 text-cur-primary-active", seg: "text-cur-primary-active" },
    "하": { border: "border-l-cur-success", badge: "bg-cur-success/10 text-cur-success", seg: "text-cur-success" },
    "상중하": { border: "border-l-cur-hairline-strong", badge: "bg-cur-elevated text-cur-ink", seg: "text-cur-ink" },
}
const levelStyle = (level: string) => LEVEL_STYLES[level] ?? LEVEL_STYLES["상중하"]

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
    // 화면 꺼짐/이동으로 자동 일시정지됐음을 재개 화면에서 안내하기 위한 플래그
    const [autoPaused, setAutoPaused] = useState(false);
    const MAX_RECORDING_TIME = 1200;

    // 20분 상한 임박 알림(3분·1분 전 각 1회) — 진동(안드로이드) + 짧은 알림음(진동 미지원 아이폰 폴백).
    // AudioContext는 '녹음 시작' 클릭(사용자 제스처) 이후에만 만들어져 자동재생 정책에 걸리지 않는다.
    const limitWarnedRef = useRef({ m3: false, m1: false });
    const audioCtxRef = useRef<AudioContext | null>(null);
    const notifyLimit = () => {
        try { navigator.vibrate?.([200, 100, 200]); } catch { /* 미지원 무시 */ }
        try {
            const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AC) return;
            const ctx = audioCtxRef.current ?? new AC();
            audioCtxRef.current = ctx;
            if (ctx.state === "suspended") void ctx.resume();
            const t0 = ctx.currentTime;
            [0, 0.25].forEach((t) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.frequency.value = 880;
                osc.connect(gain);
                gain.connect(ctx.destination);
                gain.gain.setValueAtTime(0.0001, t0 + t);
                gain.gain.exponentialRampToValueAtTime(0.18, t0 + t + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.18);
                osc.start(t0 + t);
                osc.stop(t0 + t + 0.2);
            });
        } catch { /* 오디오 미지원 무시 */ }
    };

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

                    // 상한 임박 알림 — 3분 전(진동+알림음), 1분 전(한 번 더). 재개 시점이 늦으면 해당 단계만.
                    const remaining = MAX_RECORDING_TIME - total;
                    if (remaining <= 180 && remaining > 60 && !limitWarnedRef.current.m3) {
                        limitWarnedRef.current.m3 = true;
                        notifyLimit();
                    }
                    if (remaining <= 60 && remaining > 0 && !limitWarnedRef.current.m1) {
                        limitWarnedRef.current.m1 = true;
                        notifyLimit();
                    }

                    if (total >= MAX_RECORDING_TIME) {
                        setIsRecording(false);
                        isRecordingRef.current = false;
                        if (recognitionRef.current) {
                            recognitionRef.current.stop();
                        }
                        // 수동 일시정지(stopRecording)와 동일한 종료 처리 필수 — 빠뜨리면 첫 녹음이
                        // 20분을 채웠을 때 recordingCount가 0에 머물러 'AI 요약' 버튼이 계속 잠기고
                        // 화면도 초기 상태로 돌아가, 인식된 내용이 있어도 저장 못 하는 것처럼 보인다.
                        setFormData(prev => ({ ...prev, endTime: getCurrentTime() }));
                        setRecordingCount(prev => prev + 1);
                        alert("최대 녹음 시간(20분)에 도달해 녹음이 자동 종료되었습니다.\n지금까지 인식된 내용은 그대로 있으니, 아래 'AI 요약'을 눌러 회의록을 만드세요.");
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
                setFormData(prev => ({ ...prev, endTime: getCurrentTime() }));
                setRecordingCount(prev => prev + 1);
                setAutoPaused(true);
            }
        };
        document.addEventListener("visibilitychange", handleVisibility);
        window.addEventListener("pagehide", handleVisibility);
        return () => {
            document.removeEventListener("visibilitychange", handleVisibility);
            window.removeEventListener("pagehide", handleVisibility);
        };
    }, []);

    // 녹음 중 화면 자동 꺼짐 방지(Wake Lock) — 화면이 꺼지면 브라우저가 마이크·음성인식을
    // 중단시키므로 녹음 동안은 화면을 깨워둔다(안드로이드 크롬·iOS 사파리 16.4+ 지원,
    // 미지원 브라우저는 기존 "화면을 켜두세요" 안내가 커버).
    useEffect(() => {
        if (!isRecording) return;
        let sentinel: WakeLockSentinel | null = null;
        let cancelled = false;
        void (async () => {
            try {
                sentinel = (await navigator.wakeLock?.request("screen")) ?? null;
                if (cancelled) void sentinel?.release();
            } catch { /* 저전력 모드 거부·구형 브라우저 미지원은 무시 */ }
        })();
        return () => {
            cancelled = true;
            try { void sentinel?.release(); } catch { /* 이미 해제됨 */ }
        };
    }, [isRecording]);

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
    // 가이드 아코디언 표시 전용 토글 — 녹음 로직·데이터 무관. step 전환·녹음 시작/정지에 리셋하지 않음(대본 보며 진행 워크플로 보존)
    const [guideOpen, setGuideOpen] = useState(false)
    const sigCanvas = useRef<SignatureCanvas>(null)

    const [isConfirmationOpen, setIsConfirmationOpen] = useState(false)
    const [hasAgreedToDisclaimer, setHasAgreedToDisclaimer] = useState(false)
    const confirmationSigCanvas = useRef<SignatureCanvas>(null)
    const savingRef = useRef(false)

    const getCurrentTime = () => {
        const now = new Date()
        return now.toTimeString().slice(0, 8) // HH:MM:SS — 초까지 저장해야 1분 미만 세션이 잘리지 않음
    }

    const [formData, setFormData] = useState<TBMMinutesData>({
        date: new Date(),
        startTime: getCurrentTime(),
        endTime: "",
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
    // 위험성평가 방법(AI 응답에서 받음). freq_sev면 위험성 편집을 빈도/강도 입력으로.
    const [riskMethod, setRiskMethod] = useState<"level3" | "freq_sev">("level3")
    const [riskMatrix, setRiskMatrix] = useState<MatrixScale>("3x3")

    // 근로자 의견 합류(step 4): 이미 반영한 의견 id — '이전'으로 갔다 와도 중복 추가 방지
    const processedSuggestionIds = useRef(new Set<string>())
    const isMergingRef = useRef(false)
    const [isMergingSuggestions, setIsMergingSuggestions] = useState(false)

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

                // 세션 소유자(로그인 유저)를 마커에 기록 — RLS 격리(내 세션 서명만 조회/삭제)
                supabase.auth.getSession().then(({ data }) =>
                    supabase.from('tbm_pending_signatures').insert({
                        session_id: currentSessionId,
                        name: "OPEN_SESSION",
                        gender: "M",
                        signature: "init",
                        user_id: data.session?.user?.id ?? null,
                    }).then()
                );
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

    // step 4에서 근로자 의견을 위험성평가 항목으로 합류.
    // 진입 시 1회 + 12초 주기 폴링 — 소장이 검토 화면을 보는 동안 뒤늦게 도착하는 의견도
    // 저장 전에 잡아야 한다(진입 시 1회만 조회하면 검토 중 도착분이 문서에서 빠짐 — 실사고 있었음).
    useEffect(() => {
        if (step !== 4 || isProcessingSTT || isProcessingAI || !sessionId) return;
        const mergeWorkerSuggestions = async () => {
            if (isMergingRef.current) return;
            isMergingRef.current = true;
            try {
                const { data, error } = await supabase
                    .from('worker_suggestions')
                    .select('id, content')
                    .eq('session_id', sessionId);
                if (error || !data) return; // 실패해도 검토 흐름은 계속
                const fresh = (data as { id: string; content: string }[])
                    .filter(s => !processedSuggestionIds.current.has(s.id))
                    .slice(0, 30); // API 상한
                if (fresh.length === 0) return;
                setIsMergingSuggestions(true);
                try {
                    const { data: { session } } = await supabase.auth.getSession();
                    const res = await fetch('/api/ai/suggestion-hazards', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
                        body: JSON.stringify({ suggestions: fresh.map(s => s.content.slice(0, 500)) })
                    });
                    if (!res.ok) {
                        if (res.status !== 429 && res.status !== 402) console.error('suggestion-hazards error:', res.status);
                        return;
                    }
                    const result = await res.json();
                    if (Array.isArray(result.hazards) && result.hazards.length > 0) {
                        setFormData(prev => ({ ...prev, hazards: [...prev.hazards, ...result.hazards] }));
                    }
                    fresh.forEach(s => processedSuggestionIds.current.add(s.id));
                } finally {
                    setIsMergingSuggestions(false);
                }
            } catch (e) {
                console.error('suggestion merge failed:', e); // 알림 없이 콘솔만
            } finally {
                isMergingRef.current = false;
            }
        };
        mergeWorkerSuggestions();
        const poll = setInterval(mergeWorkerSuggestions, 12_000);
        return () => clearInterval(poll);
    }, [step, isProcessingSTT, isProcessingAI, sessionId]);

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
                    end_time: formData.endTime || getCurrentTime(),
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
                    hazards: formData.hazards,
                    // 음성 인식 원문 보관(재가공용). 없으면 null. 개인정보 포함 가능 → 판매 전 별도 동의 필요.
                    raw_transcript: accumulatedTranscript.trim() || null
                })
                .select()
                .single()

            if (logError) throw logError

            const validParticipantsForDB = formData.participants.filter(p => p.name.trim() !== "" || p.signature);
            // 참석자 서명 업로드 병렬화 — 직렬이면 저장이 인원수에 비례해 길어짐(31명 = 수십 초).
            // Promise.all은 순서를 보존하므로 insert 순서도 기존과 동일.
            const participantsData = await Promise.all(validParticipantsForDB.map(async (p) => ({
                minutes_id: logData.id,
                name: p.name,
                signature: p.signature && p.signature.startsWith('data:')
                    ? await uploadBase64ToStorage(p.signature, 'signatures', 'minute-participant')
                    : p.signature
            })));

            if(participantsData.length > 0) {
                const { error: partError } = await supabase.from('tbm_minutes_participants').insert(participantsData)
                if (partError) {
                    // 참가자 저장 실패 시 방금 생성한 회의록을 롤백(고아/중복 방지)
                    await supabase.from('tbm_minutes').delete().eq('id', logData.id)
                    throw partError
                }
            }

            if (sessionId) {
                // 저장 완료 → pending 정리. OPEN 마커가 사라지면 서명 페이지는 자동으로 만료 처리되므로
                // 별도 CLOSED 마커 삽입은 불필요(삭제 후엔 소유권 근거가 없어 RLS상 삽입도 거부됨).
                await supabase.from('tbm_pending_signatures').delete().eq('session_id', sessionId);
            }

            setSavedLogId(logData.id)
            setStep(5)

        } catch (e: unknown) {
            const errorMessage =
                e instanceof Error
                    ? e.message
                    : e && typeof e === "object" && "message" in e
                    ? String((e as { message: unknown }).message)
                    : "알 수 없는 오류"
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
                if (data.riskMethod === "freq_sev" || data.riskMethod === "level3") setRiskMethod(data.riskMethod)
                if (data.riskMatrix === "3x3" || data.riskMatrix === "5x4" || data.riskMatrix === "5x5") setRiskMatrix(data.riskMatrix)
                setFormData(prev => ({
                    ...prev,
                    processName: data.processName || prev.processName,
                    workName: data.workName || prev.workName,
                    workContent: data.workContent || prev.workContent,
                    // 재요약 시에도 이미 합류된 [근로자 의견] 항목은 보존 — processedSuggestionIds에 남아
                    // 재병합이 안 되므로 여기서 지우면 근로자 의견이 문서에서 영구 소실된다.
                    hazards: [
                        ...(Array.isArray(data.hazards) ? data.hazards : []),
                        ...prev.hazards.filter(h => h.factor?.startsWith("[근로자 의견]")),
                    ],
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
        // 종료시간 = 마지막 녹음 종료 시각
        setFormData(prev => ({ ...prev, endTime: getCurrentTime() }))
        setRecordingCount(prev => prev + 1)
    }

    const startRecording = async () => {
        setAutoPaused(false);
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
                if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                    // 마이크 권한을 실수로 거부/차단한 경우 — 브라우저별 허용 방법 안내
                    stopRecording();
                    alert("마이크 권한이 꺼져 있어 음성 인식을 시작할 수 없습니다.\n\n[마이크 허용 방법]\n· 아이폰(Safari): 주소창의 'AA' 버튼 → 웹사이트 설정 → 마이크 → 허용 (또는 설정 > Safari > 마이크)\n· PC·안드로이드(Chrome): 주소창 왼쪽 자물쇠 아이콘 → 마이크 → 허용\n\n허용으로 바꾼 뒤 다시 '녹음 시작'을 눌러주세요.");
                } else if (event.error === 'audio-capture') {
                    stopRecording();
                    alert("마이크를 찾을 수 없습니다. 마이크가 연결·활성화돼 있는지 확인한 뒤 다시 시도해주세요.");
                } else if (event.error === 'network') {
                    stopRecording();
                    alert("네트워크 문제로 음성 인식이 중단되었습니다. 인터넷 연결을 확인한 뒤 다시 시도해주세요.");
                }
                // 'no-speech','aborted' 등 일시적 오류는 무시(onend에서 자동 재시작)
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
            // 시작시간 = 첫 녹음 시작 시각 (여러 번 녹음해도 처음 것 유지)
            setFormData(prev => ({ ...prev, startTime: recordingCount === 0 ? getCurrentTime() : prev.startTime }));
        } catch (err) {
            console.error(err);
            alert("마이크 권한을 확인해주세요.\n브라우저에서 마이크 사용을 '허용'으로 바꾼 뒤 다시 시도해주세요.");
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

    const addHazard = () => setFormData(prev => {
        const g = freqSevGrade(1, 1, riskMatrix)
        const h: Hazard = riskMethod === "freq_sev"
            ? { factor: "", measure: "", frequency: 1, severity: 1, risk: g.score, level: g.level }
            : { factor: "", level: "중", measure: "" }
        return { ...prev, hazards: [...prev.hazards, h] }
    })
    const updateHazard = (idx: number, field: string, value: string) => {
        const newHazards = [...formData.hazards];
        newHazards[idx] = { ...newHazards[idx], [field]: value };
        setFormData(prev => ({ ...prev, hazards: newHazards }));
    }
    // 빈도/강도 변경 시 위험도·등급을 다시 산정해 함께 저장
    const updateHazardFreqSev = (idx: number, field: "frequency" | "severity", value: number) => {
        const newHazards = [...formData.hazards];
        const h = { ...newHazards[idx], [field]: value };
        const { score, level } = freqSevGrade(Number(h.frequency) || 1, Number(h.severity) || 1, riskMatrix);
        newHazards[idx] = { ...h, risk: score, level };
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
        <div className="w-full text-left border-t border-cur-hairline">
            {/* 탭 → 세그먼트 컨트롤 (주황 배급 금지 — 주황은 CTA 전용) */}
            <div className="m-3 h-9 p-1 rounded-[8px] bg-cur-canvas grid grid-cols-2 gap-1">
                <button onClick={() => setGuideTab('guide')} className={guideTab === 'guide' ? "rounded-[6px] bg-cur-card shadow-sm text-cur-ink text-[13px] font-semibold" : "rounded-[6px] text-cur-muted text-[13px] font-medium"}>TBM 가이드</button>
                <button onClick={() => setGuideTab('script')} className={guideTab === 'script' ? "rounded-[6px] bg-cur-card shadow-sm text-cur-ink text-[13px] font-semibold" : "rounded-[6px] text-cur-muted text-[13px] font-medium"}>대본 예시</button>
            </div>
            <div className="p-4 bg-cur-canvas-soft text-[13px] leading-relaxed max-h-[200px] overflow-y-auto">
                {guideTab === 'guide' ? (
                    <div className="space-y-3">
                        <div><span className="font-semibold text-cur-ink">1. 오늘의 작업내용</span><br /><span className="text-cur-muted">오늘 할 작업과 위험요인을 공유합니다</span></div>
                        <div><span className="font-semibold text-cur-ink">2. 위험요인과 대책</span><br /><span className="text-cur-muted">제거→대체→공학→관리→보호구 순으로 대책을 정합니다</span></div>
                        <div><span className="font-semibold text-cur-ink">3. 시작 전 확인</span><br /><span className="text-cur-muted">건강상태·보호구 점검 후 안전구호 제창</span></div>
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
                                <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">1</span> 날짜와 장소
                            </h2>
                            <div className="space-y-4 bg-cur-card p-4 rounded-[12px] border border-cur-hairline shadow-none">
                                <div className="space-y-2">
                                    <Label className={LABEL_CLS}>날짜</Label>
                                    <Popover>
                                        <PopoverTrigger asChild>
                                            <Button variant="ghost" className={cn(FIELD_CLS, "justify-start text-left hover:bg-cur-elevated")}>
                                                <CalendarIcon className="mr-2 h-5 w-5 text-cur-muted" />
                                                <span className={cn(formData.date ? "text-cur-ink" : "text-cur-muted")}>
                                                    {formData.date ? format(formData.date, "yyyy년 MM월 dd일 (EEE)", { locale: ko }) : "날짜 선택"}
                                                </span>
                                            </Button>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-auto p-0 rounded-[12px] border-cur-hairline shadow-[0_4px_24px_rgba(0,0,0,0.08)]" align="center">
                                            <Calendar mode="single" locale={ko} selected={formData.date} onSelect={(date) => setFormData(prev => ({ ...prev, date }))} initialFocus className="p-3" />
                                        </PopoverContent>
                                    </Popover>
                                </div>

                                <div className="space-y-2"><Label className={LABEL_CLS}>장소</Label><Input name="location" value={formData.location} onChange={handleChange} className={FIELD_CLS} /></div>

                                {/* 자동 시간 상태 라인 — 표시 전용, 기록 로직(녹음 시작/종료 시 자동 기록)은 불변 */}
                                <div className="pt-3 border-t border-cur-hairline-soft flex items-center gap-2">
                                    <Clock className="w-4 h-4 text-cur-muted shrink-0" />
                                    {formData.startTime ? (
                                        <>
                                            <span className="text-[14px] font-medium text-cur-body tabular-nums">
                                                시작 {formData.startTime.slice(0, 5)} · 종료 {formData.endTime ? formData.endTime.slice(0, 5) : "진행 전"}
                                            </span>
                                            <span className="text-[11px] text-cur-muted bg-cur-elevated rounded-[6px] px-1.5 py-0.5 shrink-0">자동 기록</span>
                                        </>
                                    ) : (
                                        <span className="text-[13px] text-cur-muted">시작·종료 시간은 녹음할 때 자동 기록됩니다</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 2 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-[20px] font-semibold text-cur-ink flex items-center gap-2 tracking-tight">
                                <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">2</span> 회의 녹음
                            </h2>

                            {/* 가이드 아코디언 — 전 상태 상시 렌더 (녹음 중에도 대본 접근 가능).
                                트리거와 패널을 한 카드로 묶어 펼쳤을 때 따로 떠 보이지 않게 한다. */}
                            <div className="rounded-[12px] border border-cur-hairline bg-cur-card overflow-hidden">
                                <button type="button" onClick={() => setGuideOpen(v => !v)}
                                    className="h-12 w-full flex items-center justify-between px-4 text-[14px] font-medium text-cur-body active:bg-cur-elevated">
                                    <span className="flex items-center gap-2"><BookOpen className="w-4 h-4 text-cur-muted" /> 진행 순서·대본 보기</span>
                                    <ChevronDown className={cn("w-4 h-4 text-cur-muted-soft transition-transform", guideOpen && "rotate-180")} />
                                </button>
                                {guideOpen && tbmGuideBox}
                            </div>

                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] p-6 min-h-[360px] flex flex-col items-center justify-center text-center">
                                {isRecording ? (
                                    <div className="w-full flex flex-col items-center animate-in fade-in duration-300">
                                        <div className="flex items-center gap-2">
                                            <span className="w-2.5 h-2.5 bg-cur-error rounded-full animate-pulse shrink-0" />
                                            <span className="text-[13px] font-semibold text-cur-error">녹음 중{recordingCount > 0 && ` · ${recordingCount + 1}회차`}</span>
                                        </div>
                                        <div className={cn("text-[36px] font-bold tabular-nums leading-none mt-2", MAX_RECORDING_TIME - recordingTime <= 60 ? "text-cur-error" : "text-cur-ink")}>{formatTime(recordingTime)}</div>
                                        <div className="text-[13px] text-cur-muted mt-1">/ 20:00</div>
                                        {MAX_RECORDING_TIME - recordingTime <= 180 && (
                                            <p className={cn("text-[13px] font-semibold mt-2", MAX_RECORDING_TIME - recordingTime <= 60 ? "text-cur-error" : "text-cur-body")}>
                                                {formatTime(Math.max(0, MAX_RECORDING_TIME - recordingTime))} 남음 — 최대 20분까지 녹음되고 자동 종료돼요
                                            </p>
                                        )}
                                        <Button onClick={stopRecording} className="w-32 h-32 rounded-full shadow-[0_8px_24px_rgba(207,45,86,0.25)] bg-cur-error hover:bg-cur-error/90 flex flex-col items-center justify-center gap-2 mt-4 shrink-0 transition-transform active:scale-95">
                                            <Pause className="w-10 h-10 text-cur-on-primary" />
                                            <span className="text-cur-on-primary font-bold text-[16px]">일시정지</span>
                                        </Button>
                                        <p className="text-[13px] font-medium text-cur-body mt-2">화면을 켜두세요 — 꺼지면 녹음이 멈춥니다</p>
                                    </div>
                                ) : recordingCount > 0 ? (
                                    <div className="w-full flex flex-col items-center space-y-6 animate-in fade-in duration-300">
                                        <div className="flex items-center gap-2">
                                            <CheckCircle2 className="w-5 h-5 text-cur-success shrink-0" />
                                            <span className="text-[15px] font-semibold text-cur-ink">녹음 완료</span>
                                            <span className="text-[13px] text-cur-muted font-mono">{recordingCount}회 · {formatTime(recordingTime)}</span>
                                        </div>
                                        {autoPaused && (
                                            <p className="text-[13px] text-cur-body font-medium">화면이 꺼지거나 다른 화면으로 이동해 자동 일시정지됐어요 — &lsquo;이어서 녹음&rsquo;을 누르면 계속됩니다.</p>
                                        )}
                                        <Button onClick={startRecording} variant="outline" className="w-full h-12 rounded-[8px] border border-cur-hairline bg-cur-card text-cur-ink text-[15px] font-semibold hover:bg-cur-elevated shadow-none">
                                            <Play className="mr-2 w-4 h-4 text-cur-muted" /> 이어서 녹음
                                        </Button>
                                        <p className="text-[13px] text-cur-muted">회의를 마쳤으면 아래 &apos;AI 요약&apos;을 누르세요</p>
                                    </div>
                                ) : (
                                    <div className="w-full flex flex-col items-center animate-in zoom-in duration-300">
                                        <Button onClick={startRecording} className="w-40 h-40 rounded-full bg-cur-primary hover:bg-cur-primary-active shadow-[0_12px_32px_rgba(245,78,0,0.25)] flex flex-col items-center justify-center gap-3 shrink-0 transition-transform active:scale-95">
                                            <Mic className="w-14 h-14 text-cur-on-primary" />
                                            <span className="text-[18px] font-bold text-cur-on-primary">녹음 시작</span>
                                        </Button>
                                        <p className="mt-5 text-[14px] text-cur-body text-center">
                                            누르고 평소처럼 회의하세요 — AI가 회의록으로 정리합니다
                                        </p>

                                        {typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && (
                                            <div className="flex flex-col items-center space-y-2 mt-8">
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

                            {/* 고지 캡션 — 녹음 시작 전(idle)에만 노출. 법적 요지(변환·저장·이용 목적·방침 링크)는 녹음 전 반드시 화면에 있어야 함 */}
                            {recordingCount === 0 && !isRecording && (
                                <div className="space-y-1.5 px-4">
                                    <p className="text-[12px] text-cur-muted text-center">Chrome·Safari 브라우저 권장</p>
                                    <p className="text-[11px] text-cur-muted-soft text-center leading-relaxed">
                                        녹음은 텍스트로 변환·저장되어 일지 작성과 서비스 개선에 이용됩니다 · <a href="/privacy" target="_blank" className="underline">개인정보처리방침</a>
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {step === 4 && (
                        <div className="space-y-4 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-[20px] font-semibold text-cur-ink flex items-center gap-2 tracking-tight">
                                <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">4</span> 요약본 확인 및 수정
                            </h2>

                            {(isProcessingSTT || isProcessingAI) ? (
                                <div className="bg-cur-card border border-cur-hairline rounded-[12px] p-12 text-center flex flex-col items-center justify-center shadow-sm">
                                    <Loader2 className="w-12 h-12 text-cur-ink animate-spin mb-4" />
                                    <p className="text-[18px] font-semibold text-cur-ink">
                                        {isProcessingSTT ? "음성을 텍스트로 변환 중…" : "AI가 회의록을 작성 중입니다…"}
                                    </p>
                                    <p className="text-[14px] text-cur-muted-soft font-medium mt-2">참석자 서명을 미리 진행하시면 AI 처리 후 결과가 표시됩니다.</p>
                                </div>
                            ) : (
                                <>
                            {/* AI 안내 바 */}
                            <div className="bg-cur-elevated rounded-[10px] p-3 flex items-start gap-2">
                                <Sparkles className="w-4 h-4 text-cur-info mt-0.5 shrink-0" />
                                <p className="text-[14px] text-cur-body leading-relaxed">AI가 녹음을 요약해 초안을 채웠어요. 내용을 탭하면 바로 수정할 수 있습니다.</p>
                            </div>

                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden">
                                <div className="px-4 py-3 border-b border-cur-hairline">
                                    <h3 className="text-[15px] font-semibold text-cur-ink tracking-tight">공정 및 작업명</h3>
                                </div>
                                <div className="p-4 grid grid-cols-2 gap-4">
                                    <div className="flex flex-col gap-1.5">
                                        <Label className={LABEL_CLS}>공정(종)명</Label>
                                        <Input name="processName" value={formData.processName} onChange={handleChange} className={FIELD_CLS} />
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <Label className={LABEL_CLS}>작업명</Label>
                                        <Input name="workName" value={formData.workName} onChange={handleChange} className={FIELD_CLS} />
                                    </div>
                                </div>
                            </div>

                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden">
                                <div className="px-4 py-3 border-b border-cur-hairline">
                                    <h3 className="text-[15px] font-semibold text-cur-ink tracking-tight">금일 작업 내용</h3>
                                </div>
                                <div className="p-4">
                                    <textarea
                                        name="workContent"
                                        value={formData.workContent}
                                        onChange={handleChange}
                                        rows={3}
                                        className={AREA_CLS}
                                        placeholder="AI가 요약한 작업 내용을 확인하고 수정하세요."
                                    />
                                </div>
                            </div>

                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden">
                                <div className="px-4 py-3 border-b border-cur-hairline flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <h3 className="text-[15px] font-semibold text-cur-ink tracking-tight">근로자 참여 위험성평가</h3>
                                        <span className="text-[12px] font-medium text-cur-muted bg-cur-elevated px-2 py-0.5 rounded-[6px]">{formData.hazards.length}건</span>
                                        {isMergingSuggestions && (
                                            <span className="inline-flex items-center gap-1 text-[12px] text-cur-muted"><Loader2 className="w-3 h-3 animate-spin" /> 근로자 의견 반영 중</span>
                                        )}
                                    </div>
                                    <Button size="sm" onClick={addHazard} variant="ghost" className="h-9 px-3 rounded-[6px] text-[12px] font-semibold bg-cur-card border border-cur-hairline text-cur-ink hover:bg-cur-canvas"><Plus className="w-3.5 h-3.5 mr-1" /> 요인 추가</Button>
                                </div>
                                <div className="divide-y divide-cur-hairline">
                                    {formData.hazards.length === 0 && <p className="text-[14px] text-cur-muted text-center py-6 font-medium">도출된 위험요인이 없습니다.</p>}
                                    {formData.hazards.map((hazard, idx) => {
                                        const ls = levelStyle(hazard.level)
                                        return (
                                        <div key={idx} className={cn("py-4 px-4 space-y-3 border-l-[3px]", ls.border)}>
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[12px] font-semibold text-cur-muted-soft">위험요인 {idx + 1}</span>
                                                    <span className={cn("text-[12px] font-bold px-2 py-0.5 rounded-[6px]", ls.badge)}>{hazard.level === "상중하" ? "복합" : hazard.level}</span>
                                                </div>
                                                <button onClick={() => removeHazard(idx)} aria-label="위험요인 삭제" className="h-10 w-10 flex items-center justify-center rounded-[8px] text-cur-muted-soft hover:text-cur-error hover:bg-cur-error/5 transition-colors"><Trash2 className="w-4 h-4" /></button>
                                            </div>
                                            <textarea
                                                value={hazard.factor}
                                                onChange={(e) => updateHazard(idx, "factor", e.target.value)}
                                                className={AREA_CLS}
                                                placeholder="잠재 유해위험요인"
                                                aria-label="잠재 유해위험요인"
                                                rows={2}
                                            />
                                            {riskMethod === "freq_sev" ? (
                                                <div className="space-y-2">
                                                    <div className="grid grid-cols-2 gap-2">
                                                        <select
                                                            value={hazard.frequency ?? 1}
                                                            onChange={(e) => updateHazardFreqSev(idx, "frequency", Number(e.target.value))}
                                                            className={SELECT_CLS}
                                                            aria-label="빈도"
                                                        >
                                                            {Array.from({ length: MATRIX_DIMS[riskMatrix].freqMax }, (_, i) => i + 1).map((n) => (
                                                                <option key={n} value={n}>빈도 {n}</option>
                                                            ))}
                                                        </select>
                                                        <select
                                                            value={hazard.severity ?? 1}
                                                            onChange={(e) => updateHazardFreqSev(idx, "severity", Number(e.target.value))}
                                                            className={SELECT_CLS}
                                                            aria-label="강도"
                                                        >
                                                            {Array.from({ length: MATRIX_DIMS[riskMatrix].sevMax }, (_, i) => i + 1).map((n) => (
                                                                <option key={n} value={n}>강도 {n}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                    <span className={cn("inline-flex items-center text-[12px] font-bold px-2 py-0.5 rounded-[6px]", ls.badge)}>위험도 {hazard.risk ?? ""} · {hazard.level}</span>
                                                </div>
                                            ) : (
                                                <div role="group" aria-label="위험성 등급" className="flex p-0.5 bg-cur-elevated rounded-[8px] gap-0.5">
                                                    {(["상", "중", "하"] as const).map((lv) => (
                                                        <button
                                                            key={lv}
                                                            type="button"
                                                            aria-pressed={hazard.level === lv}
                                                            onClick={() => updateHazard(idx, "level", lv)}
                                                            className={cn("flex-1 h-11 rounded-[6px] text-[15px] font-semibold transition-colors", hazard.level === lv ? cn("bg-cur-card shadow-sm", levelStyle(lv).seg) : "text-cur-muted")}
                                                        >
                                                            {lv}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="flex flex-col gap-1.5">
                                                <Label className={LABEL_CLS}>↳ 대책 (제거·대체·통제)</Label>
                                                <textarea
                                                    value={hazard.measure}
                                                    onChange={(e) => updateHazard(idx, "measure", e.target.value)}
                                                    className={AREA_CLS}
                                                    rows={2}
                                                />
                                            </div>
                                        </div>
                                        )
                                    })}
                                </div>
                            </div>

                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden">
                                <div className="px-4 py-3 border-b border-cur-hairline">
                                    <h3 className="text-[15px] font-semibold text-cur-ink tracking-tight">작업 시작전 확인사항</h3>
                                </div>
                                <div className="p-4 space-y-4">
                                    <div className="flex flex-col gap-1.5">
                                        <Label className={LABEL_CLS}>개인별 건강상태 이상 유무</Label>
                                        <Input name="healthCheck" value={formData.healthCheck} onChange={handleChange} className={FIELD_CLS} />
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <Label className={LABEL_CLS}>개인 보호구 착용 상태</Label>
                                        <Input name="ppeCheck" value={formData.ppeCheck} onChange={handleChange} className={FIELD_CLS} />
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <div className="flex items-center gap-1.5">
                                            <Label className={LABEL_CLS}>안전구호 제창</Label>
                                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-cur-info bg-cur-info/10 px-1.5 py-0.5 rounded-[6px]"><Sparkles className="w-3 h-3" /> AI 추천</span>
                                        </div>
                                        <Input name="safetyPhrase" value={formData.safetyPhrase} onChange={handleChange} className={FIELD_CLS} />
                                    </div>
                                </div>
                            </div>

                            <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden">
                                <div className="px-4 py-3 border-b border-cur-hairline">
                                    <h3 className="text-[15px] font-semibold text-cur-ink tracking-tight">작업 시작전 협의 및 지시사항</h3>
                                </div>
                                <div className="p-4">
                                    <textarea
                                        name="instructions"
                                        value={formData.instructions}
                                        onChange={handleChange}
                                        rows={5}
                                        className={AREA_CLS}
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
                                        <QRCodeCanvas value={typeof window !== "undefined" ? `${window.location.origin}/sign/${sessionId}` : ""} size={150} level={"H"} />
                                    </div>
                                )}
                                <p className="text-[13px] text-cur-info font-medium leading-relaxed">위 QR을 보여주거나 아래 링크를 카톡으로 보내세요.</p>
                                <Button variant="outline" onClick={() => { if (typeof window !== "undefined" && sessionId) { navigator.clipboard.writeText(`${window.location.origin}/sign/${sessionId}`); alert("복사 완료!"); } }} className="bg-cur-card border-cur-info/30 text-cur-info hover:bg-cur-info/10 h-10 rounded-[8px] font-semibold text-[13px] px-5"><Copy className="w-4 h-4 mr-2" /> 링크 복사</Button>
                            </div>

                            <div className="space-y-3">
                                {formData.participants.map((p, idx) => (
                                    <div key={p.id} className="bg-cur-card p-4 border border-cur-hairline rounded-[12px] shadow-none flex flex-col gap-3">
                                        <div className="flex items-center gap-3">
                                            <div className="w-7 h-7 bg-cur-canvas rounded-[6px] flex items-center justify-center font-bold text-cur-muted text-[12px] shrink-0">{idx + 1}</div>
                                            <Input placeholder="이름을 입력하세요" className="flex-1 h-10 text-[15px] font-bold border-0 border-b border-cur-hairline rounded-none px-1 focus-visible:ring-0 focus-visible:border-cur-primary" value={p.name} onChange={(e) => updateParticipant(p.id, "name", e.target.value)} />
                                            <Button size="icon" variant="ghost" className="text-cur-error/70 hover:text-cur-error hover:bg-cur-error/5 h-8 w-8 rounded-[6px]" onClick={() => removeParticipant(p.id)}><Trash2 className="w-4 h-4" /></Button>
                                        </div>
                                        <div className="flex gap-3 mt-1">
                                            <div className="flex bg-cur-canvas p-1 rounded-[8px] shrink-0">
                                                <button onClick={() => updateParticipant(p.id, "gender", "M")} className={cn("px-4 py-1.5 text-[13px] font-bold rounded-[6px] transition-colors", p.gender === 'M' ? 'bg-cur-card text-cur-ink shadow-sm' : 'text-cur-muted hover:text-cur-ink')}>남</button>
                                                <button onClick={() => updateParticipant(p.id, "gender", "F")} className={cn("px-4 py-1.5 text-[13px] font-bold rounded-[6px] transition-colors", p.gender === 'F' ? 'bg-cur-card text-cur-ink shadow-sm' : 'text-cur-muted hover:text-cur-ink')}>여</button>
                                            </div>
                                            <div className="flex-1" onClick={() => openSignModal({ type: 'participant', id: p.id })}>
                                                {p.signature ? <div className="h-10 bg-cur-success/5 border border-cur-success/30 rounded-[8px] flex items-center justify-center overflow-hidden"><img src={p.signature} className="h-[120%] object-contain" /></div> : <Button variant="outline" className="w-full h-10 border-dashed text-cur-muted font-medium text-[13px] border-cur-hairline rounded-[8px] hover:bg-cur-elevated">내 폰으로 직접 받기</Button>}
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
                                <CheckCircle2 className="w-10 h-10 text-cur-success" />
                            </div>
                            <h2 className="text-[24px] font-bold text-cur-ink mb-2 tracking-tight">저장 완료</h2>
                            <p className="text-[14px] text-cur-muted-soft text-center mb-10 font-medium">안전가이드라인 TBM 회의록 작성이 완료되었습니다.</p>
                            <div className="w-full max-w-xs space-y-3">
                                {savedLogId && (
                                    <Button onClick={() => router.push(`/report/minutes/${savedLogId}`)} className="w-full bg-cur-ink hover:bg-cur-ink/90 text-cur-on-primary h-12 text-[15px] font-bold rounded-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.1)]">
                                        <FileText className="mr-2 w-4 h-4" /> 작성된 회의록 보기
                                    </Button>
                                )}
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
                                className={cn(
                                    "flex-[2] h-14 text-[16px] font-bold text-cur-on-primary rounded-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.1)] transition-transform active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100",
                                    // step 2 일시정지 상태에서만 'AI 요약'을 주황으로 승격 — 커밋 행동=주황 패턴(step 4 '완료 및 저장'과 정합)
                                    step === 2 && recordingCount > 0 && !isRecording
                                        ? "bg-cur-primary hover:bg-cur-primary-active"
                                        : "bg-cur-ink hover:bg-cur-ink/90"
                                )}
                            >
                                {step === 2 ? "AI 요약" : "다음 단계"}
                            </Button>
                        ) : (
                            <Button onClick={() => setIsConfirmationOpen(true)} disabled={isSaving} className="flex-[2] h-14 text-[16px] font-bold bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[10px] shadow-sm transition-transform active:scale-[0.98]">
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
                                <Sparkles className="w-4 h-4 shrink-0" /> AI 요약본 확인 안내
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
                        <Button onClick={handleConfirmAndSave} className="flex-1 h-12 text-[15px] font-bold bg-cur-primary text-cur-on-primary rounded-[10px] hover:bg-cur-primary-active shadow-sm">동의 및 저장</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
