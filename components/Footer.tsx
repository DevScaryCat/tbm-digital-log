"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export function Footer() {
  // 로그인된 홈("/")은 하단 탭바가 있는 앱 셸이다 — 법정 푸터가 탭바 뒤에 반쯤 가려져
  // 깨진 것처럼 보이므로 여기서는 숨긴다. 랜딩(비로그인 "/")·요금제·약관 등
  // 공개 페이지에는 그대로 노출된다 (전자상거래법 표시 의무는 공개 화면에서 이행).
  const pathname = usePathname();
  const [hasSession, setHasSession] = useState(false);
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setHasSession(!!data?.session);
    });
    const { data: subscr } = supabase.auth.onAuthStateChange((_e, session) => {
      if (active) setHasSession(!!session);
    });
    return () => { active = false; subscr.subscription.unsubscribe(); };
  }, []);
  if (pathname === "/" && hasSession) return null;

  return (
    <footer className="w-full text-center py-12 px-4 text-[13px] text-cur-muted bg-cur-canvas border-t border-cur-hairline font-sans print:hidden">
      <div className="max-w-2xl mx-auto flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-center gap-3 font-semibold text-cur-ink">
          <Link href="/terms" className="hover:underline">이용약관 및 환불정책</Link>
          <span className="w-1 h-1 bg-cur-hairline rounded-full" />
          <Link href="/privacy" className="hover:underline">개인정보처리방침</Link>
          <span className="w-1 h-1 bg-cur-hairline rounded-full" />
          <Link href="/pricing" className="hover:underline">요금안내</Link>
        </div>

        {/* 운영·개발 주체 크레딧 — 아래 통신판매업자(법정) 표기와 분리해 소비자 혼동을 막는다.
            판매·결제 당사자는 비트플립이고, 서비스 운영·고객대응은 이에이치에스프렌즈가 위탁 수행한다. */}
        <p className="mt-2 text-cur-body">
          안톡 &nbsp;·&nbsp; 운영: 주식회사 이에이치에스프렌즈 &nbsp;·&nbsp; 개발·결제: 비트플립(Bitflip.)
        </p>

        <p className="text-cur-muted-soft leading-relaxed">
          고객센터: 032-229-1556 <span className="text-cur-muted-soft">(운영사)</span> | 이메일: support@bitflip.team
        </p>

        {/* 전자상거래법상 통신판매업자 표기 — PG 가맹점 등록 정보와 동일하게 유지할 것
            (KG이니시스·카카오페이는 사이트 하단 표기와 가맹점 신청 정보가 일치해야 심사를 통과시킨다) */}
        <div className="text-cur-muted-soft leading-relaxed mt-1">
          <p>통신판매업자(판매·결제): 비트플립(Bitflip.) | 대표자: 문경민</p>
          <p>사업자등록번호: 493-40-01338 | 통신판매업신고번호: 2026-고양덕양구-1574</p>
          <p>사업장 소재지: 경기도 고양시 덕양구 꽃마을로 46, 13층 1313호 (향동동)</p>
          {/* 호스팅서비스 제공자 상호는 법정 표시사항 —
              전자상거래법 제10조①6호 → 시행령 제11조의4 → 시행규칙 제7조① */}
          <p>호스팅서비스 제공자: Vercel Inc.</p>
        </div>

        <div className="mt-4 text-[12px]">
          © {new Date().getFullYear()} EHS Friends (안톡). All rights reserved.
        </div>
      </div>
    </footer>
  );
}
