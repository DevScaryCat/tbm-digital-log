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
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from "@/components/ui/drawer"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Mic, Camera, CheckCircle2, Plus, Trash2, PenTool, Loader2, Save, StopCircle, CalendarIcon, Clock, RefreshCw, FileText, Upload, ExternalLink, BookOpen } from "lucide-react"

// 날씨 유틸리티
function getWeatherLabel(code: number): string {
  if (code === 0) return "맑음 ☀️"
  if (code >= 1 && code <= 3) return "구름조금 🌤️"
  if (code >= 45) return "흐림 ☁️"
  if (code >= 51) return "비 ☔"
  if (code >= 71) return "눈 ☃️"
  return "맑음"
}

// 타입 정의
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
  durationHour: string
  durationMinute: string
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
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [step, setStep] = useState(1)
  const [savedLogId, setSavedLogId] = useState<string | null>(null)

  // 녹음 관련 상태
  const [isRecording, setIsRecording] = useState(false)
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
  const audioChunks = useRef<Blob[]>([])

  const fileInputRef = useRef<HTMLInputElement>(null)

  const [isProcessingSTT, setIsProcessingSTT] = useState(false)
  const [isProcessingAI, setIsProcessingAI] = useState(false)

  const [isSignOpen, setIsSignOpen] = useState(false)
  const [currentSignTarget, setCurrentSignTarget] = useState<{ type: 'participant' | 'instructor', id?: number } | null>(null)
  const [instructorSignature, setInstructorSignature] = useState<string | null>(null)
  const sigCanvas = useRef<SignatureCanvas>(null)

  const getCurrentTime = () => {
    const now = new Date()
    return now.toTimeString().slice(0, 5)
  }

  const [formData, setFormData] = useState<TBMData>({
    date: new Date(),
    startTime: getCurrentTime(),
    durationHour: "0",
    durationMinute: "10",
    weather: "불러오는 중...",
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
      if (!session) { router.push("/login"); return; }

      const userCompany = session.user.user_metadata.full_name || session.user.user_metadata.company_name || "현장명 미설정"

      setFormData(prev => ({
        ...prev,
        companyName: userCompany,
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
      if (!formData.educationContent || formData.educationContent.length < 5) return "교육 내용을 입력하거나 AI 요약을 진행해주세요.";
    }
    if (currentStep === 4) {
      if (!formData.photo) return "현장 사진 촬영은 필수입니다.";
    }
    if (currentStep === 5) {
      const missingSign = formData.participants.find(p => !p.signature);
      if (missingSign) return `${missingSign.name || '참석자'} 님의 서명이 누락되었습니다.`;
      if (formData.participants.some(p => !p.name)) return "참석자 이름을 모두 입력해주세요.";
    }
    return null;
  }

  const handleNext = () => {
    const errorMsg = validateStep(step);
    if (errorMsg) { alert(errorMsg); return; }
    setStep(prev => Math.min(6, prev + 1));
  }

  const saveToDatabase = async () => {
    const errorMsg = validateStep(5);
    if (errorMsg) { alert(errorMsg); return; }

    setIsSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error("로그인 필요")

      const [startH, startM] = formData.startTime.split(':').map(Number);
      const durationH = parseInt(formData.durationHour) || 0;
      const durationM = parseInt(formData.durationMinute) || 0;
      let totalMinutes = (startH * 60) + startM + (durationH * 60) + durationM;
      const endH = Math.floor(totalMinutes / 60) % 24;
      const endM = totalMinutes % 60;
      const formattedEndTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;

      const { data: logData, error: logError } = await supabase
        .from('tbm_logs')
        .insert({
          user_id: session.user.id,
          date: formData.date ? format(formData.date, "yyyy-MM-dd") : new Date().toISOString().split('T')[0],
          start_time: formData.startTime,
          end_time: formattedEndTime,
          location: formData.location,
          company_name: formData.companyName,
          education_type: formData.educationType,
          instructor_name: formData.educationType === "TBM" ? "TBM (자율)" : formData.instructorName,
          instructor_signature: formData.educationType === "TBM" ? null : instructorSignature,
          education_content: formData.educationContent,
          remarks: formData.remarks,
          photo_url: formData.photo
        })
        .select()
        .single()

      if (logError) throw logError

      const participantsData = formData.participants.map(p => ({
        log_id: logData.id,
        name: p.name,
        gender: p.gender,
        signature: p.signature,
        status: p.status
      }))

      const { error: partError } = await supabase.from('tbm_participants').insert(participantsData)
      if (partError) throw partError

      setSavedLogId(logData.id)
      setStep(6)

    } catch (e: any) {
      alert("저장 실패: " + e.message)
    } finally {
      setIsSaving(false)
    }
  }

  const requestAISummary = async (text: string) => {
    if (!text) return;
    setIsProcessingAI(true)
    try {
      const res = await fetch('/api/ai/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      })
      const data = await res.json()

      if (res.ok) {
        setFormData(prev => ({
          ...prev,
          educationContent: data.educationContent || "",
          remarks: data.remarks || ""
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

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsProcessingSTT(true)

    try {
      const formData = new FormData()
      formData.append("file", file)

      const res = await fetch('/api/stt', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || "음성 인식 실패")
      }

      if (data.transcript) {
        requestAISummary(data.transcript)
      }

    } catch (e: any) {
      console.error(e)
      alert("파일 처리 오류: " + e.message)
    } finally {
      setIsProcessingSTT(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const processAudioBlob = async (blob: Blob) => {
    const file = new File([blob], "recording.webm", { type: blob.type })
    setIsProcessingSTT(true)

    try {
      const formData = new FormData()
      formData.append("file", file)

      const res = await fetch('/api/stt', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) throw new Error(data.error || "음성 인식 실패")

      if (data.transcript) {
        requestAISummary(data.transcript)
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

  const toggleRecording = async () => {
    if (isRecording) {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop()
        setIsRecording(false)
      }
    } else {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("현재 브라우저가 마이크를 지원하지 않습니다.")
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const recorder = new MediaRecorder(stream)
        audioChunks.current = []

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunks.current.push(event.data)
          }
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
        console.error(err)
        alert("마이크 권한이 필요합니다.")
      }
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

  const addParticipant = () => setFormData(prev => ({ ...prev, participants: [...prev.participants, { id: Date.now(), name: "", gender: "M", status: "present", signature: null }] }))
  const updateParticipant = (id: number, field: keyof Participant, value: any) => setFormData(prev => ({ ...prev, participants: prev.participants.map(p => p.id === id ? { ...p, [field]: value } : p) }))
  const removeParticipant = (id: number) => { if (formData.participants.length > 1) setFormData(prev => ({ ...prev, participants: prev.participants.filter(p => p.id !== id) })) }

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
                  <Button key={hour} variant="ghost" className={cn("justify-center", h === hour && "bg-slate-100 font-bold")} onClick={() => onChange(`${hour}:${m}`)}>
                    {hour}시
                  </Button>
                ))}
              </div>
            </ScrollArea>
            <ScrollArea className="w-20">
              <div className="flex flex-col p-2">
                {minutes.map((minute) => (
                  <Button key={minute} variant="ghost" className={cn("justify-center", m === minute && "bg-slate-100 font-bold")} onClick={() => onChange(`${h}:${minute}`)}>
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

  if (isLoading) return <div className="min-h-screen flex justify-center items-center"><Loader2 className="animate-spin w-10 h-10 text-slate-500" /></div>

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      <div className="max-w-md mx-auto min-h-screen bg-white shadow-lg overflow-hidden relative">
        <div className="p-4 bg-white sticky top-0 z-50 border-b">
          <TBMHeader />
        </div>

        <div className="p-4 space-y-6">

          {/* STEP 1: 기본 정보 */}
          {step === 1 && (
            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <span className="bg-slate-900 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">1</span> 기본 정보
              </h2>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>교육 일자</Label>
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

                <div className="grid grid-cols-2 gap-3 items-end">
                  <div className="space-y-1.5">
                    <div className="flex justify-between">
                      <Label>시작 시간</Label>
                      <Button variant="ghost" size="sm" className="h-6 px-1 text-slate-500" onClick={() => setFormData(prev => ({ ...prev, startTime: getCurrentTime() }))}>
                        <RefreshCw className="w-3 h-3 mr-1" /> 현시간
                      </Button>
                    </div>
                    <CustomTimePicker value={formData.startTime} onChange={(val) => setFormData(prev => ({ ...prev, startTime: val }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>소요 시간</Label>
                    <div className="flex items-center gap-2 h-12">
                      <div className="relative flex-1"><Input type="number" inputMode="numeric" className="h-12 text-center text-lg font-bold border-slate-300 pr-8" value={formData.durationHour} onChange={(e) => setFormData(prev => ({ ...prev, durationHour: e.target.value }))} /><span className="absolute right-2 top-3 text-slate-500 text-sm">시간</span></div>
                      <div className="relative flex-1"><Input type="number" inputMode="numeric" className="h-12 text-center text-lg font-bold border-slate-300 pr-6" value={formData.durationMinute} onChange={(e) => setFormData(prev => ({ ...prev, durationMinute: e.target.value }))} /><span className="absolute right-2 top-3 text-slate-500 text-sm">분</span></div>
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5"><Label>교육 장소</Label><Input name="location" value={formData.location} onChange={handleChange} className="h-12 text-lg border-slate-300" /></div>
                <div className="space-y-1.5">
                  <Label>교육 구분</Label>
                  <Select value={formData.educationType} onValueChange={(val) => setFormData(prev => ({ ...prev, educationType: val }))}>
                    <SelectTrigger className="h-12 text-lg bg-white border-slate-300"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="TBM">TBM (작업 전 안전점검)</SelectItem>
                      <SelectItem value="정기 안전교육">정기 안전교육</SelectItem>
                      <SelectItem value="특별안전보건교육">특별안전보건교육</SelectItem>
                      <SelectItem value="신규 채용시 교육">신규 채용시 교육</SelectItem>
                      <SelectItem value="작업내용 변경시 교육">작업내용 변경시 교육</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formData.educationType !== "TBM" && (
                  <>
                    <div className="space-y-1.5"><Label>교육실시자</Label><Input name="instructorName" value={formData.instructorName} onChange={handleChange} className="h-12 text-lg border-slate-300" placeholder="이름 입력" /></div>
                    {instructorSignature ? (
                      <div onClick={() => openSignModal({ type: 'instructor' })} className="h-14 border border-green-500 bg-green-50 rounded-lg flex items-center justify-center cursor-pointer relative overflow-hidden"><img src={instructorSignature} alt="서명" className="h-full object-contain" /><div className="absolute right-2 bottom-1 text-xs text-green-700 font-bold bg-white/80 px-1 rounded">교육실시자 서명 완료</div></div>
                    ) : (
                      <Button variant="outline" className="w-full h-14 border-dashed border-2 border-slate-300 text-slate-500 text-lg hover:bg-slate-50" onClick={() => openSignModal({ type: 'instructor' })}><PenTool className="mr-2 h-5 w-5" /> 교육실시자 서명하기</Button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* STEP 2: 교육 자료 및 녹음/업로드 (Iframe 제거, 버튼 링크로 대체) */}
          {step === 2 && (
            <div className="animate-in slide-in-from-right-4 duration-300 relative min-h-[60vh] flex flex-col">
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2 mb-4">
                <span className="bg-slate-900 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">2</span> 교육 자료 확인 및 녹음
              </h2>

              {/* ⭐️ 교육자료 링크 버튼 (Iframe 대체) */}
              <div className="flex-1 border-2 border-slate-200 rounded-xl bg-slate-50 flex flex-col items-center justify-center p-6 text-center relative min-h-[500px]">
                <BookOpen className="w-20 h-20 text-slate-300 mb-6" />
                <h3 className="text-xl font-bold text-slate-800 mb-2">안전보건 교육자료</h3>
                <p className="text-slate-500 mb-8 max-w-xs leading-relaxed">
                  구글 사이트 보안 정책으로 인해<br />
                  교육자료는 새 창에서 확인해야 합니다.
                </p>
                <Button
                  onClick={() => window.open("https://sites.google.com/musinsalogistics.co.kr/healthandsafety", '_blank')}
                  className="h-14 px-8 text-lg bg-blue-600 hover:bg-blue-700 text-white shadow-lg rounded-full"
                >
                  <ExternalLink className="mr-2 w-5 h-5" /> 자료 보러가기
                </Button>
              </div>

              {/* 우측 상단 고정 컨트롤 (녹음 + 업로드) */}
              <div className="absolute top-12 right-2 z-10 flex flex-col items-end gap-3 pointer-events-none">
                {/* 파일 업로드 버튼 */}
                <div className="pointer-events-auto shadow-md rounded-full">
                  <input type="file" ref={fileInputRef} className="hidden" accept="audio/*, .m4a, .mp3, .wav" onChange={handleFileUpload} />
                  <Button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isProcessingSTT || isProcessingAI || isRecording}
                    className="w-12 h-12 rounded-full flex items-center justify-center bg-white text-slate-700 hover:bg-slate-100 border border-slate-200"
                    title="오디오 파일 업로드"
                  >
                    <Upload className="w-5 h-5" />
                  </Button>
                </div>

                {/* 녹음 버튼 */}
                <div className="pointer-events-auto shadow-2xl rounded-full">
                  <Button
                    onClick={toggleRecording}
                    disabled={isProcessingSTT || isProcessingAI}
                    className={cn(
                      "w-16 h-16 rounded-full flex items-center justify-center transition-all duration-300 border-4 border-white",
                      isRecording ? "bg-red-500 hover:bg-red-600 animate-pulse scale-110" : "bg-slate-900 hover:bg-slate-800"
                    )}
                  >
                    {isProcessingSTT || isProcessingAI ? (
                      <Loader2 className="w-8 h-8 text-white animate-spin" />
                    ) : isRecording ? (
                      <StopCircle className="w-8 h-8 text-white" />
                    ) : (
                      <Mic className="w-8 h-8 text-white" />
                    )}
                  </Button>
                </div>

                {/* 상태 메시지 */}
                {(isProcessingSTT || isProcessingAI || isRecording) && (
                  <div className="bg-black/70 text-white text-xs px-2 py-1 rounded-md backdrop-blur-sm pointer-events-auto">
                    {isProcessingSTT ? "변환 중..." : isProcessingAI ? "요약 중..." : "녹음 중"}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 3: 내용 확인 및 수정 */}
          {step === 3 && (
            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <span className="bg-slate-900 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">3</span> 내용 확인 및 수정
              </h2>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="flex justify-between">
                    <span>교육 내용 (요약)</span>
                    <span className="text-xs text-slate-400 font-normal">자동 요약된 내용입니다.</span>
                  </Label>
                  <textarea
                    className="w-full p-3 border-2 border-slate-200 rounded-lg bg-slate-50 min-h-[200px] text-base leading-relaxed focus:bg-white focus:border-slate-400 transition-colors resize-none"
                    value={formData.educationContent}
                    onChange={handleChange}
                    name="educationContent"
                    placeholder="녹음 내용이 요약되어 여기에 표시됩니다."
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>특이사항 (안내/전파)</Label>
                  <textarea
                    name="remarks"
                    value={formData.remarks}
                    onChange={handleChange}
                    className="w-full p-3 border border-slate-300 rounded-lg h-32 text-base bg-white resize-none"
                    placeholder="전달사항이나 공지사항이 여기에 표시됩니다."
                  />
                </div>

                <div className="bg-blue-50 p-4 rounded-lg text-sm text-blue-700 flex items-start gap-2">
                  <FileText className="w-5 h-5 shrink-0 mt-0.5" />
                  <p>내용이 올바르지 않다면 직접 수정해주세요. 다음 단계로 넘어가면 서명을 진행합니다.</p>
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: 사진 */}
          {step === 4 && (
            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <span className="bg-slate-900 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">4</span> 현장 사진
              </h2>
              <div className="aspect-square bg-slate-50 rounded-xl border-2 border-dashed border-slate-300 flex items-center justify-center relative overflow-hidden active:bg-slate-200 transition-colors">
                {formData.photo ? (
                  <img src={formData.photo} className="w-full h-full object-cover" alt="교육사진" />
                ) : (
                  <div className="flex flex-col items-center text-slate-400">
                    <Camera className="w-16 h-16 mb-2" />
                    <span className="text-lg font-bold">터치하여 사진 촬영</span>
                  </div>
                )}
                <input type="file" accept="image/*" className="absolute inset-0 opacity-0 z-10" onChange={(e) => {
                  if (e.target.files?.[0]) {
                    const reader = new FileReader();
                    reader.onloadend = () => setFormData(prev => ({ ...prev, photo: reader.result as string }))
                    reader.readAsDataURL(e.target.files[0])
                  }
                }} />
              </div>
            </div>
          )}

          {/* STEP 5: 명단 */}
          {step === 5 && (
            <div className="space-y-4 animate-in slide-in-from-right-4 duration-300">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                  <span className="bg-slate-900 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">5</span> 명단 ({formData.participants.length}명)
                </h2>
                <Button size="sm" onClick={() => setFormData(prev => ({ ...prev, participants: [...prev.participants, { id: Date.now(), name: "", gender: "M", status: "present", signature: null }] }))} className="bg-slate-900 hover:bg-slate-800"><Plus className="w-4 h-4" /> 추가</Button>
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
                      <div className="flex bg-slate-100 p-1 rounded-lg">
                        <button onClick={() => updateParticipant(p.id, "gender", "M")} className={cn("px-3 py-2 text-sm font-bold rounded-md transition-all", p.gender === 'M' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400')}>남</button>
                        <button onClick={() => updateParticipant(p.id, "gender", "F")} className={cn("px-3 py-2 text-sm font-bold rounded-md transition-all", p.gender === 'F' ? 'bg-white text-pink-600 shadow-sm' : 'text-slate-400')}>여</button>
                      </div>
                      <div className="flex-1" onClick={() => openSignModal({ type: 'participant', id: p.id })}>
                        {p.signature ? <div className="h-10 bg-green-50 border border-green-500 rounded-lg flex items-center justify-center"><img src={p.signature} className="h-full object-contain" /></div> : <Button variant="outline" className="w-full h-10 border-dashed text-slate-400 border-slate-300">서명하기</Button>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP 6: 완료 */}
          {step === 6 && (
            <div className="flex flex-col items-center justify-center h-[60vh] animate-in zoom-in duration-300">
              <CheckCircle2 className="w-24 h-24 text-green-600 mb-6" />
              <h2 className="text-2xl font-bold text-slate-900 mb-2">저장 완료!</h2>
              <p className="text-slate-500 text-center mb-8">모든 내용이 서버에 안전하게 저장되었습니다.</p>

              <div className="w-full space-y-3 px-4">
                <Button onClick={() => router.push(`/report/${savedLogId}`)} className="w-full bg-slate-900 hover:bg-slate-800 text-white h-14 text-xl font-bold shadow-lg">
                  <FileText className="mr-2" /> 작성된 일지 보기
                </Button>
                <Button variant="outline" onClick={() => router.push('/dashboard')} className="w-full h-14 text-lg border-slate-300">
                  대시보드로 이동
                </Button>
              </div>
            </div>
          )}

        </div>

        {/* 하단 버튼 */}
        {step < 6 && (
          <div className="absolute bottom-0 left-0 w-full bg-white border-t p-4 flex gap-3 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
            <Button variant="outline" onClick={() => setStep(prev => Math.max(1, prev - 1))} disabled={step === 1} className="flex-1 h-12 text-lg border-slate-300">이전</Button>
            {step < 5 ? (
              <Button onClick={handleNext} className="flex-[2] h-12 text-lg bg-slate-900 hover:bg-slate-800 text-white">다음 단계</Button>
            ) : (
              <Button onClick={saveToDatabase} disabled={isSaving} className="flex-[2] h-12 text-lg bg-green-600 hover:bg-green-700 text-white font-bold">
                {isSaving ? <Loader2 className="animate-spin" /> : <Save className="mr-2" />} 완료 및 저장
              </Button>
            )}
          </div>
        )}

      </div>

      {/* 서명 Drawer */}
      <Drawer open={isSignOpen} onOpenChange={setIsSignOpen}>
        <DrawerContent className="h-[80vh]">
          <DrawerHeader><DrawerTitle className="text-center text-xl">서명해 주세요</DrawerTitle></DrawerHeader>
          <div className="p-4 flex-1 bg-slate-50">
            <div className="border-2 border-slate-300 rounded-xl bg-white h-full shadow-inner" style={{ touchAction: "none" }}>
              <SignatureCanvas ref={sigCanvas} canvasProps={{ className: "w-full h-full" }} />
            </div>
          </div>
          <DrawerFooter className="flex-row gap-3 border-t bg-white">
            <Button variant="outline" onClick={() => sigCanvas.current?.clear()} className="flex-1 h-12 text-lg">지우기</Button>
            <Button onClick={saveSignature} className="flex-1 h-12 text-lg bg-slate-900 text-white">확인</Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  )
}