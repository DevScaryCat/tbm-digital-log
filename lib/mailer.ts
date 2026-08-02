// lib/mailer.ts — Naver SMTP 기반 메일 발송 (월간 보고서용)
import nodemailer from "nodemailer";

let cached: nodemailer.Transporter | null = null;

/** 메일 발송 설정이 갖춰져 있는지 */
export function mailerConfigured(): boolean {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

function getTransport(): nodemailer.Transporter {
  if (cached) return cached;
  const host = process.env.EMAIL_HOST || "smtp.naver.com";
  const port = Number(process.env.EMAIL_PORT || 465);
  cached = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465=SSL, 587=STARTTLS
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  return cached;
}

export async function sendMail(params: {
  to: string | string[];
  subject: string;
  html: string;
  attachments?: { filename: string; content: string | Buffer; contentType?: string }[];
}): Promise<{ ok: boolean; error?: string }> {
  if (!mailerConfigured()) {
    return { ok: false, error: "메일 설정(EMAIL_USER/EMAIL_PASS)이 없습니다." };
  }
  try {
    const info = await getTransport().sendMail({
      // 발신 표기는 env로 뺀다 — 회사 도메인 메일(Zoho·SES 등)로 갈아끼울 때 코드를 안 고치게.
      // 기본값은 인증 계정 그대로: 대부분의 SMTP는 인증 계정과 다른 From을 거부한다(SPF/DMARC도 마찬가지).
      from: `"${process.env.EMAIL_FROM_NAME || "안톡"}" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
      to: Array.isArray(params.to) ? params.to.join(", ") : params.to,
      subject: params.subject,
      html: params.html,
      attachments: params.attachments,
    });

    // 여기까지 예외가 안 났다고 '보냈다'가 아니다. SMTP는 연결·인증이 멀쩡해도 수신자를
    // 개별로 거절할 수 있고(없는 주소·차단), 그건 info.rejected로만 나온다.
    // 종전엔 이 값을 통째로 버려서, 아무에게도 안 갔는데 발송 완료로 기록되고 있었다.
    const accepted = (info?.accepted ?? []) as unknown[];
    const rejected = (info?.rejected ?? []) as unknown[];
    if (rejected.length > 0) {
      console.error("sendMail rejected:", { rejected, accepted, response: info?.response });
      // 전원 거절 = 발송 실패. 한 명이라도 받았으면 성공으로 두되(재시도가 받은 사람에게
      // 중복 발송이 되므로) 거절자는 로그로 남긴다.
      if (accepted.length === 0) {
        return { ok: false, error: `수신 거부된 주소: ${rejected.join(", ")}` };
      }
    }
    return { ok: true };
  } catch (e: any) {
    console.error("sendMail error:", e);
    return { ok: false, error: e?.message || "메일 발송 실패" };
  }
}
