// lib/exportFormats.ts — 문서 출력 형식 설정
// 가입 후 최초 로그인 시 모달에서 선택하고, 내 정보 수정에서 언제든 변경할 수 있다.
// value는 auth user_metadata.preferred_export_format에 저장된다.
export type ExportFormat = "hwp" | "docx" | "xlsx" | "pdf"

// PDF는 편집이 불가능한 출력 전용 형식이므로 항상 마지막(맨 오른쪽)에 배치한다.
export const EXPORT_FORMATS: { value: ExportFormat; label: string; sub: string; note?: string }[] = [
    { value: "hwp", label: "한글", sub: "HWP" },
    { value: "docx", label: "워드", sub: "DOCX" },
    { value: "xlsx", label: "엑셀", sub: "XLSX" },
    { value: "pdf", label: "PDF", sub: "출력 전용", note: "편집 불가 · 출력만 가능" },
]

export const DEFAULT_EXPORT_FORMAT: ExportFormat = "pdf"
