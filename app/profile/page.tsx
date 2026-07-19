"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2 } from "lucide-react"
import { type ExportFormat } from "@/lib/exportFormats"
import { ExportFormatPicker } from "@/components/ExportFormatPicker"
// 가입 위저드(app/signup)와 동일한 KSIC 기반 옵션 — 여기서 기존 유저가 나중에 편집/백필한다.
import { KSIC_FREQUENT, KSIC_OTHERS, findKsicMajor } from "@/lib/ksic"

export default function ProfilePage() {
    const router = useRouter()
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    const [fullName, setFullName] = useState("")
    const [companyName, setCompanyName] = useState("")
    const [workerType, setWorkerType] = useState("현장 근로자 (비사무직)")
    // ""=미설정. 미설정 상태로 저장해도 값을 쓰지 않아야 홈의 최초 설정 모달이 유지된다(임의 pdf 확정 방지).
    const [exportFormat, setExportFormat] = useState<string>("")
    const [industry, setIndustry] = useState("")
    const [workCategory, setWorkCategory] = useState("")

    useEffect(() => {
        ;(async () => {
            const {
                data: { session },
            } = await supabase.auth.getSession()
            if (!session) {
                router.replace("/login")
                return
            }
            const meta = session.user.user_metadata ?? {}
            setFullName(meta.full_name ?? "")
            setCompanyName(meta.company_name ?? "")
            setWorkerType(meta.worker_type ?? "현장 근로자 (비사무직)")
            setExportFormat(meta.preferred_export_format ?? "")
            setIndustry(meta.industry ?? "")
            // 저장 키는 snake_case(work_category) — 가입 API와 동일
            setWorkCategory(meta.work_category ?? "")
            setLoading(false)
        })()
    }, [router])

    // KSIC 개편 이전에 저장된 구 값(예: "물류·운수업", "건축")은 목록에 없어도 선택 상태로 보이게 항목을 덧붙인다.
    const selectedMajor = industry ? findKsicMajor(industry) : undefined
    const isLegacyIndustry = !!industry && !selectedMajor
    const minors = selectedMajor?.minors ?? []
    const isLegacyWorkCategory = !!workCategory && !minors.some((mi) => mi.name === workCategory)

    const handleSave = async () => {
        if (!fullName.trim()) {
            setMsg({ type: "err", text: "성명을 입력해주세요." })
            return
        }
        if (!companyName.trim()) {
            setMsg({ type: "err", text: "소속 현장명(또는 업체명)을 입력해주세요." })
            return
        }
        setSaving(true)
        setMsg(null)
        try {
            const { data, error } = await supabase.auth.updateUser({
                data: {
                    full_name: fullName.trim(),
                    company_name: companyName.trim(),
                    worker_type: workerType,
                    ...(exportFormat ? { preferred_export_format: exportFormat } : {}),
                    industry: industry || null,
                    work_category: workCategory || null,
                },
            })
            if (error) throw error
            setWorkCategory(data.user.user_metadata.work_category ?? "")
            setMsg({ type: "ok", text: "내 정보가 저장되었습니다." })
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : "알 수 없는 오류"
            setMsg({ type: "err", text: "저장 실패: " + errMsg })
        } finally {
            setSaving(false)
        }
    }

    if (loading)
        return (
            <div className="min-h-screen flex items-center justify-center bg-cur-canvas">
                <Loader2 className="w-10 h-10 text-cur-primary animate-spin" />
            </div>
        )

    return (
        <div className="min-h-screen bg-cur-canvas flex flex-col font-sans text-cur-body">
            <div className="w-full max-w-md mx-auto px-4 pt-4">
                <TBMHeader title="내 정보 수정" backHref="/" />
            </div>
            <div className="flex-1 w-full max-w-md mx-auto px-4 py-6 pb-16 space-y-4">
                {msg && (
                    <div
                        className={`text-[13px] rounded-lg p-3 ${
                            msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"
                        }`}
                    >
                        {msg.text}
                    </div>
                )}

                <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-4">
                    <div className="space-y-2">
                        <Label className="text-[13px] font-medium text-cur-body">성명</Label>
                        <Input
                            value={fullName}
                            onChange={(e) => setFullName(e.target.value)}
                            placeholder="성명을 입력하세요"
                            className="h-11"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label className="text-[13px] font-medium text-cur-body">소속 현장명 (또는 업체명)</Label>
                        <Input
                            value={companyName}
                            onChange={(e) => setCompanyName(e.target.value)}
                            placeholder="소속 현장명 (또는 업체명)"
                            className="h-11"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label className="text-[13px] font-medium text-cur-body">근로자 구분 (교육시간 산정용)</Label>
                        <Select value={workerType} onValueChange={setWorkerType}>
                            <SelectTrigger className="w-full h-11 text-[14px]">
                                <SelectValue placeholder="직군 선택" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="현장 근로자 (비사무직)">현장 근로자 (비사무직) (반기 12시간)</SelectItem>
                                <SelectItem value="사무직 / 판매직">사무직 / 판매직 (반기 6시간)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label className="text-[13px] font-medium text-cur-body">문서 출력 형식</Label>
                        <ExportFormatPicker
                            value={(exportFormat || null) as ExportFormat | null}
                            onChange={(v) => setExportFormat(v)}
                        />
                        <p className="text-[12px] text-cur-muted">한글(.hwpx)·워드(.docx)·엑셀(.xlsx)은 문서 보기 화면에서 해당 형식으로 저장돼요. PDF는 편집 불가·출력 전용.</p>
                    </div>
                </div>

                <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-4">
                    <div>
                        <p className="text-[15px] font-bold text-cur-ink">현장 정보</p>
                        <p className="text-[12px] text-cur-muted mt-0.5">업종·공종은 보고서·통계 정확도를 높이는 데 쓰입니다.</p>
                    </div>
                    <div className="space-y-2">
                        <Label className="text-[13px] font-medium text-cur-body">업종</Label>
                        <Select
                            value={industry}
                            onValueChange={(v) => {
                                setIndustry(v)
                                // 중분류가 하나뿐인 업종은 공종을 자동 선택 (가입 위저드와 동일 규칙)
                                const next = findKsicMajor(v)?.minors ?? []
                                setWorkCategory(next.length === 1 ? next[0].name : "")
                            }}
                        >
                            <SelectTrigger className="w-full h-11 text-[14px]">
                                <SelectValue placeholder="업종 선택" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    <SelectLabel className="text-[12px] text-cur-muted">자주 찾는 업종</SelectLabel>
                                    {KSIC_FREQUENT.map((m) => (
                                        <SelectItem key={m.code} value={m.name}>
                                            {m.name}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                                <SelectGroup>
                                    <SelectLabel className="text-[12px] text-cur-muted border-t border-cur-hairline mt-1 pt-2">그 외 업종</SelectLabel>
                                    {KSIC_OTHERS.map((m) => (
                                        <SelectItem key={m.code} value={m.name}>
                                            {m.name}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                                {isLegacyIndustry && (
                                    <SelectItem value={industry}>{industry} (이전 항목)</SelectItem>
                                )}
                            </SelectContent>
                        </Select>
                    </div>
                    {industry && (
                        <div className="space-y-2">
                            <Label className="text-[13px] font-medium text-cur-body">공종</Label>
                            <Select value={workCategory} onValueChange={setWorkCategory}>
                                <SelectTrigger className="w-full h-11 text-[14px]">
                                    <SelectValue placeholder="공종 선택" />
                                </SelectTrigger>
                                <SelectContent>
                                    {minors.map((mi) => (
                                        <SelectItem key={mi.code} value={mi.name}>
                                            {mi.name}
                                        </SelectItem>
                                    ))}
                                    {isLegacyWorkCategory && (
                                        <SelectItem value={workCategory}>{workCategory} (이전 항목)</SelectItem>
                                    )}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                </div>

                <Button
                    onClick={handleSave}
                    disabled={saving}
                    className="w-full h-12 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90"
                >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "저장"}
                </Button>
            </div>
        </div>
    )
}
