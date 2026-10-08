import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/backend/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Mỗi tệp test dùng database riêng nên chạy tuần tự cho an toàn.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
