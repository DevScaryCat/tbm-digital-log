// app/safety-log/page.tsx
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Mic, Camera, CheckCircle2, Plus, Trash2, PenTool, Loader2, Save, StopCircle, CalendarIcon, Clock, RefreshCw, FileText, Upload, ExternalLink, X, Pause, Play, Send, QrCode, Copy, Sparkles } from "lucide-react"
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

// ─── 공용 스타일 상수 (quiet-filled 편집 필드) — tbm-minutes와 동일 ───
// 16px는 iOS 자동 줌 방지 임계 — 절대 내리지 말 것 (md:text-[16px]로 shadcn 기본 md:text-sm 무력화)
const FIELD_CLS = "h-12 w-full px-3 bg-cur-canvas border-0 shadow-none rounded-[8px] text-[16px] md:text-[16px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus:bg-cur-card focus:outline-none focus-visible:border-0 focus-visible:ring-1 focus-visible:ring-cur-primary"
const AREA_CLS = "w-full p-3 min-h-[64px] resize-y leading-relaxed bg-cur-canvas border-0 shadow-none rounded-[8px] text-[16px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus:bg-cur-card focus:ring-1 focus:ring-cur-primary focus:outline-none"
const SELECT_CLS = "h-12 w-full px-3 bg-cur-canvas border-0 rounded-[8px] text-[16px] font-medium text-cur-ink focus:bg-cur-card focus:ring-1 focus:ring-cur-primary focus:outline-none"
// 라벨은 값(16px ink)보다 조용하게 — 단 cur-muted(4.1:1)는 야외 현장 가독에 부족해 body(7:1) 사용
const LABEL_CLS = "text-[13px] font-medium text-cur-body"

function getWeatherLabel(code: number): string {
    if (code === 0) return "맑음 ☀️"
    if (code >= 1 && code <= 3) return "구름조금 🌤️"
    if (code >= 45) return "흐림 ☁️"
    if (code >= 51) return "비 ☔"
    if (code >= 71) return "눈 ☃️"
    return "맑음"
}

interface Participant {
    id: number
    name: string
    gender: "M" | "F"
    status: "present" | "absent"
    signature: string | null
}

interface TBMData {
    date: Date | undefined
    startTime: string
    endTime: string
    weather: string
    temperature: string
    companyName: string
    location: string
    educationType: string
    instructorName: string
    educationContent: string
    remarks: string
    photo: string | null
    participants: Participant[]
}

export default function TBMPage() {
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
                        alert("최대 녹음 시간(20분)에 도달해 녹음이 자동 종료되었습니다.\n지금까지 인식된 내용은 그대로 있으니, 아래 'AI 요약'을 눌러 일지를 만드세요.");
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
    const [currentSignTarget, setCurrentSignTarget] = useState<{ type: 'participant' | 'instructor', id?: number } | null>(null)
    const [instructorSignature, setInstructorSignature] = useState<string | null>(null)
    const sigCanvas = useRef<SignatureCanvas>(null)

    const [isConfirmationOpen, setIsConfirmationOpen] = useState(false)
    const [hasAgreedToDisclaimer, setHasAgreedToDisclaimer] = useState(false)
    const confirmationSigCanvas = useRef<SignatureCanvas>(null)
    const savingRef = useRef(false)

    const getCurrentTime = () => {
        const now = new Date()
        return now.toTimeString().slice(0, 8) // HH:MM:SS — 초까지 저장해야 1분 미만 세션이 잘리지 않음
    }

    const [formData, setFormData] = useState<TBMData>({
        date: new Date(),
        startTime: getCurrentTime(),
        endTime: "",
        weather: "불러오는 중…",
        temperature: "",
        companyName: "",
        location: "현장 사무실",
        educationType: "TBM",
        instructorName: "",
        educationContent: "",
        remarks: "",
        photo: null,
        participants: [{ id: 1, name: "", gender: "M", status: "present", signature: null }],
    })

    const hours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0'))
    const minutes = ["00", "10", "20", "30", "40", "50"]

    useEffect(() => {
        const initPage = async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) { router.push("/"); return; }

            const userCompany = session.user.user_metadata.company_name || session.user.user_metadata.full_name || "현장명 미설정"

            const { data: lastLog } = await supabase
                .from('tbm_logs')
                .select('location')
                .eq('user_id', session.user.id)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()

            const lastLocation = lastLog?.location || "현장 사무실"

            setFormData(prev => ({
                ...prev,
                companyName: userCompany,
                location: lastLocation,
                instructorName: prev.educationType === "TBM" ? "" : (session.user.email?.split("@")[0] || ""),
                startTime: getCurrentTime()
            }))

            if ("geolocation" in navigator) {
                navigator.geolocation.getCurrentPosition(
                    async (position) => {
                        try {
                            const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${position.coords.latitude}&longitude=${position.coords.longitude}&current_weather=true&timezone=auto`)
                            const data = await res.json()
                            if (data.current_weather) {
                                setFormData(prev => ({
                                    ...prev,
                                    weather: getWeatherLabel(data.current_weather.weathercode),
                                    temperature: String(data.current_weather.temperature)
                                }))
                            }
                        } catch (e) { console.error(e) }
                    },
                    () => console.log("위치 권한 없음")
                )
            }
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
            if (currentSession && currentStep !== 6) {
                console.log("Abandoning session (unmount): ", currentSession);
                const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/tbm_pending_signatures`;
                const headers = {
                    'Content-Type': 'application/json',
                    'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                    'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}`,
                };
                const body = JSON.stringify({
                    session_id: currentSession,
                    name: "CLOSED_SESSION",
                    gender: "M",
                    signature: "abandoned"
                });
                try {
                    const blob = new Blob([body], { type: 'application/json' });
                    const beaconUrl = `${url}?apikey=${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`;
                    if (!navigator.sendBeacon(beaconUrl, blob)) {
                        fetch(url, { method: 'POST', headers, body, keepalive: true }).catch(() => {});
                    }
                } catch {
                    supabase.from('tbm_pending_signatures').insert({
                        session_id: currentSession,
                        name: "CLOSED_SESSION",
                        gender: "M",
                        signature: "abandoned"
                    }).then();
                }
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
                    }).then(() => console.log("Session opened"))
                );
            }

            console.log("Listening for signatures on session:", currentSessionId);

            const channel = supabase.channel(`public:tbm_pending_signatures:${currentSessionId}`)
                .on(
                    'postgres_changes',
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'tbm_pending_signatures',
                        filter: `session_id=eq.${currentSessionId}`
                    },
                    (payload) => {
                        const newSignature = payload.new;
                        console.log("New signature received:", newSignature);

                        setFormData(prev => {
                            if (newSignature.name === "OPEN_SESSION" || newSignature.name === "CLOSED_SESSION") return prev;

                            const participants = [...prev.participants];

                            const newParticipant = {
                                id: Date.now() + Math.random(),
                                name: newSignature.name,
                                gender: newSignature.gender as "M" | "F",
                                status: "present" as const,
                                signature: newSignature.signature
                            };

                            participants.push(newParticipant);

                            return { ...prev, participants };
                        });
                    }
                )
                .subscribe();

            return () => {
                supabase.removeChannel(channel);
            }
        }
    }, [step, sessionId]);

    const validateStep = (currentStep: number) => {
        if (currentStep === 1) {
            if (!formData.date) return "교육 일자를 선택해주세요.";
            if (!formData.location) return "교육 장소를 입력해주세요.";
            if (formData.educationType !== "TBM") {
                if (!formData.instructorName) return "교육실시자명을 입력해주세요.";
                if (!instructorSignature) return "교육실시자 서명을 완료해주세요.";
            }
        }
        if (currentStep === 3) {
            const validParticipants = formData.participants.filter(p => p.name.trim() !== "" || p.signature);

            if (validParticipants.length === 0) return "최소 1명 이상의 참석자 서명이 필요합니다.";

            const missingSign = validParticipants.find(p => !p.signature);
            if (missingSign) return `${missingSign.name || '참석자'} 님의 서명이 누락되었습니다.`;

            if (validParticipants.some(p => !p.name.trim())) return "참석자 이름을 모두 입력해주세요.";
        }
        if (currentStep === 4) {
            if (!formData.photo) return "현장 사진 촬영은 필수입니다.";
        }
        if (currentStep === 5) {
            if (!formData.educationContent || formData.educationContent.length < 5) return "교육 내용을 입력하거나 AI 요약을 진행해주세요.";
        }
        return null;
    }

    const handleNext = () => {
        const errorMsg = validateStep(step);
        if (errorMsg) { alert(errorMsg); return; }
        setStep(prev => Math.min(6, prev + 1));
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
        const errorMsg = validateStep(5);
        if (errorMsg) { alert(errorMsg); return; }

        setIsSaving(true)
        try {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) throw new Error("로그인 필요")

            // 서로 독립인 업로드 3개는 병렬로 (현장 LTE에서 직렬 대기 제거)
            const [instructorSignatureUrl, photoUrl, confirmationSignatureUrl] = await Promise.all([
                formData.educationType !== "TBM" && instructorSignature
                    ? uploadBase64ToStorage(instructorSignature, 'signatures', 'instructor') : Promise.resolve(null),
                formData.photo ? uploadBase64ToStorage(formData.photo, 'photos', 'photo') : Promise.resolve(null),
                confirmationSigBase64 ? uploadBase64ToStorage(confirmationSigBase64, 'signatures', 'confirmation') : Promise.resolve(null),
            ])

            const { data: logData, error: logError } = await supabase
                .from('tbm_logs')
                .insert({
                    user_id: session.user.id,
                    date: formData.date ? format(formData.date, "yyyy-MM-dd") : new Date().toISOString().split('T')[0],
                    start_time: formData.startTime,
                    end_time: formData.endTime || new Date().toTimeString().slice(0, 8),
                    location: formData.location,
                    company_name: formData.companyName,
                    education_type: formData.educationType,
                    instructor_name: formData.educationType === "TBM" ? "" : formData.instructorName,
                    instructor_signature: instructorSignatureUrl,
                    education_content: formData.educationContent,
                    remarks: formData.remarks,
                    photo_url: photoUrl,
                    confirmation_signature: confirmationSignatureUrl,
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
                log_id: logData.id,
                name: p.name,
                gender: p.gender,
                signature: p.signature && p.signature.startsWith('data:')
                    ? await uploadBase64ToStorage(p.signature, 'signatures', 'participant')
                    : p.signature,
                status: p.status
            })));

            if (participantsData.length > 0) {
                const { error: partError } = await supabase.from('tbm_participants').insert(participantsData)
                if (partError) {
                    // 참가자 저장 실패 시 방금 생성한 로그를 롤백(고아 로그/중복 재제출 방지)
                    await supabase.from('tbm_logs').delete().eq('id', logData.id)
                    throw partError
                }
            }

            if (sessionId) {
                // 저장 완료 → pending 정리. OPEN 마커가 사라지면 서명 페이지는 자동으로 만료 처리되므로
                // 별도 CLOSED 마커 삽입은 불필요(삭제 후엔 소유권 근거가 없어 RLS상 삽입도 거부됨).
                await supabase.from('tbm_pending_signatures')
                    .delete()
                    .eq('session_id', sessionId);
            }

            setSavedLogId(logData.id)
            setStep(6)

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

    const requestAISummary = async (text: string) => {
        if (!text) return;
        setIsProcessingAI(true)
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const res = await fetch('/api/ai/summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
                body: JSON.stringify({ text })
            })
            const data = await res.json()

            if (res.ok) {
                let educationContent = data.educationContent || ""
                let remarks = data.remarks || ""

                if (typeof educationContent === 'string' && educationContent.trim().startsWith('{')) {
                    try {
                        const parsed = JSON.parse(educationContent)
                        if (parsed && typeof parsed === 'object') {
                            educationContent = parsed.educationContent || ""
                            if (parsed.remarks && !remarks) remarks = parsed.remarks
                        }
                    } catch {
                    }
                }

                if (typeof educationContent === 'object') {
                    educationContent = ""
                }
                if (typeof remarks === 'object') {
                    remarks = ""
                }

                setFormData(prev => ({
                    ...prev,
                    educationContent,
                    remarks
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
            requestAISummary(accumulatedTranscript)
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
                requestAISummary(data.transcript)
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

    const openSignModal = (target: { type: 'participant' | 'instructor', id?: number }) => { setCurrentSignTarget(target); setIsSignOpen(true) }

    const saveSignature = () => {
        if (sigCanvas.current && currentSignTarget) {
            const dataURL = sigCanvas.current.toDataURL()
            if (currentSignTarget.type === 'participant' && currentSignTarget.id) {
                setFormData(prev => ({ ...prev, participants: prev.participants.map(p => p.id === currentSignTarget.id ? { ...p, signature: dataURL } : p) }))
            } else { setInstructorSignature(dataURL) }
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

    const addParticipant = () => setFormData(prev => ({ ...prev, participants: [...prev.participants, { id: Date.now(), name: "", gender: "M", status: "present", signature: null }] }))
    const updateParticipant = (id: number, field: keyof Participant, value: Participant[keyof Participant]) => setFormData(prev => ({ ...prev, participants: prev.participants.map(p => p.id === id ? { ...p, [field]: value } as Participant : p) }))
    const removeParticipant = (id: number) => { if (formData.participants.length > 1) setFormData(prev => ({ ...prev, participants: prev.participants.filter(p => p.id !== id) })) }

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
                                    <Button key={hour} variant="ghost" className={cn("justify-center rounded-[8px] h-10 text-[14px]", h === hour ? "bg-cur-primary text-cur-on-primary font-semibold hover:bg-cur-primary hover:text-cur-on-primary" : "text-cur-ink hover:bg-cur-elevated")} onClick={() => onChange(`${hour}:${m}`)}>
                                        {hour}시
                                    </Button>
                                ))}
                            </div>
                        </ScrollArea>
                        <ScrollArea className="w-20">
                            <div className="flex flex-col p-1">
                                {minutes.map((minute) => (
                                    <Button key={minute} variant="ghost" className={cn("justify-center rounded-[8px] h-10 text-[14px]", m === minute ? "bg-cur-primary text-cur-on-primary font-semibold hover:bg-cur-primary hover:text-cur-on-primary" : "text-cur-ink hover:bg-cur-elevated")} onClick={() => onChange(`${h}:${minute}`)}>
                                        {minute}분
                                    </Button>
                                ))}
                            </div>
                        </ScrollArea>
                    </div>
                </PopoverContent>
            </Popover>
        )
    }

    if (isLoading) return <div className="min-h-screen flex justify-center items-center bg-cur-canvas"><Loader2 className="animate-spin w-10 h-10 text-cur-ink" /></div>

    return (
        <div className="bg-cur-canvas min-h-screen sm:py-8 flex sm:block items-center justify-center font-sans text-cur-ink">
            <div className="max-w-lg w-full mx-auto bg-cur-card sm:shadow-none sm:rounded-[12px] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border border-cur-hairline mb-[env(safe-area-inset-bottom)] overflow-hidden">
                <div className="p-4 bg-cur-card border-b border-cur-hairline sticky top-0 z-50">
                    <TBMHeader title="안전보건교육일지" />
                </div>

                <div className="p-6 space-y-8 flex-1 pb-12 bg-cur-canvas-soft">

                    {step === 1 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-[20px] font-semibold text-cur-ink flex items-center gap-2 tracking-tight">
                                <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">1</span> 기본 정보
                            </h2>
                            <div className="space-y-4 bg-cur-card p-4 rounded-[12px] border border-cur-hairline shadow-none">
                                <div className="space-y-2">
                                    <Label className={LABEL_CLS}>교육 일자</Label>
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

                                <div className="space-y-2">
                                    <Label className={LABEL_CLS}>교육 장소</Label>
                                    <Input name="location" value={formData.location} onChange={handleChange} className={FIELD_CLS} />
                                </div>
                                <div className="space-y-2">
                                    <Label className={LABEL_CLS}>교육 구분</Label>
                                    <Select value={formData.educationType} onValueChange={(val) => setFormData(prev => ({ ...prev, educationType: val }))}>
                                        {/* shadcn 트리거 기본값(h-9·shadow-xs·3px 링)이 SELECT_CLS를 이기므로 중화 클래스 추가 — 시각 결과는 tbm-minutes SELECT_CLS와 동일 */}
                                        <SelectTrigger className={cn(SELECT_CLS, "shadow-none data-[size=default]:h-12 focus-visible:bg-cur-card focus-visible:border-0 focus-visible:ring-1 focus-visible:ring-cur-primary")}><SelectValue /></SelectTrigger>
                                        <SelectContent className="rounded-[12px] border-cur-hairline">
                                            <SelectItem value="정기 안전교육" className="rounded-[6px] focus:bg-cur-elevated">정기 안전교육</SelectItem>
                                            <SelectItem value="특별안전보건교육" className="rounded-[6px] focus:bg-cur-elevated">특별안전보건교육</SelectItem>
                                            <SelectItem value="신규 채용시 교육" className="rounded-[6px] focus:bg-cur-elevated">신규 채용시 교육</SelectItem>
                                            <SelectItem value="작업내용 변경시 교육" className="rounded-[6px] focus:bg-cur-elevated">작업내용 변경시 교육</SelectItem>
                                            <SelectItem value="TBM" className="rounded-[6px] focus:bg-cur-elevated">TBM (작업 전 안전점검)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                {formData.educationType !== "TBM" && (
                                    <>
                                        <div className="space-y-2"><Label className={LABEL_CLS}>교육실시자</Label><Input name="instructorName" value={formData.instructorName} onChange={handleChange} className={FIELD_CLS} placeholder="이름 입력" /></div>
                                        {instructorSignature ? (
                                            <div onClick={() => openSignModal({ type: 'instructor' })} className="h-16 border border-cur-success bg-cur-success/5 rounded-[8px] flex items-center justify-center cursor-pointer relative overflow-hidden"><img src={instructorSignature} alt="서명" className="h-full object-contain mix-blend-multiply" /><div className="absolute right-2 bottom-1.5 text-[10px] text-cur-success font-bold bg-cur-card/90 px-1.5 py-0.5 rounded-[4px]">서명 완료</div></div>
                                        ) : (
                                            <Button variant="outline" className="w-full h-14 border-dashed border-2 border-cur-hairline text-cur-muted font-medium text-[15px] hover:bg-cur-canvas rounded-[8px]" onClick={() => openSignModal({ type: 'instructor' })}><PenTool className="mr-2 h-5 w-5" /> 교육실시자 서명하기</Button>
                                        )}
                                    </>
                                )}

                                {/* 자동 시간 상태 라인 — 표시 전용, 기록 로직(녹음 시작/종료 시 자동 기록)은 불변.
                                    이 페이지는 startTime이 마운트 시각으로 초기화되므로(회의록과 다름) 녹음 여부로 분기 —
                                    startTime 기준이면 녹음 전에도 접속 시각이 '자동 기록'으로 보이는 오표시가 된다. */}
                                <div className="pt-3 border-t border-cur-hairline-soft flex items-center gap-2">
                                    <Clock className="w-4 h-4 text-cur-muted shrink-0" />
                                    {(recordingCount > 0 || isRecording) && formData.startTime ? (
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
                                <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">2</span> 교육 진행 및 녹음
                            </h2>

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
                                        <Button onClick={startRecording} variant="outline" className="w-full h-12 rounded-[8px] border border-cur-hairline bg-cur-card text-cur-ink text-[15px] font-semibold hover:bg-cur-elevated shadow-none">
                                            <Play className="mr-2 w-4 h-4 text-cur-muted" /> 이어서 녹음
                                        </Button>
                                        <p className="text-[13px] text-cur-muted">교육을 마쳤으면 아래 &apos;AI 요약&apos;을 누르세요</p>
                                    </div>
                                ) : (
                                    <div className="w-full flex flex-col items-center animate-in zoom-in duration-300">
                                        <Button onClick={startRecording} className="w-40 h-40 rounded-full bg-cur-primary hover:bg-cur-primary-active shadow-[0_12px_32px_rgba(245,78,0,0.25)] flex flex-col items-center justify-center gap-3 shrink-0 transition-transform active:scale-95">
                                            <Mic className="w-14 h-14 text-cur-on-primary" />
                                            <span className="text-[18px] font-bold text-cur-on-primary">녹음 시작</span>
                                        </Button>
                                        <p className="mt-5 text-[14px] text-cur-body text-center">
                                            누르고 평소처럼 교육하세요 — AI가 교육일지로 정리합니다
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

                    {step === 5 && (
                        <div className="space-y-4 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-[20px] font-semibold text-cur-ink flex items-center gap-2 tracking-tight">
                                <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">5</span> 내용 확인 및 수정
                            </h2>

                            {(isProcessingSTT || isProcessingAI) ? (
                                <div className="bg-cur-card border border-cur-hairline rounded-[12px] p-12 text-center flex flex-col items-center justify-center shadow-sm">
                                    <Loader2 className="w-12 h-12 text-cur-ink animate-spin mb-4" />
                                    <p className="text-[18px] font-semibold text-cur-ink">
                                        {isProcessingSTT ? "음성을 텍스트로 변환 중…" : "AI가 교육내용을 요약 중…"}
                                    </p>
                                    <p className="text-[14px] text-cur-muted-soft font-medium mt-2">잠시만 기다려주세요…</p>
                                </div>
                            ) : (
                                <>
                                    {/* AI 안내 바 — 파랑=AI 표시 전용 */}
                                    <div className="bg-cur-elevated rounded-[10px] p-3 flex items-start gap-2">
                                        <Sparkles className="w-4 h-4 text-cur-info mt-0.5 shrink-0" />
                                        <p className="text-[14px] text-cur-body leading-relaxed">AI가 녹음을 요약해 초안을 채웠어요. 내용을 탭하면 바로 수정할 수 있습니다.</p>
                                    </div>

                                    <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden">
                                        <div className="px-4 py-3 border-b border-cur-hairline">
                                            <h3 className="text-[15px] font-semibold text-cur-ink tracking-tight">교육 내용 (요약)</h3>
                                        </div>
                                        <div className="p-4">
                                            <textarea
                                                name="educationContent"
                                                value={formData.educationContent}
                                                onChange={handleChange}
                                                rows={8}
                                                className={AREA_CLS}
                                                placeholder="녹음 내용이 요약되어 여기에 표시됩니다."
                                            />
                                        </div>
                                    </div>

                                    <div className="bg-cur-card border border-cur-hairline rounded-[12px] overflow-hidden">
                                        <div className="px-4 py-3 border-b border-cur-hairline">
                                            <h3 className="text-[15px] font-semibold text-cur-ink tracking-tight">특이사항 (안내/전파)</h3>
                                        </div>
                                        <div className="p-4">
                                            <textarea
                                                name="remarks"
                                                value={formData.remarks}
                                                onChange={handleChange}
                                                rows={4}
                                                className={AREA_CLS}
                                                placeholder="전달사항이나 공지사항이 여기에 표시됩니다."
                                            />
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {step === 4 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <h2 className="text-[20px] font-semibold text-cur-ink flex items-center gap-2 tracking-tight">
                                <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">4</span> 현장 사진
                            </h2>

                            <div className="aspect-video bg-cur-canvas rounded-[12px] border border-cur-hairline flex items-center justify-center relative overflow-hidden">
                                {formData.photo ? (
                                    <img src={formData.photo} className="w-full h-full object-cover" alt="교육사진" />
                                ) : (
                                    <span className="text-cur-muted font-semibold text-[15px]">등록된 사진이 없습니다.</span>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                {/* 1번: 즉시 촬영 */}
                                <div className="relative group">
                                    <input
                                        type="file"
                                        accept="image/*"
                                        capture="environment"
                                        className="absolute inset-0 opacity-0 z-10 w-full h-full cursor-pointer"
                                        onChange={(e) => {
                                            if (e.target.files?.[0]) {
                                                const reader = new FileReader();
                                                reader.onloadend = () => setFormData(prev => ({ ...prev, photo: reader.result as string }))
                                                reader.readAsDataURL(e.target.files[0])
                                            }
                                        }} />
                                    <Button className="w-full h-14 bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[15px] font-semibold rounded-[10px] flex items-center justify-center pointer-events-none shadow-sm transition-[transform,background-color] group-active:scale-95">
                                        <Camera className="w-5 h-5 mr-2" /> 바로 촬영
                                    </Button>
                                </div>

                                {/* 2번: 앨범 업로드 */}
                                <div className="relative group">
                                    <input
                                        type="file"
                                        accept="image/*"
                                        className="absolute inset-0 opacity-0 z-10 w-full h-full cursor-pointer"
                                        onChange={(e) => {
                                            if (e.target.files?.[0]) {
                                                const reader = new FileReader();
                                                reader.onloadend = () => setFormData(prev => ({ ...prev, photo: reader.result as string }))
                                                reader.readAsDataURL(e.target.files[0])
                                            }
                                        }} />
                                    <Button variant="outline" className="w-full h-14 border border-cur-hairline bg-cur-card hover:bg-cur-canvas text-cur-ink text-[15px] font-semibold rounded-[10px] flex items-center justify-center pointer-events-none shadow-sm transition-[transform,background-color] group-active:scale-95">
                                        <Upload className="w-5 h-5 mr-2" /> 앨범 업로드
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <div className="flex justify-between items-center">
                                <h2 className="text-[20px] font-semibold text-cur-ink flex items-center gap-2 tracking-tight">
                                    <span className="bg-cur-primary text-cur-on-primary w-7 h-7 rounded-[8px] flex items-center justify-center text-[14px] font-bold shadow-sm">3</span> 명단 <span className="text-[14px] font-medium text-cur-muted bg-cur-card px-2 py-0.5 rounded-[6px] border border-cur-hairline ml-1">{formData.participants.length}명</span>
                                </h2>
                                <Button size="sm" onClick={() => setFormData(prev => ({ ...prev, participants: [...prev.participants, { id: Date.now(), name: "", gender: "M", status: "present", signature: null }] }))} className="bg-cur-card border border-cur-hairline text-cur-ink hover:bg-cur-canvas h-8 px-3 rounded-[6px] text-[12px] font-semibold shadow-sm"><Plus className="w-3.5 h-3.5 mr-1" /> 추가</Button>
                            </div>

                            <div className="bg-cur-info/5 border border-cur-info/20 rounded-[12px] p-5 flex flex-col items-center justify-center text-center space-y-4 shadow-none">
                                <div className="flex items-center gap-2 text-cur-info font-bold text-[15px]">
                                    <QrCode className="w-5 h-5" /> 작업자 각자 스마트폰으로 서명받기
                                </div>

                                {sessionId && (
                                    <div className="bg-cur-card p-3.5 rounded-[12px] shadow-sm border border-cur-hairline">
                                        <QRCodeCanvas
                                            value={typeof window !== "undefined" ? `${window.location.origin}/sign/${sessionId}` : ""}
                                            size={150}
                                            level={"H"}
                                        />
                                    </div>
                                )}

                                <p className="text-[13px] text-cur-info font-medium leading-relaxed">작업자에게 위 QR을 보여주거나<br />아래 링크를 복사하여 메신저로 공유하세요.</p>

                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        if (typeof window !== "undefined" && sessionId) {
                                            navigator.clipboard.writeText(`${window.location.origin}/sign/${sessionId}`)
                                            alert("서명 링크가 복사되었습니다.")
                                        }
                                    }}
                                    className="bg-cur-card border-cur-info/30 text-cur-info hover:bg-cur-info/10 h-10 rounded-[8px] font-semibold text-[13px] px-5"
                                >
                                    <Copy className="w-4 h-4 mr-2" /> 서명 링크 복사
                                </Button>
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
                                                {p.signature ? <div className="h-10 bg-cur-success/5 border border-cur-success/30 rounded-[8px] flex items-center justify-center overflow-hidden"><img src={p.signature} className="h-[120%] object-contain mix-blend-multiply" /></div> : <Button variant="outline" className="w-full h-10 border-dashed text-cur-muted font-medium text-[13px] border-cur-hairline rounded-[8px] hover:bg-cur-elevated">서명하기</Button>}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {step === 6 && (
                        <div className="flex flex-col items-center justify-center h-[50vh] animate-in zoom-in duration-300">
                            <div className="w-20 h-20 bg-cur-success/5 rounded-full flex items-center justify-center mb-6 shadow-sm">
                                <CheckCircle2 className="w-10 h-10 text-cur-success" />
                            </div>
                            <h2 className="text-[24px] font-bold text-cur-ink mb-2 tracking-tight">저장 완료</h2>
                            <p className="text-[14px] text-cur-muted-soft text-center mb-10 font-medium">일지가 안전하게 등록되었습니다.</p>

                            <div className="w-full max-w-xs space-y-3">
                                <Button onClick={() => router.push(`/report/${savedLogId}`)} className="w-full bg-cur-ink hover:bg-cur-ink/90 text-cur-on-primary h-12 text-[15px] font-bold rounded-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.1)]">
                                    <FileText className="mr-2 w-4 h-4" /> 작성된 일지 보기
                                </Button>
                                <Button variant="outline" onClick={() => router.push('/')} className="w-full h-12 text-[14px] font-semibold border-cur-hairline text-cur-ink rounded-[10px] bg-cur-card hover:bg-cur-elevated">
                                    메인 화면으로
                                </Button>
                            </div>
                        </div>
                    )}

                </div>

                {step < 6 && (
                    <div className="bg-cur-card border-t border-cur-hairline p-4 flex gap-3 shadow-[0_-4px_24px_rgba(0,0,0,0.02)] sticky bottom-0 z-50 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:rounded-b-[24px]">
                        {step > 1 && (
                            <Button variant="outline" onClick={() => setStep(prev => Math.max(1, prev - 1))} className="flex-1 h-14 text-[15px] font-semibold border-cur-hairline text-cur-ink rounded-[10px] hover:bg-cur-elevated">이전</Button>
                        )}
                        {step < 5 ? (
                            <Button
                                onClick={step === 2 ? submitRecording : handleNext}
                                disabled={step === 2 && (isRecording || recordingCount === 0)}
                                className={cn(
                                    "flex-[2] h-14 text-[16px] font-bold text-cur-on-primary rounded-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.1)] transition-transform active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100",
                                    // step 2 일시정지 상태에서만 'AI 요약'을 주황으로 승격 — 커밋 행동=주황 패턴(step 5 '완료 및 저장'과 정합)
                                    step === 2 && recordingCount > 0 && !isRecording
                                        ? "bg-cur-primary hover:bg-cur-primary-active"
                                        : "bg-cur-ink hover:bg-cur-ink/90"
                                )}
                            >
                                {step === 2 ? "AI 요약" : "다음 단계"}
                            </Button>
                        ) : (
                            <Button onClick={() => setIsConfirmationOpen(true)} disabled={isSaving || isProcessingSTT || isProcessingAI} className="flex-[2] h-14 text-[16px] font-bold bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[10px] shadow-sm transition-transform active:scale-[0.98]">
                                {(isSaving || isProcessingSTT || isProcessingAI) ? <Loader2 className="animate-spin w-5 h-5 mr-2" /> : <Save className="mr-2 w-5 h-5" />} 완료 및 저장
                            </Button>
                        )}
                    </div>
                )}

            </div>

            <Dialog open={isSignOpen} onOpenChange={setIsSignOpen}>
                <DialogContent showCloseButton={true} className="max-w-md w-[calc(100%-2rem)] h-[70vh] max-h-[70vh] flex flex-col p-0 gap-0 rounded-[20px] overflow-hidden border-cur-hairline shadow-[0_8px_32px_rgba(0,0,0,0.1)]">
                    <DialogHeader className="p-4 border-b border-cur-hairline bg-cur-card shrink-0">
                        <DialogTitle className="text-center text-[18px] font-bold text-cur-ink tracking-tight">서명해 주세요</DialogTitle>
                    </DialogHeader>
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
                                본 안전보건교육일지의 교육 내용 및 특이사항 등은 AI 요약 기술을 기반으로 생성된 초안을 바탕으로 작성되었습니다.
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