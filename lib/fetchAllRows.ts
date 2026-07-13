// PostgREST(수파베이스 REST)는 한 요청당 최대 1000행에서 "침묵 절단"한다 —
// 에러 없이 잘려서 카운트·달력·통계가 조용히 틀어지는 것을 막기 위한 페이지 순회 조회.
// build(from, to)는 반드시 안정적인 정렬(.order('id') 등 유니크 키)을 포함해야
// 페이지 사이에 행이 끼거나 빠지지 않는다.
export async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) throw new Error(error.message || 'fetchAllRows 실패')
    const rows = data || []
    all.push(...rows)
    if (rows.length < pageSize) return all
  }
}
