// app/api/admin/create/route.ts
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

// 관리자 권한으로 Supabase 접속 (Service Role Key 사용)
const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  try {
    // 🔒 [보안] 헤더에서 마스터 키 확인
    // 클라이언트에서 보낸 'x-admin-secret-key'와 환경변수 'ADMIN_SECRET_KEY'가 일치하는지 검사
    const adminKey = request.headers.get("x-admin-secret-key");

    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return NextResponse.json({ error: "관리자 권한이 없습니다. (비밀번호 불일치)" }, { status: 401 });
    }

    // 요청 본문에서 데이터 추출
    const { siteName, managerEmail, desiredId } = await request.json();

    // 1. 랜덤 비밀번호 생성 (6자리 숫자)
    const randomPassword = Math.floor(100000 + Math.random() * 900000).toString();

    // 2. Supabase용 가상 이메일 생성 (아이디@tbm.com)
    const fakeEmail = `${desiredId}@tbm.com`;

    // 3. Supabase 계정 생성
    const { data: user, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: fakeEmail,
      password: randomPassword,
      email_confirm: true, // 이메일 인증 건너뛰기
      user_metadata: {
        full_name: siteName, // 현장명을 Display Name으로 저장
        company_name: siteName,
      },
    });

    if (createError) {
      // 이미 존재하는 아이디 등 에러 처리
      return NextResponse.json({ error: createError.message }, { status: 400 });
    }

    // 4. 네이버 메일 발송 설정 (SMTP)
    const transporter = nodemailer.createTransport({
      host: "smtp.naver.com", // 네이버 SMTP 서버
      port: 465, // SSL 포트
      secure: true, // SSL 사용
      auth: {
        user: process.env.EMAIL_USER, // .env.local의 네이버 아이디
        pass: process.env.EMAIL_PASS, // .env.local의 네이버 비번 (또는 앱 비번)
      },
    });

    // 이메일 전송
    await transporter.sendMail({
      from: `"TBM 관리자" <${process.env.EMAIL_USER}>`, // 보내는 사람 (네이버 아이디와 일치해야 함)
      to: managerEmail, // 받는 사람 (담당자 이메일)
      subject: `[TBM] ${siteName} 현장 계정 발급 안내`,
      html: `
        <div style="padding: 20px; border: 1px solid #ddd; border-radius: 10px; font-family: 'Malgun Gothic', sans-serif;">
          <h2 style="color: #03C75A;">✅ TBM 디지털 일지 계정 발급</h2>
          <p>안녕하세요, <strong>${siteName}</strong> 안전관리자님.</p>
          <p>요청하신 현장용 계정이 생성되었습니다.</p>
          <hr style="border: 0; border-top: 1px solid #eee;" />
          <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px;">
            <p style="margin: 5px 0;"><strong>🆔 아이디:</strong> <span style="font-size: 18px; font-weight: bold; color: #333;">${desiredId}</span></p>
            <p style="margin: 5px 0;"><strong>🔒 비밀번호:</strong> <span style="font-size: 18px; font-weight: bold; color: #333;">${randomPassword}</span></p>
          </div>
          <hr style="border: 0; border-top: 1px solid #eee;" />
          <p style="color: #888; font-size: 12px;">앱에 접속하여 위 정보로 로그인해주세요.</p>
        </div>
      `,
    });

    console.log(`>>> 네이버 메일 발송 성공: To ${managerEmail}`);

    // 성공 응답 반환
    return NextResponse.json({ success: true, userId: desiredId, password: randomPassword });
  } catch (error: any) {
    console.error("에러 발생:", error);
    return NextResponse.json({ error: error.message || "서버 에러 발생" }, { status: 500 });
  }
}
