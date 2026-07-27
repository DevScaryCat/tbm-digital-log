// app/verify-email/[token]/page.tsx — 이메일 인증 확정 페이지 (무로그인 접근 가능)
import { getAdminClient } from "@/lib/portone";
import { verifyRealEmailToken } from "@/lib/emailVerification";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = getAdminClient();
  const r = await verifyRealEmailToken(admin, token);

  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-cur-canvas">
      <div className="w-full max-w-sm bg-cur-card border border-cur-hairline rounded-2xl p-8 text-center space-y-4">
        {r.ok ? (
          <>
            <div className="text-[40px]">✅</div>
            <h1 className="text-[18px] font-bold text-cur-ink">이메일 인증 완료</h1>
            <p className="text-[14px] text-cur-muted leading-relaxed">
              <b>{r.email}</b> 인증이 완료됐어요.
              <br />
              매달 1일 이 주소로 월간 보고서가 발송됩니다.
            </p>
            <p className="text-[12px] text-cur-muted-soft leading-relaxed">
              열어둔 안톡 화면으로 돌아가면 인증이 자동으로 반영돼요.
            </p>
          </>
        ) : (
          <>
            <div className="text-[40px]">⚠️</div>
            <h1 className="text-[18px] font-bold text-cur-ink">인증에 실패했어요</h1>
            <p className="text-[14px] text-cur-muted leading-relaxed">{r.error}</p>
          </>
        )}
        <Link
          href="/"
          className="inline-block w-full h-11 leading-[44px] rounded-xl bg-cur-ink text-white text-[14px] font-bold"
        >
          안톡으로 이동
        </Link>
      </div>
    </main>
  );
}
