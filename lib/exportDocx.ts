// lib/exportDocx.ts
// TBM 회의록 / 안전보건교육일지 → 정식 .docx 빌더 (브라우저 전용)
// - MinutesView / ReportView의 표 구조·항목·강조를 docx Table로 재현
// - Packer.toBlob 사용 (Node Buffer 등 서버 전용 API 금지)
// - 서명/사진 로드 실패는 이미지만 생략 — 문서 생성 자체는 계속 진행
import {
    AlignmentType,
    BorderStyle,
    Document,
    HeightRule,
    ImageRun,
    Packer,
    PageBreak,
    Paragraph,
    Table,
    TableCell,
    TableLayoutType,
    TableRow,
    TextRun,
    VerticalAlign,
    WidthType,
    type TableVerticalAlign,
} from "docx"

// ---------------- 입력 타입 (뷰 페이지가 가진 데이터를 그대로 넘길 수 있게 전부 optional/nullable) ----------------

export interface MinutesHazard {
    factor?: string | null
    level?: string | null
    measure?: string | null
    frequency?: number | string | null
    severity?: number | string | null
}

export interface MinutesDocData {
    date?: string | null
    start_time?: string | null
    end_time?: string | null
    location?: string | null
    process_name?: string | null
    work_name?: string | null
    work_content?: string | null
    leader_title?: string | null
    leader_name?: string | null
    leader_signature?: string | null
    health_check?: string | null
    ppe_check?: string | null
    safety_phrase?: string | null
    instructions?: string | null
    hazards?: MinutesHazard[] | null
}

export interface DocParticipant {
    name?: string | null
    gender?: string | null
    signature?: string | null
}

export interface MinutesDocItem {
    minutes: MinutesDocData
    participants: DocParticipant[]
}

export interface EducationDocData {
    date?: string | null
    start_time?: string | null
    end_time?: string | null
    location?: string | null
    company_name?: string | null
    education_type?: string | null
    instructor_name?: string | null
    instructor_signature?: string | null
    confirmation_signature?: string | null
    education_content?: string | null
    remarks?: string | null
    photo_url?: string | null
}

export interface EducationDocItem {
    log: EducationDocData
    participants: DocParticipant[]
}

// ---------------- 공통 상수 ----------------

const FONT = "Malgun Gothic"
// A4 세로 (twip)
const PAGE_W = 11906
const PAGE_H = 16838
const MARGIN = 850 // 약 15mm
const CONTENT_W = PAGE_W - MARGIN * 2

// 뷰(Tailwind)에서 쓰는 색을 hex로 맞춤
const C = {
    navy: "0B285B", // bg-[#0b285b] 제목 밴드
    white: "FFFFFF",
    red: "DC2626", // text-red-600 위험성 등급
    blue: "1E3A8A", // text-blue-900 안전구호
    gray500: "6B7280",
    gray50: "F9FAFB",
    gray100: "F3F4F6",
    gray200: "E5E7EB",
    gray300: "D1D5DB",
    orange50: "FFF7ED", // bg-orange-50/50 위험성평가 섹션 띠
}

// ---------------- 이미지 로드 (서명 signed URL / base64 data URL 공용) ----------------

type ImgType = "png" | "jpg"

interface LoadedImage {
    data: ArrayBuffer
    type: ImgType
    width: number
    height: number
}

/** 이미지 로드 실패 집계 — 서명이 빠진 문서가 조용히 저장되지 않도록 호출부에 알린다 */
export interface ImageLoadStats {
    failures: number
}

// canvas 재인코딩을 항상 거치는 이유:
//  1) WebP·HEIC 등 docx가 모르는 포맷이 PNG로 오라벨돼 깨진 이미지로 박히는 것 방지(포맷 통일)
//  2) 원본 카메라 사진(수 MB)을 축소해 일괄 내보내기 메모리·파일 크기 폭주 방지
// 브라우저가 못 여는 포맷(SVG·HEIC 등)은 실패로 집계하고 생략한다.
async function loadImage(
    url: string | null | undefined,
    stats: ImageLoadStats,
    opts?: { photo?: boolean }
): Promise<LoadedImage | null> {
    if (!url) return null // 값 자체가 없는 건 실패가 아님(서명 미수집 등)
    try {
        // fetch는 data: URL도 처리한다 (canvas 서명 base64 대응)
        const res = await fetch(url)
        if (!res.ok) {
            stats.failures++
            return null
        }
        const raw = await res.arrayBuffer()
        let bmp: ImageBitmap
        try {
            bmp = await createImageBitmap(new Blob([raw]))
        } catch {
            stats.failures++
            return null
        }
        const maxDim = opts?.photo ? 1400 : 800
        const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height))
        const width = Math.max(1, Math.round(bmp.width * scale))
        const height = Math.max(1, Math.round(bmp.height * scale))
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext("2d")
        if (!ctx) {
            bmp.close()
            stats.failures++
            return null
        }
        // 사진은 흰 배경 JPEG(용량 절감), 서명은 투명 유지 PNG
        if (opts?.photo) {
            ctx.fillStyle = "#ffffff"
            ctx.fillRect(0, 0, width, height)
        }
        ctx.drawImage(bmp, 0, 0, width, height)
        bmp.close()
        const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, opts?.photo ? "image/jpeg" : "image/png", 0.85)
        )
        if (!blob) {
            stats.failures++
            return null
        }
        return { data: await blob.arrayBuffer(), type: opts?.photo ? "jpg" : "png", width, height }
    } catch {
        stats.failures++
        return null
    }
}

// 박스(px) 안에 비율 유지로 맞춘 ImageRun
function imageRun(img: LoadedImage, maxW: number, maxH: number): ImageRun {
    const scale = Math.min(maxW / img.width, maxH / img.height)
    return new ImageRun({
        type: img.type,
        data: img.data,
        transformation: {
            width: Math.max(1, Math.round(img.width * scale)),
            height: Math.max(1, Math.round(img.height * scale)),
        },
    })
}

// ---------------- 표/문단 빌더 헬퍼 ----------------

type Align = (typeof AlignmentType)[keyof typeof AlignmentType]
type VAlign = TableVerticalAlign

interface TextOpts {
    bold?: boolean
    color?: string
    size?: number // half-point (20 = 10pt)
    align?: Align
}

function run(text: string, o: TextOpts = {}): TextRun {
    return new TextRun({ text, font: FONT, bold: o.bold, color: o.color, size: o.size })
}

// 줄바꿈 포함 텍스트 → 문단 배열
function paras(text: string | null | undefined, o: TextOpts = {}): Paragraph[] {
    return String(text ?? "").split("\n").map(
        (line) => new Paragraph({ alignment: o.align, children: [run(line, o)] })
    )
}

interface CellOpts extends TextOpts {
    text?: string
    children?: (Paragraph | Table)[]
    span?: number
    rowSpan?: number
    fill?: string
    valign?: VAlign
}

function cell(o: CellOpts): TableCell {
    return new TableCell({
        columnSpan: o.span,
        rowSpan: o.rowSpan,
        shading: o.fill ? { fill: o.fill } : undefined,
        verticalAlign: o.valign ?? VerticalAlign.CENTER,
        margins: { top: 40, bottom: 40, left: 80, right: 80 },
        children: o.children ?? paras(o.text ?? "", o),
    })
}

function row(cells: TableCell[], minHeight?: number): TableRow {
    return new TableRow({
        children: cells,
        height: minHeight ? { value: minHeight, rule: HeightRule.ATLEAST } : undefined,
    })
}

// % 배열 → DXA 열 너비
function grid(percents: number[]): number[] {
    return percents.map((p) => Math.round((CONTENT_W * p) / 100))
}

function table(columnWidths: number[], rows: TableRow[]): Table {
    return new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths,
        layout: TableLayoutType.FIXED,
        rows,
    })
}

function pageBreak(): Paragraph {
    return new Paragraph({ children: [new PageBreak()] })
}

// 페이지 하단 현장명 (상단 실선 포함) — ReportView 푸터 재현
function footer(company?: string | null): Paragraph {
    return new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 240 },
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: "000000" } },
        children: [run(company || "현장명", { bold: true })],
    })
}

function dateKo(date?: string | null): string {
    if (!date) return "년 월 일"
    const [y, m, d] = date.split("-")
    return `${y}년 ${m}월 ${d}일`
}

function timeRange(start?: string | null, end?: string | null): string {
    return `${start?.slice(0, 5) || ""} ~ ${end?.slice(0, 5) || ""}`
}

// ---------------- TBM 회의록 (MinutesView 재현) ----------------

async function minutesChildren(item: MinutesDocItem, stats: ImageLoadStats): Promise<(Paragraph | Table)[]> {
    const m = item.minutes
    const parts = item.participants || []

    const [leaderSig, ...partSigs] = await Promise.all([
        loadImage(m.leader_signature, stats),
        ...parts.map((p) => loadImage(p.signature, stats)),
    ])

    const rows: TableRow[] = []

    // 제목 밴드 — 남색 배경 + 흰 글씨
    rows.push(row([
        cell({ span: 4, fill: C.navy, text: "Tool Box Meeting 회의록", bold: true, color: C.white, size: 44, align: AlignmentType.CENTER }),
    ], 900))

    // 문서 정보
    rows.push(row([
        cell({ text: "TBM 일시", fill: C.gray200, bold: true, align: AlignmentType.CENTER }),
        cell({ text: `${dateKo(m.date)}  ${timeRange(m.start_time, m.end_time)}`, bold: true, align: AlignmentType.CENTER }),
        cell({ text: "TBM 장소", fill: C.gray200, bold: true, align: AlignmentType.CENTER }),
        cell({ text: m.location ?? "", bold: true, align: AlignmentType.CENTER }),
    ], 500))
    rows.push(row([
        cell({ text: "공정명", fill: C.gray200, bold: true, align: AlignmentType.CENTER }),
        cell({ text: m.process_name ?? "", bold: true, align: AlignmentType.CENTER }),
        cell({ text: "작업명", fill: C.gray200, bold: true, align: AlignmentType.CENTER }),
        cell({ text: m.work_name ?? "", bold: true, align: AlignmentType.CENTER }),
    ], 500))
    rows.push(row([
        cell({ text: "작업내용", fill: C.gray200, bold: true, align: AlignmentType.CENTER }),
        cell({ span: 3, valign: VerticalAlign.TOP, children: paras(m.work_content, { size: 18 }) }),
    ], 1100))

    // TBM 리더 + 서명 (+ 서명 시 법적 책임 동의 문구)
    const leaderRuns: (TextRun | ImageRun)[] = [
        run(`직책 : ${m.leader_title ?? ""}      성명 : ${m.leader_name ?? ""}      (서명) `, { bold: true }),
    ]
    if (leaderSig) leaderRuns.push(imageRun(leaderSig, 90, 36))
    const leaderParas: Paragraph[] = [new Paragraph({ children: leaderRuns })]
    if (leaderSig) {
        leaderParas.push(new Paragraph({
            children: [run("* 본인은 일지의 내용을 정확하게 확인하였으며, 최종 검토 및 수정의 법적 책임이 본인에게 있음을 동의합니다.", { size: 14, color: C.gray500 })],
        }))
    }
    rows.push(row([
        cell({ text: "TBM 리더", fill: C.gray200, bold: true, align: AlignmentType.CENTER }),
        cell({ span: 3, children: leaderParas }),
    ], 650))

    // 근로자 참여 위험성평가
    rows.push(row([cell({ span: 4, fill: C.orange50, text: "■ 근로자 참여 위험성평가", bold: true })], 400))
    rows.push(row([
        cell({ span: 2, fill: C.gray200, text: "잠재 유해위험요인", bold: true, align: AlignmentType.CENTER }),
        cell({ fill: C.gray200, text: "위험성", bold: true, align: AlignmentType.CENTER }),
        cell({ fill: C.gray200, text: "대책(※ 제거 → 대체 → 통제 순서 고려)", bold: true, align: AlignmentType.CENTER }),
    ], 400))

    const hazards = Array.isArray(m.hazards) ? m.hazards : []
    const hazardRows = Math.max(3, hazards.length)
    for (let i = 0; i < hazardRows; i++) {
        const h = hazards[i]
        // 빈도·강도가 있으면 "빈도×강도 · 등급", 없으면 등급만 — MinutesView와 동일
        const risk = h
            ? (h.frequency && h.severity ? `${h.frequency}×${h.severity} · ${h.level || ""}` : (h.level || ""))
            : "상/중/하"
        rows.push(row([
            cell({ span: 2, valign: VerticalAlign.TOP, children: paras(`□ ${h?.factor ?? ""}`, { size: 18 }) }),
            cell({ text: risk, bold: true, color: C.red, align: AlignmentType.CENTER }),
            cell({ valign: VerticalAlign.TOP, children: paras(`□ ${h?.measure ?? ""}`, { size: 18 }) }),
        ], 550))
    }

    // 작업 시작전 확인사항
    rows.push(row([cell({ span: 4, text: "■ 작업 시작전 확인사항", bold: true })], 400))
    rows.push(row([
        cell({ span: 2, text: "□ 개인별 건강상태 이상 유무", bold: true }),
        cell({ span: 2, text: m.health_check ?? "", bold: true, align: AlignmentType.CENTER }),
    ], 500))
    rows.push(row([
        cell({ span: 2, text: "□ 개인 보호구 착용 상태", bold: true }),
        cell({ span: 2, text: m.ppe_check ?? "", bold: true, align: AlignmentType.CENTER }),
    ], 500))
    rows.push(row([
        cell({ span: 2, text: "□ 안전구호 제창", bold: true }),
        cell({ span: 2, text: `"${m.safety_phrase || "안전, 안전, 안전"}"`, bold: true, color: C.blue, align: AlignmentType.CENTER }),
    ], 500))

    // 협의 및 지시사항
    rows.push(row([cell({ span: 4, text: "■ 작업 시작전 협의 및 지시사항(작업전에 협의할 사항을 음성으로 녹음하세요)", bold: true })], 400))
    rows.push(row([
        cell({ span: 4, valign: VerticalAlign.TOP, children: paras(m.instructions, { size: 18 }) }),
    ], 1550))

    // 참석자 확인 — 2열(이름/서명 × 2) 최소 15행, 분할점은 인원수에 맞춰 동적 산정
    rows.push(row([cell({ span: 4, text: "■ 참석자 확인(※ TBM에 참여하지 않은 작업자를 확인하여 미팅 참석 유도)", bold: true })], 400))
    rows.push(row([
        cell({ fill: C.gray300, text: "이름", bold: true, align: AlignmentType.CENTER }),
        cell({ fill: C.gray300, text: "서명", bold: true, align: AlignmentType.CENTER }),
        cell({ fill: C.gray300, text: "이름", bold: true, align: AlignmentType.CENTER }),
        cell({ fill: C.gray300, text: "서명", bold: true, align: AlignmentType.CENTER }),
    ], 400))

    const half = Math.max(15, Math.ceil(parts.length / 2))
    const sigCell = (img: LoadedImage | null | undefined): TableCell => cell({
        children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: img ? [imageRun(img, 110, 34)] : [run("")],
        })],
    })
    for (let i = 0; i < half; i++) {
        const p1 = parts[i]
        const p2 = parts[i + half]
        rows.push(row([
            cell({ text: p1?.name || "", bold: true, align: AlignmentType.CENTER }),
            sigCell(partSigs[i]),
            cell({ text: p2?.name || "", bold: true, align: AlignmentType.CENTER }),
            sigCell(partSigs[i + half]),
        ], 550))
    }

    return [table(grid([15, 35, 15, 35]), rows)]
}

// ---------------- 안전보건교육일지 (ReportView 재현: 일지 + 참석자 명단 + 사진) ----------------

async function educationChildren(item: EducationDocItem, stats: ImageLoadStats): Promise<(Paragraph | Table)[]> {
    const log = item.log
    const parts = item.participants || []

    const [instructorSig, photo, ...partSigs] = await Promise.all([
        // 뷰와 동일: 검토 확인 서명 우선, 없으면 실시자 서명
        loadImage(log.confirmation_signature || log.instructor_signature, stats),
        loadImage(log.photo_url, stats, { photo: true }),
        ...parts.map((p) => loadImage(p.signature, stats)),
    ])

    const children: (Paragraph | Table)[] = []
    const title = (text: string): Paragraph => new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
        children: [run(text, { bold: true, size: 44 })],
    })

    // --- PAGE 1: 교육일지 ---
    children.push(title("안 전 보 건 교 육 일 지"))

    const rows: TableRow[] = []

    // 교육 명칭 — 체크박스 6종 (☑/☐)
    const eduTypes = ["정기 안전교육", "특별안전보건교육", "신규 채용시 교육", "TBM (작업 전 안전점검)", "작업내용 변경시 교육"]
    const eduKeys = ["정기 안전교육", "특별안전보건교육", "신규 채용시 교육", "TBM", "작업내용 변경시 교육"]
    const isEtc = !eduKeys.includes(log.education_type ?? "")
    const mark = (checked: boolean, label: string) => `${checked ? "☑" : "☐"} ${label}`
    const checkLines = [
        `${mark(log.education_type === eduKeys[0], eduTypes[0])}        ${mark(log.education_type === eduKeys[1], eduTypes[1])}`,
        `${mark(log.education_type === eduKeys[2], eduTypes[2])}        ${mark(log.education_type === eduKeys[3], eduTypes[3])}`,
        `${mark(log.education_type === eduKeys[4], eduTypes[4])}        ${mark(isEtc, "기타")}`,
    ]
    rows.push(row([
        cell({ text: "교육 명칭", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
        cell({ span: 5, children: checkLines.map((l) => new Paragraph({ children: [run(l)] })) }),
    ], 900))

    // 교육 인원 (구분/계/남/여/비고)
    const maleCount = parts.filter((p) => p.gender === "M").length
    const femaleCount = parts.filter((p) => p.gender === "F").length
    const totalCount = parts.length
    rows.push(row([
        cell({ text: "교육 인원", fill: C.gray100, bold: true, align: AlignmentType.CENTER, rowSpan: 3 }),
        cell({ text: "구분", fill: C.gray50, bold: true, align: AlignmentType.CENTER }),
        cell({ text: "계", fill: C.gray50, bold: true, align: AlignmentType.CENTER }),
        cell({ text: "남", fill: C.gray50, bold: true, align: AlignmentType.CENTER }),
        cell({ text: "여", fill: C.gray50, bold: true, align: AlignmentType.CENTER }),
        cell({ text: "비고", fill: C.gray50, bold: true, align: AlignmentType.CENTER }),
    ], 400))
    for (const label of ["대상 인원", "참석 인원"]) {
        rows.push(row([
            cell({ text: label, bold: true, align: AlignmentType.CENTER }),
            cell({ text: String(totalCount), align: AlignmentType.CENTER }),
            cell({ text: String(maleCount), align: AlignmentType.CENTER }),
            cell({ text: String(femaleCount), align: AlignmentType.CENTER }),
            cell({ text: "", align: AlignmentType.CENTER }),
        ], 400))
    }

    // 시간/장소/방법
    rows.push(row([
        cell({ text: "교육 시간", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
        cell({ span: 5, text: `${dateKo(log.date)}   ${timeRange(log.start_time, log.end_time)}`, align: AlignmentType.CENTER }),
    ], 500))
    rows.push(row([
        cell({ text: "교육 장소", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
        cell({ span: 5, text: log.location ?? "" }),
    ], 500))
    rows.push(row([
        cell({ text: "교육 방법", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
        cell({ span: 5, text: "강의식 / 시청각 교육 / 현장 TBM" }),
    ], 500))

    // 교육 내용 (본문 대영역)
    rows.push(row([
        cell({ text: "교육 내용", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
        cell({ span: 5, valign: VerticalAlign.TOP, children: paras(log.education_content, { size: 18 }) }),
    ], 4500))

    // 교육 실시자 (관리감독자) + 서명 + 법적 책임 동의 문구
    rows.push(row([
        cell({ fill: C.gray100, rowSpan: 3, children: paras("교육 실시자\n(관리감독자)", { bold: true, align: AlignmentType.CENTER }) }),
        cell({ span: 2, text: "소속 및 직위", fill: C.gray50, bold: true, align: AlignmentType.CENTER }),
        cell({ span: 2, text: "성 명", fill: C.gray50, bold: true, align: AlignmentType.CENTER }),
        cell({ text: "서 명", fill: C.gray50, bold: true, align: AlignmentType.CENTER }),
    ], 400))
    rows.push(row([
        cell({ span: 2, text: log.company_name ?? "", align: AlignmentType.CENTER }),
        cell({ span: 2, text: log.instructor_name ?? "", bold: true, align: AlignmentType.CENTER }),
        cell({
            children: [new Paragraph({
                alignment: AlignmentType.CENTER,
                children: instructorSig ? [imageRun(instructorSig, 110, 45)] : [run("")],
            })],
        }),
    ], 850))
    rows.push(row([
        cell({ span: 5, text: "본인은 일지의 내용을 정확하게 확인하였으며, 최종 검토 및 수정의 법적 책임이 본인에게 있음을 동의합니다.", size: 14, color: C.gray500 }),
    ], 400))

    // 특이사항 (뷰와 동일하게 빨간 강조)
    rows.push(row([
        cell({ children: paras("특 이 사 항\n(기타 전달사항 등)", { bold: true, align: AlignmentType.CENTER }), fill: C.gray100 }),
        cell({ span: 5, valign: VerticalAlign.TOP, children: paras(log.remarks, { size: 18, color: C.red }) }),
    ], 1350))

    children.push(table(grid([15, 17, 17, 17, 17, 17]), rows))
    children.push(footer(log.company_name))

    // --- PAGE 2+: 참석자 명단 (30명/페이지, 31명 이상도 유실 없이) ---
    const pageCount = Math.max(1, Math.ceil(parts.length / 30))
    for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
        const base = pageIdx * 30
        children.push(pageBreak())
        children.push(title(`교 육 참 석 자 명 단${pageCount > 1 ? ` (${pageIdx + 1}/${pageCount})` : ""}`))
        children.push(new Paragraph({
            spacing: { after: 200 },
            children: [run(`일시: ${log.date ?? ""}      업체명: ${log.company_name ?? ""}      근무조: 주간/야간`, { bold: true })],
        }))

        const listRows: TableRow[] = [row([
            cell({ text: "순번", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
            cell({ text: "이 름", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
            cell({ text: "서 명", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
            cell({ text: "순번", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
            cell({ text: "이 름", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
            cell({ text: "서 명", fill: C.gray100, bold: true, align: AlignmentType.CENTER }),
        ], 500)]
        for (let i = 0; i < 15; i++) {
            const i1 = base + i
            const i2 = base + i + 15
            const sig = (img: LoadedImage | null | undefined): TableCell => cell({
                children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: img ? [imageRun(img, 120, 42)] : [run("")],
                })],
            })
            listRows.push(row([
                cell({ text: String(i1 + 1), align: AlignmentType.CENTER }),
                cell({ text: parts[i1]?.name || "", bold: true, size: 24, align: AlignmentType.CENTER }),
                sig(partSigs[i1]),
                cell({ text: String(i2 + 1), align: AlignmentType.CENTER }),
                cell({ text: parts[i2]?.name || "", bold: true, size: 24, align: AlignmentType.CENTER }),
                sig(partSigs[i2]),
            ], 750))
        }
        children.push(table(grid([10, 25, 15, 10, 25, 15]), listRows))
        children.push(footer(log.company_name))
    }

    // --- PAGE 3: 교육 사진 ---
    children.push(pageBreak())
    children.push(title("교 육 사 진"))
    children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 200 },
        // 본문 폭 약 680px — 사진을 비율 유지로 최대한 크게
        children: photo ? [imageRun(photo, 680, 780)] : [run("등록된 현장 사진이 없습니다.", { bold: true, color: C.gray500 })],
    }))
    children.push(footer(log.company_name))

    return children
}

// ---------------- 문서 조립 / 공개 API ----------------

function makeDoc(sectionChildren: (Paragraph | Table)[][]): Document {
    return new Document({
        styles: { default: { document: { run: { font: FONT, size: 20 } } } },
        sections: sectionChildren.map((children) => ({
            properties: {
                page: {
                    size: { width: PAGE_W, height: PAGE_H }, // A4 세로
                    margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
                },
            },
            children,
        })),
    })
}

export interface DocxBuildResult {
    blob: Blob
    /** 불러오지 못해 문서에서 빠진 서명·사진 수 — 0이 아니면 저장 전 사용자에게 알릴 것 */
    imageFailures: number
}

/** TBM 회의록 .docx — 1건이면 단건, 여러 건이면 문서(섹션) 사이 자동 페이지 나눔 */
export async function buildMinutesDocx(items: MinutesDocItem[]): Promise<DocxBuildResult> {
    const stats: ImageLoadStats = { failures: 0 }
    // 일괄 수백 건이 사진·서명 버퍼를 동시에 적재하면 모바일 탭이 OOM으로 죽을 수 있어 문서 단위 순차 처리
    const sections: (Paragraph | Table)[][] = []
    for (const item of items) sections.push(await minutesChildren(item, stats))
    return { blob: await Packer.toBlob(makeDoc(sections)), imageFailures: stats.failures }
}

/** 안전보건교육일지 .docx — 건마다 일지·참석자 명단·사진 페이지 구성, 여러 건은 섹션으로 분리 */
export async function buildEducationDocx(items: EducationDocItem[]): Promise<DocxBuildResult> {
    const stats: ImageLoadStats = { failures: 0 }
    const sections: (Paragraph | Table)[][] = []
    for (const item of items) sections.push(await educationChildren(item, stats))
    return { blob: await Packer.toBlob(makeDoc(sections)), imageFailures: stats.failures }
}

/** a[download] 트리거로 Blob 저장 */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 클릭 처리 전에 revoke되지 않도록 지연
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 예: "TBM회의록_2026-07-18_비트플립.docx" (일괄이면 dateLabel에 기간 문자열) */
export function suggestFilename(kind: "minutes" | "education", dateLabel: string, company?: string): string {
    const base = kind === "minutes" ? "TBM회의록" : "안전보건교육일지"
    return [base, dateLabel, company]
        .filter(Boolean)
        .join("_")
        .replace(/[\\/:*?"<>|]/g, "-") + ".docx"
}
