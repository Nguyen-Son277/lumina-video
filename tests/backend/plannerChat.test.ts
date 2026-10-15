import { describe, expect, it } from 'vitest'
import { plannerChatText } from '../../shared/plannerChat'
import { messagePublic, type PlanMessageRow } from '../../server/planner/service'

const fallback = 'Hãy cùng làm rõ ý tưởng.'
describe('Readable planner chat', () => {
  it.each([
    ['Ý tưởng tốt.\n- Video 60 giây\n- Tông ấm áp', 'Ý tưởng tốt.\n- Video 60 giây\n- Tông ấm áp'],
    ['{"reply":"Mình đề xuất 3 cảnh.","run":"script","scenes":[]}', 'Mình đề xuất 3 cảnh.'],
    ['{"reply":"Tóm tắt","summary":"Tóm tắt"}', 'Tóm tắt'],
    ['```json\n{"reply":"Bạn muốn tông vui hay trầm?"}\n```', 'Bạn muốn tông vui hay trầm?'],
    ['Đã thống nhất:\n```json\n{"summary":"Video về tình bạn.","scenes":[]}\n```\nBạn muốn dài bao lâu?', 'Đã thống nhất:\nVideo về tình bạn.\nBạn muốn dài bao lâu?'],
    ['Ý tưởng tốt. {"scenes":[{"action":"technical"}]}', 'Ý tưởng tốt.'],
    [JSON.stringify({ reply: JSON.stringify({ reply: 'Cùng chốt nhân vật nhé.' }) }), 'Cùng chốt nhân vật nhé.'],
    ['{"scenes":[]}', fallback],
    ['[{"reply":"hidden artifact"}]', fallback],
    ['{"reply": "broken', fallback],
    ['```json\n{"scenes": []}\n```', fallback],
    ['Chọn {ý tưởng} và [ghi chú] phù hợp.', 'Chọn {ý tưởng} và [ghi chú] phù hợp.'],
    ['', fallback],
  ])('normalizes %s', (raw, expected) => {
    expect(plannerChatText(raw, fallback)).toBe(expected)
  })

  it('sanitizes old assistant messages without mutating stored rows or user content', () => {
    const row: PlanMessageRow = { id: 'm', session_id: 's', role: 'assistant', content: '{"reply":"Ý tưởng đã chốt.","run":"script"}', created_at: 1 }
    expect(messagePublic(row).content).toBe('Ý tưởng đã chốt.')
    expect(row.content).toContain('"run"')
    expect(messagePublic({ ...row, role: 'user' }).content).toBe(row.content)
  })
})
