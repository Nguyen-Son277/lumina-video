export type PendingCanvasRun = { stamp: string; key: string }
export type PendingCanvasRuns = Record<string, PendingCanvasRun>

/** Retain uncertain submissions until acknowledged, not merely until fetch settles. */
export function canvasRunKey(pending: PendingCanvasRuns, scope: string, stamp: string, createKey: () => string = () => crypto.randomUUID()): string {
  if (pending[scope]?.stamp !== stamp) pending[scope] = { stamp, key: createKey() }
  return pending[scope]!.key
}

export function acknowledgeCanvasRun(pending: PendingCanvasRuns, scope: string, key: string): void {
  // A late acknowledgement must not clear a newer submission for this node.
  if (pending[scope]?.key === key) delete pending[scope]
}
