"use client"

// components/RecoveryRequest.tsx — 아이디 찾기 / 비밀번호 찾기 공통 화면
// 두 화면은 "한 칸 입력 → 메일 발송 → 메일함 확인" 으로 완전히 같은 흐름이라 하나로 둔다.
// 서버는 계정이 있든 없든 같은 문구를 돌려주므로, 이 화면도 성공/실패를 구분해 보여주지 않는다.
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertCircle, Loader2, MailCheck } from "lucide-react"
import { Logo } from "@/components/Logo"
import { CARD_CLS, FIELD_CLS, PRIMARY_BTN_CLS } from "@/lib/authStyles"

const RESEND_COOLDOWN_SEC = 60

interface Props {
    title: string
    subtitle: string
    fieldLabel: string
    fieldPlaceholder: string
    fieldType: "email" | "text"
    autoComplete: string
    /** 입력값을 실어 보낼 API 경로 */
    endpoint: string
    /** 요청 본문의 키 (email | loginId) */
    bodyKey: string
    /** 입력 칸 아래 안내 — 복구 이메일을 등록해야만 쓸 수 있다는 사실을 미리 알린다 */
    hint: string
}

export function RecoveryRequest(props: Props) {
    const [value, setValue] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [sentMessage, setSentMessage] = useState<string | null>(null)
    const [cooldown, setCooldown] = useState(0)
    const sentTo = useRef("")

    useEffect(() => {
        if (cooldown <= 0) return
        const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
        return () => clearTimeout(t)
    }, [cooldown])

    const submit = async (e?: React.FormEvent) => {
        e?.preventDefault()
        if (loading) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(props.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ [props.bodyKey]: value.trim() }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                setError(data?.error || "요청을 처리하지 못했어요. 잠시 후 다시 시도해주세요.")
                return
            }
            sentTo.current = value.trim()
            setSentMessage(data?.message || "등록된 복구 이메일로 안내를 보냈어요.")
            setCooldown(RESEND_COOLDOWN_SEC)
        } catch {
            setError("네트워크 상태를 확인하고 다시 시도해주세요.")
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-cur-canvas px-5 py-10 font-sans text-cur-ink">
            <div className="w-full max-w-md">
                <div className="flex flex-col items-center gap-5 mb-7">
                    <Logo size="md" />
                    <div className="text-center space-y-1">
                        <h1 className="text-[22px] font-bold tracking-[-0.02em] text-cur-ink">{props.title}</h1>
                        <p className="text-[13px] text-cur-muted">{props.subtitle}</p>
                    </div>
                </div>

                {sentMessage ? (
                    <div className={CARD_CLS}>
                        <div className="flex flex-col items-center text-center gap-3 py-2">
                            <span className="w-11 h-11 rounded-full bg-cur-primary/[0.08] flex items-center justify-center">
                                <MailCheck className="w-5 h-5 text-cur-primary" aria-hidden />
                            </span>
                            <div className="space-y-1.5">
                                <p className="text-[15px] font-bold text-cur-ink">메일함을 확인해주세요</p>
                                <p className="text-[13px] text-cur-muted leading-[1.7]" aria-live="polite">
                                    {sentMessage}
                                    <br />
                                    메일이 안 보이면 스팸함도 확인해주세요.
                                </p>
                            </div>
                        </div>

                        <Button
                            type="button"
                            onClick={() => submit()}
                            disabled={loading || cooldown > 0}
                            className={PRIMARY_BTN_CLS}
                        >
                            {loading ? (
                                <Loader2 className="h-5 w-5 animate-spin" />
                            ) : cooldown > 0 ? (
                                `다시 보내기 (${cooldown}초)`
                            ) : (
                                "다시 보내기"
                            )}
                        </Button>

                        {error && (
                            <div className="flex items-center gap-2 p-3 text-[13px] font-medium text-cur-error bg-cur-error/[0.06] rounded-[8px]">
                                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden />
                                {error}
                            </div>
                        )}
                    </div>
                ) : (
                    <form onSubmit={submit} className={CARD_CLS}>
                        {error && (
                            <div className="flex items-center gap-2 p-3 text-[13px] font-medium text-cur-error bg-cur-error/[0.06] rounded-[8px]">
                                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden />
                                {error}
                            </div>
                        )}

                        <div className="space-y-1.5">
                            <Label htmlFor="recovery-field" className="text-[13px] font-medium text-cur-body">
                                {props.fieldLabel}
                            </Label>
                            <Input
                                id="recovery-field"
                                type={props.fieldType}
                                value={value}
                                onChange={(e) => setValue(e.target.value)}
                                placeholder={props.fieldPlaceholder}
                                autoComplete={props.autoComplete}
                                required
                                className={FIELD_CLS}
                            />
                            <p className="text-[12px] text-cur-muted-soft leading-[1.6]">{props.hint}</p>
                        </div>

                        <Button type="submit" disabled={loading || !value.trim()} className={PRIMARY_BTN_CLS}>
                            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "메일 보내기"}
                        </Button>
                    </form>
                )}

                <p className="text-center text-[14px] text-cur-muted mt-5">
                    <a
                        href="/login"
                        className="font-semibold text-cur-primary hover:underline rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        로그인 화면으로 돌아가기
                    </a>
                </p>
            </div>
        </div>
    )
}
