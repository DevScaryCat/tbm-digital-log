import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    // 1. API 키 확인
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "서버 설정 오류: DEEPGRAM_API_KEY가 없습니다." }, { status: 500 });
    }

    // 2. 파일 데이터 받기
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "파일이 전송되지 않았습니다." }, { status: 400 });
    }

    // 3. 파일을 Buffer로 변환
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 파일 용량 검사: 10MB 제한 (약 20~30분 분량 이상의 녹음 방지, 과도한 API 비용 청구 차단)
    const MAX_FILE_SIZE_MB = 10;
    if (buffer.length > MAX_FILE_SIZE_MB * 1024 * 1024) {
      return NextResponse.json({ 
        error: `녹음 파일 용량이 너무 큽니다 (${MAX_FILE_SIZE_MB}MB 초과). API 비용 과다 청구를 방지하기 위해 20분을 초과하는 녹음은 처리하지 않습니다.` 
      }, { status: 400 });
    }

    // 4. Deepgram API 호출 (Nova-2 모델, 한국어 설정)
    const deepgramUrl = "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=ko";

    const response = await fetch(deepgramUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": file.type || "audio/wav", // 파일 타입 그대로 전달
      },
      body: buffer,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Deepgram Error:", errorText);
      throw new Error(`Deepgram API 오류: ${response.statusText}`);
    }

    const data = await response.json();

    // 5. 결과 추출
    const transcript = data.results?.channels[0]?.alternatives[0]?.transcript;

    if (!transcript) {
      return NextResponse.json({ error: "음성을 인식할 수 없습니다." }, { status: 400 });
    }

    return NextResponse.json({ transcript });
  } catch (error: any) {
    console.error("STT Route Error:", error);
    return NextResponse.json(
      { error: "음성 인식 처리 중 오류가 발생했습니다.", details: error.message },
      { status: 500 },
    );
  }
}
