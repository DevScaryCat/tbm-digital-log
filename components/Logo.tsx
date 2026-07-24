// components/Logo.tsx
import { cn } from "@/lib/utils"

type LogoSize = "sm" | "md" | "lg"

const SIZES: Record<LogoSize, { box: string; text: string; gap: string }> = {
  sm: { box: "w-9 h-9 rounded-[8px]", text: "text-[15px]", gap: "gap-2" },
  md: { box: "w-12 h-12 rounded-[10px]", text: "text-[20px]", gap: "gap-2.5" },
  lg: { box: "w-20 h-20 rounded-[14px]", text: "text-[34px] sm:text-[40px]", gap: "gap-4" },
}

export function Logo({ size = "md", className }: { size?: LogoSize; className?: string }) {
  const s = SIZES[size]
  return (
    <div className={cn("flex items-center", s.gap, className)}>
      {/* 브랜드 아이콘(안전모=말풍선) — 이미지 자체에 배경·라운드 포함, 앱 아이콘과 동일 자산 */}
      <img
        src="/brand/antok-icon-256.png"
        alt=""
        className={cn("shrink-0 object-cover shadow-[0_0_24px_rgba(245,78,0,0.18)]", s.box)}
      />
      <div
        className={cn(
          "flex flex-col items-start text-left leading-none font-bold tracking-[-0.02em] text-cur-ink",
          s.text
        )}
      >
        <span className="text-[0.78em] font-semibold text-cur-ink/65">안전</span>
        <span className="-mt-[0.16em]">
          톡톡<span className="text-cur-primary ml-[0.12em]">e</span>
        </span>
      </div>
    </div>
  )
}
