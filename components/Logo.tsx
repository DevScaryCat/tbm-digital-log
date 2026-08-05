// components/Logo.tsx
import { cn } from "@/lib/utils"

type LogoSize = "sm" | "md" | "lg"

// 새 브랜드 마크(말풍선 "안톡", 512×443)가 워드마크를 겸한다 — 텍스트 병기 금지("안톡 안톡" 중복)
const SIZES: Record<LogoSize, string> = {
  sm: "h-9",
  md: "h-12",
  lg: "h-20",
}

export function Logo({ size = "md", className }: { size?: LogoSize; className?: string }) {
  return (
    <img
      src="/brand/antok-mark.png"
      alt="안톡"
      className={cn("w-auto shrink-0 select-none", SIZES[size], className)}
      draggable={false}
    />
  )
}
