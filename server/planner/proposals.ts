import { createHash } from 'node:crypto'
import type { LocationReference, Timeline, TimelineFrame } from './artifacts'

/**
 * So sánh "hiện tại" với "đề xuất" để tạo danh sách thay đổi tất định.
 *
 * Danh sách này do server tự tính, KHÔNG lấy từ lời AI tự liệt kê: người dùng phải
 * chốt đúng những gì hệ thống sắp ghi, nên nó không được phụ thuộc vào việc model
 * có mô tả trung thực hay không.
 */

export type ProposalSurface = 'timeline' | 'locations'

export type ProposalChangeAction =
  | 'add'
  | 'update'
  | 'remove'
  | 'assign'
  | 'unassign'
  | 'reorder'
  | 'frame_update'

export type ProposalChangeField = { field: string; from: string; to: string }

export type ProposalChange = {
  action: ProposalChangeAction
  entity: 'location' | 'frame'
  /** Id ổn định nếu có; rỗng với mục mới. */
  id: string
  /** Tên hiển thị thô (tên bối cảnh, tiêu đề khung); UI dịch nhãn hành động. */
  label: string
  fields: ProposalChangeField[]
}

/** Dấu vân tay trạng thái để phát hiện dữ liệu đã đổi giữa lúc đề xuất và lúc áp dụng. */
export function stampOf(json: string | null | undefined): string {
  return createHash('sha256').update(json ?? 'null').digest('hex').slice(0, 16)
}

const cut = (value: unknown, max = 200): string => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const fieldsDiff = (
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  keys: string[],
): ProposalChangeField[] =>
  keys.flatMap((key) => {
    const before = cut(current[key])
    const after = cut(next[key])
    return before === after ? [] : [{ field: key, from: before, to: after }]
  })

const LOCATION_FIELDS = ['name', 'stage', 'description', 'continuityNotes', 'imagePrompt'] as const

/** Thay đổi của danh sách bối cảnh & tính liên tục. */
export function diffLocations(
  current: LocationReference[],
  next: LocationReference[],
): ProposalChange[] {
  const changes: ProposalChange[] = []
  const currentById = new Map(current.map((item) => [item.id, item]))
  const nextById = new Map(next.map((item) => [item.id, item]))

  for (const item of next) {
    const before = currentById.get(item.id)
    if (!before) {
      changes.push({
        action: 'add',
        entity: 'location',
        id: item.id,
        label: item.name,
        fields: LOCATION_FIELDS.flatMap((field) =>
          item[field] ? [{ field, from: '', to: cut(item[field]) }] : [],
        ),
      })
      continue
    }
    const fields = fieldsDiff(before, item, [...LOCATION_FIELDS])
    if (fields.length) {
      changes.push({ action: 'update', entity: 'location', id: item.id, label: item.name, fields })
    }
  }

  for (const item of current) {
    if (nextById.has(item.id)) continue
    changes.push({ action: 'remove', entity: 'location', id: item.id, label: item.name, fields: [] })
  }

  return changes
}

const FRAME_FIELDS = [
  'title',
  'context',
  'action',
  'dialogue',
  'speaker',
  'durationSeconds',
  'shotNotes',
  'beats',
] as const

/** Thay đổi của timeline: thêm/xoá/sửa khung, đổi thứ tự và đổi bối cảnh gắn cho khung. */
export function diffTimeline(
  current: Timeline | null,
  next: TimelineFrame[],
  locationNameById: Map<string, string>,
): ProposalChange[] {
  const changes: ProposalChange[] = []
  const currentFrames = current?.frames ?? []
  const currentById = new Map(currentFrames.map((frame) => [frame.id, frame]))
  const locationOf = (id: string | null | undefined): string =>
    id ? locationNameById.get(id) ?? id : ''

  const currentOrder = currentFrames.map((frame) => frame.id).filter((id) => next.some((frame) => frame.id === id))
  const nextOrder = next.map((frame) => frame.id).filter((id) => currentById.has(id))
  if (currentOrder.join('|') !== nextOrder.join('|')) {
    changes.push({
      action: 'reorder',
      entity: 'frame',
      id: '',
      label: '',
      fields: [
        {
          field: 'order',
          from: currentOrder.map((id, index) => `${index + 1}. ${currentById.get(id)?.title ?? id}`).join(' → '),
          to: nextOrder.map((id, index) => `${index + 1}. ${currentById.get(id)?.title ?? id}`).join(' → '),
        },
      ],
    })
  }

  for (const frame of next) {
    const before = currentById.get(frame.id)
    if (!before) {
      changes.push({
        action: 'add',
        entity: 'frame',
        id: frame.id,
        label: frame.title,
        fields: FRAME_FIELDS.flatMap((field) =>
          frame[field] ? [{ field, from: '', to: cut(frame[field]) }] : [],
        ),
      })
      continue
    }
    const fields = fieldsDiff(before, frame, [...FRAME_FIELDS])
    if ((before.locationId ?? null) !== (frame.locationId ?? null)) {
      fields.push({
        field: 'locationId',
        from: locationOf(before.locationId),
        to: locationOf(frame.locationId),
      })
    }
    const beforeCast = before.characters.join(', ')
    const afterCast = frame.characters.join(', ')
    if (beforeCast !== afterCast) {
      fields.push({ field: 'characters', from: beforeCast, to: afterCast })
    }
    if (fields.length) {
      changes.push({
        action: fields.every((entry) => entry.field === 'locationId') ? 'assign' : 'frame_update',
        entity: 'frame',
        id: frame.id,
        label: frame.title || before.title,
        fields,
      })
    }
  }

  for (const before of currentFrames) {
    if (next.some((frame) => frame.id === before.id)) continue
    changes.push({ action: 'remove', entity: 'frame', id: before.id, label: before.title, fields: [] })
  }

  return changes
}
