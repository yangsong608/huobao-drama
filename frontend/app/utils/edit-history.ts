import type { EditPlanV1 } from './edit-plan'

export interface EditHistory {
  past: EditPlanV1[]
  present: EditPlanV1
  future: EditPlanV1[]
  limit: number
}

export function createEditHistory(plan: EditPlanV1, limit = 50): EditHistory {
  return { past: [], present: plan, future: [], limit: Math.max(1, limit) }
}

export function pushEditHistory(history: EditHistory, plan: EditPlanV1): EditHistory {
  if (JSON.stringify(history.present) === JSON.stringify(plan)) return history
  const past = [...history.past, history.present].slice(-history.limit)
  return { ...history, past, present: plan, future: [] }
}

export function undoEditHistory(history: EditHistory): EditHistory {
  if (!history.past.length) return history
  const present = history.past[history.past.length - 1]
  return {
    ...history,
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future].slice(0, history.limit),
  }
}

export function redoEditHistory(history: EditHistory): EditHistory {
  if (!history.future.length) return history
  const [present, ...future] = history.future
  return {
    ...history,
    past: [...history.past, history.present].slice(-history.limit),
    present,
    future,
  }
}

export function canUndo(history: EditHistory): boolean {
  return history.past.length > 0
}

export function canRedo(history: EditHistory): boolean {
  return history.future.length > 0
}
