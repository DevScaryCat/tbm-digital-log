"use client"

/* Hallmark · component: notice card · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: static (표시 전용 — 인터랙티브 요소 없음)
 *
 * 영구 무료(grandfather) 계정이 결제/이용 화면에서 보는 **유일한** 안내.
 *
 * 2026-08-10 Chris 결정으로 전제가 뒤집혔다. 이전 판은 "구독하면 이 혜택이 사라진다"는
 * 결제 전 고지였다 — 그건 grandfather의 AI 분석 한도가 0이라 구독할 이유가 있던 시절의 말이다.
 * 이제 grandfather는 유료와 기능·한도가 완전히 같고(교육일지 200·회의록 30·AI 분석 20)
 * 결제 시스템만 빠져 있다. 그러니 비교표도, 구매 유도도, 잃는 것 얘기도 남길 게 없다.
 * 남는 말은 하나뿐이다: 지금 무료고, 정책이 바뀌기 전까지 그대로다.
 *
 * ⚠️ 여기에 금액·구매 버튼·결제수단 안내를 다시 넣지 말 것. 이 계정들은 카드 등록 자체가
 *    서버에서 409로 막혀 있어(app/api/payments/billing-key·app/api/billing/card),
 *    결제를 권하는 문구는 곧바로 막다른 길이 된다.
 */

import { Gift } from "lucide-react"

export function GrandfatherNotice() {
    return (
        <div className="rounded-[12px] border border-cur-hairline-strong bg-cur-elevated p-5 space-y-2">
            <div className="flex items-center gap-2">
                <Gift className="w-4 h-4 shrink-0 text-cur-primary" />
                <p className="text-[15px] font-bold text-cur-ink">영구 무료로 이용 중이에요</p>
            </div>
            <p className="text-[14px] text-cur-body leading-relaxed">정책 변경 전까지 무료로 사용 가능합니다.</p>
            <p className="text-[13px] text-cur-muted leading-relaxed">
                모든 기능을 유료 구독과 똑같이 쓸 수 있어요. 결제하실 것은 없습니다.
            </p>
        </div>
    )
}
