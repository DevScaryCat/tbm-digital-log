// app/api/ai/stt/route.ts
import { NextResponse } from "next/server";
import { getUserAndSubscription } from "@/lib/portone";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 30 * 1024 * 1024; // 30MB

export async function POST(request: Request) {
  try {
    const { user, allowed } = await getUserAndSubscription(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    if (!allowed) return NextResponse.json({ error: "구독이 필요합니다." }, { status: 402 });

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

    return NextResponse.json({ transcript });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
