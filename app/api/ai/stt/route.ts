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

    const response = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&language=ko&smart_format=true", {
      method: "POST",
      headers: {
        "Authorization": `Token ${apiKey}`,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: buffer,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({ error: `Deepgram API 오류: ${errorText}` }, { status: response.status });
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
