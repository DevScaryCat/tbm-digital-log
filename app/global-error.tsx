"use client"

// 루트 레이아웃까지 전파된 예외용. 자체 <html><body>를 렌더해야 하며, 전역 CSS가
// 적용되지 않을 수 있어 인라인 스타일로 자립적으로 구성한다.
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    return (
        <html lang="ko">
            <body
                style={{
                    margin: 0,
                    fontFamily: "system-ui, -apple-system, 'Apple SD Gothic Neo', sans-serif",
                    background: "#f4f3ee",
                    minHeight: "100vh",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 24,
                }}
            >
                <div
                    style={{
                        maxWidth: 360,
                        width: "100%",
                        background: "#fff",
                        border: "1px solid #e6e5e0",
                        borderRadius: 16,
                        padding: 32,
                        textAlign: "center",
                    }}
                >
                    <div style={{ fontSize: 40 }}>⚠️</div>
                    <h1 style={{ margin: "16px 0 0", fontSize: 18, fontWeight: 700, color: "#26251e" }}>
                        문제가 발생했어요
                    </h1>
                    <p style={{ margin: "8px 0 0", fontSize: 14, color: "#807d72", lineHeight: 1.6 }}>
                        일시적인 오류일 수 있습니다.
                        <br />다시 시도해 주세요.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 24 }}>
                        <button
                            onClick={() => reset()}
                            style={{
                                height: 48,
                                borderRadius: 10,
                                border: "none",
                                background: "#f54e00",
                                color: "#fff",
                                fontSize: 15,
                                fontWeight: 700,
                                cursor: "pointer",
                            }}
                        >
                            다시 시도
                        </button>
                        <a
                            href="/"
                            style={{
                                height: 48,
                                borderRadius: 10,
                                border: "1px solid #e6e5e0",
                                color: "#26251e",
                                fontSize: 14,
                                fontWeight: 600,
                                background: "#fff",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                textDecoration: "none",
                            }}
                        >
                            홈으로
                        </a>
                    </div>
                </div>
            </body>
        </html>
    )
}
