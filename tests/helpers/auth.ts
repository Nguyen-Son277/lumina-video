import type { Page } from '@playwright/test'

export const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'

export type TestAccount = {
  email: string
  password: string
}

let counter = 0

/**
 * Đăng ký một tài khoản mới hoàn toàn qua API rồi lưu cookie phiên vào trình duyệt.
 *
 * Mỗi bài test dùng một tài khoản riêng nên luôn bắt đầu với workspace trống,
 * nhờ đó các khẳng định về trạng thái rỗng vẫn đúng.
 */
export async function signUpFresh(page: Page): Promise<TestAccount> {
  counter += 1
  const email = `e2e-${Date.now()}-${counter}@gigone.com`
  const password = 'matkhau-e2e-rat-dai-123'

  const response = await page.request.post(`${BASE}/api/auth/register`, {
    data: { email, password },
  })

  if (!response.ok()) {
    throw new Error(`Đăng ký tài khoản test thất bại: ${response.status()} ${await response.text()}`)
  }

  // Cookie phiên đã được page.request lưu vào context dùng chung với page.
  return { email, password }
}

/** Đăng nhập qua giao diện, dùng khi cần kiểm tra chính form đăng nhập. */
export async function signInViaUi(page: Page, account: TestAccount): Promise<void> {
  await page.goto(BASE)
  await page.getByPlaceholder('ban@example.com').fill(account.email)
  await page.getByPlaceholder('Nhập mật khẩu').fill(account.password)
  await page.getByRole('button', { name: 'Đăng nhập' }).click()
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.getByRole('heading', { name: /Tạo nội dung/ }).waitFor()
}

/** Thêm provider qua API để test không phụ thuộc modal. */
export async function seedProvider(
  page: Page,
  options: { name?: string; baseUrl?: string; apiKey?: string } = {},
): Promise<string> {
  const response = await page.request.post(`${BASE}/api/providers`, {
    data: {
      name: options.name ?? 'Provider test',
      baseUrl: options.baseUrl ?? 'https://e2e.mock.test/v1',
      apiKey: options.apiKey ?? 'sk-e2e-test-key',
    },
  })
  if (!response.ok()) {
    throw new Error(`Tạo provider thất bại: ${response.status()} ${await response.text()}`)
  }
  const body = (await response.json()) as { provider: { id: string } }
  return body.provider.id
}

/** Thêm model qua API với phân loại cho trước. */
export async function seedModel(
  page: Page,
  providerId: string,
  options: { modelId?: string; displayName?: string; kind?: 'image' | 'video' | 'llm' | 'unclassified' } = {},
): Promise<string> {
  const response = await page.request.post(`${BASE}/api/models`, {
    data: {
      providerId,
      modelId: options.modelId ?? 'mock-image-model',
      displayName: options.displayName ?? 'Mock Image',
      kind: options.kind ?? 'image',
    },
  })
  if (!response.ok()) {
    throw new Error(`Tạo model thất bại: ${response.status()} ${await response.text()}`)
  }
  const body = (await response.json()) as { model: { id: string } }
  return body.model.id
}

/**
 * Thêm provider + model LLM & Chat qua API để test tính năng văn bản mà không
 * phụ thuộc modal. Trả về id dòng model.
 */
export async function seedLlmModel(
  page: Page,
  options: { baseUrl?: string; apiKey?: string; modelId?: string } = {},
): Promise<string> {
  const providerId = await seedProvider(page, {
    name: 'LLM provider',
    baseUrl: options.baseUrl ?? 'https://llm.mock.test/v1',
    apiKey: options.apiKey ?? 'sk-llm-abcd1234',
  })
  return seedModel(page, providerId, {
    modelId: options.modelId ?? 'mock-chat-model',
    displayName: 'Mock Chat',
    kind: 'llm',
  })
}

/** Chờ một tác vụ đạt trạng thái kết thúc bằng cách hỏi API. */
export async function waitForGeneration(
  page: Page,
  id: string,
  timeoutMs = 30_000,
): Promise<{ status: string; assets: Array<{ url: string }> }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await page.request.get(`${BASE}/api/generations/${id}`)
    const body = (await response.json()) as { generation: { status: string; assets: Array<{ url: string }> } }
    const status = body.generation.status
    if (status === 'succeeded' || status === 'failed' || status === 'unknown') {
      return body.generation
    }
    await page.waitForTimeout(400)
  }
  throw new Error(`Tác vụ ${id} không kết thúc trong thời gian cho phép`)
}
