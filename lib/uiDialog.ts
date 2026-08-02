// lib/uiDialog.ts — 브라우저 기본 alert()/confirm() 대체.
//
// 기본 대화상자는 (1) 브랜드 밖의 OS 창이라 앱이 갑자기 남의 화면처럼 보이고,
// (2) 인앱 브라우저·iOS에서 문구가 잘리거나 URL이 함께 노출되며,
// (3) 줄바꿈·강조가 안 먹어 긴 안내가 읽히지 않는다.
//
// 화면 어디서든(훅이 아닌 곳, 이벤트 핸들러 안에서도) 부를 수 있게 모듈 수준 큐로 만들고,
// components/DialogHost가 layout에서 하나만 구독해 그린다.
//
// 호스트가 없는 상황(마운트 전, 예외적 경로)에서는 **기본 대화상자로 폴백**한다 —
// 안내가 조용히 사라지는 것이 제일 나쁜 결과이므로.

export type DialogRequest = {
  id: number
  title?: string
  message: string
  /** true면 [취소][확인] 2버튼(확인 시 resolve(true)), false면 [확인] 1버튼 */
  isConfirm: boolean
  /** 확인 버튼 문구 — 삭제처럼 되돌릴 수 없는 행동은 여기서 무엇을 하는지 말한다 */
  confirmText?: string
  /** 확인 버튼을 위험색으로 (삭제·해지) */
  danger?: boolean
  resolve: (ok: boolean) => void
}

let seq = 0
const queue: DialogRequest[] = []
let notify: (() => void) | null = null

/** DialogHost 전용 — 큐가 바뀔 때 다시 그리도록 구독한다 */
export function subscribeDialogs(fn: () => void): () => void {
  notify = fn
  return () => { if (notify === fn) notify = null }
}

/** DialogHost 전용 — 지금 보여줄 요청(맨 앞) */
export function peekDialog(): DialogRequest | null {
  return queue[0] ?? null
}

/** DialogHost 전용 — 응답 후 큐에서 제거 */
export function resolveDialog(id: number, ok: boolean): void {
  const i = queue.findIndex((d) => d.id === id)
  if (i < 0) return
  const [d] = queue.splice(i, 1)
  d.resolve(ok)
  notify?.()
}

function enqueue(req: Omit<DialogRequest, "id">): boolean {
  // 호스트 미구독 = 그릴 사람이 없다 → 기본 대화상자로 폴백(안내 유실 방지)
  if (!notify) return false
  queue.push({ ...req, id: ++seq })
  notify()
  return true
}

export type DialogOptions = { title?: string; confirmText?: string; danger?: boolean }

/** 안내 1개 — 기본 alert() 자리. 호출부가 기다릴 필요 없다. */
export function showAlert(message: string, opts?: DialogOptions): void {
  const queued = enqueue({ message, isConfirm: false, resolve: () => {}, ...opts })
  if (!queued && typeof window !== "undefined") window.alert(message)
}

/** 예/아니오 — 기본 confirm() 자리. 확인이면 true. */
export function showConfirm(message: string, opts?: DialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const queued = enqueue({ message, isConfirm: true, resolve, ...opts })
    if (!queued) resolve(typeof window === "undefined" ? false : window.confirm(message))
  })
}
