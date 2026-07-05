// lib/reportXlsx.ts — 서식 있는 엑셀(.xlsx) 첨부 생성 (exceljs)
// CSV(원시 row)는 받는 사람이 열면 컬럼이 눌리고 "######"로 깨져 보기 불편 →
// 컬럼 너비·굵은 헤더·테두리·위험등급 색상을 넣은 진짜 엑셀로 만든다.
// exceljs는 Node 전용·무겁기 때문에 첨부 빌더에서 동적 import로만 로드한다.
import ExcelJS from "exceljs";

const INK = "FF26251E";
const MUTED = "FF807D72";
const HEAD_BG = "FFF4F3EE";

const BORDER = {
  top: { style: "thin" as const, color: { argb: "FFD9D7CF" } },
  left: { style: "thin" as const, color: { argb: "FFD9D7CF" } },
  bottom: { style: "thin" as const, color: { argb: "FFD9D7CF" } },
  right: { style: "thin" as const, color: { argb: "FFD9D7CF" } },
};

function levelFill(level: string): string {
  if (["매우높음", "상", "높음"].includes(level)) return "FFFDECEF"; // 빨강 계열
  if (["보통", "중"].includes(level)) return "FFFFF1E3"; // 주황 계열
  return "FFE7F6EE"; // 초록 계열
}

function styleTitle(cell: ExcelJS.Cell, text: string) {
  cell.value = text;
  cell.font = { bold: true, size: 15, color: { argb: INK } };
  cell.alignment = { vertical: "middle", horizontal: "left" };
}
function styleMeta(cell: ExcelJS.Cell, text: string) {
  cell.value = text;
  cell.font = { size: 10, color: { argb: MUTED } };
  cell.alignment = { vertical: "middle", horizontal: "left" };
}
function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell((c) => {
    c.font = { bold: true, size: 10, color: { argb: INK } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_BG } };
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    c.border = BORDER;
  });
  row.height = 24;
}

type RiskRow = {
  hazard: string; cause: string; frequency: number; severity: number;
  risk: number; level: string; measures: string; recurring?: boolean;
};

/** 위험성평가표 → 서식 엑셀 Buffer */
export async function buildRiskXlsx(
  items: RiskRow[],
  meta: { company: string; period: string; date: string }
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "안전톡톡e";
  const ws = wb.addWorksheet("위험성평가표", {
    views: [{ state: "frozen", ySplit: 4 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [
    { width: 5 }, { width: 6 }, { width: 30 }, { width: 30 },
    { width: 8 }, { width: 8 }, { width: 8 }, { width: 10 }, { width: 44 },
  ];

  ws.mergeCells("A1:I1");
  styleTitle(ws.getCell("A1"), "위험성평가표");
  ws.getRow(1).height = 26;

  ws.mergeCells("A2:I2");
  styleMeta(ws.getCell("A2"), `현장/업체: ${meta.company || "-"}     대상기간: ${meta.period}     작성일: ${meta.date}`);

  ws.addRow([]); // row 3 여백

  const header = ["No", "반복", "유해·위험요인", "발생 원인", "가능성", "중대성", "위험성", "등급", "감소대책"];
  styleHeaderRow(ws.addRow(header)); // row 4

  items.forEach((it, i) => {
    const r = ws.addRow([
      i + 1, it.recurring ? "반복" : "", it.hazard, it.cause,
      it.frequency, it.severity, it.risk, it.level, it.measures,
    ]);
    r.eachCell((c) => {
      c.border = BORDER;
      c.alignment = { vertical: "middle", wrapText: true };
      c.font = { size: 10, color: { argb: INK } };
    });
    [1, 2, 5, 6, 7, 8].forEach((col) => {
      r.getCell(col).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    });
    const lv = r.getCell(8);
    lv.fill = { type: "pattern", pattern: "solid", fgColor: { argb: levelFill(it.level) } };
    lv.font = { size: 10, bold: true, color: { argb: INK } };
  });

  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}

type EduContent = {
  companyName: string | null;
  periodLabel: string;
  stats: { sessions: number; days: number; headcount: number; avg: string };
  types?: { type: string; count: number }[];
  days: { date: string; sessions: number; summary: string }[];
};

/** 안전보건교육일지 종합 → 서식 엑셀 Buffer */
export async function buildEducationXlsx(content: EduContent): Promise<Buffer> {
  const { stats, types = [], days } = content;
  const wb = new ExcelJS.Workbook();
  wb.creator = "안전톡톡e";
  const ws = wb.addWorksheet("안전보건교육일지 종합", {
    views: [{ state: "frozen", ySplit: 6 }],
    pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [{ width: 16 }, { width: 12 }, { width: 72 }];

  ws.mergeCells("A1:C1");
  styleTitle(ws.getCell("A1"), "안전보건교육일지 종합");
  ws.getRow(1).height = 26;

  ws.mergeCells("A2:C2");
  styleMeta(ws.getCell("A2"), `현장/업체: ${content.companyName || "-"}     대상기간: ${content.periodLabel}`);

  ws.mergeCells("A3:C3");
  styleMeta(ws.getCell("A3"), `교육 횟수 ${stats.sessions}회 · 교육 일수 ${stats.days}일 · 연인원 ${stats.headcount}명 · 평균 ${stats.avg}명/회`);

  ws.mergeCells("A4:C4");
  styleMeta(ws.getCell("A4"), `교육 유형: ${types.map((t) => `${t.type} ${t.count}회`).join(" / ") || "-"}`);

  ws.addRow([]); // row 5 여백

  styleHeaderRow(ws.addRow(["날짜", "교육 횟수", "교육 핵심 요약"])); // row 6

  days.forEach((d) => {
    const r = ws.addRow([d.date, `${d.sessions}회`, d.summary || `교육 ${d.sessions}회 실시`]);
    r.eachCell((c) => {
      c.border = BORDER;
      c.alignment = { vertical: "middle", wrapText: true };
      c.font = { size: 10, color: { argb: INK } };
    });
    r.getCell(1).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    r.getCell(1).font = { size: 10, bold: true, color: { argb: INK } };
    r.getCell(2).alignment = { vertical: "middle", horizontal: "center" };
  });

  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}
