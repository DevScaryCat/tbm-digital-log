"use client"

// components/ConsentGate.tsx — 전역 약관 동의 게이트.
// 운영 DB의 기존 계정들은 동의 증빙이 남아 있지 않아 소급 동의가 필요하고,
// 약관이 개정되면 같은 화면으로 재동의를 받는다.
import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import type { User } from "@supabase/supabase-js"
// ui/dialog의 DialogContent는 오버레이를 z-50으로 직접 렌더해 바깥에서 못 올린다.
// 오버레이까지 최상단으로 올려야 해서 프리미티브를 직접 조립한다(아래 z-index 주석 참고).
import { Dialog as DialogPrimitive } from "radix-ui"
import { supabase } from "@/lib/supabaseClient"
// 서버 전용 모듈(nodemailer)이 딸려오지 않도록 consent.ts가 아니라 순수 모듈에서 가져온다
import { consentMetaPatch, isConsentCurrent } from "@/lib/consentTerms"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"

// 자체 동의 절차가 있는 화면(가입·로그인)과 약관 본문, 비로그인 외부인용 서명 화면은 건너뛴다
const SKIP_PREFIXES = [
    "/login",
    "/start",
    "/signup",
    "/join",
    "/terms",
    "/privacy",
    "/consent",
    "/sign",
    "/start-trial",
    "/tutorial",
]

// /login의 카카오 동의 다이얼로그가 남기는 마커.
// 그 시점엔 세션이 없어 서버 기록이 불가능하므로, 세션이 잡힌 뒤 이 게이트가 대신 접수한다.
// sessionStorage인 이유: 탭을 닫으면 사라지고, 아래에서 1회 소비 후 즉시 지우므로
// 공용 PC에서 다음 사람이 남의 동의를 물려받지 않는다.
const PENDING_KEY = "antok_pending_consent"

// 스토리지가 차단된 환경(쿠키 전체 차단, opaque origin, DOM storage 꺼진 WebView)에서
// sessionStorage 접근은 SecurityError를 던진다. 이 컴포넌트는 루트 레이아웃에 있어
// 여기서 예외가 나면 앱 전 페이지가 백지가 되므로 전부 감싼다.
function readPending(): boolean {
    if (typeof window === "undefined") return false
    try {
        return window.sessionStorage.getItem(PENDING_KEY) === "1"
    } catch {
        return false
    }
}

function clearPending(): void {
    if (typeof window === "undefined") return
    try {
        window.sessionStorage.removeItem(PENDING_KEY)
    } catch {
        /* 못 지워도 아래 provider 검사가 오소비를 막는다 */
    }
}

export function ConsentGate() {
    const pathname = usePathname()
    const [user, setUser] = useState<User | null>(null)
    const [agreed, setAgreed] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState("")
    // 마커는 첫 렌더에서 읽는다 — effect까지 미루면 모달이 한 프레임 번쩍인다.
    // 서버 렌더에선 false이고 user가 null인 동안 아무것도 그리지 않아 하이드레이션 차이는 없다.
    const [pending, setPending] = useState(readPending)
    // 계정이 실제로 바뀌었는지 판별용 — 아래 리스너 주석 참고
    const lastUserIdRef = useRef<string | null>(null)
    // 자동 기록은 마운트당 1회 — user가 다시 세팅되며 effect가 재실행돼도 중복 POST를 막는다
    const autoRanRef = useRef(false)

    useEffect(() => {
        let alive = true
        supabase.auth.getSession().then(({ data }) => {
            if (!alive) return
            const next = data.session?.user ?? null
            lastUserIdRef.current = next?.id ?? null
            setUser(next)
        })
        const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
            if (!alive) return
            const next = session?.user ?? null
            setUser(next)
            // supabase-js는 탭이 다시 보일 때마다 SIGNED_IN을 재방출한다. 매 이벤트마다 초기화하면
            // 약관을 새 탭에서 읽고 돌아왔을 때 체크가 조용히 풀린다 — 계정이 바뀔 때만 리셋한다.
            const nextId = next?.id ?? null
            if (lastUserIdRef.current !== nextId) {
                lastUserIdRef.current = nextId
                setAgreed(false)
                setError("")
            }
        })
        return () => {
            alive = false
            sub.subscription.unsubscribe()
        }
    }, [])

    // 동의 접수 — 실패하면 throw해서 호출부가 모달/에러로 처리한다
    const saveConsent = useCallback(async () => {
        const { data } = await supabase.auth.getSession()
        const res = await fetch("/api/consent", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${data.session?.access_token ?? ""}`,
            },
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json?.error || "동의 저장에 실패했습니다.")

        // 토큰 안의 user_metadata는 발급 시점 스냅샷이라, 갱신해야 게이트 판정이 통과한다
        const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession()
        if (refreshErr || !refreshed.session) {
            // 서버에는 이미 동의가 기록됐다 — 갱신 실패로 사용자를 계속 막지는 않는다
            setUser((u) => (u ? { ...u, user_metadata: { ...u.user_metadata, ...consentMetaPatch() } } : u))
        } else {
            lastUserIdRef.current = refreshed.session.user.id
            setUser(refreshed.session.user)
        }
    }, [])

    // 로그인 다이얼로그에서 이미 명시적으로 동의한 사람에게 같은 화면을 또 띄우지 않는다.
    // 세션이 잡히는 즉시 그 동의를 서버 원장으로 잇고(모달 없이), 실패하면 그때 모달로 되돌린다.
    useEffect(() => {
        if (!pending || !user || autoRanRef.current) return
        autoRanRef.current = true
        // 1회 소비 — 성공·실패와 무관하게 마커는 여기서 버린다
        clearPending()

        // 마커는 카카오 다이얼로그에서만 심긴다. 그런데 카카오 화면에서 취소하고 같은 탭에서
        // 아이디로 다른 계정에 로그인하면 마커가 그대로 남아, 약관 화면을 본 적 없는 그 계정에
        // 동의가 기록되고 게이트가 영구히 닫힌다 — 세션이 실제 카카오일 때만 소비한다.
        const provider = (user.app_metadata as { provider?: string } | undefined)?.provider
        const viaKakao =
            provider === "kakao" || (user.identities ?? []).some((i) => i.provider === "kakao")
        if (!viaKakao) {
            setPending(false)
            return
        }

        if (isConsentCurrent(user.user_metadata)) {
            setPending(false)
            return
        }
        let alive = true
        saveConsent()
            .catch(() => { /* 기록 실패 — 아래 setPending(false)로 모달이 뜬다 */ })
            .finally(() => {
                if (alive) setPending(false)
            })
        return () => {
            alive = false
        }
    }, [pending, user, saveConsent])

    const skipped = SKIP_PREFIXES.some((p) => (pathname ?? "").startsWith(p))
    const open = !skipped && !pending && !!user && !isConsentCurrent(user.user_metadata)

    const submit = async () => {
        if (!agreed || saving) return
        setSaving(true)
        setError("")
        try {
            await saveConsent()
        } catch (e) {
            setError(e instanceof Error ? e.message : "동의 저장에 실패했습니다.")
        } finally {
            setSaving(false)
        }
    }

    const logout = async () => {
        try {
            await supabase.auth.signOut()
        } finally {
            window.location.href = "/login"
        }
    }

    if (!open) return null

    return (
        <DialogPrimitive.Root open onOpenChange={() => { /* 동의 전에는 닫을 수 없다 — 이탈구는 로그아웃뿐 */ }}>
            <DialogPrimitive.Portal>
                {/* z-index를 z-[200]대로 올리는 이유: 홈의 편입 초대 모달(z-[90], 포털 아님)이
                    기본 z-50 위에 그려지는데, Radix modal이 body의 pointer-events를 꺼서 그 모달은
                    보이기만 하고 눌리지 않는다. 동의를 항상 맨 위에 올려 "동의 먼저, 그다음 다른 모달"
                    순서를 강제한다. */}
                <DialogPrimitive.Overlay className="fixed inset-0 z-[200] bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
                <DialogPrimitive.Content
                    onEscapeKeyDown={(e) => e.preventDefault()}
                    onPointerDownOutside={(e) => e.preventDefault()}
                    onInteractOutside={(e) => e.preventDefault()}
                    className="fixed top-[50%] left-[50%] z-[201] grid w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-[20px] border border-cur-hairline bg-cur-card p-5 shadow-[0_8px_32px_rgba(0,0,0,0.1)] outline-none duration-200 sm:max-w-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
                >
                    <div className="flex flex-col gap-2">
                        <DialogPrimitive.Title className="text-[16px] font-bold text-cur-ink">
                            약관 동의가 필요해요
                        </DialogPrimitive.Title>
                        <DialogPrimitive.Description className="text-[13px] text-cur-muted leading-[1.6]">
                            서비스 이용을 위해 한 번만 확인할게요. 아래 내용에 동의해주세요 — 내용은 새 창에서 볼 수 있습니다.
                        </DialogPrimitive.Description>
                    </div>

                    <div className="flex items-start gap-3 rounded-[8px] border border-cur-hairline bg-cur-elevated p-4">
                        <Checkbox
                            id="consent-gate-agree"
                            checked={agreed}
                            onCheckedChange={(v) => setAgreed(v === true)}
                            disabled={saving}
                            className="mt-0.5 size-[18px] rounded-[4px] border-cur-muted data-[state=checked]:bg-cur-primary data-[state=checked]:text-cur-on-primary focus-visible:ring-2 focus-visible:ring-cur-primary"
                        />
                        <label
                            htmlFor="consent-gate-agree"
                            className="text-[14px] text-cur-body leading-[1.5] cursor-pointer"
                        >
                            <a
                                href="/privacy"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-cur-primary font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[4px]"
                            >
                                개인정보처리방침
                            </a>{" "}
                            및{" "}
                            <a
                                href="/terms"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-cur-primary font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[4px]"
                            >
                                서비스 이용약관
                            </a>
                            에 동의합니다.
                        </label>
                    </div>

                    {error && (
                        <p
                            role="alert"
                            className="text-[13px] text-cur-error rounded-[8px] border border-cur-hairline bg-cur-elevated px-3 py-2"
                        >
                            {error}
                        </p>
                    )}

                    <div className="flex flex-col gap-2">
                        {/* 미체크 상태에서 연주황 배경 + 흰 글씨는 대비 1.3:1이라 문구가 안 읽힌다.
                            배경 없는 톤으로 떨어뜨려 "지금은 못 누른다"와 "무슨 버튼인지"를 둘 다 보이게 한다. */}
                        <Button
                            onClick={submit}
                            disabled={!agreed || saving}
                            className="h-12 w-full rounded-[8px] text-[15px] font-bold bg-cur-primary text-cur-on-primary hover:bg-cur-primary-active focus-visible:ring-2 focus-visible:ring-cur-primary disabled:opacity-100 disabled:bg-cur-elevated disabled:text-cur-muted disabled:border disabled:border-cur-hairline"
                        >
                            {saving ? "저장 중…" : "동의하고 계속하기"}
                        </Button>
                        <button
                            type="button"
                            onClick={logout}
                            disabled={saving}
                            className="h-10 w-full rounded-[8px] text-[13px] text-cur-muted hover:text-cur-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary disabled:opacity-50"
                        >
                            로그아웃
                        </button>
                    </div>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}
