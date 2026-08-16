// app/api/ai/stt/route.ts
import { NextResponse } from "next/server";
import { getUserAndSubscription, getAdminClient } from "@/lib/portone";
import { checkAndRecordAiUsage, AI_LIMIT_MESSAGE } from "@/lib/aiUsage";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 30 * 1024 * 1024; // 30MB

// 계정당 월 전사 한도(초). 비용 폭주 방어선 — 넘으면 전사를 거절하고 클라이언트는
// 브라우저 실시간 인식본으로 조용히 폴백한다(문서 작성 자체는 계속 가능).
// 900분 ≈ 매일 30분씩 한 달. 정상 사용은 닿지 않는다.
const MONTHLY_SECONDS_CAP = 900 * 60;

/** 이번 달(KST) 누적 전사 초 */
async function monthlySeconds(admin: ReturnType<typeof getAdminClient>, userId: string): Promise<number> {
  const kstNow = new Date(Date.now() + 9 * 3600_000);
  const startISO = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), 1) - 9 * 3600_000).toISOString();
  const { data } = await admin
    .from("stt_usage")
    .select("seconds")
    .eq("user_id", userId)
    .gte("created_at", startISO);
  return (data ?? []).reduce((sum, r: { seconds: number | string }) => sum + Number(r.seconds || 0), 0);
}

export async function POST(request: Request) {
  try {
    const { user, allowed } = await getUserAndSubscription(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    if (!allowed) return NextResponse.json({ error: "구독이 필요합니다." }, { status: 402 });
    // 남용 방어(비용 보호): KST 일일 한도 — 정상 사용은 닿지 않는 상한
    if (!(await checkAndRecordAiUsage(user.id, "stt"))) {
      return NextResponse.json({ error: AI_LIMIT_MESSAGE }, { status: 429 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "파일이 없습니다." }, { status: 400 });
    }
    if (typeof file.type === "string" && file.type && !file.type.startsWith("audio/")) {
      return NextResponse.json({ error: "오디오 파일만 업로드할 수 있습니다." }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "파일이 너무 큽니다 (최대 30MB)." }, { status: 413 });
    }

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Deepgram API key가 설정되지 않았습니다." }, { status: 500 });
    }

    const admin = getAdminClient();
    if ((await monthlySeconds(admin, user.id)) >= MONTHLY_SECONDS_CAP) {
      return NextResponse.json(
        { error: "이번 달 정밀 전사 한도를 초과했습니다.", capped: true },
        { status: 429 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // ⚠️ mip_opt_out=true 는 지우지 말 것 (2026-08-12).
    //    Deepgram에는 Model Improvement Partnership이라는 학습 데이터 프로그램이 있고,
    //    이 파라미터를 붙이지 않으면 요청한 음성이 향후 모델 학습에 쓰일 수 있다. 옵트아웃하면
    //    "요청 처리에 필요한 기간 동안만" 보관된다(Deepgram 문서).
    //    우리가 다루는 것은 **현장 근로자들의 목소리**다. 그 사람들은 안톡에 가입한 적도,
    //    동의한 적도 없다(TBM 참석자는 QR로 서명만 한다). 감독자의 약관 동의로는 남의 음성을
    //    제3자 학습에 제공할 근거가 되지 못한다. 개인정보처리방침 제5조에 "변환 직후 폐기"라고
    //    적어 둔 문장이 참이 되려면 이 한 줄이 반드시 있어야 한다.
    const response = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&language=ko&smart_format=true&mip_opt_out=true", {
      method: "POST",
      headers: {
        "Authorization": `Token ${apiKey}`,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: buffer,
    });

    if (!response.ok) {
      const errorText = await response.text();
      // ⚠️ Deepgram의 상태 코드를 그대로 릴레이하지 않는다(2026-08-14 검수).
      // 클라이언트는 이 라우트의 402=구독, 429=우리 한도로 번역한다 — Deepgram 크레딧이
      // 바닥나면(402) 정상 구독자 전원이 "구독이 필요해요"를, Deepgram 레이트리밋(429)이면
      // "한도를 다 썼어요"를 보게 된다. 우리 쪽 문제가 아닌 실패는 전부 502(서버 오류)로:
      // 클라이언트가 'network/재시도 가능'으로 분류해 거짓 막다른 길이 생기지 않는다.
      console.error("Deepgram error:", response.status, errorText.slice(0, 500));
      return NextResponse.json({ error: "음성 변환 서버 오류 — 잠시 후 다시 시도해주세요." }, { status: 502 });
    }

    const data = await response.json();
    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    // 실제 과금 단위(오디오 길이)를 남긴다 — 한 달 뒤 요금 판단을 추정이 아니라 실측으로 하기 위해.
    // 기록 실패가 전사를 막지는 않는다.
    const seconds = Number(data.metadata?.duration ?? 0);
    if (seconds > 0) {
      const source = (formData.get("source") as string | null) === "app" ? "app" : "web";
      await admin.from("stt_usage").insert({ user_id: user.id, seconds, source });
    }

    return NextResponse.json({ transcript, seconds });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
