/**
 * Catalog namespace `planner` — toàn bộ chuỗi giao diện do ứng dụng sở hữu thuộc
 * khu vực Tạo kịch bản AI / Timeline:
 *
 *   - `src/pages/PlannerPage.tsx`
 *   - `src/pages/TimelineBoardPage.tsx`
 *   - `src/components/planner/**`
 *
 * Quy ước:
 *   - Mỗi khoá là NGỮ NGHĨA, có đủ `en` (mặc định) và `vi`.
 *   - KHÔNG chứa nội dung do người dùng/AI/provider sinh ra, prompt gửi AI,
 *     giá trị enum API hay định danh — những thứ đó giữ nguyên, không dịch.
 *   - Khoá đếm có hậu tố `One`/`Other` để tiếng Anh chia số ít/số nhiều;
 *     tiếng Việt dùng chung một dạng nên hai bản dịch giống nhau.
 */

import type { Catalog } from '../types'

export const plannerCatalog = {
  // ── Dùng chung: mục tiêu artifact, nhãn trạng thái, hành động cơ bản ──────
  targetScript: { en: 'Draft script', vi: 'Kịch bản nháp' },
  targetCast: { en: 'Characters', vi: 'Nhân vật' },
  targetTimeline: { en: 'Timeline', vi: 'Timeline' },
  eyebrowAiScript: { en: 'AI script', vi: 'Kịch bản AI' },
  untitledSession: { en: 'Untitled session', vi: 'Phiên chưa đặt tên' },
  untitledSessionShort: { en: 'Untitled', vi: 'Chưa đặt tên' },
  untitledFrame: { en: 'Untitled frame', vi: 'Frame chưa đặt tên' },
  senderYou: { en: 'You', vi: 'Bạn' },
  send: { en: 'Send', vi: 'Gửi' },
  cancel: { en: 'Cancel', vi: 'Huỷ' },
  save: { en: 'Save', vi: 'Lưu' },
  delete: { en: 'Delete', vi: 'Xoá' },
  generateImage: { en: 'Generate image', vi: 'Sinh ảnh' },
  addFrame: { en: 'Add frame', vi: 'Thêm frame' },
  addCharacter: { en: 'Add character', vi: 'Thêm nhân vật' },
  chatWithAi: { en: 'Chat with AI', vi: 'Chat với AI' },

  // ── PlannerPage ──────────────────────────────────────────────────────────
  plannerPageTitle: { en: 'AI script writer', vi: 'Tạo kịch bản AI' },
  plannerPageIntro: {
    en: 'Pick a model, chat directly with the AI to write a draft script, lock in characters and build a frame-by-frame timeline. Open the right-hand panel when you want to review or edit by hand.',
    vi: 'Chọn model, nhắn trực tiếp cho AI để viết kịch bản nháp, chốt nhân vật và lên timeline từng frame. Mở panel bên phải khi muốn xem hoặc sửa tay.',
  },
  newSession: { en: 'New session', vi: 'Phiên mới' },
  loadingSessions: { en: 'Loading script sessions…', vi: 'Đang tải phiên kịch bản…' },
  noSessionsTitle: { en: 'No script session yet', vi: 'Chưa có phiên kịch bản' },
  noSessionsBody: {
    en: 'Click “New session” to start a new script.',
    vi: 'Bấm “Phiên mới” để bắt đầu một kịch bản mới.',
  },
  sessionListTitle: { en: 'Session list', vi: 'Danh sách phiên' },
  sessionsShort: { en: 'Sessions', vi: 'Phiên' },
  sessionsHeading: { en: 'Script sessions', vi: 'Phiên kịch bản' },
  closeSessionList: { en: 'Close session list', vi: 'Đóng danh sách phiên' },
  deleteSession: { en: 'Delete session', vi: 'Xoá phiên' },
  modelSetup: { en: 'Model setup', vi: 'Cấu hình model' },
  closeModelSetup: { en: 'Close model setup', vi: 'Đóng cấu hình model' },
  openArtifactTitle: { en: 'Open {artifact}', vi: 'Mở {artifact}' },
  closeArtifactTitle: { en: 'Close {artifact}', vi: 'Đóng {artifact}' },
  openTimelinePage: {
    en: 'Open the Timeline page (horizontal storyboard)',
    vi: 'Mở trang Timeline (storyboard ngang)',
  },
  modelsForSession: { en: 'Models for this session', vi: 'Model cho phiên này' },
  chatModelLabel: { en: 'AI chat model', vi: 'Model chat AI' },
  chooseLlmChatModel: { en: 'Choose an LLM & Chat model', vi: 'Chọn model LLM & Chat' },
  imageModelLabel: { en: 'AI image model', vi: 'Model AI hình ảnh' },
  chooseImageModel: { en: 'Choose an image model', vi: 'Chọn model tạo ảnh' },
  videoModelLabel: { en: 'Video model', vi: 'Model video' },
  chooseVideoModel: { en: 'Choose a video model', vi: 'Chọn model tạo video' },
  addModelsInSettings: { en: 'Add models in API & Models', vi: 'Thêm model trong API & Models' },
  modelKindLlmChat: { en: 'LLM & Chat', vi: 'LLM & Chat' },
  noChatModelTitle: { en: 'No AI chat model selected', vi: 'Chưa chọn model chat AI' },
  noChatModelBodyPrefix: { en: 'Click the ', vi: 'Bấm icon ' },
  noChatModelBodyMid: { en: ' icon to choose an enabled ', vi: ' để chọn một model ' },
  noChatModelBodySuffix: {
    en: ' model; chat only works once a model is set.',
    vi: ' đang bật; chat chỉ hoạt động sau khi có model.',
  },
  statusSetup: { en: 'No model selected', vi: 'Chưa chọn model' },
  statusScripting: { en: 'In conversation', vi: 'Đang trao đổi' },
  statusScriptReady: { en: 'Draft script ready', vi: 'Có kịch bản nháp' },
  statusCastReady: { en: 'Characters ready', vi: 'Có nhân vật' },
  statusTimelineReady: { en: 'Timeline ready', vi: 'Có timeline' },
  statusApplied: { en: 'Project created', vi: 'Đã tạo dự án' },
  sessionCreated: { en: 'Created a new script session.', vi: 'Đã tạo phiên kịch bản mới.' },
  sessionDeleted: { en: 'Deleted the script session.', vi: 'Đã xoá phiên kịch bản.' },
  aiRanTimelineOpening: {
    en: 'The AI built the timeline on its own. Opening the Timeline page.',
    vi: 'AI đã tự lên timeline. Đang mở trang Timeline.',
  },
  aiRanStep: { en: 'The AI ran a step on its own: {step}.', vi: 'AI đã tự chạy bước: {step}.' },
  aiFinishedTimeline: { en: 'AI finished: Timeline.', vi: 'AI đã xong: Timeline.' },
  aiFinishedStep: { en: 'AI finished: {step}.', vi: 'AI đã xong: {step}.' },

  // ── PlanChat ─────────────────────────────────────────────────────────────
  chatEditingPrefix: { en: 'Editing: ', vi: 'Đang sửa: ' },
  chatCastCountOne: { en: ' · {count} character', vi: ' · {count} nhân vật' },
  chatCastCountOther: { en: ' · {count} characters', vi: ' · {count} nhân vật' },
  chatFrameCountOne: { en: ' · {count} frame', vi: ' · {count} frame' },
  chatFrameCountOther: { en: ' · {count} frames', vi: ' · {count} frame' },
  quickActionsLabel: { en: 'Quick actions', vi: 'Hành động nhanh' },
  quickScript: { en: 'Write a script', vi: 'Viết kịch bản' },
  quickCast: { en: 'Suggest characters', vi: 'Đề xuất nhân vật' },
  quickTimeline: { en: 'Build timeline', vi: 'Lên timeline' },
  needScriptFirst: { en: 'Write a script first', vi: 'Cần viết kịch bản trước' },
  callAiAction: { en: 'Ask the AI: {action}', vi: 'Gọi AI: {action}' },
  chatEmptyTitle: {
    en: 'Describe the video you want to make',
    vi: 'Mô tả video bạn muốn làm',
  },
  chatEmptyBody: {
    en: 'Example: “A 60-second video about a trip taken by two friends, warm tone, with Vietnamese dialogue.” The AI will ask follow-up questions, write a draft script and may run the next step on its own.',
    vi: 'Ví dụ: “Video 60 giây về một chuyến đi của hai người bạn, tông ấm áp, có lời thoại tiếng Việt.” AI sẽ hỏi lại, viết kịch bản nháp và có thể tự chạy bước tiếp theo.',
  },
  messageContentLabel: { en: 'Message content', vi: 'Nội dung tin nhắn' },
  composerPlaceholder: {
    en: 'Message the AI to edit {target}… (Enter to send, Shift+Enter for a new line)',
    vi: 'Nhắn cho AI để sửa {target}… (Enter để gửi, Shift+Enter để xuống dòng)',
  },
  aiThinkingShort: { en: 'Writing…', vi: 'Đang soạn…' },

  // ── ArtifactDrawer ───────────────────────────────────────────────────────
  scriptPanelLabel: { en: 'Script panel', vi: 'Panel kịch bản' },
  closePanel: { en: 'Close panel', vi: 'Đóng panel' },

  // ── ArtifactPanels: ScriptPanel ──────────────────────────────────────────
  imageGenerateFailed: { en: 'Image generation failed', vi: 'Tạo ảnh thất bại' },
  imageGenerateFailedRetry: {
    en: 'Image generation failed. Please try again.',
    vi: 'Tạo ảnh thất bại. Hãy thử lại.',
  },
  imageTooLong: {
    en: 'Image generation is taking too long. Please check again later.',
    vi: 'Tạo ảnh quá lâu. Hãy kiểm tra lại sau.',
  },
  imageTooLongRetry: {
    en: 'Image generation is taking too long. Please try again.',
    vi: 'Tạo ảnh quá lâu. Hãy thử lại.',
  },
  draftScriptHeading: { en: 'Draft script', vi: 'Kịch bản nháp' },
  rewriteScript: { en: 'Rewrite script', vi: 'Viết lại kịch bản' },
  aiWriteScript: { en: 'AI writes script', vi: 'AI viết kịch bản' },
  writingScript: { en: 'Writing script…', vi: 'Đang viết kịch bản…' },
  saveDraft: { en: 'Save draft', vi: 'Lưu nháp' },
  scriptSaved: { en: 'Draft script saved.', vi: 'Đã lưu kịch bản nháp.' },
  scriptSaveFailed: { en: 'Could not save the script', vi: 'Không lưu được kịch bản' },
  scriptGenerateFailed: { en: 'The AI could not write the script', vi: 'AI không viết được kịch bản' },
  scriptWorkingOverlay: {
    en: 'The AI is writing a script from the conversation and the current draft',
    vi: 'AI đang viết kịch bản từ hội thoại và bản nháp hiện tại',
  },
  scriptTextLabel: { en: 'Script (edit directly)', vi: 'Bản kịch bản (sửa trực tiếp)' },
  scriptTextPlaceholder: {
    en: 'Click “AI writes script” or type your own script.',
    vi: 'Bấm “AI viết kịch bản” hoặc tự nhập kịch bản của bạn.',
  },
  sceneIndex: { en: 'Scene {index}', vi: 'Cảnh {index}' },
  sceneTitleLabel: { en: 'Scene title {index}', vi: 'Tiêu đề cảnh {index}' },
  secondsShort: { en: 'sec', vi: 'giây' },
  sceneDurationLabel: { en: 'Scene duration {index}', vi: 'Thời lượng cảnh {index}' },
  fieldContext: { en: 'Context', vi: 'Bối cảnh' },
  fieldAction: { en: 'Action', vi: 'Hành động' },
  fieldBeats: { en: 'Action beats over time', vi: 'Nhịp hành động theo thời gian' },
  fieldDialogue: { en: 'Dialogue', vi: 'Lời thoại' },
  fieldSpeaker: { en: 'Speaker', vi: 'Người nói' },
  sceneCharactersLabel: {
    en: 'Characters (comma separated)',
    vi: 'Nhân vật (cách nhau dấu phẩy)',
  },
  goCast: { en: 'Generate character ideas', vi: 'Tạo ý tưởng nhân vật' },

  // ── ArtifactPanels: CastPanel ────────────────────────────────────────────
  castHeading: { en: 'Character ideas', vi: 'Ý tưởng nhân vật' },
  regenerateWithAi: { en: 'Regenerate with AI', vi: 'Tạo lại bằng AI' },
  aiSuggestCast: { en: 'AI suggests characters', vi: 'AI đề xuất nhân vật' },
  generatingCast: { en: 'Generating characters…', vi: 'Đang tạo nhân vật…' },
  castSaved: { en: 'Character ideas saved.', vi: 'Đã lưu ý tưởng nhân vật.' },
  castSaveFailed: { en: 'Could not save the characters', vi: 'Không lưu được nhân vật' },
  castGenerateFailed: {
    en: 'The AI could not suggest characters',
    vi: 'AI không đề xuất được nhân vật',
  },
  castWorkingOverlay: {
    en: 'The AI is reading the script and suggesting characters with voice profiles',
    vi: 'AI đang đọc kịch bản và đề xuất nhân vật kèm hồ sơ giọng',
  },
  zoomImage: { en: 'View enlarged image', vi: 'Xem ảnh phóng to' },
  zoomPortraitOf: { en: 'View enlarged portrait of {name}', vi: 'Xem ảnh phóng to của {name}' },
  portraitReferenceAlt: { en: 'Reference image of {name}', vi: 'Ảnh tham chiếu của {name}' },
  portraitAlt: { en: '{name} image', vi: 'Ảnh {name}' },
  generatingImage: { en: 'Generating image…', vi: 'Đang sinh ảnh…' },
  noImage: { en: 'No image yet', vi: 'Chưa có ảnh' },
  uploadImage: { en: 'Upload image', vi: 'Tải ảnh' },
  imageUploadFailed: { en: 'Could not upload the image', vi: 'Không tải được ảnh' },
  imageRemoveFailed: { en: 'Could not delete the image', vi: 'Không xoá được ảnh' },
  fieldName: { en: 'Name', vi: 'Tên' },
  fieldRole: { en: 'Role', vi: 'Vai' },
  fieldAppearance: { en: 'Appearance', vi: 'Ngoại hình' },
  storageLabel: {
    en: 'Save location when applying the project',
    vi: 'Nơi lưu khi chốt dự án',
  },
  storageLibrary: { en: 'Shared library', vi: 'Thư viện dùng chung' },
  storageProject: { en: 'This project only', vi: 'Chỉ dự án này' },
  removeCharacterAria: { en: 'Remove {name}', vi: 'Xoá {name}' },
  removeCharacter: { en: 'Remove character', vi: 'Bỏ nhân vật' },
  newCharacterName: { en: 'New character', vi: 'Nhân vật mới' },
  goTimeline: { en: 'Build timeline', vi: 'Lên timeline' },

  // ── PlannerLoading ───────────────────────────────────────────────────────
  waitedSeconds: { en: 'Waiting {seconds}s…', vi: 'Đã chờ {seconds} giây…' },

  // ── TimelineOverlay ──────────────────────────────────────────────────────
  closeChat: { en: 'Close chat', vi: 'Đóng chat' },
  closeProjectSetup: { en: 'Close project setup', vi: 'Đóng cấu hình dự án' },

  // ── TimelineBoardPage: vị trí nhân vật trong khung ───────────────────────
  positionLeft: { en: 'Left', vi: 'Bên trái' },
  positionCenter: { en: 'Center', vi: 'Chính giữa' },
  positionRight: { en: 'Right', vi: 'Bên phải' },
  positionBackground: { en: 'Behind', vi: 'Phía sau' },

  // ── TimelineBoardPage: trạng thái trang & tiêu đề ────────────────────────
  // Danh sách phiên dạng thẻ (mở trang Timeline khi chưa gắn phiên nào).
  boardListTitle: { en: 'Timelines', vi: 'Danh sách timeline' },
  boardListIntro: {
    en: 'Pick a timeline to open its storyboard. Each card shows the cover image, status and size.',
    vi: 'Chọn một timeline để mở storyboard. Mỗi thẻ cho biết ảnh bìa, trạng thái và quy mô.',
  },
  boardListEmptyTitle: { en: 'No timelines yet', vi: 'Chưa có timeline nào' },
  boardListEmptyBody: {
    en: 'Create a session in the AI script writer, then click “Build timeline”.',
    vi: 'Tạo một phiên trong Tạo kịch bản AI rồi bấm “Lên timeline”.',
  },
  boardOpenSessionAria: { en: 'Open timeline {title}', vi: 'Mở timeline {title}' },
  boardCardFramesOne: { en: '{count} frame', vi: '{count} frame' },
  boardCardFramesOther: { en: '{count} frames', vi: '{count} frame' },
  boardCardCastOne: { en: '{count} character', vi: '{count} nhân vật' },
  boardCardCastOther: { en: '{count} characters', vi: '{count} nhân vật' },
  boardCardDuration: { en: 'Total {total}', vi: 'Tổng {total}' },
  boardCardUpdated: { en: 'Updated {date}', vi: 'Cập nhật {date}' },
  backToPlanner: { en: 'Back to AI script writer', vi: 'Về Tạo kịch bản AI' },
  backToTimelineList: { en: 'All timelines', vi: 'Danh sách timeline' },
  loadingTimeline: { en: 'Loading timeline…', vi: 'Đang tải timeline…' },
  sessionOpenFailed: { en: 'Could not open this session', vi: 'Không mở được phiên này' },
  sessionMaybeDeleted: {
    en: 'The session may have been deleted.',
    vi: 'Phiên có thể đã bị xoá.',
  },
  backToPlannerChat: { en: 'Back to AI script writer chat', vi: 'Về chat Tạo kịch bản AI' },
  boardSubtitleOne: {
    en: '{title} · {frames} frame · total {total} · each card shows who is present and what they do.',
    vi: '{title} · {frames} frame · tổng {total} · mỗi thẻ cho biết ai có mặt và làm gì.',
  },
  boardSubtitleOther: {
    en: '{title} · {frames} frames · total {total} · each card shows who is present and what they do.',
    vi: '{title} · {frames} frame · tổng {total} · mỗi thẻ cho biết ai có mặt và làm gì.',
  },
  boardImageModelLabel: { en: 'Image model', vi: 'Model ảnh' },
  boardNoImageModel: { en: 'No image model selected', vi: 'Chưa chọn model ảnh' },
  timelineUpdatedByAi: {
    en: 'The AI updated the timeline from the draft script.',
    vi: 'AI đã cập nhật timeline từ kịch bản nháp.',
  },
  aiBuildTimeline: { en: 'AI builds timeline', vi: 'AI lên timeline' },
  buildingTimeline: { en: 'Building timeline…', vi: 'Đang lên timeline…' },
  saveChanges: { en: 'Save changes', vi: 'Lưu thay đổi' },
  saving: { en: 'Saving…', vi: 'Đang lưu…' },
  generateAllImagesTitle: {
    en: 'Generate storyboard images for the whole timeline',
    vi: 'Sinh ảnh storyboard cho cả timeline',
  },
  chooseImageModelFirst: { en: 'Choose an image model first', vi: 'Chọn model ảnh trước' },
  generateAllImages: { en: 'Generate all images', vi: 'Sinh tất cả ảnh' },
  hideChat: { en: 'Hide chat', vi: 'Ẩn chat' },
  finalizeProject: { en: 'Finalize & create project', vi: 'Chốt & tạo dự án' },

  // ── TimelineBoardPage: batch sinh ảnh storyboard ─────────────────────────
  batchPanelTitle: {
    en: 'Generate storyboard images for the timeline',
    vi: 'Sinh ảnh storyboard cho timeline',
  },
  batchIntroPrefix: { en: 'Images will be generated for ', vi: 'Sẽ tạo ảnh cho ' },
  batchIntroFrameOne: { en: ' frame', vi: ' frame' },
  batchIntroFrameOther: { en: ' frames', vi: ' frame' },
  batchIntroNoImage: { en: ' without an image yet', vi: ' chưa có ảnh' },
  batchIntroTail: {
    en: ' using the “{model}” model, one frame at a time. Images use your API key, so costs may apply.',
    vi: ' bằng model “{model}”, chạy lần lượt từng frame. Ảnh dùng API key của bạn nên có thể phát sinh chi phí.',
  },
  chosenModel: { en: 'selected', vi: 'đã chọn' },
  batchRegenerateCheckbox: {
    en: 'Regenerate existing images too (replaces current images)',
    vi: 'Tạo lại cả ảnh đã có (thay ảnh hiện tại)',
  },
  batchMissingPortraitsOne: {
    en: '{count} character has no portrait (',
    vi: '{count} nhân vật chưa có ảnh chân dung (',
  },
  batchMissingPortraitsOther: {
    en: '{count} characters have no portrait (',
    vi: '{count} nhân vật chưa có ảnh chân dung (',
  },
  batchMissingPortraitsTail: {
    en: '): images are still generated from the description, but faces may be less consistent. Add portraits in the Characters panel to improve this.',
    vi: '): ảnh vẫn được tạo theo mô tả nhưng khuôn mặt có thể kém nhất quán. Gắn chân dung ở panel Nhân vật để cải thiện.',
  },
  startBatchOne: { en: 'Start generating {count} image', vi: 'Bắt đầu sinh {count} ảnh' },
  startBatchOther: { en: 'Start generating {count} images', vi: 'Bắt đầu sinh {count} ảnh' },
  queuing: { en: 'Queuing…', vi: 'Đang xếp hàng…' },
  batchProgressLabel: { en: 'Image generation progress', vi: 'Tiến trình sinh ảnh' },
  batchProgressDone: { en: '{done}/{total} images done', vi: '{done}/{total} ảnh xong' },
  batchProgressFailed: { en: ' · {count} failed', vi: ' · {count} lỗi' },
  batchStatusRunning: { en: ' · running', vi: ' · đang chạy' },
  batchStatusStopped: { en: ' · stopped', vi: ' · đã dừng' },
  batchStatusFinished: { en: ' · finished', vi: ' · hoàn tất' },
  stop: { en: 'Stop', vi: 'Dừng' },
  retryFailedFrames: { en: 'Retry failed frames', vi: 'Thử lại frame lỗi' },
  previousSession: { en: 'Previous session', vi: 'Phiên trước' },
  nextSession: { en: 'Next session', vi: 'Phiên sau' },

  // ── TimelineBoardPage: danh sách frame ───────────────────────────────────
  noFramesTitle: { en: 'No frames yet', vi: 'Chưa có frame nào' },
  noFramesBody: {
    en: 'Click “AI builds timeline” to split the draft script into frames, or add frames manually.',
    vi: 'Bấm “AI lên timeline” để chia kịch bản nháp thành từng frame, hoặc thêm frame thủ công.',
  },
  storyboardLabel: { en: 'Storyboard', vi: 'Storyboard' },
  frameIndex: { en: 'Frame {index}', vi: 'Frame {index}' },
  frameDurationShort: { en: '{seconds}s', vi: '{seconds}s' },
  batchItemPending: { en: 'Waiting for its turn', vi: 'Đang chờ tới lượt' },
  batchItemRunning: { en: 'Generating image…', vi: 'Đang tạo ảnh…' },
  batchItemError: { en: 'Image error', vi: 'Lỗi ảnh' },
  batchItemStopped: { en: 'Stopped', vi: 'Đã dừng' },
  zoomFrameImage: {
    en: 'View enlarged image of frame {index}',
    vi: 'Xem ảnh phóng to của frame {index}',
  },
  storyboardFrameAlt: { en: 'Storyboard image for frame {index}', vi: 'Ảnh storyboard frame {index}' },
  noStoryboardImage: { en: 'No storyboard image yet', vi: 'Chưa có ảnh storyboard' },
  generatingStoryboardImage: { en: 'Generating storyboard image', vi: 'Đang tạo ảnh storyboard' },
  peopleCountOne: { en: '{count} person', vi: '{count} người' },
  peopleCountOther: { en: '{count} people', vi: '{count} người' },
  noCharactersInFrame: { en: 'No characters defined', vi: 'Chưa xác định nhân vật' },
  speakerWithName: { en: 'Speaker: {name}', vi: 'Người nói: {name}' },
  generateFrameImageTitle: {
    en: 'Generate a storyboard image for this frame',
    vi: 'Tạo ảnh storyboard cho frame này',
  },
  regenerateImage: { en: 'Regenerate image', vi: 'Tạo lại ảnh' },
  removeImage: { en: 'Delete image', vi: 'Xoá ảnh' },
  boardLegend: {
    en: 'Each frame is a node; the arrows are the playback order. Drag a node to reconnect the chain, then edit its content below or click “AI arranges frame”.',
    vi: 'Mỗi frame là một node; mũi tên là thứ tự phát. Kéo một node để nối lại chuỗi, rồi sửa nội dung ở khung dưới hoặc bấm “AI sắp xếp frame”.',
  },
  nodeDragHandleTitle: { en: 'Drag to reorder this node', vi: 'Kéo để đổi thứ tự node này' },

  // ── TimelineBoardPage: khung sửa frame đang chọn ─────────────────────────
  editFrameAria: { en: 'Edit {title}', vi: 'Sửa {title}' },
  selectedFrame: { en: 'Selected frame', vi: 'Frame đang chọn' },
  moveFrameLeftAria: { en: 'Move frame left', vi: 'Chuyển frame sang trái' },
  moveLeft: { en: 'Move left', vi: 'Sang trái' },
  moveFrameRightAria: { en: 'Move frame right', vi: 'Chuyển frame sang phải' },
  moveRight: { en: 'Move right', vi: 'Sang phải' },
  aiArrangeFrame: { en: 'AI arranges frame', vi: 'AI sắp xếp frame' },
  aiArranging: { en: 'AI is arranging…', vi: 'AI đang sắp xếp…' },
  duplicate: { en: 'Duplicate', vi: 'Nhân bản' },
  frameRemoved: {
    en: 'Frame removed from the timeline. Click “Save changes” to persist.',
    vi: 'Đã xoá frame khỏi timeline. Bấm “Lưu thay đổi” để ghi lại.',
  },
  removeFrame: { en: 'Delete frame', vi: 'Xoá frame' },
  frameTitleLabel: { en: 'Frame title', vi: 'Tiêu đề frame' },
  frameTitleSelectedAria: { en: 'Selected frame title', vi: 'Tiêu đề frame đang chọn' },
  frameDurationLabel: { en: 'Duration (seconds)', vi: 'Thời lượng (giây)' },
  frameDurationSelectedAria: { en: 'Selected frame duration', vi: 'Thời lượng frame đang chọn' },
  frameSpeakerAria: { en: 'Frame speaker', vi: 'Người nói của frame' },
  noDialogue: { en: 'No dialogue', vi: 'Không có lời thoại' },
  shotNotesLabel: { en: 'Camera angle / shot notes', vi: 'Góc máy / ghi chú hình' },
  shotNotesAria: { en: 'Selected frame camera angle', vi: 'Góc máy của frame đang chọn' },
  frameContextLabel: {
    en: 'Context (used for the storyboard image)',
    vi: 'Bối cảnh (dùng cho ảnh storyboard)',
  },
  frameContextAria: { en: 'Selected frame context', vi: 'Bối cảnh frame đang chọn' },
  frameActionLabel: { en: 'Overall frame action', vi: 'Hành động chung của frame' },
  frameActionAria: { en: 'Selected frame action', vi: 'Hành động frame đang chọn' },
  frameBeatsLabel: { en: 'Action beats over time', vi: 'Nhịp hành động theo thời gian' },
  frameBeatsAria: { en: 'Selected frame action beats', vi: 'Nhịp hành động của frame đang chọn' },
  frameBeatsPlaceholder: {
    en: 'e.g. 0–2s looks up in surprise, 2–5s stands and reaches for the bag, 5–8s steps out',
    vi: 'Ví dụ: 0–2s ngước lên ngạc nhiên, 2–5s đứng dậy với lấy túi, 5–8s bước ra ngoài',
  },
  frameDialogueAria: { en: 'Selected frame dialogue', vi: 'Lời thoại frame đang chọn' },
  frameCharactersHeading: { en: 'Characters in frame ({count})', vi: 'Nhân vật trong frame ({count})' },
  frameNoCharacters: {
    en: 'This frame has no characters. Add one or click “AI arranges frame”.',
    vi: 'Frame chưa có nhân vật. Thêm nhân vật hoặc bấm “AI sắp xếp frame”.',
  },
  fieldCharacter: { en: 'Character', vi: 'Nhân vật' },
  characterOfFrameAria: { en: 'Character {index} of the frame', vi: 'Nhân vật {index} của frame' },
  chooseCharacter: { en: '— choose a character —', vi: '— chọn nhân vật —' },
  characterActionLabel: { en: 'Action within the frame', vi: 'Hành động riêng trong frame' },
  characterActionPlaceholder: { en: 'e.g. opens the door and walks in', vi: 'Ví dụ: mở cửa bước vào' },
  characterActionAria: { en: 'Action of character {index}', vi: 'Hành động của nhân vật {index}' },
  characterExpressionLabel: { en: 'Facial expression & gaze', vi: 'Biểu cảm khuôn mặt & ánh mắt' },
  characterExpressionPlaceholder: {
    en: 'e.g. eyes wide, brows raised, jaw tight, looks at Bình',
    vi: 'Ví dụ: mắt mở to, nhướng mày, hàm siết lại, nhìn sang Bình',
  },
  characterExpressionAria: { en: 'Facial expression of character {index}', vi: 'Biểu cảm của nhân vật {index}' },
  positionLabel: { en: 'Position in frame', vi: 'Vị trí trong khung' },
  characterPositionAria: { en: 'Position of character {index}', vi: 'Vị trí của nhân vật {index}' },
  removeCharacterFromFrameAria: {
    en: 'Remove character {index} from the frame',
    vi: 'Xoá nhân vật {index} khỏi frame',
  },

  // ── TimelineBoardPage: chat trong overlay ────────────────────────────────
  timelineChatTitle: { en: 'Chat with AI about the Timeline', vi: 'Chat với AI về Timeline' },
  timelineChatEmpty: {
    en: 'Message the AI to change the timeline, e.g. “split frame 2 into two frames” or “add character Chi to frame 3”.',
    vi: 'Nhắn cho AI để đổi timeline, ví dụ “tách frame 2 thành hai frame” hoặc “thêm nhân vật Chi vào frame 3”.',
  },
  aiTyping: { en: 'AI is writing…', vi: 'AI đang soạn…' },
  timelineMessageAria: { en: 'Timeline message content', vi: 'Nội dung tin nhắn timeline' },
  timelineComposerPlaceholder: {
    en: 'Message the AI about the timeline… (Enter to send, Shift+Enter for a new line)',
    vi: 'Nhắn cho AI về timeline… (Enter để gửi, Shift+Enter để xuống dòng)',
  },

  // ── TimelineBoardPage: chốt dự án Studio ─────────────────────────────────
  finalizeProjectTitle: { en: 'Finalize & create project', vi: 'Chốt & tạo dự án' },
  newProjectName: { en: 'New project name', vi: 'Tên dự án mới' },
  projectNamePlaceholder: { en: 'Studio project name', vi: 'Tên dự án Studio' },
  chooseLaterInStudio: { en: 'Choose later in Studio', vi: 'Chọn sau trong Studio' },
  autoGenerateCheckbox: {
    en: 'Automatically queue video generation for every scene after approval',
    vi: 'Tự động xếp hàng tạo video cho mọi cảnh sau khi duyệt',
  },
  confirmCreateProject: { en: 'Confirm project creation', vi: 'Xác nhận tạo dự án' },
  creatingProject: { en: 'Creating project…', vi: 'Đang tạo dự án…' },
  projectNote: {
    en: 'New scenes are still unapproved. Videos are only queued after you approve them in Studio; video jobs use your API key and may incur charges.',
    vi: 'Cảnh mới vẫn chưa duyệt. Chỉ sau khi duyệt trong Studio, hệ thống mới xếp hàng tạo video; tác vụ video dùng API key của bạn và có thể tính phí.',
  },
  chooseVideoModelForAuto: {
    en: 'Choose a video model to enable automatic queuing.',
    vi: 'Chọn model video để bật xếp hàng tự động.',
  },

  // ── TimelineBoardPage: thông báo & nhãn phụ trợ ──────────────────────────
  frameCopySuffix: { en: ' (copy)', vi: ' (bản sao)' },
  batchQueued: { en: 'Queued {count} storyboard images.', vi: 'Đã xếp hàng sinh {count} ảnh storyboard.' },
  batchAlreadyRunningNotice: {
    en: 'A batch is already running for this session. Following it now; stop it to start over.',
    vi: 'Phiên này đang có batch sinh ảnh chạy. Đang theo dõi batch đó; hãy dừng nếu muốn tạo lại.',
  },
  batchStoppedNotice: {
    en: 'Batch stopped. Jobs already sent to the provider may still finish and are still billed.',
    vi: 'Đã dừng batch. Tác vụ đã gửi provider vẫn có thể xong và vẫn tính phí.',
  },
  batchFinishedNotice: {
    en: 'Storyboard image generation finished: {done}/{total}{failed}.',
    vi: 'Sinh ảnh storyboard xong: {done}/{total}{failed}.',
  },
  batchFinishedFailedOne: { en: ', {count} failed frame', vi: ', {count} frame lỗi' },
  batchFinishedFailedOther: { en: ', {count} failed frames', vi: ', {count} frame lỗi' },
  allCastInFrame: {
    en: 'Every character in the session is already in this frame.',
    vi: 'Mọi nhân vật trong phiên đã có mặt ở frame này.',
  },
  backgroundAttached: {
    en: 'Attached the new storyboard image to the frame.',
    vi: 'Đã gắn ảnh storyboard mới cho frame.',
  },
  backgroundFailed: { en: 'Storyboard image generation failed.', vi: 'Tạo ảnh storyboard thất bại.' },
  arrangeFallback: { en: 'The AI rearranged the frame.', vi: 'AI đã sắp xếp lại frame.' },
  projectCreated: {
    en: 'Created a Studio project from the timeline.',
    vi: 'Đã tạo dự án Studio từ timeline.',
  },
  boardHint: {
    en: 'Storyboard images use your API key and cost money: each click only generates an image for a single frame, so you control the cost. Characters with a portrait are sent along as reference images.',
    vi: 'Ảnh storyboard dùng API key của bạn và tốn phí: mỗi lần bấm chỉ tạo ảnh cho đúng một frame nên bạn kiểm soát được chi phí. Nhân vật có ảnh chân dung sẽ được gửi kèm làm ảnh tham chiếu.',
  },
} as const satisfies Catalog

export type PlannerCatalog = typeof plannerCatalog
