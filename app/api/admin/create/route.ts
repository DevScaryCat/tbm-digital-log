import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
// @ts-ignore
import nodemailer from "nodemailer";

export async function POST(request: Request) {
  try {
    // ⭐️ [수정] 빌드 타임 에러 방지를 위해 클라이언트 생성을 함수 내부로 이동
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Supabase 환경변수가 설정되지 않았습니다.");
      return NextResponse.json({ error: "Server Configuration Error" }, { status: 500 });
    }

    // 관리자 권한으로 Supabase 접속
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    // Body 데이터 파싱
    const { email, password, name, company } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: "이메일과 비밀번호는 필수입니다." }, { status: 400 });
    }

    // 1. 유저 생성 (Admin API 사용)
    const { data: user, error: userError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // 이메일 인증 자동 완료 처리
      user_metadata: {
        full_name: name,
        company_name: company,
        role: "admin", // 관리자 역할 부여
      },
    });

    if (userError) {
      return NextResponse.json({ error: userError.message }, { status: 400 });
    }

    // 2. 이메일 전송 로직 (Nodemailer)
    // 주의: Vercel 환경변수에 EMAIL_USER, EMAIL_PASS가 설정되어 있어야 합니다.
    const transporter = nodemailer.createTransport({
      service: "gmail", // 또는 사용하는 SMTP 서비스 (예: Naver, Daum 등)
      auth: {
        user: process.env.EMAIL_USER, // 보내는 사람 이메일
        pass: process.env.EMAIL_PASS, // 보내는 사람 이메일 앱 비밀번호
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `[TBM 디지털 일지] ${name}님, 관리자 계정이 생성되었습니다.`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
          <h2 style="color: #ea580c;">TBM 디지털 일지 관리자 계정 안내</h2>
          <p>안녕하세요, <strong>${name}</strong>님 (${company}).</p>
          <p>요청하신 관리자 계정이 성공적으로 생성되었습니다.</p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
          <p><strong>아이디(이메일):</strong> ${email}</p>
          <p><strong>비밀번호:</strong> ${password}</p>
          <p style="color: #666; font-size: 12px; margin-top: 20px;">
            * 보안을 위해 로그인 후 반드시 비밀번호를 변경해 주세요.<br/>
            * 이 메일은 발신 전용입니다.
          </p>
        </div>
      `,
    };

    // 이메일 발송 (실패하더라도 계정 생성은 성공 처리하기 위해 try-catch 내부 사용 가능)
    try {
      if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        await transporter.sendMail(mailOptions);
        console.log("초대 메일 전송 성공:", email);
      } else {
        console.log("이메일 환경변수가 없어 메일 발송을 건너뜁니다.");
      }
    } catch (mailError) {
      console.error("메일 전송 실패:", mailError);
      // 메일 전송 실패는 전체 에러로 처리하지 않고 진행 (클라이언트에 알림만 줄 수도 있음)
    }

    return NextResponse.json({ success: true, user });
  } catch (error: any) {
    console.error("Admin Create Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
