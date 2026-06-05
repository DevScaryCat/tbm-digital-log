import { NextResponse } from "next/server";
import { getUserAndSubscription } from "@/lib/portone";
import { sendMail, mailerConfigured } from "@/lib/mailer";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RiskItem {
  hazard: string;
  cause: string;
  frequency: number;
  severity: number;
  risk: number;
  level: string;
  measures: string;
  recurring?: boolean;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

function levelColor(level: string): string {
  switch (level) {
    case "매우높음": return "#dc2626";
    case "높음": return "#ea580c";
    case "보통": return "#ca8a04";
    default: return "#16a34a";
  }
}

function buildHtml(items: RiskItem[], meta: { company: string; period: string; date: string }): string {
  const rows = items
    .map(
      (it, i) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;color:#888;">${i + 1}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;">
          ${it.recurring ? `<span style="display:inline-block;font-size:11px;font-weight:700;color:#f54e00;background:#f54e0018;padding:1px 6px;border-radius:4px;margin-right:4px;">반복</span>` : ""}
          <b>${esc(it.hazard)}</b><br/><span style="font-size:12px;color:#888;">${esc(it.cause)}</span>
        </td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;">${it.frequency}×${it.severity}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;"><b style="color:${levelColor(it.level)};">${it.risk} · ${esc(it.level)}</b></td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;">${esc(it.measures)}</td>
      </tr>`
    )
    .join("");
  const recurring = items.filter((it) => it.recurring).length;
  return `
  <div style="max-width:720px;margin:0 auto;font-family:'Apple SD Gothic Neo',Arial,sans-serif;color:#26251e;">
    <div style="background:#f54e00;padding:20px 24px;border-radius:12px 12px 0 0;">
      <div style="color:#fff;font-size:13px;opacity:.9;">안전톡톡e 위험성평가</div>
      <div style="color:#fff;font-size:22px;font-weight:700;margin-top:4px;">${esc(meta.period)}</div>
      ${meta.company ? `<div style="color:#fff;font-size:14px;opacity:.95;margin-top:2px;">${esc(meta.company)}</div>` : ""}
    </div>
    <div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:20px 24px;">
      ${recurring ? `<div style="background:#f54e000d;border:1px solid #f54e0033;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px;color:#c2410c;">⟳ 반복 위험요인 ${recurring}건 — 여러 TBM에서 반복 등장, 우선 관리 대상</div>` : ""}
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="background:#fafaf7;color:#666;font-size:12px;">
            <th style="padding:8px 10px;text-align:center;border-bottom:1px solid #eee;">No</th>
            <th style="padding:8px 10px;text-align:left;border-bottom:1px solid #eee;">유해·위험요인</th>
            <th style="padding:8px 10px;text-align:center;border-bottom:1px solid #eee;">가능성×중대성</th>
            <th style="padding:8px 10px;text-align:center;border-bottom:1px solid #eee;">위험성</th>
            <th style="padding:8px 10px;text-align:left;border-bottom:1px solid #eee;">감소대책</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px;color:#999;margin-top:18px;">첨부된 엑셀(CSV) 파일로 편집·보관하실 수 있습니다. 작성일: ${esc(meta.date)}</p>
    </div>
  </div>`;
}

function buildCsv(items: RiskItem[], meta: { company: string; period: string; date: string }): string {
  const header = ["No", "반복", "유해·위험요인", "발생 원인", "가능성", "중대성", "위험성", "등급", "감소대책"];
  const rows = items.map((it, i) => [i + 1, it.recurring ? "반복" : "", it.hazard, it.cause, it.frequency, it.severity, it.risk, it.level, it.measures]);
  const top = [["위험성평가표"], ["현장/업체", meta.company || "-", "대상기간", meta.period, "작성일", meta.date], [], header, ...rows];
  return "﻿" + top.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "보고서 발송은 Pro 플랜 기능입니다." }, { status: 403 });
  if (!mailerConfigured()) return NextResponse.json({ error: "메일 설정이 없습니다." }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const items: RiskItem[] = Array.isArray(body?.items) ? body.items : [];
  const rawRecipients: string[] = Array.isArray(body?.recipients)
    ? body.recipients.map((e: any) => String(e).trim()).filter(Boolean)
    : [];
  const recipients: string[] = [...new Set(rawRecipients)];
  const period = String(body?.period || "").trim() || "위험성평가";
  const company = String(body?.company || "").trim();
  const date = new Date().toISOString().slice(0, 10);

  if (items.length === 0) return NextResponse.json({ error: "보낼 위험성평가 내용이 없습니다." }, { status: 400 });
  if (recipients.length === 0) return NextResponse.json({ error: "받는 사람 이메일을 입력해주세요." }, { status: 400 });
  const invalid = recipients.find((e) => !EMAIL_RE.test(e));
  if (invalid) return NextResponse.json({ error: `이메일 형식 오류: ${invalid}` }, { status: 400 });

  const meta = { company, period, date };
  const html = buildHtml(items, meta);
  const csv = buildCsv(items, meta);

  const sent = await sendMail({
    to: recipients,
    subject: `[안전톡톡e] ${company ? company + " " : ""}위험성평가 (${period})`,
    html,
    attachments: [{ filename: `위험성평가_${date}.csv`, content: csv, contentType: "text/csv;charset=utf-8" }],
  });
  if (!sent.ok) return NextResponse.json({ error: "메일 발송 실패: " + (sent.error ?? "") }, { status: 502 });

  return NextResponse.json({ success: true, sent: recipients.length });
}
