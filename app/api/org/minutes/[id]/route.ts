// app/api/org/minutes/[id]/route.ts — 감독자의 자식 현장 회의록 열람 (읽기 전용 폴백)
// /report/minutes/[id] 뷰어는 RLS 직조회라 본인 문서만 열린다 — 감독자가 자식 현장
// 문서 id로 진입하면 빈 화면이 되므로, 서버 경유(§4-A)로 조직 관계를 검증하고 내려준다.
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";

// lib/storageSign.ts와 동일한 파싱 — 거긴 클라이언트 supabase로 서명하는데, 감독자는
// 자식 현장 버킷 경로에 서명 권한이 없어 여기서 admin으로 대신 발급한다.
const PUBLIC_RE = /\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/;

/** 저장된 public URL들을 admin 권한 signed URL(1일)로 — data:·비매칭 값은 원본 유지 */
async function resolveSignedMapAdmin(
  admin: SupabaseClient,
  urls: (string | null | undefined)[],
): Promise<Record<string, string>> {
  const byBucket = new Map<string, { url: string; path: string }[]>();
  for (const u of urls) {
    if (!u || typeof u !== "string" || u.startsWith("data:")) continue;
    const m = u.match(PUBLIC_RE);
    if (!m) continue;
    const bucket = m[1];
    const path = decodeURIComponent(m[2].split("?")[0]);
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket)!.push({ url: u, path });
  }
  const map: Record<string, string> = {};
  for (const [bucket, items] of byBucket) {
    const { data, error } = await admin.storage
      .from(bucket)
      .createSignedUrls(items.map((i) => i.path), 60 * 60 * 24);
    if (error || !data) continue;
    data.forEach((d, i) => {
      if (d.signedUrl) map[items[i].url] = d.signedUrl;
    });
  }
  return map;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const { id } = await params;
  const admin = getAdminClient();
  const { data: minute } = await admin.from("tbm_minutes").select("*").eq("id", id).maybeSingle();
  if (!minute) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  // 본인 문서가 아니면 감독자→활성 하위 현장 관계일 때만 허용
  if (minute.user_id !== user.id) {
    const ctx = await getOrgContext(user.id, admin);
    if (!(ctx.kind === "owner" && (ctx.memberIds ?? []).includes(minute.user_id))) {
      return NextResponse.json({ error: "우리 조직의 현장 문서가 아닙니다." }, { status: 403 });
    }
  }

  const { data: partData } = await admin
    .from("tbm_minutes_participants")
    .select("*")
    .eq("minutes_id", id)
    .order("id", { ascending: true });
  const participants = (partData ?? []) as { signature: string | null }[];

  // 서명 이미지는 서버에서 signed URL까지 만들어 내려준다 — 클라이언트 재서명 불필요
  const sig = await resolveSignedMapAdmin(admin, [
    minute.leader_signature,
    ...participants.map((p) => p.signature),
  ]);
  const signedUrl = <T extends string | null | undefined>(u: T): T => (u ? ((sig[u] ?? u) as T) : u);

  // 현장명 — 뷰어의 읽기 전용 배지용 (조회 실패해도 열람은 막지 않는다)
  let siteName = "현장";
  try {
    const { data: u } = await admin.auth.admin.getUserById(minute.user_id);
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    siteName =
      String(meta.site_name ?? "").trim() || String(meta.company_name ?? "").trim() || "현장";
  } catch { /* 무시 */ }

  return NextResponse.json({
    minutes: { ...minute, leader_signature: signedUrl(minute.leader_signature) },
    participants: participants.map((p) => ({ ...p, signature: signedUrl(p.signature) })),
    siteName,
  });
}
