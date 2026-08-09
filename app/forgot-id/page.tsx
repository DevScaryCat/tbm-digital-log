// app/forgot-id/page.tsx — 아이디 찾기
import { RecoveryRequest } from "@/components/RecoveryRequest"

export const metadata = { title: "아이디 찾기 · 안톡" }

export default function ForgotIdPage() {
    return (
        <RecoveryRequest
            title="아이디 찾기"
            subtitle="복구 이메일로 아이디를 보내드려요"
            fieldLabel="복구 이메일"
            fieldPlaceholder="가입할 때 인증한 이메일"
            fieldType="email"
            autoComplete="email"
            endpoint="/api/auth/find-id"
            bodyKey="email"
            hint="안톡에 등록하고 인증까지 마친 이메일 주소만 받을 수 있어요."
        />
    )
}
