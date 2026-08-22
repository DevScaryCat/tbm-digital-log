// lib/exportHwpx.ts
// TBM 회의록 / 안전보건교육일지 → 정식 .hwpx(OWPML, KS X 6101) 빌더
// - HWPX = OWPML XML들을 zip으로 묶은 컨테이너. 구조는 실제 한컴 오피스가 저장한
//   Skeleton.hwpx(python-hwpx 동봉)와 hwpxlib 코퍼스 파일을 그대로 따랐다:
//     mimetype(첫 엔트리, 무압축) / version.xml / settings.xml
//     META-INF/container.xml·manifest.xml·container.rdf
//     Contents/content.hpf(OPF: metadata·manifest·spine) / header.xml / section0.xml
//     BinData/imageN.png|jpg  ← content.hpf manifest에 isEmbeded="1" 아이템으로 등록,
//                               본문 <hc:img binaryItemIDRef="…">가 그 id를 참조
// - 표 구성·항목·강조는 exportDocx.ts(docx 빌더)와 동일하게 재현한다.
// - 텍스트 문서 생성 경로는 Node에서도 동작(브라우저 전용 API는 이미지 로드 경로에만 존재).
import { TRANSCRIPT_VISIBLE } from "./reportFlags"
import JSZip from "jszip"
import {
    loadImage,
    type EducationDocItem,
    type ImageLoadStats,
    type LoadedImage,
    type MinutesDocItem,
} from "./exportDocx"

// ---------------- 단위/페이지 상수 ----------------
// HWPUNIT: 1pt = 100, 1mm = 283.465, 96dpi 1px = 75, docx twip(1/20pt) 1 = 5
const TWIP = 5 // docx 빌더의 twip 수치를 그대로 가져와 ×5로 환산
const PX = 75 // px(96dpi) → HWPUNIT

// A4 세로(210×297mm), 여백 15mm — exportDocx와 동일 레이아웃
const PAGE_W = 59528 // 210mm × 283.465
const PAGE_H = 84186 // 297mm × 283.465 (한컴 저장값 기준)
const MARGIN = 4252 // 15mm
const CONTENT_W = PAGE_W - MARGIN * 2 // 51024

const FONT = "맑은 고딕"

// 뷰(Tailwind) 색 — exportDocx의 C와 동일 (OWPML은 # 접두 필요)
const C = {
    navy: "#0B285B",
    white: "#FFFFFF",
    red: "#DC2626",
    blue: "#1E3A8A",
    gray500: "#6B7280",
    gray50: "#F9FAFB",
    gray100: "#F3F4F6",
    gray200: "#E5E7EB",
    gray300: "#D1D5DB",
    orange50: "#FFF7ED",
    black: "#000000",
}

// ---------------- XML 이스케이프 (사용자 입력이 그대로 들어간다 — 철저히) ----------------

function esc(s: string): string {
    return s
        // XML 1.0 비허용 문자(제어문자·고아 서로게이트·U+FFFE/FFFF) 제거 — 하나라도 남으면
        // section0.xml이 malformed가 되어 한/글이 파일 자체를 못 연다(PDF/PPT 복붙 텍스트에 실재)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/g, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
}

// ---------------- 공통 네임스페이스 (한컴 저장 파일 그대로) ----------------

const NS =
    'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ' +
    'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ' +
    'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ' +
    'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" ' +
    'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" ' +
    'xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" ' +
    'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'

// ---------------- 스타일 레지스트리 (header.xml의 charPr/paraPr/borderFill을 사용분만 동적 생성) ----------------

type HAlign = "LEFT" | "CENTER" | "JUSTIFY"

interface CharSpec {
    /** docx와 동일한 half-point 단위 (20 = 10pt). HWPUNIT 환산은 ×50 */
    size?: number
    bold?: boolean
    color?: string
}

interface ParaSpec {
    align?: HAlign
    /** 문단 앞 쪽 나눔 (paraPr pageBreakBefore + hp:p pageBreak 병행) */
    breakBefore?: boolean
    /** 상단 실선(문서 푸터 재현) */
    topBorder?: boolean
}

class HwpxStyles {
    private charKeys = new Map<string, number>()
    private charList: Required<CharSpec>[] = []
    private paraKeys = new Map<string, number>()
    private paraList: Required<ParaSpec>[] = []
    // borderFill id 1(무테두리)·2(charPr 참조용)는 골격 고정 — 동적 항목은 3부터
    private fillKeys = new Map<string, number>()
    private fillList: { fill: string | null; topOnly: boolean }[] = []

    charPr(spec: CharSpec = {}): number {
        const c: Required<CharSpec> = {
            size: spec.size ?? 20,
            bold: spec.bold ?? false,
            color: spec.color ?? C.black,
        }
        const key = `${c.size}|${c.bold ? 1 : 0}|${c.color}`
        let id = this.charKeys.get(key)
        if (id === undefined) {
            id = this.charList.length
            this.charList.push(c)
            this.charKeys.set(key, id)
        }
        return id
    }

    paraPr(spec: ParaSpec = {}): number {
        const p: Required<ParaSpec> = {
            align: spec.align ?? "LEFT",
            breakBefore: spec.breakBefore ?? false,
            topBorder: spec.topBorder ?? false,
        }
        const key = `${p.align}|${p.breakBefore ? 1 : 0}|${p.topBorder ? 1 : 0}`
        let id = this.paraKeys.get(key)
        if (id === undefined) {
            id = this.paraList.length
            this.paraList.push(p)
            this.paraKeys.set(key, id)
        }
        return id
    }

    /** 4방 실선(0.12mm) + 선택적 배경색 셀 테두리 */
    borderFill(fill: string | null): number {
        return this.fillId(fill, false)
    }

    /** 상단만 실선 — 푸터 문단 상단 괘선 */
    topBorderFill(): number {
        return this.fillId(null, true)
    }

    private fillId(fill: string | null, topOnly: boolean): number {
        const key = `${topOnly ? "T" : "B"}|${fill ?? ""}`
        let id = this.fillKeys.get(key)
        if (id === undefined) {
            id = 3 + this.fillList.length
            this.fillList.push({ fill, topOnly })
            this.fillKeys.set(key, id)
        }
        return id
    }

    // ---- header.xml 조립 ----

    private charPrXml(id: number, c: Required<CharSpec>): string {
        const per7 = (tag: string, v: string) =>
            `<hh:${tag} hangul="${v}" latin="${v}" hanja="${v}" japanese="${v}" other="${v}" symbol="${v}" user="${v}"/>`
        return (
            `<hh:charPr id="${id}" height="${c.size * 50}" textColor="${c.color}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">` +
            per7("fontRef", "0") +
            per7("ratio", "100") +
            per7("spacing", "0") +
            per7("relSz", "100") +
            per7("offset", "0") +
            (c.bold ? "<hh:bold/>" : "") + // <hh:bold/>는 offset과 underline 사이 (실제 한컴 출력 순서)
            '<hh:underline type="NONE" shape="SOLID" color="#000000"/>' +
            '<hh:strikeout shape="NONE" color="#000000"/>' +
            '<hh:outline type="NONE"/>' +
            '<hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/>' +
            "</hh:charPr>"
        )
    }

    private paraPrXml(id: number, p: Required<ParaSpec>): string {
        const marginLs =
            "<hh:margin>" +
            '<hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/>' +
            '<hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/>' +
            "</hh:margin>" +
            '<hh:lineSpacing type="PERCENT" value="130" unit="HWPUNIT"/>'
        const borderRef = p.topBorder ? this.topBorderFill() : 2
        return (
            `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0" textDir="LTR">` +
            `<hh:align horizontal="${p.align}" vertical="BASELINE"/>` +
            '<hh:heading type="NONE" idRef="0" level="0"/>' +
            `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="${p.breakBefore ? 1 : 0}" lineWrap="BREAK"/>` +
            '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
            // 한컴 저장 파일과 동일한 hp:switch(HwpUnitChar 분기) 형태 유지
            `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${marginLs}</hp:case><hp:default>${marginLs}</hp:default></hp:switch>` +
            `<hh:border borderFillIDRef="${borderRef}" offsetLeft="0" offsetRight="0" offsetTop="${p.topBorder ? 283 : 0}" offsetBottom="0" connect="0" ignoreMargin="0"/>` +
            "</hh:paraPr>"
        )
    }

    private borderFillXml(id: number, f: { fill: string | null; topOnly: boolean }): string {
        const side = (name: string, solid: boolean) =>
            `<hh:${name} type="${solid ? "SOLID" : "NONE"}" width="0.12 mm" color="#000000"/>`
        return (
            `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
            '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
            side("leftBorder", !f.topOnly) +
            side("rightBorder", !f.topOnly) +
            side("topBorder", true) +
            side("bottomBorder", !f.topOnly) +
            '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
            (f.fill ? `<hc:fillBrush><hc:winBrush faceColor="${f.fill}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : "") +
            "</hh:borderFill>"
        )
    }

    headerXml(): string {
        const langs = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"]
        const fontfaces = langs
            .map(
                (lang) =>
                    `<hh:fontface lang="${lang}" fontCnt="1"><hh:font id="0" face="${esc(FONT)}" type="TTF" isEmbedded="0">` +
                    '<hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>' +
                    "</hh:font></hh:fontface>"
            )
            .join("")

        // id 1·2: 한컴 골격 그대로 (1=무테두리: secPr pageBorderFill 참조 / 2: charPr·paraPr 참조)
        const baseFills =
            '<hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">' +
            '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
            '<hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>' +
            '<hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>' +
            '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill>' +
            '<hh:borderFill id="2" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">' +
            '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
            '<hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>' +
            '<hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>' +
            '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
            '<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#999999" alpha="0"/></hc:fillBrush></hh:borderFill>'

        // secPr outlineShapeIDRef="1"이 참조하는 개요 번호 — 한컴 골격 그대로
        const numberings =
            '<hh:numberings itemCnt="1"><hh:numbering id="1" start="0">' +
            [
                ["1", "DIGIT", "^1.", "0"],
                ["2", "HANGUL_SYLLABLE", "^2.", "0"],
                ["3", "DIGIT", "^3)", "0"],
                ["4", "HANGUL_SYLLABLE", "^4)", "0"],
                ["5", "DIGIT", "(^5)", "0"],
                ["6", "HANGUL_SYLLABLE", "(^6)", "0"],
                ["7", "CIRCLED_DIGIT", "^7", "1"],
            ]
                .map(
                    ([lv, fmt, txt, chk]) =>
                        `<hh:paraHead start="1" level="${lv}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="${fmt}" charPrIDRef="4294967295" checkable="${chk}">${esc(txt)}</hh:paraHead>`
                )
                .join("") +
            "</hh:numbering></hh:numberings>"

        return (
            XML_DECL +
            `<hh:head ${NS} version="1.5" secCnt="1">` +
            '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>' +
            "<hh:refList>" +
            `<hh:fontfaces itemCnt="7">${fontfaces}</hh:fontfaces>` +
            `<hh:borderFills itemCnt="${2 + this.fillList.length}">${baseFills}${this.fillList.map((f, i) => this.borderFillXml(3 + i, f)).join("")}</hh:borderFills>` +
            `<hh:charProperties itemCnt="${this.charList.length}">${this.charList.map((c, i) => this.charPrXml(i, c)).join("")}</hh:charProperties>` +
            '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' +
            numberings +
            `<hh:paraProperties itemCnt="${this.paraList.length}">${this.paraList.map((p, i) => this.paraPrXml(i, p)).join("")}</hh:paraProperties>` +
            '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>' +
            "</hh:refList>" +
            '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
            '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>' +
            "</hh:head>"
        )
    }
}

// ---------------- 문서 컨텍스트 (스타일 + BinData 이미지 + 본문 문단) ----------------

interface HwpxBinItem {
    id: string // content.hpf manifest 아이템 id = hc:img binaryItemIDRef
    name: string // BinData/ 안 파일명
    mediaType: string
    data: ArrayBuffer
}

class HwpxDoc {
    readonly styles = new HwpxStyles()
    readonly paras: string[] = []
    readonly images: HwpxBinItem[] = []
    private objSeq = 1849000000 // hp:tbl/hp:pic 고유 id 발급용 임의 시작값

    constructor(private title: string) {}

    nextObjId(): string {
        return String(this.objSeq++)
    }

    /** 이미지를 BinData로 등록하고 binaryItemIDRef로 쓸 manifest id 반환 */
    addImage(img: LoadedImage): string {
        const n = this.images.length + 1
        const ext = img.type === "jpg" ? "jpg" : "png"
        const item: HwpxBinItem = {
            id: `image${n}`,
            name: `image${n}.${ext}`,
            // 한컴 저장 파일은 jpeg도 "image/jpg"로 기록한다 — 실물 규약을 따름
            mediaType: `image/${ext}`,
            data: img.data,
        }
        this.images.push(item)
        return item.id
    }

    private contentHpf(): string {
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
        const imageItems = this.images
            .map((it) => `<opf:item id="${it.id}" href="BinData/${it.name}" media-type="${it.mediaType}" isEmbeded="1"/>`)
            .join("")
        return (
            XML_DECL +
            `<opf:package ${NS} version="" unique-identifier="" id="">` +
            "<opf:metadata>" +
            `<opf:title>${esc(this.title)}</opf:title><opf:language>ko</opf:language>` +
            '<opf:meta name="creator" content="text">안톡</opf:meta>' +
            `<opf:meta name="CreatedDate" content="text">${now}</opf:meta>` +
            `<opf:meta name="ModifiedDate" content="text">${now}</opf:meta>` +
            "</opf:metadata>" +
            "<opf:manifest>" +
            '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>' +
            imageItems +
            '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>' +
            '<opf:item id="settings" href="settings.xml" media-type="application/xml"/>' +
            "</opf:manifest>" +
            '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine>' +
            "</opf:package>"
        )
    }

    // 첫 문단: 구역 설정(secPr — A4 세로·여백 15mm)과 단 설정. 한컴 골격 그대로, 페이지 값만 교체.
    private sectionXml(): string {
        const secPr =
            '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">' +
            '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>' +
            '<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
            '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
            '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
            `<hp:pagePr landscape="WIDELY" width="${PAGE_W}" height="${PAGE_H}" gutterType="LEFT_ONLY">` +
            `<hp:margin header="0" footer="0" gutter="0" left="${MARGIN}" right="${MARGIN}" top="${MARGIN}" bottom="${MARGIN}"/>` +
            "</hp:pagePr>" +
            "<hp:footNotePr>" +
            '<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>' +
            '<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>' +
            '<hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/>' +
            '<hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/>' +
            "</hp:footNotePr>" +
            "<hp:endNotePr>" +
            '<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>' +
            '<hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/>' +
            '<hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/>' +
            '<hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/>' +
            "</hp:endNotePr>" +
            ["BOTH", "EVEN", "ODD"]
                .map(
                    (t) =>
                        `<hp:pageBorderFill type="${t}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`
                )
                .join("") +
            "</hp:secPr>"
        const firstP =
            `<hp:p id="0" paraPrIDRef="${this.styles.paraPr({})}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
            `<hp:run charPrIDRef="${this.styles.charPr({})}">${secPr}<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>` +
            `<hp:run charPrIDRef="${this.styles.charPr({})}"><hp:t/></hp:run>` +
            `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="${CONTENT_W}" flags="393216"/></hp:linesegarray>` +
            "</hp:p>"
        return XML_DECL + `<hs:sec ${NS}>` + firstP + this.paras.join("") + "</hs:sec>"
    }

    /** zip 패키징 — mimetype은 반드시 첫 엔트리·무압축(STORE), 디렉터리 엔트리 없음(한컴 실물과 동일) */
    async pack(): Promise<Blob> {
        const zip = new JSZip()
        // createFolders:false — 한컴 실물처럼 "Contents/" 같은 디렉터리 엔트리를 만들지 않는다
        const put = (path: string, data: string | ArrayBuffer): void => {
            zip.file(path, data, { createFolders: false })
        }
        zip.file("mimetype", "application/hwp+zip", { compression: "STORE", createFolders: false })
        put(
            "version.xml",
            XML_DECL +
                '<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="AnjeonTalkTalk" appVersion="1.0"/>'
        )
        // section보다 header가 스타일 확정 이후에 생성되도록 순서 주의: sectionXml()이 스타일을 등록한다
        const sectionXml = this.sectionXml()
        put("Contents/header.xml", this.styles.headerXml())
        put("Contents/section0.xml", sectionXml)
        put("Contents/content.hpf", this.contentHpf())
        // 텍스트 미리보기 — macOS 한컴 호환에 권장 (본문은 한/글이 열 때 재생성)
        put("Preview/PrvText.txt", this.title)
        put(
            "settings.xml",
            XML_DECL +
                '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>'
        )
        put(
            "META-INF/container.xml",
            XML_DECL +
                '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf">' +
                '<ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>' +
                '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>' +
                '<ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>'
        )
        put(
            "META-INF/manifest.xml",
            XML_DECL + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>'
        )
        put(
            "META-INF/container.rdf",
            XML_DECL +
                '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
                '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description>' +
                '<rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description>' +
                '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description>' +
                '<rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description>' +
                '<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>'
        )
        for (const img of this.images) put(`BinData/${img.name}`, img.data)
        // Node(검증)와 브라우저 모두에서 동작하도록 uint8array로 생성 후 Blob 래핑
        const buf = await zip.generateAsync({
            type: "arraybuffer",
            compression: "DEFLATE",
            compressionOptions: { level: 6 },
        })
        return new Blob([buf], { type: "application/hwp+zip" })
    }
}

// ---------------- 문단/표 빌더 ----------------

interface ParaOpts {
    align?: HAlign
    breakBefore?: boolean
    topBorder?: boolean
    /** 텍스트 한 줄 (줄바꿈 포함 텍스트는 paras() 사용) */
    text?: string
    char?: CharSpec
    /** hp:run XML을 직접 지정(텍스트+서명 이미지 혼합 등) */
    runsXml?: string
}

function para(doc: HwpxDoc, o: ParaOpts): string {
    const paraPrId = doc.styles.paraPr({ align: o.align, breakBefore: o.breakBefore, topBorder: o.topBorder })
    const runs =
        o.runsXml ??
        `<hp:run charPrIDRef="${doc.styles.charPr(o.char ?? {})}">${o.text ? `<hp:t>${esc(o.text)}</hp:t>` : "<hp:t/>"}</hp:run>`
    return `<hp:p id="0" paraPrIDRef="${paraPrId}" styleIDRef="0" pageBreak="${o.breakBefore ? 1 : 0}" columnBreak="0" merged="0">${runs}</hp:p>`
}

// 줄바꿈 포함 텍스트 → 문단 배열 (docx 빌더의 paras()와 동일 정책)
function paras(doc: HwpxDoc, text: string | null | undefined, char: CharSpec = {}, align?: HAlign): string[] {
    return String(text ?? "")
        .split("\n")
        .map((line) => para(doc, { align, char, text: line }))
}

function textRunXml(doc: HwpxDoc, text: string, char: CharSpec = {}): string {
    return `<hp:run charPrIDRef="${doc.styles.charPr(char)}"><hp:t>${esc(text)}</hp:t></hp:run>`
}

// hp:pic — 글자처럼 취급(treatAsChar) 인라인 이미지. 크기는 HWPUNIT.
function picRunXml(doc: HwpxDoc, img: LoadedImage, maxWpx: number, maxHpx: number): string {
    const binId = doc.addImage(img)
    const scale = Math.min(maxWpx / img.width, maxHpx / img.height)
    const w = Math.max(75, Math.round(img.width * scale * PX))
    const h = Math.max(75, Math.round(img.height * scale * PX))
    const id = doc.nextObjId()
    const matrix = '<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
    const pic =
        `<hp:pic id="${id}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${doc.nextObjId()}" reverse="0">` +
        '<hp:offset x="0" y="0"/>' +
        `<hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/>` +
        '<hp:flip horizontal="0" vertical="0"/>' +
        `<hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>` +
        `<hp:renderingInfo>${matrix}</hp:renderingInfo>` +
        `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>` +
        `<hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/>` +
        '<hp:inMargin left="0" right="0" top="0" bottom="0"/>' +
        `<hp:imgDim dimwidth="${w}" dimheight="${h}"/>` +
        `<hc:img binaryItemIDRef="${binId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
        "<hp:effects/>" +
        `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
        '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
        '<hp:outMargin left="0" right="0" top="0" bottom="0"/>' +
        "<hp:shapeComment/>" +
        "</hp:pic>"
    return `<hp:run charPrIDRef="${doc.styles.charPr({})}">${pic}</hp:run>`
}

// ---- 표: docx 빌더와 같은 모양의 cell()/row()/grid() 헬퍼 ----

interface CellOpts {
    text?: string
    /** hp:p XML 배열을 직접 지정(이미지 셀·복합 문단) */
    parasXml?: string[]
    span?: number
    rowSpan?: number
    fill?: string
    bold?: boolean
    color?: string
    size?: number
    align?: HAlign
    /** 기본은 세로 가운데(CENTER) — 본문형 셀만 TOP */
    valignTop?: boolean
}

interface HRow {
    cells: CellOpts[]
    /** 최소 높이 (HWPUNIT) */
    h: number
}

function cell(o: CellOpts): CellOpts {
    return o
}

/** minHeight는 docx 빌더의 twip 값을 그대로 받는다 (내부에서 HWPUNIT 환산) */
function row(cells: CellOpts[], minHeightTwip = 400): HRow {
    return { cells, h: minHeightTwip * TWIP }
}

// % 배열 → HWPUNIT 열 너비
function grid(percents: number[]): number[] {
    return percents.map((p) => Math.round((CONTENT_W * p) / 100))
}

function tableXml(doc: HwpxDoc, colWidths: number[], rows: HRow[]): string {
    const borderId = doc.styles.borderFill(null)
    const covered = new Set<string>()
    const trs: string[] = []
    rows.forEach((r, ri) => {
        let col = 0
        const tcs: string[] = []
        for (const c of r.cells) {
            while (covered.has(`${ri}:${col}`)) col++
            const colSpan = c.span ?? 1
            const rowSpan = c.rowSpan ?? 1
            const w = colWidths.slice(col, col + colSpan).reduce((s, x) => s + x, 0)
            const h = rows.slice(ri, ri + rowSpan).reduce((s, x) => s + x.h, 0)
            // 병합으로 덮인 좌표는 이후 행에서 hp:tc를 내지 않는다 (한컴 실물과 동일)
            for (let rr = ri; rr < ri + rowSpan; rr++)
                for (let cc = col; cc < col + colSpan; cc++)
                    if (rr !== ri || cc !== col) covered.add(`${rr}:${cc}`)
            const cellBorderId = doc.styles.borderFill(c.fill ?? null)
            const content = (
                c.parasXml ??
                String(c.text ?? "")
                    .split("\n")
                    .map((line) =>
                        para(doc, { align: c.align, char: { size: c.size, bold: c.bold, color: c.color }, text: line })
                    )
            ).join("")
            tcs.push(
                `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${cellBorderId}">` +
                    `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${c.valignTop ? "TOP" : "CENTER"}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${content}</hp:subList>` +
                    `<hp:cellAddr colAddr="${col}" rowAddr="${ri}"/>` +
                    `<hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/>` +
                    `<hp:cellSz width="${w}" height="${h}"/>` +
                    '<hp:cellMargin left="400" right="400" top="200" bottom="200"/>' +
                    "</hp:tc>"
            )
            col += colSpan
        }
        trs.push(`<hp:tr>${tcs.join("")}</hp:tr>`)
    })
    const totalW = colWidths.reduce((s, x) => s + x, 0)
    const totalH = rows.reduce((s, x) => s + x.h, 0)
    return (
        `<hp:tbl id="${doc.nextObjId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="${colWidths.length}" cellSpacing="0" borderFillIDRef="${borderId}" noAdjust="0">` +
        `<hp:sz width="${totalW}" widthRelTo="ABSOLUTE" height="${totalH}" heightRelTo="ABSOLUTE" protect="0"/>` +
        '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
        '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="400" right="400" top="200" bottom="200"/>' +
        trs.join("") +
        "</hp:tbl>"
    )
}

/** 표를 담는 문단 (breakBefore면 표 앞에서 쪽 나눔) */
function tablePara(doc: HwpxDoc, colWidths: number[], rows: HRow[], breakBefore = false): string {
    return para(doc, {
        breakBefore,
        runsXml: `<hp:run charPrIDRef="${doc.styles.charPr({})}">${tableXml(doc, colWidths, rows)}</hp:run>`,
    })
}

// 이미지 한 장짜리 가운데 정렬 셀 문단 (서명 셀)
function sigParas(doc: HwpxDoc, img: LoadedImage | null | undefined, maxWpx: number, maxHpx: number): string[] {
    return [
        img
            ? para(doc, { align: "CENTER", runsXml: picRunXml(doc, img, maxWpx, maxHpx) })
            : para(doc, { align: "CENTER", text: "" }),
    ]
}

// 페이지 하단 현장명 (상단 실선) — docx footer() 재현
function footerPara(doc: HwpxDoc, company?: string | null): string {
    return para(doc, { align: "CENTER", topBorder: true, char: { bold: true }, text: company || "현장명" })
}

function dateKo(date?: string | null): string {
    if (!date) return "년 월 일"
    const [y, m, d] = date.split("-")
    return `${y}년 ${m}월 ${d}일`
}

function timeRange(start?: string | null, end?: string | null): string {
    return `${start?.slice(0, 5) || ""} ~ ${end?.slice(0, 5) || ""}`
}

// ---------------- 음성 원문 (STT 원문 — 문서 맨 뒤 별도 페이지) ----------------

const TRANSCRIPT_TITLE = "음성 원문"
const TRANSCRIPT_NOTE =
    "현장에서 녹음된 음성을 자동으로 받아 적은 기록입니다. 맞춤법·표기가 실제 발화와 다를 수 있습니다."

/**
 * 원문 문단들. 내용이 공백뿐이면 빈 배열 — 제목만 남은 빈 섹션을 만들지 않는다.
 * 발화 원문이 그대로 들어오므로 텍스트는 전부 para()/paras()를 거쳐 esc()로 이스케이프된다
 * (&, <, > 가 날것으로 남으면 section0.xml이 깨져 한/글이 파일을 아예 못 연다).
 */
function transcriptParas(doc: HwpxDoc, raw?: string | null): string[] {
    // 원문 노출 정지(2026-08-18 Chris) — 수집·저장은 그대로, 출력물에서만 뺀다. lib/reportFlags.ts 참조
    if (!TRANSCRIPT_VISIBLE) return []
    // STT 텍스트에 \r\n·\r이 섞여 들어와도 문단 분할이 어긋나지 않게 정규화
    const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim()
    if (!text) return []
    return [
        // 법정 서식 레이아웃이 밀리지 않도록 원문은 항상 새 페이지에서 시작
        para(doc, { breakBefore: true, char: { bold: true, size: 24 }, text: TRANSCRIPT_TITLE }),
        para(doc, { char: { size: 18, color: C.gray500 }, text: TRANSCRIPT_NOTE }),
        // ParaSpec에 문단 간격이 없어 빈 문단으로 제목/본문 사이를 띄운다
        para(doc, { char: { size: 18 } }),
        ...paras(doc, text, { size: 18 }),
    ]
}

// ---------------- TBM 회의록 (exportDocx.minutesChildren과 동일 표 구성) ----------------

async function addMinutes(doc: HwpxDoc, item: MinutesDocItem, stats: ImageLoadStats, first: boolean): Promise<void> {
    const m = item.minutes
    const parts = item.participants || []

    const [leaderSig, photo, ...partSigs] = await Promise.all([
        loadImage(m.leader_signature, stats),
        loadImage(m.photo_url, stats, { photo: true }),
        ...parts.map((p) => loadImage(p.signature, stats)),
    ])

    const rows: HRow[] = []

    // 제목 밴드 — 남색 배경 + 흰 글씨
    rows.push(row([
        cell({ span: 4, fill: C.navy, text: "Tool Box Meeting 회의록", bold: true, color: C.white, size: 44, align: "CENTER" }),
    ], 900))

    // 문서 정보
    rows.push(row([
        cell({ text: "TBM 일시", fill: C.gray200, bold: true, align: "CENTER" }),
        cell({ text: `${dateKo(m.date)}  ${timeRange(m.start_time, m.end_time)}`, bold: true, align: "CENTER" }),
        cell({ text: "TBM 장소", fill: C.gray200, bold: true, align: "CENTER" }),
        cell({ text: m.location ?? "", bold: true, align: "CENTER" }),
    ], 500))
    rows.push(row([
        cell({ text: "공정명", fill: C.gray200, bold: true, align: "CENTER" }),
        cell({ text: m.process_name ?? "", bold: true, align: "CENTER" }),
        cell({ text: "작업명", fill: C.gray200, bold: true, align: "CENTER" }),
        cell({ text: m.work_name ?? "", bold: true, align: "CENTER" }),
    ], 500))
    rows.push(row([
        cell({ text: "작업내용", fill: C.gray200, bold: true, align: "CENTER" }),
        cell({ span: 3, valignTop: true, parasXml: paras(doc, m.work_content, { size: 18 }) }),
    ], 1100))

    // TBM 리더 + 서명 (+ 서명 시 법적 책임 동의 문구)
    let leaderRuns = textRunXml(doc, `직책 : ${m.leader_title ?? ""}      성명 : ${m.leader_name ?? ""}      (서명) `, { bold: true })
    if (leaderSig) leaderRuns += picRunXml(doc, leaderSig, 90, 36)
    const leaderParas = [para(doc, { runsXml: leaderRuns })]
    if (leaderSig) {
        leaderParas.push(para(doc, {
            char: { size: 14, color: C.gray500 },
            text: "* 본인은 일지의 내용을 정확하게 확인하였으며, 최종 검토 및 수정의 법적 책임이 본인에게 있음을 동의합니다.",
        }))
    }
    rows.push(row([
        cell({ text: "TBM 리더", fill: C.gray200, bold: true, align: "CENTER" }),
        cell({ span: 3, parasXml: leaderParas }),
    ], 650))

    // 근로자 참여 유해·위험요인
    rows.push(row([cell({ span: 4, fill: C.orange50, text: "■ 근로자 참여 유해·위험요인", bold: true })], 400))
    rows.push(row([
        cell({ span: 2, fill: C.gray200, text: "잠재 유해위험요인", bold: true, align: "CENTER" }),
        cell({ fill: C.gray200, text: "위험성", bold: true, align: "CENTER" }),
        cell({ fill: C.gray200, text: "대책(※ 제거 → 대체 → 통제 순서 고려)", bold: true, align: "CENTER" }),
    ], 400))

    // 실데이터 행만 — 빈 패딩 행('상/중/하' 자리표시)은 미완성 문서로 보인다. 0건이면 형식 유지용 빈 1행
    const hazards = (Array.isArray(m.hazards) ? m.hazards : []).filter((h) => h?.factor?.trim())
    const hazardRows = Math.max(1, hazards.length)
    for (let i = 0; i < hazardRows; i++) {
        const h = hazards[i]
        // 빈도·강도가 있으면 "빈도×강도 · 등급", 없으면 등급만 — MinutesView와 동일
        const risk = h
            ? (h.frequency && h.severity ? `${h.frequency}×${h.severity} · ${h.level || ""}` : (h.level || ""))
            : ""
        rows.push(row([
            cell({ span: 2, valignTop: true, parasXml: paras(doc, `□ ${h?.factor ?? ""}`, { size: 18 }) }),
            cell({ text: risk, bold: true, color: C.red, align: "CENTER" }),
            cell({ valignTop: true, parasXml: paras(doc, `□ ${h?.measure ?? ""}`, { size: 18 }) }),
        ], 550))
    }

    // 작업 시작전 확인사항
    rows.push(row([cell({ span: 4, text: "■ 작업 시작전 확인사항", bold: true })], 400))
    rows.push(row([
        cell({ span: 2, text: "□ 개인별 건강상태 이상 유무", bold: true }),
        cell({ span: 2, text: m.health_check ?? "", bold: true, align: "CENTER" }),
    ], 500))
    rows.push(row([
        cell({ span: 2, text: "□ 개인 보호구 착용 상태", bold: true }),
        cell({ span: 2, text: m.ppe_check ?? "", bold: true, align: "CENTER" }),
    ], 500))
    rows.push(row([
        cell({ span: 2, text: "□ 안전구호 제창", bold: true }),
        cell({ span: 2, text: `"${m.safety_phrase || "안전, 안전, 안전"}"`, bold: true, color: C.blue, align: "CENTER" }),
    ], 500))

    // 협의 및 지시사항
    rows.push(row([cell({ span: 4, text: "■ 작업 시작전 협의 및 지시사항(작업전에 협의할 사항을 음성으로 녹음하세요)", bold: true })], 400))
    rows.push(row([
        cell({ span: 4, valignTop: true, parasXml: paras(doc, m.instructions, { size: 18 }) }),
    ], 1550))

    // 참석자 확인 — 2열(이름/서명 × 2) 최소 15행, 분할점은 인원수에 맞춰 동적 산정
    rows.push(row([cell({ span: 4, text: "■ 참석자 확인(※ TBM에 참여하지 않은 작업자를 확인하여 미팅 참석 유도)", bold: true })], 400))
    rows.push(row([
        cell({ fill: C.gray300, text: "이름", bold: true, align: "CENTER" }),
        cell({ fill: C.gray300, text: "서명", bold: true, align: "CENTER" }),
        cell({ fill: C.gray300, text: "이름", bold: true, align: "CENTER" }),
        cell({ fill: C.gray300, text: "서명", bold: true, align: "CENTER" }),
    ], 400))

    const half = Math.max(15, Math.ceil(parts.length / 2))
    for (let i = 0; i < half; i++) {
        const p1 = parts[i]
        const p2 = parts[i + half]
        rows.push(row([
            cell({ text: p1?.name || "", bold: true, align: "CENTER" }),
            cell({ parasXml: sigParas(doc, partSigs[i], 110, 34) }),
            cell({ text: p2?.name || "", bold: true, align: "CENTER" }),
            cell({ parasXml: sigParas(doc, partSigs[i + half], 110, 34) }),
        ], 550))
    }

    // 여러 건은 표 앞 쪽 나눔으로 구분
    doc.paras.push(tablePara(doc, grid([15, 35, 15, 35]), rows, !first))

    // --- 다음 쪽: 현장 사진 (교육일지와 같은 규격) ---
    doc.paras.push(para(doc, { align: "CENTER", breakBefore: true, char: { bold: true, size: 44 }, text: "현 장 사 진" }))
    doc.paras.push(
        photo
            ? para(doc, { align: "CENTER", runsXml: picRunXml(doc, photo, 680, 780) })
            : para(doc, { align: "CENTER", char: { bold: true, color: C.gray500 }, text: "등록된 현장 사진이 없습니다." })
    )

    // 원문은 이 건의 맨 뒤 — 다음 건도 쪽 나눔으로 시작하므로 건끼리 섞이지 않는다
    doc.paras.push(...transcriptParas(doc, m.raw_transcript))
}

// ---------------- 안전보건교육일지 (exportDocx.educationChildren과 동일 구성) ----------------

async function addEducation(doc: HwpxDoc, item: EducationDocItem, stats: ImageLoadStats, first: boolean): Promise<void> {
    const log = item.log
    const parts = item.participants || []

    const [instructorSig, photo, ...partSigs] = await Promise.all([
        // 뷰와 동일: 검토 확인 서명 우선, 없으면 실시자 서명
        loadImage(log.confirmation_signature || log.instructor_signature, stats),
        loadImage(log.photo_url, stats, { photo: true }),
        ...parts.map((p) => loadImage(p.signature, stats)),
    ])

    const title = (text: string, breakBefore: boolean): string =>
        para(doc, { align: "CENTER", breakBefore, char: { bold: true, size: 44 }, text })

    // --- PAGE 1: 교육일지 ---
    doc.paras.push(title("안 전 보 건 교 육 일 지", !first))

    const rows: HRow[] = []

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
        cell({ text: "교육 명칭", fill: C.gray100, bold: true, align: "CENTER" }),
        cell({ span: 5, parasXml: checkLines.map((l) => para(doc, { text: l })) }),
    ], 900))

    // 교육 인원 (구분/계/비고)
    // 남/여 칸 삭제(2026-08-22 Chris) — 앱·QR 서명 어디서도 성별을 묻지 않기로 했다.
    // 물어보지 않은 값을 칸만 남겨두면 전원이 '남'으로 찍힌다.
    const totalCount = parts.length
    rows.push(row([
        cell({ text: "교육 인원", fill: C.gray100, bold: true, align: "CENTER", rowSpan: 3 }),
        cell({ text: "구분", fill: C.gray50, bold: true, align: "CENTER" }),
        cell({ text: "계", fill: C.gray50, bold: true, align: "CENTER" }),
        cell({ span: 3, text: "비고", fill: C.gray50, bold: true, align: "CENTER" }),
    ], 400))
    for (const label of ["대상 인원", "참석 인원"]) {
        rows.push(row([
            cell({ text: label, bold: true, align: "CENTER" }),
            cell({ text: String(totalCount), align: "CENTER" }),
            cell({ span: 3, text: "", align: "CENTER" }),
        ], 400))
    }

    // 시간/장소/방법
    rows.push(row([
        cell({ text: "교육 시간", fill: C.gray100, bold: true, align: "CENTER" }),
        cell({ span: 5, text: `${dateKo(log.date)}   ${timeRange(log.start_time, log.end_time)}`, align: "CENTER" }),
    ], 500))
    rows.push(row([
        cell({ text: "교육 장소", fill: C.gray100, bold: true, align: "CENTER" }),
        cell({ span: 5, text: log.location ?? "" }),
    ], 500))
    rows.push(row([
        cell({ text: "교육 방법", fill: C.gray100, bold: true, align: "CENTER" }),
        cell({ span: 5, text: "강의식 / 시청각 교육 / 현장 TBM" }),
    ], 500))

    // 교육 내용 (본문 대영역)
    rows.push(row([
        cell({ text: "교육 내용", fill: C.gray100, bold: true, align: "CENTER" }),
        cell({ span: 5, valignTop: true, parasXml: paras(doc, log.education_content, { size: 18 }) }),
    ], 4500))

    // 교육 실시자 (관리감독자) + 서명 + 법적 책임 동의 문구
    rows.push(row([
        cell({ fill: C.gray100, rowSpan: 3, text: "교육 실시자\n(관리감독자)", bold: true, align: "CENTER" }),
        cell({ span: 2, text: "소속 및 직위", fill: C.gray50, bold: true, align: "CENTER" }),
        cell({ span: 2, text: "성 명", fill: C.gray50, bold: true, align: "CENTER" }),
        cell({ text: "서 명", fill: C.gray50, bold: true, align: "CENTER" }),
    ], 400))
    rows.push(row([
        cell({ span: 2, text: log.company_name ?? "", align: "CENTER" }),
        cell({ span: 2, text: log.instructor_name ?? "", bold: true, align: "CENTER" }),
        cell({ parasXml: sigParas(doc, instructorSig, 110, 45) }),
    ], 850))
    rows.push(row([
        cell({ span: 5, text: "본인은 일지의 내용을 정확하게 확인하였으며, 최종 검토 및 수정의 법적 책임이 본인에게 있음을 동의합니다.", size: 14, color: C.gray500 }),
    ], 400))

    // 특이사항 (뷰와 동일하게 빨간 강조)
    rows.push(row([
        cell({ text: "특 이 사 항\n(기타 전달사항 등)", bold: true, align: "CENTER", fill: C.gray100 }),
        cell({ span: 5, valignTop: true, parasXml: paras(doc, log.remarks, { size: 18, color: C.red }) }),
    ], 1350))

    doc.paras.push(tablePara(doc, grid([15, 17, 17, 17, 17, 17]), rows))
    doc.paras.push(footerPara(doc, log.company_name))

    // --- PAGE 2+: 참석자 명단 (30명/페이지, 31명 이상도 유실 없이) ---
    const pageCount = Math.max(1, Math.ceil(parts.length / 30))
    for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
        const base = pageIdx * 30
        doc.paras.push(title(`교 육 참 석 자 명 단${pageCount > 1 ? ` (${pageIdx + 1}/${pageCount})` : ""}`, true))
        doc.paras.push(para(doc, {
            char: { bold: true },
            text: `일시: ${log.date ?? ""}      업체명: ${log.company_name ?? ""}      근무조: 주간/야간`,
        }))

        const listRows: HRow[] = [row([
            cell({ text: "순번", fill: C.gray100, bold: true, align: "CENTER" }),
            cell({ text: "이 름", fill: C.gray100, bold: true, align: "CENTER" }),
            cell({ text: "서 명", fill: C.gray100, bold: true, align: "CENTER" }),
            cell({ text: "순번", fill: C.gray100, bold: true, align: "CENTER" }),
            cell({ text: "이 름", fill: C.gray100, bold: true, align: "CENTER" }),
            cell({ text: "서 명", fill: C.gray100, bold: true, align: "CENTER" }),
        ], 500)]
        for (let i = 0; i < 15; i++) {
            const i1 = base + i
            const i2 = base + i + 15
            listRows.push(row([
                cell({ text: String(i1 + 1), align: "CENTER" }),
                cell({ text: parts[i1]?.name || "", bold: true, size: 24, align: "CENTER" }),
                cell({ parasXml: sigParas(doc, partSigs[i1], 120, 42) }),
                cell({ text: String(i2 + 1), align: "CENTER" }),
                cell({ text: parts[i2]?.name || "", bold: true, size: 24, align: "CENTER" }),
                cell({ parasXml: sigParas(doc, partSigs[i2], 120, 42) }),
            ], 750))
        }
        doc.paras.push(tablePara(doc, grid([10, 25, 15, 10, 25, 15]), listRows))
        doc.paras.push(footerPara(doc, log.company_name))
    }

    // --- PAGE 3: 교육 사진 ---
    doc.paras.push(title("교 육 사 진", true))
    doc.paras.push(
        photo
            ? para(doc, { align: "CENTER", runsXml: picRunXml(doc, photo, 680, 780) })
            : para(doc, { align: "CENTER", char: { bold: true, color: C.gray500 }, text: "등록된 현장 사진이 없습니다." })
    )
    doc.paras.push(footerPara(doc, log.company_name))

    // --- PAGE 4: 음성 원문 (원문이 있을 때만) ---
    const transcript = transcriptParas(doc, log.raw_transcript)
    if (transcript.length > 0) {
        doc.paras.push(...transcript)
        // 이 문서의 모든 페이지가 현장명 푸터로 끝나므로 원문 페이지도 동일하게 맞춘다
        doc.paras.push(footerPara(doc, log.company_name))
    }
}

// ---------------- 공개 API (exportDocx와 대칭) ----------------

export interface HwpxBuildResult {
    blob: Blob
    /** 불러오지 못해 문서에서 빠진 서명·사진 수 — 0이 아니면 저장 전 사용자에게 알릴 것 */
    imageFailures: number
}

/** TBM 회의록 .hwpx — 1건이면 단건, 여러 건이면 건 사이 자동 쪽 나눔 */
export async function buildMinutesHwpx(items: MinutesDocItem[]): Promise<HwpxBuildResult> {
    const stats: ImageLoadStats = { failures: 0 }
    const doc = new HwpxDoc("TBM 회의록")
    // 일괄 수백 건이 사진·서명 버퍼를 동시에 적재하면 모바일 탭이 OOM으로 죽을 수 있어 문서 단위 순차 처리
    let first = true
    for (const item of items) {
        await addMinutes(doc, item, stats, first)
        first = false
    }
    return { blob: await doc.pack(), imageFailures: stats.failures }
}

/** 안전보건교육일지 .hwpx — 건마다 일지·참석자 명단·사진 페이지 구성, 여러 건은 쪽 나눔으로 분리 */
export async function buildEducationHwpx(items: EducationDocItem[]): Promise<HwpxBuildResult> {
    const stats: ImageLoadStats = { failures: 0 }
    const doc = new HwpxDoc("안전보건교육일지")
    let first = true
    for (const item of items) {
        await addEducation(doc, item, stats, first)
        first = false
    }
    return { blob: await doc.pack(), imageFailures: stats.failures }
}

/** 예: "TBM회의록_2026-07-18_비트플립.hwpx" (일괄이면 dateLabel에 기간 문자열) */
export function suggestHwpxFilename(kind: "minutes" | "education", dateLabel: string, company?: string): string {
    const base = kind === "minutes" ? "TBM회의록" : "안전보건교육일지"
    return [base, dateLabel, company]
        .filter(Boolean)
        .join("_")
        .replace(/[\\/:*?"<>|]/g, "-") + ".hwpx"
}
