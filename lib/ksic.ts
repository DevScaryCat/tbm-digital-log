// lib/ksic.ts — 업종·공종 선택 목록 (한국표준산업분류 KSIC 10차 기반, TBM 관련 업종만 발췌)
// 용어 매핑(제품 언어): 업종 = KSIC 대분류, 공종 = KSIC 중분류.
// 가입 단순화를 위해 TBM·안전관리 수요가 있는 고위험 업종만 남기고 나머지는 "기타"로 수렴.
// 가입 위저드(app/signup)와 내 정보 수정(app/profile)이 공유한다.
// 저장 값은 이름 문자열(코드 아님) — 기존 user_metadata(industry/work_category)와 형식 호환.
// 서버(app/api/signup)는 40자 절단이 있으므로 이름은 40자 이내로 유지할 것.

export type KsicMinor = { code: string; name: string }
export type KsicMajor = { code: string; name: string; minors: KsicMinor[] }

export const KSIC_MAJORS: KsicMajor[] = [
    {
        code: "F", name: "건설업",
        minors: [
            { code: "41", name: "종합 건설업" },
            { code: "42", name: "전문직별 공사업" },
        ],
    },
    {
        code: "C", name: "제조업",
        minors: [
            { code: "10", name: "식료품 제조업" },
            { code: "11", name: "음료 제조업" },
            { code: "13", name: "섬유제품 제조업(의복 제외)" },
            { code: "16", name: "목재 및 나무제품 제조업(가구 제외)" },
            { code: "17", name: "펄프, 종이 및 종이제품 제조업" },
            { code: "19", name: "코크스, 연탄 및 석유정제품 제조업" },
            { code: "20", name: "화학물질 및 화학제품 제조업(의약품 제외)" },
            { code: "22", name: "고무 및 플라스틱제품 제조업" },
            { code: "23", name: "비금속 광물제품 제조업" },
            { code: "24", name: "1차 금속 제조업" },
            { code: "25", name: "금속 가공제품 제조업(기계·가구 제외)" },
            { code: "26", name: "전자부품·컴퓨터·영상·음향·통신장비 제조업" },
            { code: "28", name: "전기장비 제조업" },
            { code: "29", name: "기타 기계 및 장비 제조업" },
            { code: "30", name: "자동차 및 트레일러 제조업" },
            { code: "31", name: "기타 운송장비 제조업(조선 등)" },
            { code: "32", name: "가구 제조업" },
            { code: "33", name: "기타 제품 제조업" },
            { code: "34", name: "산업용 기계 및 장비 수리업" },
        ],
    },
    {
        code: "H", name: "운수 및 창고업",
        minors: [
            { code: "49", name: "육상 운송 및 파이프라인 운송업" },
            { code: "50", name: "수상 운송업" },
            { code: "51", name: "항공 운송업" },
            { code: "52", name: "창고 및 운송관련 서비스업" },
        ],
    },
    {
        code: "D", name: "전기, 가스, 증기 및 공기조절 공급업",
        minors: [
            { code: "35", name: "전기, 가스, 증기 및 공기조절 공급업" },
        ],
    },
    {
        code: "E", name: "수도, 하수·폐기물 처리, 원료 재생업",
        minors: [
            { code: "36", name: "수도업" },
            { code: "37", name: "하수, 폐수 및 분뇨 처리업" },
            { code: "38", name: "폐기물 수집·운반·처리 및 원료 재생업" },
            { code: "39", name: "환경 정화 및 복원업" },
        ],
    },
    {
        code: "B", name: "광업",
        minors: [
            { code: "05", name: "석탄, 원유 및 천연가스 광업" },
            { code: "06", name: "금속 광업" },
            { code: "07", name: "비금속광물 광업(연료용 제외)" },
            { code: "08", name: "광업 지원 서비스업" },
        ],
    },
    {
        code: "A", name: "농업, 임업 및 어업",
        minors: [
            { code: "01", name: "농업" },
            { code: "02", name: "임업" },
            { code: "03", name: "어업" },
        ],
    },
    {
        code: "N", name: "시설관리·사업지원 서비스업",
        minors: [
            { code: "74", name: "사업시설 관리 및 조경 서비스업" },
            { code: "75", name: "사업 지원 서비스업" },
            { code: "76", name: "임대업(부동산 제외)" },
        ],
    },
    {
        code: "ETC", name: "기타",
        minors: [
            { code: "ETC", name: "기타" },
        ],
    },
]

export function findKsicMajor(name: string): KsicMajor | undefined {
    return KSIC_MAJORS.find((m) => m.name === name)
}
