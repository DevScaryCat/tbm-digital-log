// lib/approvalPdf.tsx — 결재서류 PDF 생성 (react-pdf, 한글 폰트 임베드)
import React from "react";
import { Document, Page, View, Text, Svg, Rect, Font, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import type { ReportContent } from "@/lib/monthlyReport";

const FONT = "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nanumgothic";
let fontReady = false;
function ensureFont() {
  if (fontReady) return;
  Font.register({
    family: "Nanum",
    fonts: [
      { src: `${FONT}/NanumGothic-Regular.ttf` },
      { src: `${FONT}/NanumGothic-Bold.ttf`, fontWeight: "bold" },
    ],
  });
  Font.registerHyphenationCallback((w) => [w]); // 한글 줄바꿈 깨짐 방지
  fontReady = true;
}

const C = {
  ink: "#26251e", body: "#444", muted: "#807d72", line: "#d9d7cf",
  primary: "#f54e00", high: "#cf2d56", mid: "#d4691a", low: "#1f8a65",
  highBg: "#fdecef", midBg: "#fff1e3", soft: "#fafaf7", chipBg: "#f1f0ea",
};

const s = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 40, paddingHorizontal: 34, fontFamily: "Nanum", fontSize: 9.5, color: C.body, lineHeight: 1.5 },
  header: { position: "relative", minHeight: 74, marginBottom: 14 },
  appAbs: { position: "absolute", top: 0, right: 0 },
  brand: { fontSize: 8.5, color: C.primary, fontWeight: "bold" },
  title: { fontSize: 17, color: C.ink, fontWeight: "bold", marginTop: 7, marginRight: 178, lineHeight: 1.25 },
  company: { fontSize: 10, color: C.muted, marginTop: 7, lineHeight: 1.3 },
  // 결재란
  appBox: { flexDirection: "row", borderWidth: 0.8, borderColor: C.ink },
  appLabel: { width: 16, alignItems: "center", justifyContent: "center", borderRightWidth: 0.8, borderColor: C.ink, paddingVertical: 4 },
  appLabelTxt: { fontSize: 8, color: C.ink, fontWeight: "bold" },
  appCol: { width: 52, borderRightWidth: 0.8, borderColor: C.ink },
  appColLast: { width: 52 },
  appHead: { fontSize: 7.5, color: C.ink, textAlign: "center", paddingVertical: 2.5, borderBottomWidth: 0.8, borderColor: C.ink, backgroundColor: "#f4f3ee" },
  appStamp: { height: 38 },
  sectionTitle: { fontSize: 11.5, color: C.ink, fontWeight: "bold", marginTop: 14, marginBottom: 6 },
  // 통계
  statRow: { flexDirection: "row", gap: 8, marginBottom: 4 },
  statCell: { flex: 1, borderWidth: 0.8, borderColor: C.line, borderRadius: 4, paddingVertical: 8, alignItems: "center" },
  statLabel: { fontSize: 8.5, color: C.muted, marginBottom: 3 },
  statVal: { fontSize: 16, fontWeight: "bold", color: C.ink },
  // AI 총평
  aiBox: { backgroundColor: C.soft, borderWidth: 0.8, borderColor: C.line, borderRadius: 5, padding: 10 },
  aiHead: { fontSize: 9, fontWeight: "bold", color: C.primary, marginBottom: 4 },
  // 키워드
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  chip: { backgroundColor: C.chipBg, borderWidth: 0.5, borderColor: C.line, borderRadius: 9, paddingHorizontal: 7, paddingVertical: 2, fontSize: 8.5, color: C.ink },
  // 표
  table: { borderWidth: 0.8, borderColor: C.line, borderRadius: 4 },
  th: { flexDirection: "row", backgroundColor: "#f4f3ee", borderBottomWidth: 0.8, borderColor: C.line },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: C.line },
  cell: { paddingVertical: 4, paddingHorizontal: 5, fontSize: 8.5 },
  thTxt: { fontSize: 8, color: C.muted, fontWeight: "bold" },
  badge: { fontSize: 8, fontWeight: "bold", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, alignSelf: "center" },
  foot: { fontSize: 7.5, color: C.muted, textAlign: "center", marginTop: 16, paddingTop: 8, borderTopWidth: 0.5, borderColor: C.line, lineHeight: 1.5 },
});

function gradeColor(level: string) {
  return level === "상" || level === "매우높음" || level === "높음" ? C.high : level === "중" || level === "보통" ? C.mid : C.low;
}
function gradeBg(level: string) {
  return level === "상" || level === "매우높음" || level === "높음" ? C.highBg : level === "중" || level === "보통" ? C.midBg : "#e7f6ee";
}

function Badge({ level }: { level: string }) {
  return <Text style={[s.badge, { color: gradeColor(level), backgroundColor: gradeBg(level) }]}>{level}</Text>;
}

function ApprovalGrid() {
  const cols = ["작성자", "안전관리자", "대표"];
  return (
    <View style={s.appBox}>
      <View style={s.appLabel}><Text style={s.appLabelTxt}>결</Text><Text style={s.appLabelTxt}>재</Text></View>
      {cols.map((c, i) => (
        <View key={c} style={i === cols.length - 1 ? s.appColLast : s.appCol}>
          <Text style={s.appHead}>{c}</Text>
          <View style={s.appStamp} />
        </View>
      ))}
    </View>
  );
}

function GradeChart({ high, mid, low }: { high: number; mid: number; low: number }) {
  const data = [
    { label: "상", v: high, color: C.high },
    { label: "중", v: mid, color: C.mid },
    { label: "하", v: low, color: C.low },
  ];
  const max = Math.max(1, high, mid, low);
  const W = 240, H = 70, bw = 46, gap = 28, baseY = H - 14;
  return (
    <View>
      <Svg width={W} height={H}>
        <Rect x={0} y={baseY} width={W} height={0.8} fill={C.line} />
        {data.map((d, i) => {
          const h = Math.round(((baseY - 6) * d.v) / max);
          const x = 6 + i * (bw + gap);
          return <Rect key={d.label} x={x} y={baseY - h} width={bw} height={Math.max(h, 1)} fill={d.color} />;
        })}
      </Svg>
      <View style={{ flexDirection: "row", marginTop: -2 }}>
        {data.map((d, i) => (
          <Text key={d.label} style={{ width: bw, marginLeft: i === 0 ? 6 : gap, fontSize: 8.5, textAlign: "center", color: C.muted }}>
            {d.label} {d.v}
          </Text>
        ))}
      </View>
    </View>
  );
}

function ApprovalDoc({ content, docTitle }: { content: ReportContent; docTitle: string }) {
  const stats = content.stats || { total: 0, high: 0, mid: 0 };
  const keywords = content.keywords || [];
  const hazards = content.hazards || [];
  const riskItems = content.riskItems || [];
  const lowCount = hazards.filter((h) => h.level === "하").length;
  const topWords = keywords.slice(0, 2).map((k) => k.word);

  return (
    <Document title={docTitle} author="안전톡톡e">
      <Page size="A4" style={s.page} wrap>
        <View style={s.header}>
          <View style={s.appAbs}><ApprovalGrid /></View>
          <Text style={s.brand}>안전톡톡e · TBM 회의록 종합분석</Text>
          <Text style={s.title}>{docTitle}</Text>
          <Text style={s.company}>{(content.companyName ? content.companyName + " · " : "") + content.periodLabel}</Text>
        </View>

        {/* 통계 */}
        <View style={s.statRow}>
          <View style={s.statCell}><Text style={s.statLabel}>총 회의록</Text><Text style={s.statVal}>{stats.total}건</Text></View>
          <View style={[s.statCell, { backgroundColor: C.highBg, borderColor: "#f6cdd6" }]}><Text style={[s.statLabel, { color: C.high }]}>위험성 (상)</Text><Text style={[s.statVal, { color: C.high }]}>{stats.high}건</Text></View>
          <View style={[s.statCell, { backgroundColor: C.midBg, borderColor: "#ffd9b3" }]}><Text style={[s.statLabel, { color: C.mid }]}>위험성 (중)</Text><Text style={[s.statVal, { color: C.mid }]}>{stats.mid}건</Text></View>
        </View>

        {/* 등급 분포 그래프 */}
        <View wrap={false}>
          <Text style={s.sectionTitle}>위험등급 분포</Text>
          <GradeChart high={stats.high} mid={stats.mid} low={lowCount} />
        </View>

        {/* AI 총평 */}
        {content.aiSummary ? (
          <View wrap={false}>
            <Text style={s.sectionTitle}>AI 안전 총평</Text>
            <View style={s.aiBox}><Text>{content.aiSummary}</Text></View>
          </View>
        ) : null}

        {/* 핵심 위험 키워드 */}
        {keywords.length > 0 ? (
          <View wrap={false}>
            <Text style={s.sectionTitle}># 핵심 위험 키워드</Text>
            <View style={s.chips}>
              {keywords.map((k) => <Text key={k.word} style={s.chip}>#{k.word} ({k.count})</Text>)}
            </View>
            {topWords.length > 0 ? (
              <Text style={{ fontSize: 8.5, color: C.muted, marginTop: 5 }}>
                {topWords.join(" 및 ")} 관련 위험요인의 언급 빈도가 가장 높습니다. 해당 작업 전 집중 안전점검이 필요합니다.
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* 주요 위험요인 */}
        <Text style={s.sectionTitle} minPresenceAhead={72}>주요 위험요인</Text>
        <View style={s.table}>
          <View style={s.th}>
            <Text style={[s.cell, s.thTxt, { width: 24, textAlign: "center" }]}>No</Text>
            <Text style={[s.cell, s.thTxt, { flex: 1 }]}>유해·위험요인 / 공정</Text>
            <Text style={[s.cell, s.thTxt, { width: 36, textAlign: "center" }]}>등급</Text>
            <Text style={[s.cell, s.thTxt, { flex: 1 }]}>감소대책</Text>
          </View>
          {hazards.length === 0 ? (
            <Text style={[s.cell, { color: C.muted, textAlign: "center", paddingVertical: 8 }]}>집계된 위험요인이 없습니다.</Text>
          ) : hazards.map((h, i) => (
            <View key={i} style={s.tr} wrap={false}>
              <Text style={[s.cell, { width: 24, textAlign: "center", color: C.muted }]}>{i + 1}</Text>
              <View style={[s.cell, { flex: 1 }]}>
                <Text style={{ color: C.ink }}>{h.factor}</Text>
                {h.process ? <Text style={{ fontSize: 7.5, color: C.muted }}>{h.process}{h.date ? ` · ${h.date}` : ""}</Text> : null}
              </View>
              <View style={[s.cell, { width: 36, alignItems: "center" }]}><Badge level={h.level} /></View>
              <Text style={[s.cell, { flex: 1 }]}>{h.measure || "-"}</Text>
            </View>
          ))}
        </View>

        {/* 위험성평가표 */}
        {riskItems.length > 0 ? (
          <>
            <Text style={s.sectionTitle} minPresenceAhead={72}>위험성평가표</Text>
            <View style={s.table}>
              <View style={s.th}>
                <Text style={[s.cell, s.thTxt, { width: 24, textAlign: "center" }]}>No</Text>
                <Text style={[s.cell, s.thTxt, { flex: 1.3 }]}>유해·위험요인 / 원인</Text>
                <Text style={[s.cell, s.thTxt, { width: 50, textAlign: "center" }]}>가능성×중대성</Text>
                <Text style={[s.cell, s.thTxt, { width: 56, textAlign: "center" }]}>위험성</Text>
                <Text style={[s.cell, s.thTxt, { flex: 1 }]}>감소대책</Text>
              </View>
              {riskItems.map((it, i) => (
                <View key={i} style={s.tr} wrap={false}>
                  <Text style={[s.cell, { width: 24, textAlign: "center", color: C.muted }]}>{i + 1}</Text>
                  <View style={[s.cell, { flex: 1.3 }]}>
                    <Text style={{ color: C.ink }}>{it.recurring ? "[반복] " : ""}{it.hazard}</Text>
                    {it.cause ? <Text style={{ fontSize: 7.5, color: C.muted }}>{it.cause}</Text> : null}
                  </View>
                  <Text style={[s.cell, { width: 50, textAlign: "center" }]}>{it.frequency}×{it.severity}</Text>
                  <Text style={[s.cell, { width: 56, textAlign: "center", fontWeight: "bold", color: gradeColor(it.level) }]}>{it.risk} · {it.level}</Text>
                  <Text style={[s.cell, { flex: 1 }]}>{it.measures || "-"}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        <Text style={s.foot}>
          본 결재서류는 안전톡톡e가 {content.periodLabel} TBM 회의록을 분석해 자동 생성했습니다. · 위험요인은 작성된 회의록에서만 집계됩니다.
        </Text>
      </Page>
    </Document>
  );
}

/** 결재서류 PDF 생성 → Buffer */
export async function renderApprovalPdf(content: ReportContent, docTitle: string): Promise<Buffer> {
  ensureFont();
  return renderToBuffer(<ApprovalDoc content={content} docTitle={docTitle} />);
}
