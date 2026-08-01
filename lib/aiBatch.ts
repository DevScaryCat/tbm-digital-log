// AI 요청 배치 실행기 — 크론(월간·주간 보고서)처럼 사용자가 기다리지 않는 경로 전용.
// 한 실행에서 생기는 Haiku 요청을 전부 모아 Batch API(요금 50% 할인)로 처리한다.
// 발송이 늦어지면 안 되므로 시간 예산 안에 안 끝나면 배치를 취소하고 잡별 동기 폴백 —
// 최악의 경우가 "오늘과 동일한 비용·품질"이 되도록 설계했다 (할인은 보너스, 발송이 우선).
import Anthropic from "@anthropic-ai/sdk";

export interface DeferredAiJob {
  /** messages.create와 동일한 파라미터 (Batch 항목으로 그대로 전달) */
  params: Anthropic.Messages.MessageCreateParamsNonStreaming;
  /** 배치 성공 시 결과 반영 */
  apply: (msg: Anthropic.Message) => void;
  /** 배치 실패·시간 초과 시 동기 호출 폴백 (기존 경로 그대로) */
  fallback: () => Promise<void>;
}

export class AiBatch {
  private jobs: DeferredAiJob[] = [];

  defer(job: DeferredAiJob): void {
    this.jobs.push(job);
  }

  get size(): number {
    return this.jobs.length;
  }

  /**
   * 모아둔 요청을 하나의 배치로 실행하고 결과를 각 잡에 반영한다.
   * 반환값은 관측용 카운트 — 실패해도 throw하지 않는다(폴백이 항상 마무리).
   */
  async flush(timeoutMs = 120_000): Promise<{ batched: number; fallback: number }> {
    const jobs = this.jobs;
    this.jobs = [];
    const out = { batched: 0, fallback: 0 };
    if (jobs.length === 0) return out;

    const pending = new Map<string, DeferredAiJob>();
    jobs.forEach((j, i) => pending.set(`job_${i}`, j));

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      const anthropic = new Anthropic({ apiKey });
      let batchId: string | null = null;
      try {
        const batch = await anthropic.messages.batches.create({
          requests: [...pending.entries()].map(([custom_id, j]) => ({ custom_id, params: j.params })),
        });
        batchId = batch.id;

        const deadline = Date.now() + timeoutMs;
        let status = batch;
        while (status.processing_status !== "ended") {
          if (Date.now() > deadline) throw new Error(`batch timeout (${jobs.length} jobs)`);
          await new Promise((r) => setTimeout(r, 5_000));
          status = await anthropic.messages.batches.retrieve(batchId);
        }

        const results = await anthropic.messages.batches.results(batchId);
        for await (const entry of results) {
          const job = pending.get(entry.custom_id);
          if (!job) continue;
          if (entry.result.type === "succeeded") {
            job.apply(entry.result.message);
            pending.delete(entry.custom_id);
            out.batched++;
          }
          // errored/expired/canceled → pending에 남겨 폴백으로
        }
      } catch (e) {
        console.error("ai batch error:", e);
        // 시간 초과 시 미처리분 과금 방지 — 취소 실패는 무시(이미 끝났을 수 있음)
        if (batchId) {
          try { await anthropic.messages.batches.cancel(batchId); } catch { /* 무시 */ }
        }
      }
    }

    // 남은 잡(배치 실패·시간 초과·개별 오류)은 동기 폴백 — 보고서 품질은 기존과 동일 유지
    for (const job of pending.values()) {
      try {
        await job.fallback();
        out.fallback++;
      } catch (e) {
        console.error("ai batch fallback error:", e);
      }
    }
    return out;
  }
}
