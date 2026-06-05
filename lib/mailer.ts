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
    await getTransport().sendMail({
      from: `"안전톡톡e" <${process.env.EMAIL_USER}>`,
      to: Array.isArray(params.to) ? params.to.join(", ") : params.to,
      subject: params.subject,
      html: params.html,
      attachments: params.attachments,
    });
    return { ok: true };
  } catch (e: any) {
    console.error("sendMail error:", e);
    return { ok: false, error: e?.message || "메일 발송 실패" };
  }
}
