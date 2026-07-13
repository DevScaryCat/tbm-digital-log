// app/suggestions/page.tsx — 근로자 익명 제안함 (소유자 열람)
// QR 서명 페이지에서 근로자가 익명으로 보낸 의견·제안을 모아 본다.
// 익명 보장: 작성자 정보가 저장되지 않으므로 표시할 이름도 없다.
"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabaseClient"
import { fetchAllRows } from "@/lib/fetchAllRows"
import { useRequireSubscription } from "@/lib/useSubscription"
import { TBMHeader } from "@/components/TBMHeader"
import { Loader2, MessageSquareText, Trash2 } from "lucide-react"

type Suggestion = { id: string; content: string; is_read: boolean; created_at: string }

export default function SuggestionsPage() {
    useRequireSubscription()
    const [loading, setLoading] = useState(true)
    const [items, setItems] = useState<Suggestion[]>([])
    // 방금 읽음 처리된 항목도 이번 방문 동안은 NEW 배지를 유지해 알아볼 수 있게 한다
    const [newIds, setNewIds] = useState<Set<string>>(new Set())

    useEffect(() => {
        const load = async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) return
            const rows = await fetchAllRows<Suggestion>((f, t) =>
                supabase.from("worker_suggestions").select("id, content, is_read, created_at").order("id").range(f, t)
            )
            rows.sort((a, b) => b.created_at.localeCompare(a.created_at))
            setItems(rows)
            const unread = rows.filter(r => !r.is_read).map(r => r.id)
            setNewIds(new Set(unread))
            setLoading(false)
            if (unread.length > 0) {
                await supabase.from("worker_suggestions").update({ is_read: true }).in("id", unread)
            }
        }
        load()
    }, [])

    const handleDelete = async (id: string) => {
        if (!confirm("이 제안을 삭제할까요? 되돌릴 수 없습니다.")) return
        const { error } = await supabase.from("worker_suggestions").delete().eq("id", id)
        if (error) { alert("삭제 실패: " + error.message); return }
        setItems(prev => prev.filter(i => i.id !== id))
    }

    const fmt = (iso: string) => {
        const d = new Date(iso)
        return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    }

    return (
        <div className="min-h-screen bg-cur-canvas pb-24 font-sans text-cur-ink">
            <div className="max-w-md mx-auto min-h-screen bg-cur-card shadow-sm border-x border-cur-hairline flex flex-col">
                <div className="p-4 border-b border-cur-hairline bg-cur-card sticky top-0 z-10">
                    <TBMHeader title="근로자 제안함" />
                </div>

                <div className="p-5 space-y-4 flex-1 bg-cur-canvas-soft">
                    <p className="text-[13px] leading-5 text-cur-muted bg-cur-card border border-cur-hairline rounded-[12px] p-4">
                        참석자가 QR 서명 페이지에서 <b>익명으로</b> 보낸 의견·제안입니다. 작성자 정보는 저장되지 않습니다. (산업안전보건법 근로자 의견청취 기록으로 활용하세요)
                    </p>

                    {loading ? (
                        <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-cur-muted animate-spin" /></div>
                    ) : items.length === 0 ? (
                        <div className="flex flex-col items-center py-16 text-cur-muted">
                            <MessageSquareText className="w-12 h-12 mb-3 opacity-20" />
                            <p className="text-[14px]">아직 접수된 제안이 없습니다.</p>
                            <p className="text-[12px] text-cur-muted-soft mt-1">서명 QR을 공유하면 참석자가 의견을 남길 수 있어요.</p>
                        </div>
                    ) : (
                        items.map(item => (
                            <div key={item.id} className="bg-cur-card border border-cur-hairline rounded-[12px] p-4 space-y-2">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[12px] text-cur-muted font-mono">{fmt(item.created_at)}</span>
                                        {newIds.has(item.id) && (
                                            <span className="text-[10px] font-bold text-cur-on-primary bg-cur-primary px-1.5 py-0.5 rounded-[4px]">NEW</span>
                                        )}
                                    </div>
                                    <button onClick={() => handleDelete(item.id)} className="text-cur-muted hover:text-cur-error p-1 rounded-[6px] hover:bg-cur-error/10">
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                                <p className="text-[15px] leading-6 text-cur-ink whitespace-pre-wrap break-words">{item.content}</p>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
