// components/ExportFormatPicker.tsx — 문서 출력 형식 4택 타일
// 첫 로그인 설정 모달(app/page.tsx)과 내 정보 수정(app/profile)이 같은 UI를 쓰도록 공용화.
"use client"

import { EXPORT_FORMATS, type ExportFormat } from "@/lib/exportFormats"
import { cn } from "@/lib/utils"

export function ExportFormatPicker({ value, onChange }: { value: ExportFormat | null; onChange: (v: ExportFormat) => void }) {
    return (
        <div className="grid grid-cols-4 gap-2">
            {EXPORT_FORMATS.map((f) => (
                <button
                    key={f.value}
                    type="button"
                    onClick={() => onChange(f.value)}
                    aria-pressed={value === f.value}
                    className={cn(
                        "h-16 rounded-[8px] border flex flex-col items-center justify-center gap-0.5 transition-colors",
                        value === f.value
                            ? "border-cur-primary ring-1 ring-cur-primary bg-cur-primary/5 text-cur-primary"
                            : "border-cur-hairline bg-cur-card text-cur-ink"
                    )}
                >
                    <span className="text-[15px] font-semibold">{f.label}</span>
                    <span className="text-[11px] text-cur-muted">{f.sub}</span>
                </button>
            ))}
        </div>
    )
}
