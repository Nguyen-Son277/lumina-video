import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Cho phép đổi đích proxy khi chạy test E2E với backend riêng.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Chuyển tiếp /api sang backend để cookie hoạt động cùng origin khi dev.
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
})
