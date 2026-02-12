import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
// @ts-ignore
import nodemailer from "nodemailer";

export async function POST(request: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Supabase 환경변수가 설정되지 않았습니다.");
      return NextResponse.json({ error: "Server Configuration Error" }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { email, password, name, company, managerEmail } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: "이메일과 비밀번호는 필수입니다." }, { status: 400 });
    }

    // 1. 유저 생성 (Admin API)
    const { data: user, error: userError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: name,
        company_name: company,
        role: "admin",
      },
    });

    if (userError) {
      return NextResponse.json({ error: userError.message }, { status: 400 });
    }

    // 2. 이메일 전송 설정 (네이버 SMTP)
    const transporter = nodemailer.createTransport({
      host: "smtp.naver.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    // ⭐️ [수정] 메일 본문에 표시할 '순수 아이디' 추출 (@앞부분만)
    const displayId = email.split("@")[0];

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: managerEmail,
      subject: `[TBM 디지털 일지] ${name}님, 관리자 계정이 생성되었습니다.`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
          <h2 style="color: #03c75a;">TBM 디지털 일지 계정 발급</h2>
          <p>안녕하세요, <strong>${name}</strong>님 (${company}).</p>
          <p>요청하신 현장 관리자 계정이 생성되었습니다.</p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
          
          <p style="font-size: 16px;">
            <strong>아이디:</strong> <span style="color: #333; background-color: #f1f1f1; padding: 2px 6px; border-radius: 4px;">${displayId}</span>
          </p>
          <p style="font-size: 16px;">
            <strong>비밀번호:</strong> <span style="color: #333; background-color: #f1f1f1; padding: 2px 6px; border-radius: 4px;">${password}</span>
          </p>
          
          <p style="color: #666; font-size: 12px; margin-top: 20px;">
            * 위 아이디만 입력하여 로그인하시면 됩니다. (@tbm.com 입력 불필요)<br/>
            * 보안을 위해 로그인 후 비밀번호를 변경해주세요.<br/>
            * 본 메일은 발신 전용입니다.
          </p>
        </div>
      `,
    };

    try {
      if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        await transporter.sendMail(mailOptions);
        console.log(`메일 전송 성공: ${managerEmail}`);
      } else {
        console.log("메일 환경변수 누락으로 전송 건너뜁니다.");
      }
    } catch (mailError) {
      console.error("메일 전송 실패:", mailError);
    }

    return NextResponse.json({ success: true, user });
  } catch (error: any) {
    console.error("Admin Create Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
