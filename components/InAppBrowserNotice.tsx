"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { X, ExternalLink } from "lucide-react"

// 카카오톡·네이버 등 '인앱 브라우저'는 앱을 닫으면 저장소(로그인 정보)를 지워서
// 매번 다시 로그인해야 한다. 외부 브라우저(Safari/Chrome)로 유도해 로그인 유지되게 한다.
const IN_APP_RE = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|FB_IAB|Line\/|DaumApps|; wv\)|Snapchat|kakaostory|zumapp|everytimeApp|Whale/i

export function InAppBrowserNotice() {
    const [show, setShow] = useState(false)
    const [isKakao, setIsKakao] = useState(false)
    const [isAndroid, setIsAndroid] = useState(false)

    useEffect(() => {
        const ua = navigator.userAgent || ""
        if (IN_APP_RE.test(ua)) {
            setShow(true)
            setIsKakao(/KAKAOTALK/i.test(ua))
            setIsAndroid(/Android/i.test(ua))
        }
    }, [])

    if (!show) return null

    const copyUrl = async () => {
        try {
            await navigator.clipboard.writeText(window.location.href)
            alert("주소를 복사했어요.\nSafari 또는 Chrome 주소창에 붙여넣어 열어주세요.")
        } catch {
            alert("우측 상단(⋮) 메뉴에서 'Safari/Chrome으로 열기'를 눌러주세요.")
        }
    }

    const openExternal = () => {
        const url = window.location.href
        if (isKakao) {
            // 카카오톡: 외부 브라우저로 바로 열기 (딥링크)
            window.location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(url)
            return
        }
        if (isAndroid) {
            // 안드로이드: 크롬으로 열기 시도
            const clean = url.replace(/^https?:\/\//, "")
            window.location.href = `intent://${clean}#Intent;scheme=https;package=com.android.chrome;end`
            return
        }
        // iOS(카톡 외) 등: 주소 복사로 안내
        copyUrl()
    }

    return (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 font-sans">
            <div className="bg-cur-card rounded-2xl p-6 max-w-sm w-full space-y-4 relative animate-in slide-in-from-bottom-4 duration-300">
                <button onClick={() => setShow(false)} className="absolute top-4 right-4 text-cur-muted hover:text-cur-ink" aria-label="닫기">
                    <X className="w-5 h-5" />
                </button>
                <div className="text-3xl">🌐</div>
                <h2 className="text-[18px] font-bold text-cur-ink">외부 브라우저로 열어주세요</h2>
                <p className="text-[14px] text-cur-body leading-relaxed">
                    카카오톡·네이버 등 <b>앱 안에서 열린 브라우저</b>는 닫으면 로그인이 지워져 매번 다시 로그인해야 해요.
                    <br />
                    <b className="text-cur-primary">Safari·Chrome</b>에서 열면 <b>한 번만 로그인</b>하면 계속 유지됩니다.
                </p>
                <Button onClick={openExternal} className="w-full h-12 bg-cur-primary text-cur-on-primary font-bold rounded-xl">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    {isKakao ? "외부 브라우저로 열기" : isAndroid ? "Chrome으로 열기" : "주소 복사하기"}
                </Button>
                <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed">
                    안 되면 우측 상단(⋮·공유) 메뉴 →<br />“Safari/Chrome으로 열기”를 눌러주세요.
                </p>
            </div>
        </div>
    )
}
