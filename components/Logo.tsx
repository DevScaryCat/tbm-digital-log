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
      {/* 워드마크 "안톡" — 크기는 기존 두 줄 조합과 같은 시각적 무게를 갖도록 한 단계 키움 */}
      <span
        className={cn(
          "leading-none font-bold tracking-[-0.02em] text-cur-ink text-[1.28em]",
          s.text
        )}
      >
        안톡
      </span>
    </div>
  )
}
