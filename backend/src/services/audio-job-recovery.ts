/**
 * 混音作业（dubbing_jobs：环境声/人声分离）是进程内任务，重启后无法续跑。
 * 启动时把 pending/running 收敛为 failed，避免任务中心活跃计数永远不清零。
 */
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export function markInterruptedAudioJobs(): number {
  const ts = now()
  const rows = db.select().from(schema.dubbingJobs)
    .where(inArray(schema.dubbingJobs.status, ['pending', 'running']))
    .all()
  let count = 0
  for (const row of rows) {
    const message = row.kind === 'separate'
      ? '服务重启导致任务中断，请重新分离'
      : '服务重启导致任务中断，请重新生成'
    db.update(schema.dubbingJobs)
      .set({ status: 'failed', error: message, updatedAt: ts, finishedAt: ts })
      .where(eq(schema.dubbingJobs.id, row.id))
      .run()
    count += 1
  }
  return count
}
