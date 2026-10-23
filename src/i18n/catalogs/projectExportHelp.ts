import type { Catalog } from '../types'

/** Beginner guidance kept separate from the shared studio catalog. */
export const projectExportHelpCatalog = {
  intro: {
    en: 'Export joins your scene videos into one downloadable video, in timeline order. It uses each scene’s selected video version; if that version is unavailable, it uses the latest successful video. Original audio is preserved, with silence for scenes that have no audio. Enabling narration applies the audio settings below.',
    vi: 'Xuất video sẽ ghép video các cảnh thành một video để tải về, theo thứ tự trên dòng thời gian. Mỗi cảnh dùng phiên bản video bạn đã chọn; nếu bản đó không khả dụng, hệ thống dùng video thành công mới nhất. Âm thanh gốc được giữ lại; cảnh không có tiếng dùng khoảng lặng. Khi bật thuyết minh, thiết lập âm thanh bên dưới được áp dụng.',
  },
  beforeExport: { en: 'Before you export', vi: 'Trước khi xuất video' },
  checkOrder: {
    en: 'Check the scene order in your project — this is the order in the final video.',
    vi: 'Kiểm tra thứ tự các cảnh trong dự án — đây cũng là thứ tự trong video hoàn chỉnh.',
  },
  checkVideos: {
    en: 'Every scene needs a completed video. Open any scene without one, generate a video and wait for it to finish.',
    vi: 'Mỗi cảnh cần có video đã tạo xong. Mở cảnh chưa có video, tạo video và chờ hoàn tất.',
  },
  checkVersions: {
    en: 'Preview and select the video version you want for each scene, then create an export here. Exporting does not generate new scene videos.',
    vi: 'Xem trước và chọn phiên bản video muốn dùng cho từng cảnh, rồi tạo bản xuất tại đây. Xuất video không tạo video mới cho các cảnh.',
  },
  backToScenes: { en: 'Back to project', vi: 'Quay lại dự án' },
  createExport: { en: 'Create video export', vi: 'Tạo bản xuất video' },
  downloadVideo: { en: 'Download video', vi: 'Tải video về' },
  deleteExport: { en: 'Delete export', vi: 'Xoá bản xuất' },
  nextStep: {
    en: 'When the export is completed, choose Download video below. You can close this window while it processes and return to see its progress.',
    vi: 'Khi bản xuất hoàn tất, chọn Tải video về bên dưới. Bạn có thể đóng cửa sổ trong lúc xử lý và quay lại để xem tiến trình.',
  },
  errorNextStep: {
    en: 'Use the message above to see what needs fixing. If a scene has no video, go back to that scene, generate a video and wait for it to finish. Then return and choose Create video export again.',
    vi: 'Xem thông báo phía trên để biết điều cần khắc phục. Nếu cảnh chưa có video, quay lại cảnh đó, tạo video và chờ hoàn tất. Sau đó quay lại và chọn Tạo bản xuất video lần nữa.',
  },
  failedNextStep: {
    en: 'Check the error above. If a scene video is missing, go back to that scene and create it again. Once the issue is fixed, choose Create video export above to try again.',
    vi: 'Kiểm tra lỗi phía trên. Nếu thiếu video của cảnh, quay lại cảnh đó và tạo lại. Sau khi khắc phục, chọn Tạo bản xuất video ở trên để thử lại.',
  },
  serverHelp: {
    en: 'The server’s video-joining tools are not available. Ask the person who manages this app to install or configure both ffmpeg and ffprobe, then create an export again. You do not need to remake your scene videos for this error.',
    vi: 'Công cụ ghép video trên máy chủ chưa khả dụng. Nhờ người quản lý ứng dụng cài đặt hoặc cấu hình cả ffmpeg và ffprobe, rồi tạo lại bản xuất. Bạn không cần tạo lại video các cảnh vì lỗi này.',
  },
  empty: {
    en: 'No exports yet. When your scene videos are ready, choose Create video export above. Your exports and download links will appear here.',
    vi: 'Chưa có bản xuất nào. Khi video các cảnh đã sẵn sàng, chọn Tạo bản xuất video ở trên. Các bản xuất và liên kết tải về sẽ xuất hiện tại đây.',
  },
} as const satisfies Catalog
