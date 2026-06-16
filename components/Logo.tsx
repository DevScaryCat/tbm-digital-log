// components/Logo.tsx
import { HardHat } from "lucide-react"
import { cn } from "@/lib/utils"

type LogoSize = "sm" | "md" | "lg"

const SIZES: Record<LogoSize, { box: string; icon: string; text: string; gap: string }> = {
  sm: { box: "w-9 h-9 rounded-[8px] p-1.5", icon: "w-5 h-5", text: "text-[15px]", gap: "gap-2" },
  md: { box: "w-12 h-12 rounded-[10px] p-2", icon: "w-7 h-7", text: "text-[20px]", gap: "gap-2.5" },
  lg: { box: "w-20 h-20 rounded-[14px] p-4", icon: "w-10 h-10", text: "text-[34px] sm:text-[40px]", gap: "gap-4" },
}

export function Logo({ size = "md", className }: { size?: LogoSize; className?: string }) {
  const s = SIZES[size]
  return (
    <div className={cn("flex items-center", s.gap, className)}>
      <div
        className={cn(
          "bg-cur-primary flex items-center justify-center shrink-0 shadow-[0_0_24px_rgba(245,78,0,0.18)]",
          s.box
        )}
      >
        <HardHat className={cn("text-cur-on-primary", s.icon)} />
      </div>
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
