// components/ExportFormatPicker.tsx — 문서 출력 형식 4택 타일
// 첫 로그인 설정 모달(app/page.tsx)과 내 정보 수정(app/profile)이 같은 UI를 쓰도록 공용화.
"use client"

import { EXPORT_FORMATS, type ExportFormat } from "@/lib/exportFormats"
import { cn } from "@/lib/utils"

// 형식별 식별색 타일 — 각 프로그램의 통용 색(한글 파랑·워드 남색·엑셀 초록·PDF 빨강).
// 글자만 있던 4택이 밋밋하다는 지적(Chris) — 색+이니셜이 라벨보다 먼저 읽힌다.
const FORMAT_BADGE: Record<ExportFormat, { text: string; bg: string }> = {
    hwp: { text: "한", bg: "#2f7de1" },
    docx: { text: "W", bg: "#2B579A" },
    xlsx: { text: "X", bg: "#217346" },
    pdf: { text: "PDF", bg: "#D93025" },
}

export function ExportFormatPicker({ value, onChange }: { value: ExportFormat | null; onChange: (v: ExportFormat) => void }) {
    return (
        <div className="grid grid-cols-4 gap-2">
            {EXPORT_FORMATS.map((f) => {
                const badge = FORMAT_BADGE[f.value]
                return (
                    <button
                        key={f.value}
                        type="button"
                        onClick={() => onChange(f.value)}
                        aria-pressed={value === f.value}
                        className={cn(
                            "h-[84px] rounded-[8px] border flex flex-col items-center justify-center gap-1.5 transition-colors",
                            value === f.value
                                ? "border-cur-primary ring-1 ring-cur-primary bg-cur-primary/5"
                                : "border-cur-hairline bg-cur-card"
                        )}
                    >
                        <span
                            aria-hidden
                            className={cn(
                                "w-8 h-8 rounded-[7px] flex items-center justify-center text-white font-bold transition-opacity",
                                badge.text.length > 1 ? "text-[10px] tracking-tight" : "text-[14px]",
                                value !== null && value !== f.value && "opacity-45"
                            )}
                            style={{ backgroundColor: badge.bg }}
                        >
                            {badge.text}
                        </span>
                        <span className="flex flex-col items-center leading-tight">
                            <span className={cn("text-[13px] font-semibold", value === f.value ? "text-cur-primary" : "text-cur-ink")}>{f.label}</span>
                            <span className="text-[10px] text-cur-muted">{f.sub}</span>
                        </span>
                    </button>
                )
            })}
        </div>
    )
}
