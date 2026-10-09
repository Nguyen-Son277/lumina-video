import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installI18n } from './i18n'
import './styles.css'

// Áp dụng ngôn ngữ đã lưu (mặc định en) trước khi render: đồng bộ <html lang>, tiêu đề
// tài liệu và lắng nghe thay đổi từ tab khác.
installI18n()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
