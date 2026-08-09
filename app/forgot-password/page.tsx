// app/forgot-password/page.tsx — 비밀번호 찾기(재설정 링크 요청)
import { RecoveryRequest } from "@/components/RecoveryRequest"

export const metadata = { title: "비밀번호 찾기 · 안톡" }

export default function ForgotPasswordPage() {
    return (
        <RecoveryRequest
            title="비밀번호 찾기"
            subtitle="복구 이메일로 재설정 링크를 보내드려요"
            fieldLabel="아이디"
            fieldPlaceholder="로그인할 때 쓰는 아이디"
            fieldType="text"
            autoComplete="username"
            endpoint="/api/auth/request-reset"
            bodyKey="loginId"
            hint="복구 이메일을 등록·인증해 둔 계정만 링크를 받을 수 있어요. 아이디가 기억나지 않으면 아이디 찾기를 먼저 해주세요."
        />
    )
}
