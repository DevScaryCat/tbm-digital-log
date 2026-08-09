"use client"

/* Hallmark · component: notice card · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: static (표시 전용 — 인터랙티브 요소 없음)
 *
 * 영구 무료(grandfather) 계정이 결제 화면에 들어왔을 때 결제 버튼 위에 붙는 고지.
 * 구매를 막지 않는다 — 다만 "지금 무료다 / 구독하면 그 지위가 사라진다 / 해지하면 돌아온다"를
 * 결제 전에 말한다. 구독하는 정당한 이유(AI 분석 보고서 한도 0)도 같이 보여준다.
 *
 * 숫자는 지어내지 않는다 — lib/useSubscription.ts의 LIMITS(=DB 트리거 enforce_tbm_monthly_limit)에서 읽는다.
 */

import { Gift } from "lucide-react"
import { limitFor } from "@/lib/useSubscription"

const ROWS = [
    { label: "안전보건교육일지", kind: "log" },
    { label: "TBM 회의록", kind: "minutes" },
    { label: "AI 분석 보고서", kind: "ra" },
] as const

/** 한도 0은 헤더 사용량 바와 같은 말로 — '0회'가 아니라 '미포함' */
function limitLabel(n: number): string {
    return n === 0 ? "미포함" : `월 ${n}회`
}

export function GrandfatherNotice() {
    return (
        <div className="rounded-[12px] border border-cur-hairline-strong bg-cur-elevated p-5 space-y-3">
            <div className="flex items-center gap-2">
                <Gift className="w-4 h-4 shrink-0 text-cur-primary" />
                <p className="text-[15px] font-bold text-cur-ink">지금 영구 무료로 이용 중이에요</p>
            </div>
            <p className="text-[13px] text-cur-muted leading-relaxed">
                구독하면 이 무료 혜택이 사라져요. 구독의 실익은 AI 분석 보고서예요.
            </p>

            <div className="rounded-[8px] border border-cur-hairline bg-cur-card px-4 py-3 space-y-1.5">
                <div className="flex justify-between text-[12px] text-cur-muted-soft">
                    <span>월 한도</span>
                    <span>지금 → 구독 시</span>
                </div>
                {ROWS.map((r) => {
                    const free = limitFor("grandfather", r.kind)
                    const paid = limitFor("monthly_pro", r.kind)
                    return (
                        <div key={r.kind} className="flex justify-between text-[13px]">
                            <span className="text-cur-muted">{r.label}</span>
                            <span>
                                <span className={free === 0 ? "text-cur-muted-soft" : "text-cur-body"}>
                                    {limitLabel(free)}
                                </span>
                                <span className="text-cur-muted-soft"> → </span>
                                <span className="text-cur-ink font-medium">{limitLabel(paid)}</span>
                            </span>
                        </div>
                    )
                })}
            </div>

            <p className="text-[12px] text-cur-muted-soft leading-relaxed">해지하면 다시 무료로 돌아와요.</p>
        </div>
    )
}
