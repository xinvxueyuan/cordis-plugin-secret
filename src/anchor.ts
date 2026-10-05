/**
 * The subset of a live `Session` an approval anchor is read from. Declared
 * structurally so tests can drive it with a fake.
 */
export interface AnchorSessionLike {
  /** Every event of this session's log, in order. */
  snapshotEvents(): readonly {
    readonly type: string
    readonly seq: number
    readonly data?: unknown
  }[]
}
/**
 * Find the sequence of the event that anchors one approval: the assistant
 * message that carried the tool call.
 *
 * That message is a *surface* event (`SessionSurface.nodes` holds it), which is
 * exactly the property the grant check needs: an edit-and-retry rewrites the
 * surface from an earlier user message, so the anchoring assistant message
 * leaves the surface and the grant is revoked, while a compaction that leaves
 * the anchor in place does not.
 *
 * @param session - session to scan.
 * @param callId - the tool call the approval belongs to.
 * @returns the anchoring sequence, or undefined when this session never issued that call.
 */
export function findAnchorSeq(session: AnchorSessionLike, callId: string): number | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const message = (event.data as { message?: { content?: readonly unknown[] } } | undefined)?.message
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const candidate = block as { type?: unknown; id?: unknown }
      if (candidate.type === 'tool-call' && String(candidate.id) === callId) return event.seq
    }
  }
  return undefined
}
