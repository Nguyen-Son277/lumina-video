import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../../server/db/index'
import { listUsageEvents, usageSummary, type UsageFilters, type UsageTotals } from '../../server/usage/service'

let db: Database
const day1 = Date.UTC(2026, 0, 1)
const day2 = Date.UTC(2026, 0, 2)
const statuses = ['succeeded', 'failed', 'unknown', 'queued'] as const

beforeAll(() => {
  db = openDatabase(':memory:')
  const user = db.prepare(`INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?, 'hash','salt',?)`)
  user.run('summary-owner', 'summary-owner@example.com', day1)
  user.run('summary-other', 'summary-other@example.com', day1)
  db.prepare(`INSERT INTO provider_connections
    (id,user_id,name,base_url,api_key_ciphertext,api_key_iv,api_key_tag,created_at,updated_at)
    VALUES ('summary-provider','summary-owner','Provider','https://mock.test',X'00',X'00',X'00',?,?)`).run(day1, day1)
  const model = db.prepare(`INSERT INTO models
    (id,user_id,provider_id,model_id,display_name,kind,price_unit,price_input_1k,price_output_1k,created_at,updated_at)
    VALUES (?,'summary-owner','summary-provider',?,?,?,?,?,?,?,?)`)
  model.run('summary-image', 'image', 'Image', 'image', 2, null, null, day1, day1)
  model.run('summary-video', 'video', 'Video', 'video', 3, null, null, day1, day1)
  model.run('summary-llm', 'llm', 'LLM', 'llm', null, 1, 3, day1, day1)
  const media = db.prepare(`INSERT INTO generations
    (id,user_id,model_pk,provider_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,attempt_count,created_at,updated_at)
    VALUES (?,?,?,'summary-provider',?,?,'Provider','https://mock.test','mock',?,?,?,?)`)
  const llm = db.prepare(`INSERT INTO llm_usage
    (id,user_id,model_pk,source,preview,response_preview,prompt_tokens,completion_tokens,status,created_at)
    VALUES (?,'summary-owner','summary-llm','planner_chat','plain request',?,1000,2000,?,?)`)
  db.exec('BEGIN')
  try {
    for (let i = 0; i < 20_016; i++) {
      const time = i < 10_008 ? day1 : day2
      media.run(`summary-image-${i}`, 'summary-owner', 'summary-image', 'image', 'bulk image', statuses[i % 4]!, i % 4 === 1 ? 2 : 1, time, time)
    }
    for (let i = 0; i < 8; i++) {
      const time = i < 4 ? day1 : day2
      media.run(`summary-video-${i}`, 'summary-owner', 'summary-video', 'video', 'filter marker', statuses[i % 4]!, 1, time, time)
    }
    for (let i = 0; i < 12; i++) llm.run(`summary-llm-${i}`, 'filter marker', i % 2 ? 'error' : 'ok', i < 6 ? day1 : day2)
    media.run('summary-other-event', 'summary-other', 'summary-video', 'video', 'filter marker', 'failed', 1, day1, day1)
    db.prepare(`INSERT INTO assets (id,generation_id,user_id,relative_path,mime_type,byte_size,created_at)
      VALUES ('summary-asset','summary-image-0','summary-owner','image.png','image/png',17,?)`).run(day1)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
})
afterAll(() => { db?.close() })

function totals(overrides: Partial<UsageTotals>): UsageTotals {
  return { count: 0, ok: 0, failed: 0, unknown: 0, pending: 0, cost: 0, costUnknownCount: 0, promptTokens: 0, completionTokens: 0, byteSize: 0, ...overrides }
}

describe('complete streaming usage summaries', () => {
  it('includes more than 20,000 events with exact totals, daily and model buckets, ignoring pagination', () => {
    const result = usageSummary(db, { userId: 'summary-owner', limit: 1, offset: 99_999 })
    expect(result.totals).toEqual({
      image: totals({ count: 20_016, ok: 5004, failed: 5004, unknown: 5004, pending: 5004, cost: 40_032, byteSize: 17 }),
      video: totals({ count: 8, ok: 2, failed: 2, unknown: 2, pending: 2, cost: 24 }),
      llm: totals({ count: 12, ok: 6, failed: 6, cost: 84, promptTokens: 12_000, completionTokens: 24_000 }),
    })
    expect(result.overall).toEqual(totals({
      count: 20_036, ok: 5012, failed: 5012, unknown: 5006, pending: 5006,
      cost: 40_140, promptTokens: 12_000, completionTokens: 24_000, byteSize: 17,
    }))
    expect(result.daily).toEqual(['2026-01-01', '2026-01-02'].flatMap(date => [
      { date, kind: 'image', count: 10_008, cost: 20_016 },
      { date, kind: 'llm', count: 6, cost: 42 },
      { date, kind: 'video', count: 4, cost: 12 },
    ]))
    expect(result.byModel).toEqual([
      { modelPk: 'summary-image', modelName: 'Image', kind: 'image', count: 20_016, cost: 40_032 },
      { modelPk: 'summary-llm', modelName: 'LLM', kind: 'llm', count: 12, cost: 84 },
      { modelPk: 'summary-video', modelName: 'Video', kind: 'video', count: 8, cost: 24 },
    ])
    expect(result.waste).toEqual({ failedCount: 15_024, failedCost: 30_084, retriedCount: 5004, duplicateSceneGenerations: 0 })
    expect(result.currency).toBe('USD')
    expect(result.mediaBytes).toBe(17)
  })

  it('preserves listing filter parity including failed LLM calls, pending media, and inclusive dates', () => {
    const cases: UsageFilters[] = [
      { userId: 'summary-owner', kinds: ['video', 'llm'], q: 'filter marker', outcomes: ['failed', 'pending'] },
      { userId: 'summary-owner', kinds: ['video'], modelPk: 'summary-video', from: day2, to: day2, outcomes: ['pending'] },
      { userId: 'summary-owner', kinds: ['llm'], modelPk: 'summary-llm', q: 'filter marker', from: day1, to: day1, outcomes: ['failed'] },
      { userId: 'summary-other', kinds: ['video'], q: 'filter marker', outcomes: ['failed'] },
      { userId: 'summary-owner', kinds: ['video', 'llm'], q: 'does not exist' },
    ]
    const counts = [10, 1, 3, 1, 0]
    cases.forEach((filters, index) => {
      const listed = listUsageEvents(db, { ...filters, limit: 200 })
      const summary = usageSummary(db, { ...filters, limit: 1, offset: 1000 })
      expect(listed.total).toBe(counts[index])
      const expected = totals({})
      for (const event of listed.events) {
        expected.count++
        expected[event.outcome]++
        expected.cost += event.cost ?? 0
        expected.costUnknownCount += Number(event.costUnknown)
        expected.promptTokens += event.promptTokens ?? 0
        expected.completionTokens += event.completionTokens ?? 0
        expected.byteSize += event.byteSize
      }
      expect(summary.overall).toEqual(expected)
      // Stored media bytes deliberately remain user-scoped, not event-filtered.
      expect(summary.mediaBytes).toBe(filters.userId === 'summary-owner' ? 17 : 0)
    })
  })

  it('keeps ordinary listing pagination capped at 200 with the original total and offset', () => {
    const first = listUsageEvents(db, { userId: 'summary-owner', limit: 50_000 })
    const second = listUsageEvents(db, { userId: 'summary-owner', limit: 50_000, offset: 200 })
    expect(first.events).toHaveLength(200)
    expect(second.events).toHaveLength(200)
    expect(first.total).toBe(20_036)
    expect(second.total).toBe(first.total)
    expect(new Set([...first.events, ...second.events].map(event => event.id)).size).toBe(400)
  })

  it('does not populate the listing email cache even when withUserEmail is requested', () => {
    usageSummary(db, { userId: 'summary-other', withUserEmail: true })
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run('updated-summary@example.com', 'summary-other')
    expect(listUsageEvents(db, { userId: 'summary-other', withUserEmail: true }).events[0]?.userEmail)
      .toBe('updated-summary@example.com')
  })
})
