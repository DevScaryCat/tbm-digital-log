// lib/authStyles.ts — 로그인 계열 화면의 공통 클래스 (app/login/page.tsx와 같은 값)
// 계정 복구 화면 3종이 로그인과 한 몸처럼 보여야 해서 색·폰트·치수를 새로 만들지 않고 여기서 공유한다.
// 값은 DESIGN.md의 cur-* 토큰만 쓴다.

export const FIELD_CLS =
    "h-12 rounded-[8px] bg-cur-elevated border-cur-hairline text-[16px] md:text-[16px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus-visible:ring-1 focus-visible:ring-cur-primary"

export const CARD_CLS = "bg-cur-card border border-cur-hairline rounded-[12px] p-5 space-y-4"

export const BTN_CLS =
    "w-full h-12 text-[15px] font-bold rounded-[8px] transition-transform active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-cur-primary"

export const PRIMARY_BTN_CLS = `${BTN_CLS} bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary disabled:opacity-40`
