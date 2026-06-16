"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ReportSettingsPanel } from "@/components/ReportSettingsPanel"

/**
 * 자동 보고서 설정 모달 — 대시보드(기간 모드)·위험성평가 페이지에서 사용.
 * 본문은 ReportSettingsPanel 공용.
 */
export function ReportSettingsDialog({ open, onOpenChange, pro = false }: { open: boolean; onOpenChange: (o: boolean) => void; pro?: boolean }) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md w-[calc(100%-2rem)] max-h-[85vh] overflow-y-auto rounded-2xl bg-cur-card border-cur-hairline">
                <DialogHeader>
                    <DialogTitle className="text-[18px] font-bold text-cur-ink flex items-center gap-2">
                        자동 보고서 설정
                        {!pro && <span className="bg-cur-primary/15 text-cur-primary text-[10px] font-bold px-1.5 py-0.5 rounded-[4px] tracking-wide">PRO</span>}
                    </DialogTitle>
                </DialogHeader>
                <div className="pt-2">
                    <ReportSettingsPanel pro={pro} />
                </div>
            </DialogContent>
        </Dialog>
    )
}
