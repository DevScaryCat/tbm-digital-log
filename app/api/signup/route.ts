import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: "서버 설정 오류 (Supabase)" }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { id, password, siteName } = await request.json();

    if (!id || !password || !siteName) {
      return NextResponse.json({ error: "모든 필드를 입력해주세요." }, { status: 400 });
    }

    if (id.length < 3) {
      return NextResponse.json({ error: "아이디는 3자 이상 입력해주세요." }, { status: 400 });
    }

    if (password.length < 6) {
      return NextResponse.json({ error: "비밀번호는 6자 이상 입력해주세요." }, { status: 400 });
    }

    const fullEmailId = `${id}@tbm.com`;

    // 유저 생성 (Admin API 사용: 가상 이메일이라 이메일 인증을 우회하기 위해 email_confirm=true 처리)
    const { data: user, error: userError } = await supabaseAdmin.auth.admin.createUser({
      email: fullEmailId,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: siteName,
        company_name: siteName,
        role: "user", // 기본 권한
      },
    });

    if (userError) {
      // 이미 가입된 이메일 오류 처리
      if (userError.message.includes("already registered") || userError.status === 422) {
         return NextResponse.json({ error: "이미 존재하는 아이디입니다." }, { status: 400 });
      }
      return NextResponse.json({ error: userError.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, user });
  } catch (error: any) {
    console.error("Signup Error:", error);
    return NextResponse.json({ error: "회원가입 처리 중 서버 오류가 발생했습니다." }, { status: 500 });
  }
}
