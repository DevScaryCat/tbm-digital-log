// components/Antoki.tsx — 마스코트 '안톡이' 렌더러
/* Hallmark · component: mascot · genre: modern-minimal · theme: 안톡 cur-* (기존 토큰만)
 * motion: breathe · bob · pop — 프리미티브 3개 고정. 여기 없는 모션은 추가하지 않는다.
 * keyframes: app/globals.css의 @keyframes antoki-* (prefers-reduced-motion에서 전부 무력화)
 * a11y: 기본은 장식(aria-hidden + alt="") · label을 주면 그때만 의미를 전달한다
 */
import Image from "next/image"

/** 원본 스프라이트 크기와 컷 형태.
 *  bust=true는 상반신 컷(하단이 평평하게 잘림) — 공중에 띄우면 '잘린 그림'으로 보여서
 *  컨테이너 바닥에 붙이거나 가장자리 뒤에서 고개를 내미는 배치로만 쓴다. */
const POSES = {
  joy: { w: 175, h: 205, bust: true },
  wink: { w: 177, h: 205, bust: true },
  think: { w: 176, h: 205, bust: true },
  surprise: { w: 191, h: 214, bust: true },
  resolve: { w: 178, h: 208, bust: true },
  inspect: { w: 179, h: 221, bust: false },
  record: { w: 148, h: 222, bust: false },
  guide: { w: 205, h: 226, bust: false },
  shield: { w: 143, h: 219, bust: false },
  run: { w: 194, h: 220, bust: false },
  listen: { w: 697, h: 952, bust: false },
} as const

export type AntokiPose = keyof typeof POSES
export type AntokiSize = "sm" | "md" | "lg" | "xl"
export type AntokiMotion = "breathe" | "bob" | "pop" | "none"
export type AntokiAnchor = "bottom" | "free"

/** 표시 높이(px). 원본 해상도를 넘겨 키우면 흐려지므로 아래 CAP으로 한 번 더 자른다. */
const HEIGHT: Record<AntokiSize, number> = { sm: 44, md: 64, lg: 96, xl: 128 }
const CAP_DEFAULT = 96
const CAP_LISTEN = 160

const MOTION_CLASS: Record<Exclude<AntokiMotion, "none">, string> = {
  breathe: "antoki-breathe",
  bob: "antoki-bob",
  pop: "antoki-pop",
}

export function Antoki({
  pose,
  size = "md",
  motion = "none",
  anchor,
  className = "",
  label,
}: {
  pose: AntokiPose
  size?: AntokiSize
  /** breathe=대기 · bob=활동 중 · pop=등장 · none=정지 */
  motion?: AntokiMotion
  /** 생략하면 컷 형태에서 결정된다(상반신=bottom, 전신=free) */
  anchor?: AntokiAnchor
  className?: string
  /** 의미를 전달해야 하는 자리(빈 상태 등)에서만. 없으면 장식 취급 */
  label?: string
}) {
  const meta = POSES[pose]
  const cap = pose === "listen" ? CAP_LISTEN : CAP_DEFAULT
  const h = Math.min(HEIGHT[size], cap)
  const w = Math.round((h * meta.w) / meta.h)

  const bottomAnchored = (anchor ?? (meta.bust ? "bottom" : "free")) === "bottom"
  // 상반신 컷은 띄우면 잘린 단면이 드러난다 — bob은 breathe(제자리 호흡)로 내린다
  const applied: AntokiMotion = bottomAnchored && motion === "bob" ? "breathe" : motion
  const motionClass = applied === "none" ? "" : MOTION_CLASS[applied]

  return (
    <span
      className={`block max-w-full shrink-0 ${bottomAnchored ? "self-end" : ""} ${motionClass} ${className}`}
      style={{
        width: w,
        height: h,
        transformOrigin: bottomAnchored ? "bottom center" : "center",
      }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <Image
        src={`/antoki/${pose}.png`}
        alt=""
        width={w}
        height={h}
        /* sizes를 주면 next/image가 반응형 srcSet으로 바뀌어 2x 후보가 사라진다 —
           고정 크기라 기본 srcSet(1x·2x)을 그대로 쓰는 편이 레티나에서 선명하다 */
        className="block h-full w-full object-contain"
      />
    </span>
  )
}
