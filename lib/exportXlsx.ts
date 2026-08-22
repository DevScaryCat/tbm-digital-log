// lib/exportXlsx.ts
// TBM 회의록 / 안전보건교육일지 → 서식 있는 .xlsx 빌더 (브라우저 우선, 텍스트 경로는 Node 겸용)
// - MinutesView / ReportView의 표 구조·항목·강조를 exceljs 셀 병합으로 재현 (exportDocx/exportHwpx와 동일 문서 구성)
// - 문서 1건 = 시트 1장. 일괄 내보내기는 건수만큼 시트가 늘어난다.
// - 서명/사진은 exportDocx의 loadImage를 재사용 — 실패 집계도 동일해서 호출부 UX가 갈라지지 않는다.
// - exceljs는 무겁기 때문에 이 모듈 자체를 호출부에서 `await import("@/lib/exportXlsx")`로
//   동적 로드하는 것을 전제로 한다(정적 재노출·사이드이펙트 없음 → 코드 스플리팅 안전).
import ExcelJS from "exceljs"
import { TRANSCRIPT_VISIBLE } from "./reportFlags"
import {
    loadImage,
    type EducationDocItem,
    type ImageLoadStats,
    type LoadedImage,
    type MinutesDocItem,
} from "./exportDocx"

// ---------------- 공통 상수 ----------------

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const FONT = "맑은 고딕"

// 뷰(Tailwind)에서 쓰는 색 — exportDocx의 C와 동일 (exceljs는 ARGB 8자리)
const C = {
    navy: "FF0B285B", // bg-[#0b285b] 제목 밴드
    white: "FFFFFFFF",
    red: "FFDC2626", // text-red-600 위험성 등급
    blue: "FF1E3A8A", // text-blue-900 안전구호
    gray500: "FF6B7280",
    gray50: "FFF9FAFB",
    gray100: "FFF3F4F6",
    gray200: "FFE5E7EB",
    gray300: "FFD1D5DB",
    orange50: "FFFFF7ED", // bg-orange-50/50 위험성평가 섹션 띠
    black: "FF000000",
}

const THIN: ExcelJS.Border = { style: "thin", color: { argb: C.black } }
const BOX: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN }

// ---------------- 값/셀 헬퍼 ----------------

/** null 안전 문자열화 + 수식 오인 방지("="로 시작하면 앞에 공백 1칸) — 이스케이프 자체는 exceljs가 처리 */
function safeText(v: unknown): string {
    const s = v == null ? "" : String(v)
    return s.startsWith("=") ? ` ${s}` : s
}

interface CellStyle {
    bold?: boolean
    /** ARGB 8자리 (기본 검정) */
    color?: string
    /** ARGB 8자리 배경 */
    fill?: string
    /** pt (기본 10) */
    size?: number
    align?: "left" | "center"
    valign?: "top" | "middle"
    /** 표 밖 제목·메타 행 등 테두리 없는 셀 */
    noBorder?: boolean
}

function styleCell(cell: ExcelJS.Cell, v: string, s: CellStyle): void {
    cell.value = v
    cell.font = { name: FONT, size: s.size ?? 10, bold: s.bold ?? false, color: { argb: s.color ?? C.black } }
    cell.alignment = {
        vertical: s.valign === "top" ? "top" : "middle",
        horizontal: s.align ?? "left",
        wrapText: true, // 줄바꿈 포함 텍스트가 잘리지 않도록 전 셀 wrap
    }
    if (s.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: s.fill } }
    if (!s.noBorder) cell.border = BOX
}

/** (r1,c1)~(r2,c2) 병합 + 범위 전체 테두리 + 마스터 셀 서식 */
function mergeBox(
    ws: ExcelJS.Worksheet,
    r1: number, c1: number, r2: number, c2: number,
    v: unknown, s: CellStyle = {}
): void {
    ws.mergeCells(r1, c1, r2, c2)
    if (!s.noBorder) {
        // 병합 범위의 바깥 윤곽선은 내부 셀들의 border에서 그려진다 — 전 셀에 적용
        for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = BOX
        }
    }
    styleCell(ws.getCell(r1, c1), safeText(v), s)
}

interface RowCell extends CellStyle {
    v?: unknown
    /** 가로 병합 칸수 (기본 1) */
    span?: number
}

/** 한 행을 왼쪽부터 채운다. startCol은 세로 병합(rowSpan)이 차지한 열을 건너뛸 때 사용 */
function putRow(ws: ExcelJS.Worksheet, r: number, cells: RowCell[], height?: number, startCol = 1): void {
    let c = startCol
    for (const spec of cells) {
        const span = spec.span ?? 1
        if (span > 1) {
            mergeBox(ws, r, c, r, c + span - 1, spec.v, spec)
        } else {
            styleCell(ws.getCell(r, c), safeText(spec.v), spec)
        }
        c += span
    }
    if (height) ws.getRow(r).height = height
}

// ---------------- 이미지 배치 ----------------

/**
 * loadImage 결과를 (r,c) 셀 위에 비율 유지로 얹는다.
 * exceljs의 Image.buffer 타입은 자체 선언 `interface Buffer extends ArrayBuffer`라서
 * (Node Buffer가 아님) loadImage의 ArrayBuffer를 캐스팅 없이 그대로 넘기면 된다.
 */
function placeImage(
    wb: ExcelJS.Workbook,
    ws: ExcelJS.Worksheet,
    img: LoadedImage,
    r: number, c: number,
    maxW: number, maxH: number,
    colInset = 0.2
): void {
    const scale = Math.min(maxW / img.width, maxH / img.height)
    const id = wb.addImage({
        buffer: img.data,
        extension: img.type === "jpg" ? "jpeg" : "png",
    })
    ws.addImage(id, {
        tl: { col: c - 1 + colInset, row: r - 1 + 0.1 }, // 앵커는 0-기반 + 소수 오프셋
        ext: {
            width: Math.max(1, Math.round(img.width * scale)),
            height: Math.max(1, Math.round(img.height * scale)),
        },
        editAs: "oneCell",
    })
}

// ---------------- 페이지/시트 공통 ----------------

/** A4 세로 + 가로 1페이지 맞춤 + 여백. company가 있으면 인쇄 푸터에 현장명(ReportView 푸터 재현) */
function setupPage(ws: ExcelJS.Worksheet, company?: string | null): void {
    ws.pageSetup = {
        paperSize: 9, // A4
        orientation: "portrait",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0, // 세로는 내용만큼 여러 페이지
        horizontalCentered: true,
        margins: { left: 0.35, right: 0.35, top: 0.55, bottom: 0.55, header: 0.2, footer: 0.25 },
    }
    if (company) {
        // 헤더/푸터 문자열에서 &는 예약문자 — 이중으로 이스케이프
        const f = `&C&"${FONT},Bold"${company.replace(/&/g, "&&")}`
        ws.headerFooter.oddFooter = f
        ws.headerFooter.evenFooter = f
    }
}

/**
 * 시트명: "MM-DD 회의록"/"MM-DD 교육일지", 중복이면 " (2)"부터 붙인다.
 * 엑셀 제약(31자, \ / ? * [ ] : 금지)도 여기서 처리.
 */
function sheetName(kind: "minutes" | "education", date: string | null | undefined, used: Map<string, number>): string {
    const label = kind === "minutes" ? "회의록" : "교육일지"
    const m = /^\d{4}-(\d{2}-\d{2})/.exec(date ?? "")
    const base = (m ? `${m[1]} ${label}` : label).replace(/[\\/?*[\]:]/g, "-")
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    if (n === 1) return base.slice(0, 31)
    const suffix = ` (${n})`
    return base.slice(0, 31 - suffix.length) + suffix
}

function dateKo(date?: string | null): string {
    if (!date) return "년 월 일"
    const [y, m, d] = date.split("-")
    return `${y}년 ${m}월 ${d}일`
}

function timeRange(start?: string | null, end?: string | null): string {
    return `${start?.slice(0, 5) || ""} ~ ${end?.slice(0, 5) || ""}`
}

// ---------------- 음성 원문 섹션 (문서 맨 뒤 공통) ----------------

const TRANSCRIPT_NOTE =
    "현장에서 녹음된 음성을 자동으로 받아 적은 기록입니다. 맞춤법·표기가 실제 발화와 다를 수 있습니다."
/** 엑셀 셀 상한은 32,767자지만 훨씬 낮게 끊는다 — 한 행이 길면 행 높이 상한(409pt)에 걸려 인쇄에서 잘린다 */
const TRANSCRIPT_MAX_CHARS = 1000
/** 9pt 한 줄의 대략 높이(pt) */
const TRANSCRIPT_LINE_PT = 13

/** 한글·한자·가나는 폭이 2배 — 병합 셀은 자동 높이가 없어 줄 수를 직접 추정해야 한다 */
function displayWidth(s: string): number {
    let w = 0
    for (const ch of s) {
        w += /[ᄀ-ᇿ⺀-꓏ꥠ-꥿가-퟿豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
    }
    return w
}

function transcriptRowHeight(s: string, perLine: number): number {
    const lines = Math.max(1, Math.ceil(displayWidth(s) / perLine))
    return Math.min(400, lines * TRANSCRIPT_LINE_PT + 4) // 엑셀 행 높이 상한 409pt
}

function chunkLine(line: string): string[] {
    if (line.length <= TRANSCRIPT_MAX_CHARS) return [line]
    const out: string[] = []
    for (let i = 0; i < line.length; i += TRANSCRIPT_MAX_CHARS) out.push(line.slice(i, i + TRANSCRIPT_MAX_CHARS))
    return out
}

/**
 * 시트 맨 뒤에 "음성 원문"을 덧붙인다(startRow = 기존 표 다음 빈 행 → 두 줄 띄우고 시작).
 * 원문 전체를 셀 하나에 넣으면 엑셀에서 잘리므로 줄바꿈 단위로 행을 나눈다.
 * 표 너비만큼만 병합하므로 fitToWidth 인쇄 범위는 그대로다.
 */
function appendTranscript(
    ws: ExcelJS.Worksheet,
    startRow: number,
    cols: number,
    raw: string | null | undefined
): void {
    // 원문 노출 정지(2026-08-18 Chris) — 수집·저장은 그대로, 출력물에서만 뺀다. lib/reportFlags.ts 참조
    if (!TRANSCRIPT_VISIBLE) return
    // ExcelJS는 C0 제어문자는 걸러주지만 U+FFFE·U+FFFF(XML 1.0 비문자)는 그대로 써서
    // 파일이 안 열린다 — 다른 형식과 같은 문자군을 여기서도 떨궈낸다.
    const text = String(raw ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    if (!text.trim()) return // 원문이 없으면 섹션 자체를 만들지 않는다

    // 기본 11pt 기준 열 폭 합 — 본문은 9pt라 그만큼 더 들어간다
    const totalWidth = (ws.columns ?? []).slice(0, cols).reduce((a, c) => a + (c.width ?? 10), 0)
    const perLine = Math.max(20, totalWidth * 1.2)

    let r = startRow + 2 // 기존 표 마지막 행에서 두 줄 띄움

    mergeBox(ws, r, 1, r, cols, "음성 원문", { bold: true, size: 12, noBorder: true })
    ws.getRow(r).height = 24
    r++
    mergeBox(ws, r, 1, r, cols, TRANSCRIPT_NOTE, { size: 9, color: C.gray500, valign: "top", noBorder: true })
    ws.getRow(r).height = transcriptRowHeight(TRANSCRIPT_NOTE, perLine * 1.15)
    r++

    for (const line of text.split("\n")) {
        for (const chunk of chunkLine(line)) {
            mergeBox(ws, r, 1, r, cols, chunk, { size: 9, valign: "top", noBorder: true })
            ws.getRow(r).height = transcriptRowHeight(chunk, perLine)
            r++
        }
    }
}

// ---------------- TBM 회의록 시트 (MinutesView 재현) ----------------

async function fillMinutesSheet(
    wb: ExcelJS.Workbook,
    ws: ExcelJS.Worksheet,
    item: MinutesDocItem,
    stats: ImageLoadStats
): Promise<void> {
    const m = item.minutes ?? {}
    const parts = item.participants ?? []

    const [leaderSig, photo, ...partSigs] = await Promise.all([
        loadImage(m.leader_signature, stats),
        loadImage(m.photo_url, stats, { photo: true }),
        ...parts.map((p) => loadImage(p.signature, stats)),
    ])

    // 열 폭 — docx grid([15,35,15,35])와 같은 비율감
    ws.columns = [{ width: 13 }, { width: 33 }, { width: 13 }, { width: 33 }]
    setupPage(ws)

    let r = 1

    // 제목 밴드 — 남색 배경 + 흰 굵은 글씨
    mergeBox(ws, r, 1, r, 4, "Tool Box Meeting 회의록", {
        bold: true, color: C.white, fill: C.navy, size: 18, align: "center",
    })
    ws.getRow(r).height = 45
    r++

    // 문서 정보
    putRow(ws, r++, [
        { v: "TBM 일시", fill: C.gray200, bold: true, align: "center" },
        { v: `${dateKo(m.date)}  ${timeRange(m.start_time, m.end_time)}`, bold: true, align: "center" },
        { v: "TBM 장소", fill: C.gray200, bold: true, align: "center" },
        { v: m.location ?? "", bold: true, align: "center" },
    ], 25)
    putRow(ws, r++, [
        { v: "공정명", fill: C.gray200, bold: true, align: "center" },
        { v: m.process_name ?? "", bold: true, align: "center" },
        { v: "작업명", fill: C.gray200, bold: true, align: "center" },
        { v: m.work_name ?? "", bold: true, align: "center" },
    ], 25)
    putRow(ws, r++, [
        { v: "작업내용", fill: C.gray200, bold: true, align: "center" },
        { v: m.work_content ?? "", span: 3, size: 9, valign: "top" },
    ], 55)

    // TBM 리더 + 서명
    putRow(ws, r, [
        { v: "TBM 리더", fill: C.gray200, bold: true, align: "center" },
        { v: `직책 : ${m.leader_title ?? ""}      성명 : ${m.leader_name ?? ""}      (서명)`, span: 3, bold: true },
    ], 33)
    if (leaderSig) placeImage(wb, ws, leaderSig, r, 4, 90, 34, 0.55)
    r++

    // 근로자 참여 유해·위험요인
    putRow(ws, r++, [
        { v: "■ 근로자 참여 유해·위험요인", span: 4, fill: C.orange50, bold: true },
    ], 20)
    putRow(ws, r++, [
        { v: "잠재 유해위험요인", span: 2, fill: C.gray200, bold: true, align: "center" },
        { v: "위험성", fill: C.gray200, bold: true, align: "center" },
        { v: "대책(※ 제거 → 대체 → 통제 순서 고려)", fill: C.gray200, bold: true, align: "center" },
    ], 20)

    // 실데이터 행만 — 빈 패딩 행('상/중/하' 자리표시)은 미완성 문서로 보인다. 0건이면 형식 유지용 빈 1행
    const hazards = (Array.isArray(m.hazards) ? m.hazards : []).filter((h) => h?.factor?.trim())
    const hazardRows = Math.max(1, hazards.length)
    for (let i = 0; i < hazardRows; i++) {
        const h = hazards[i]
        // 빈도·강도가 있으면 "빈도×강도 · 등급", 없으면 등급만 — MinutesView와 동일
        const risk = h
            ? (h.frequency && h.severity ? `${h.frequency}×${h.severity} · ${h.level || ""}` : (h.level || ""))
            : ""
        putRow(ws, r++, [
            { v: `□ ${h?.factor ?? ""}`, span: 2, size: 9, valign: "top" },
            { v: risk, bold: true, color: C.red, align: "center" }, // 등급 셀 빨간 글씨
            { v: `□ ${h?.measure ?? ""}`, size: 9, valign: "top" },
        ], 28)
    }

    // 작업 시작전 확인사항
    putRow(ws, r++, [{ v: "■ 작업 시작전 확인사항", span: 4, bold: true }], 20)
    putRow(ws, r++, [
        { v: "□ 개인별 건강상태 이상 유무", span: 2, bold: true },
        { v: m.health_check ?? "", span: 2, bold: true, align: "center" },
    ], 25)
    putRow(ws, r++, [
        { v: "□ 개인 보호구 착용 상태", span: 2, bold: true },
        { v: m.ppe_check ?? "", span: 2, bold: true, align: "center" },
    ], 25)
    putRow(ws, r++, [
        { v: "□ 안전구호 제창", span: 2, bold: true },
        { v: `"${m.safety_phrase || "안전, 안전, 안전"}"`, span: 2, bold: true, color: C.blue, align: "center" },
    ], 25)

    // 협의 및 지시사항
    putRow(ws, r++, [
        { v: "■ 작업 시작전 협의 및 지시사항(작업전에 협의할 사항을 음성으로 녹음하세요)", span: 4, bold: true },
    ], 20)
    putRow(ws, r++, [
        { v: m.instructions ?? "", span: 4, size: 9, valign: "top" },
    ], 78)

    // 참석자 확인 — 2열(이름/서명 × 2) 최소 15행, 분할점은 인원수에 맞춰 동적 산정
    putRow(ws, r++, [
        { v: "■ 참석자 확인(※ TBM에 참여하지 않은 작업자를 확인하여 미팅 참석 유도)", span: 4, bold: true },
    ], 20)
    putRow(ws, r++, [
        { v: "이름", fill: C.gray300, bold: true, align: "center" },
        { v: "서명", fill: C.gray300, bold: true, align: "center" },
        { v: "이름", fill: C.gray300, bold: true, align: "center" },
        { v: "서명", fill: C.gray300, bold: true, align: "center" },
    ], 20)

    const half = Math.max(15, Math.ceil(parts.length / 2))
    for (let i = 0; i < half; i++) {
        const p1 = parts[i]
        const p2 = parts[i + half]
        putRow(ws, r, [
            { v: p1?.name || "", bold: true, align: "center" },
            { v: "" },
            { v: p2?.name || "", bold: true, align: "center" },
            { v: "" },
        ], 28)
        const s1 = partSigs[i]
        const s2 = partSigs[i + half]
        if (s1) placeImage(wb, ws, s1, r, 2, 110, 30, 0.3)
        if (s2) placeImage(wb, ws, s2, r, 4, 110, 30, 0.3)
        r++
    }

    // --- 현장 사진 (교육일지 시트와 같은 규격) ---
    ws.getRow(r++).height = 14 // 섹션 사이 여백 행
    mergeBox(ws, r, 1, r, 4, "현 장 사 진", { bold: true, size: 16, align: "center", noBorder: true })
    ws.getRow(r).height = 28
    r++
    const M_PHOTO_ROWS = 12
    mergeBox(ws, r, 1, r + M_PHOTO_ROWS - 1, 4,
        photo ? "" : "등록된 현장 사진이 없습니다.",
        photo ? { align: "center" } : { bold: true, color: C.gray500, align: "center" })
    for (let i = 0; i < M_PHOTO_ROWS; i++) ws.getRow(r + i).height = 30
    if (photo) placeImage(wb, ws, photo, r, 1, 600, 460, 0.25)
    r += M_PHOTO_ROWS

    appendTranscript(ws, r, 4, m.raw_transcript)
}

// ---------------- 안전보건교육일지 시트 (ReportView 재현: 일지 + 참석자 명단 + 사진) ----------------

async function fillEducationSheet(
    wb: ExcelJS.Workbook,
    ws: ExcelJS.Worksheet,
    item: EducationDocItem,
    stats: ImageLoadStats
): Promise<void> {
    const log = item.log ?? {}
    const parts = item.participants ?? []

    const [instructorSig, photo, ...partSigs] = await Promise.all([
        // 뷰와 동일: 검토 확인 서명 우선, 없으면 실시자 서명
        loadImage(log.confirmation_signature || log.instructor_signature, stats),
        loadImage(log.photo_url, stats, { photo: true }),
        ...parts.map((p) => loadImage(p.signature, stats)),
    ])

    // 열 폭 — docx grid([15,17,17,17,17,17])와 같은 비율감
    ws.columns = [{ width: 13 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }]
    setupPage(ws, log.company_name)

    let r = 1

    // 제목 (표 밖)
    mergeBox(ws, r, 1, r, 6, "안 전 보 건 교 육 일 지", { bold: true, size: 18, align: "center", noBorder: true })
    ws.getRow(r).height = 34
    r++
    ws.getRow(r++).height = 6 // 제목-표 사이 여백 행

    // 교육 명칭 — 체크박스 6종 (☑/☐)
    const eduTypes = ["정기 안전교육", "특별안전보건교육", "신규 채용시 교육", "TBM (작업 전 안전점검)", "작업내용 변경시 교육"]
    const eduKeys = ["정기 안전교육", "특별안전보건교육", "신규 채용시 교육", "TBM", "작업내용 변경시 교육"]
    const isEtc = !eduKeys.includes(log.education_type ?? "")
    const mark = (checked: boolean, label: string) => `${checked ? "☑" : "☐"} ${label}`
    const checkText = [
        `${mark(log.education_type === eduKeys[0], eduTypes[0])}        ${mark(log.education_type === eduKeys[1], eduTypes[1])}`,
        `${mark(log.education_type === eduKeys[2], eduTypes[2])}        ${mark(log.education_type === eduKeys[3], eduTypes[3])}`,
        `${mark(log.education_type === eduKeys[4], eduTypes[4])}        ${mark(isEtc, "기타")}`,
    ].join("\n")
    putRow(ws, r++, [
        { v: "교육 명칭", fill: C.gray100, bold: true, align: "center" },
        { v: checkText, span: 5 },
    ], 54)

    // 교육 인원 (구분/계/비고) — 좌측 머리글 3행 세로 병합
    // 남/여 칸 삭제(2026-08-22 Chris) — 앱·QR 서명 어디서도 성별을 묻지 않기로 했다.
    // 물어보지 않은 값을 칸만 남겨두면 전원이 '남'으로 찍힌다.
    const totalCount = parts.length
    mergeBox(ws, r, 1, r + 2, 1, "교육 인원", { fill: C.gray100, bold: true, align: "center" })
    putRow(ws, r, [
        { v: "구분", fill: C.gray50, bold: true, align: "center" },
        { v: "계", fill: C.gray50, bold: true, align: "center" },
        { v: "비고", fill: C.gray50, bold: true, align: "center", span: 3 },
    ], 20, 2)
    r++
    for (const label of ["대상 인원", "참석 인원"]) {
        putRow(ws, r, [
            { v: label, bold: true, align: "center" },
            { v: String(totalCount), align: "center" },
            { v: "", align: "center", span: 3 },
        ], 20, 2)
        r++
    }

    // 시간/장소/방법
    putRow(ws, r++, [
        { v: "교육 시간", fill: C.gray100, bold: true, align: "center" },
        { v: `${dateKo(log.date)}   ${timeRange(log.start_time, log.end_time)}`, span: 5, align: "center" },
    ], 25)
    putRow(ws, r++, [
        { v: "교육 장소", fill: C.gray100, bold: true, align: "center" },
        { v: log.location ?? "", span: 5 },
    ], 25)
    putRow(ws, r++, [
        { v: "교육 방법", fill: C.gray100, bold: true, align: "center" },
        { v: "강의식 / 시청각 교육 / 현장 TBM", span: 5 },
    ], 25)

    // 교육 내용 (본문 대영역)
    putRow(ws, r++, [
        { v: "교육 내용", fill: C.gray100, bold: true, align: "center" },
        { v: log.education_content ?? "", span: 5, size: 9, valign: "top" },
    ], 225)

    // 교육 실시자 (관리감독자) + 서명 — 좌측 머리글 2행 세로 병합
    mergeBox(ws, r, 1, r + 1, 1, "교육 실시자\n(관리감독자)", { fill: C.gray100, bold: true, align: "center" })
    putRow(ws, r, [
        { v: "소속 및 직위", span: 2, fill: C.gray50, bold: true, align: "center" },
        { v: "성 명", span: 2, fill: C.gray50, bold: true, align: "center" },
        { v: "서 명", fill: C.gray50, bold: true, align: "center" },
    ], 20, 2)
    r++
    putRow(ws, r, [
        { v: log.company_name ?? "", span: 2, align: "center" },
        { v: log.instructor_name ?? "", span: 2, bold: true, align: "center" },
        { v: "", align: "center" },
    ], 43, 2)
    if (instructorSig) placeImage(wb, ws, instructorSig, r, 6, 100, 45, 0.15)
    r++

    // 특이사항 (뷰와 동일하게 빨간 강조)
    putRow(ws, r++, [
        { v: "특 이 사 항\n(기타 전달사항 등)", fill: C.gray100, bold: true, align: "center" },
        { v: log.remarks ?? "", span: 5, size: 9, color: C.red, valign: "top" },
    ], 68)

    // --- 참석자 명단 (한 시트라 페이지 분할 없이 전원 연속 — 2열 최소 15행) ---
    ws.getRow(r++).height = 14 // 섹션 사이 여백 행
    mergeBox(ws, r, 1, r, 6, "교 육 참 석 자 명 단", { bold: true, size: 16, align: "center", noBorder: true })
    ws.getRow(r).height = 28
    r++
    mergeBox(ws, r, 1, r, 6,
        `일시: ${log.date ?? ""}      업체명: ${log.company_name ?? ""}      근무조: 주간/야간`,
        { bold: true, noBorder: true })
    ws.getRow(r).height = 20
    r++
    putRow(ws, r++, [
        { v: "순번", fill: C.gray100, bold: true, align: "center" },
        { v: "이 름", fill: C.gray100, bold: true, align: "center" },
        { v: "서 명", fill: C.gray100, bold: true, align: "center" },
        { v: "순번", fill: C.gray100, bold: true, align: "center" },
        { v: "이 름", fill: C.gray100, bold: true, align: "center" },
        { v: "서 명", fill: C.gray100, bold: true, align: "center" },
    ], 22)

    const half = Math.max(15, Math.ceil(parts.length / 2))
    for (let i = 0; i < half; i++) {
        const i1 = i
        const i2 = i + half
        putRow(ws, r, [
            { v: String(i1 + 1), align: "center" },
            { v: parts[i1]?.name || "", bold: true, size: 12, align: "center" },
            { v: "" },
            { v: String(i2 + 1), align: "center" },
            { v: parts[i2]?.name || "", bold: true, size: 12, align: "center" },
            { v: "" },
        ], 38)
        const s1 = partSigs[i1]
        const s2 = partSigs[i2]
        if (s1) placeImage(wb, ws, s1, r, 3, 90, 42, 0.1)
        if (s2) placeImage(wb, ws, s2, r, 6, 90, 42, 0.1)
        r++
    }

    // --- 교육 사진 ---
    ws.getRow(r++).height = 14 // 섹션 사이 여백 행
    mergeBox(ws, r, 1, r, 6, "교 육 사 진", { bold: true, size: 16, align: "center", noBorder: true })
    ws.getRow(r).height = 28
    r++
    const PHOTO_ROWS = 12 // 12행 × 30pt ≈ 480px 높이의 사진 영역
    mergeBox(ws, r, 1, r + PHOTO_ROWS - 1, 6,
        photo ? "" : "등록된 현장 사진이 없습니다.",
        photo ? { align: "center" } : { bold: true, color: C.gray500, align: "center" })
    for (let i = 0; i < PHOTO_ROWS; i++) ws.getRow(r + i).height = 30
    if (photo) placeImage(wb, ws, photo, r, 1, 600, 460, 0.25)
    r += PHOTO_ROWS

    appendTranscript(ws, r, 6, log.raw_transcript)
}

// ---------------- 공개 API (exportDocx/exportHwpx와 대칭) ----------------

export interface XlsxBuildResult {
    blob: Blob
    /** 불러오지 못해 문서에서 빠진 서명·사진 수 — 0이 아니면 저장 전 사용자에게 알릴 것 */
    imageFailures: number
}

/** TBM 회의록 .xlsx — 1건 = 시트 1장, 일괄이면 건수만큼 시트 */
export async function buildMinutesXlsx(items: MinutesDocItem[]): Promise<XlsxBuildResult> {
    const stats: ImageLoadStats = { failures: 0 }
    const wb = new ExcelJS.Workbook()
    wb.creator = "안톡"
    const used = new Map<string, number>()
    // 일괄 수백 건이 사진·서명 버퍼를 동시에 적재하면 모바일 탭이 OOM으로 죽을 수 있어 문서 단위 순차 처리
    for (const item of items) {
        const ws = wb.addWorksheet(sheetName("minutes", item.minutes?.date, used))
        await fillMinutesSheet(wb, ws, item, stats)
    }
    const buf = await wb.xlsx.writeBuffer()
    return {
        blob: new Blob([buf as unknown as ArrayBuffer], { type: XLSX_MIME }),
        imageFailures: stats.failures,
    }
}

/**
 * 안전보건교육일지 .xlsx — 건마다 일지·참석자 명단·사진을 한 시트에 세로로 구성.
 * (lib/reportXlsx.ts의 서버용 buildEducationXlsx와 이름 충돌을 피하려고 접미 2)
 */
export async function buildEducationXlsx2(items: EducationDocItem[]): Promise<XlsxBuildResult> {
    const stats: ImageLoadStats = { failures: 0 }
    const wb = new ExcelJS.Workbook()
    wb.creator = "안톡"
    const used = new Map<string, number>()
    for (const item of items) {
        const ws = wb.addWorksheet(sheetName("education", item.log?.date, used))
        await fillEducationSheet(wb, ws, item, stats)
    }
    const buf = await wb.xlsx.writeBuffer()
    return {
        blob: new Blob([buf as unknown as ArrayBuffer], { type: XLSX_MIME }),
        imageFailures: stats.failures,
    }
}

/** 예: "TBM회의록_2026-07-18_비트플립.xlsx" (일괄이면 dateLabel에 기간 문자열) */
export function suggestXlsxFilename(kind: "minutes" | "education", dateLabel: string, company?: string): string {
    const base = kind === "minutes" ? "TBM회의록" : "안전보건교육일지"
    return [base, dateLabel, company]
        .filter(Boolean)
        .join("_")
        .replace(/[\\/:*?"<>|]/g, "-") + ".xlsx"
}
