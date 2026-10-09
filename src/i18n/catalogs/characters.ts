/**
 * Catalog namespace `characters` — thư viện nhân vật và mọi biểu mẫu/hộp thoại quanh nó.
 *
 * Phạm vi: `CharactersPage`, `CharacterForm`, `CharacterAiModal`, `CharacterPromptModal`,
 * `CharacterIllustrate` + `CharacterIllustrateModal`.
 *
 * Quy ước:
 * - Mỗi khoá ngữ nghĩa có đủ bản dịch `en` (mặc định) và `vi`.
 * - `as const satisfies Catalog` giữ kiểu khoá literal và bắt lỗi thiếu ngôn ngữ khi biên dịch,
 *   nhờ đó `t('...')` chỉ nhận khoá hợp lệ của namespace này.
 * - Nội dung do người dùng/AI/model sinh ra (tên nhân vật, mô tả, prompt, thông báo lỗi thô từ
 *   server) KHÔNG nằm trong catalog: chúng được hiển thị nguyên văn.
 * - `ai*` = hộp thoại AI tạo nhân vật; `illustration*` = vùng tạo ảnh minh hoạ dùng chung;
 *   `illustrateModal*` = hộp thoại minh hoạ nhân vật đã lưu.
 */

import type { Catalog } from '../types'

export const charactersCatalog = {
  // ===== Trang thư viện nhân vật (CharactersPage) =====
  pageEyebrow: { en: 'Character library', vi: 'Thư viện nhân vật' },
  pageTitleLead: { en: 'Characters', vi: 'Nhân vật' },
  pageTitleAccent: { en: 'shared everywhere.', vi: 'dùng chung.' },
  pageDescription: {
    en: 'Create a character and its reference image once, then reuse them in every project and on the single-content page.',
    vi: 'Tạo nhân vật và ảnh tham chiếu một lần, rồi dùng lại ở mọi dự án và ở trang tạo nội dung đơn lẻ.',
  },
  refresh: { en: 'Refresh', vi: 'Làm mới' },
  aiCreate: { en: 'Create character with AI', vi: 'AI tạo nhân vật' },
  createCharacter: { en: 'Create character', vi: 'Tạo nhân vật' },
  createFirstCharacter: { en: 'Create your first character', vi: 'Tạo nhân vật đầu tiên' },
  loadingCharacters: { en: 'Loading characters…', vi: 'Đang tải nhân vật…' },
  viewReferenceImageAria: {
    en: 'View the reference image of {name}',
    vi: 'Xem ảnh tham chiếu của {name}',
  },
  clickToZoomHint: { en: 'Click to view details', vi: 'Bấm để xem chi tiết' },
  referenceImageAlt: { en: 'Reference image of {name}', vi: 'Ảnh tham chiếu của {name}' },
  noReferenceImage: { en: 'No reference image yet', vi: 'Chưa có ảnh tham chiếu' },
  appearanceEmpty: { en: 'No appearance description yet.', vi: 'Chưa mô tả ngoại hình.' },
  voiceSummaryEmpty: { en: 'No voice profile yet', vi: 'Chưa có hồ sơ giọng' },
  edit: { en: 'Edit', vi: 'Sửa' },
  illustrate: { en: 'Illustrate', vi: 'Minh hoạ' },
  illustrateHint: {
    en: 'Create a reference image with an image model',
    vi: 'Tạo ảnh tham chiếu bằng model tạo ảnh',
  },
  promptLabel: { en: 'Prompt', vi: 'Prompt' },
  promptHint: {
    en: 'View and copy this character prompt',
    vi: 'Xem và sao chép prompt của nhân vật',
  },
  deleteCharacterAria: { en: 'Delete {name}', vi: 'Xóa {name}' },
  deleteCharacterHint: { en: 'Delete character', vi: 'Xóa nhân vật' },
  libraryEmptyTitle: {
    en: 'Your character library is empty',
    vi: 'Thư viện nhân vật đang trống',
  },
  libraryEmptyDescription: {
    en: 'Add characters together with reference images to keep their identity consistent across every generation.',
    vi: 'Thêm nhân vật kèm ảnh tham chiếu để giữ nhận diện nhất quán giữa các lần tạo.',
  },
  notifyLibraryRefreshed: {
    en: 'Character library refreshed.',
    vi: 'Đã làm mới thư viện nhân vật.',
  },
  notifyCharacterUpdated: { en: 'Character updated.', vi: 'Đã cập nhật nhân vật.' },
  notifyCharacterCreated: {
    en: 'Character added to the library.',
    vi: 'Đã thêm nhân vật vào thư viện.',
  },
  notifyCharacterDeleted: {
    en: 'Character removed from the library.',
    vi: 'Đã xóa nhân vật khỏi thư viện.',
  },

  // Nhãn rút gọn của hồ sơ giọng, hiển thị trên thẻ nhân vật.
  voiceSummaryAccent: { en: 'Accent', vi: 'Giọng' },
  voiceSummaryPitch: { en: 'Pitch', vi: 'Cao độ' },
  voiceSummaryTimbre: { en: 'Timbre', vi: 'Âm sắc' },
  voiceSummaryPace: { en: 'Pace', vi: 'Tốc độ' },

  // ===== Biểu mẫu nhân vật (CharacterForm) =====
  formTitleEdit: { en: 'Edit character / voice', vi: 'Sửa nhân vật / giọng nói' },
  formTitleNew: { en: 'Add character', vi: 'Thêm nhân vật' },
  formSectionCharacter: { en: 'Character', vi: 'Nhân vật' },
  formScopeLabel: { en: 'Usage scope', vi: 'Phạm vi sử dụng' },
  formScopeLibrary: {
    en: 'Shared (Library) — every project',
    vi: 'Dùng chung (Thư viện) — mọi dự án',
  },
  formScopeProject: { en: 'This project only', vi: 'Chỉ dự án này' },
  formNameLabel: { en: 'Name', vi: 'Tên' },
  formNamePlaceholder: { en: 'Alex', vi: 'An' },
  formAppearanceLabel: { en: 'Appearance', vi: 'Ngoại hình' },
  formAppearancePlaceholder: {
    en: 'Blue shirt, short hair, scholarly look…',
    vi: 'Áo xanh, tóc ngắn, dáng thư sinh…',
  },
  formReferenceLabel: { en: 'Character reference image', vi: 'Ảnh tham chiếu nhân vật' },
  genericCharacter: { en: 'character', vi: 'nhân vật' },
  formChooseImage: { en: 'Choose image', vi: 'Chọn ảnh' },
  formChooseAnotherImage: { en: 'Choose another image', vi: 'Chọn ảnh khác' },
  formRemoveImage: { en: 'Remove image', vi: 'Xóa ảnh' },
  formReferenceHint: {
    en: 'PNG, JPEG, WebP or GIF, up to {size}. Images are stored privately and sent along when generating images or video so the model keeps the right appearance.',
    vi: 'PNG, JPEG, WebP hoặc GIF, tối đa {size}. Ảnh được lưu riêng tư và gửi kèm khi tạo ảnh hoặc video để model bám đúng ngoại hình.',
  },
  formSectionVoice: { en: 'Voice profile', vi: 'Hồ sơ giọng nói' },
  voiceFieldLanguage: { en: 'Language', vi: 'Ngôn ngữ' },
  voiceFieldAccent: { en: 'Regional accent', vi: 'Giọng vùng miền' },
  voiceFieldPitch: { en: 'Pitch', vi: 'Cao độ' },
  voiceFieldTimbre: { en: 'Timbre', vi: 'Âm sắc' },
  voiceFieldPace: { en: 'Pace', vi: 'Tốc độ' },
  voiceFieldArticulation: { en: 'Articulation', vi: 'Phát âm' },
  voiceFieldHabits: { en: 'Speech habits', vi: 'Thói quen nói' },
  // Mã ngôn ngữ là giá trị dữ liệu gửi cho AI, giữ nguyên ở mọi giao diện.
  voicePlaceholderLanguage: { en: 'vi', vi: 'vi' },
  voicePlaceholderAccent: { en: 'Northern', vi: 'Miền Bắc' },
  voicePlaceholderPitch: { en: 'Medium-low', vi: 'Trung trầm' },
  voicePlaceholderTimbre: { en: 'Warm, slightly husky', vi: 'Ấm, hơi khàn' },
  voicePlaceholderPace: { en: 'Moderate', vi: 'Vừa phải' },
  voicePlaceholderArticulation: {
    en: 'Clear, no dropped syllables',
    vi: 'Rõ ràng, không nuốt chữ',
  },
  voicePlaceholderHabits: {
    en: 'Gentle pauses at the end of sentences',
    vi: 'Ngắt nghỉ nhẹ cuối câu',
  },
  formVoiceNotice: {
    en: 'The voice is only a description inside the prompt and is shared by every scene of this character. The app does not use a third-party voice service and cannot guarantee an exact voice match.',
    vi: 'Giọng nói chỉ là mô tả trong prompt, dùng chung cho mọi cảnh của nhân vật này. Ứng dụng không dùng dịch vụ giọng nói bên thứ ba và không bảo đảm giọng giống tuyệt đối.',
  },
  cancel: { en: 'Cancel', vi: 'Hủy' },
  saveCharacter: { en: 'Save character', vi: 'Lưu nhân vật' },
  close: { en: 'Close', vi: 'Đóng' },

  // ===== Hộp thoại AI tạo nhân vật (CharacterAiModal) =====
  aiEyebrow: { en: 'AI character', vi: 'Nhân vật AI' },
  aiTitle: { en: 'Create character with AI', vi: 'AI tạo nhân vật' },
  aiDescriptionLead: {
    en: 'Describe the character, pick an image model and press one button: the AI writes the profile and creates',
    vi: 'Mô tả nhân vật, chọn model ảnh rồi bấm một nút: AI viết hồ sơ và tạo',
  },
  aiDescriptionHighlight: {
    en: 'a reference sheet with a close-up + 4 angles',
    vi: 'ảnh tham chiếu gồm cận mặt + 4 góc nhìn',
  },
  aiDescriptionTail: {
    en: 'for each character. With “Save now” on, characters go straight into the library — no card-by-card clicking.',
    vi: 'cho từng nhân vật. Bật “Lưu ngay” thì nhân vật vào thư viện luôn, không phải bấm từng thẻ.',
  },
  aiNoLlmTitle: { en: 'No LLM & Chat model yet', vi: 'Chưa có model LLM & Chat' },
  aiNoLlmDescription: {
    en: 'A text model is required to create characters with AI. Go to API & Models, add a provider, then classify a model as “LLM & Chat”.',
    vi: 'Cần một model văn bản để AI tạo nhân vật. Vào API & Models, thêm provider rồi phân loại một model thành “LLM & Chat”.',
  },
  aiOpenSettings: { en: 'Open API & Models', vi: 'Mở API & Models' },
  aiDescriptionLabel: { en: 'Character description', vi: 'Mô tả nhân vật' },
  aiDescriptionPlaceholder: {
    en: 'Example: a young, calm Vietnamese astronaut wearing a blue flight suit',
    vi: 'Ví dụ: một phi hành gia trẻ, điềm tĩnh, người Việt, mặc đồ bay màu xanh',
  },
  aiCountLabel: { en: 'Count', vi: 'Số lượng' },
  aiCountOption: { en: '{count} characters', vi: '{count} nhân vật' },
  aiLlmModelLabel: { en: 'LLM & Chat model', vi: 'Model LLM & Chat' },
  aiImageModelLabel: { en: 'Image model', vi: 'Model tạo ảnh' },
  aiNoImageModelOption: { en: 'No image model yet', vi: 'Chưa có model ảnh' },
  aiAutoSave: { en: 'Save to library immediately', vi: 'Lưu vào thư viện ngay' },
  aiCostLead: { en: 'Up to', vi: 'Tối đa' },
  aiCostTail: {
    en: 'images using your own API key; images go to the Library.',
    vi: 'ảnh bằng API key của bạn, ảnh vào Thư viện.',
  },
  aiCostNoImage: {
    en: 'No image model: only character profiles will be generated.',
    vi: 'Chưa có model tạo ảnh: chỉ sinh hồ sơ nhân vật.',
  },
  aiWritingProfiles: { en: 'AI is writing profiles…', vi: 'AI đang viết hồ sơ…' },
  aiGeneratingCount: {
    en: 'Generating images… {done}/{total}',
    vi: 'Đang tạo ảnh… {done}/{total}',
  },
  aiGenerateWithImages: {
    en: 'Create {count} characters + images',
    vi: 'Tạo {count} nhân vật + ảnh',
  },
  aiGenerateTextOnly: { en: 'Create {count} characters', vi: 'Tạo {count} nhân vật' },
  aiStop: { en: 'Stop', vi: 'Huỷ' },
  aiStopNotify: {
    en: 'Image generation stopped. Characters already saved are kept.',
    vi: 'Đã dừng tạo ảnh. Những nhân vật đã lưu vẫn được giữ.',
  },
  aiResultsCount: { en: '{count} draft characters', vi: '{count} nhân vật mẫu' },
  aiRegenerate: { en: 'Regenerate', vi: 'Tạo lại' },
  aiStatusSaved: { en: 'Saved', vi: 'Đã lưu' },
  aiStatusImageError: { en: 'Image error', vi: 'Lỗi ảnh' },
  aiSheetGenerating: { en: 'Creating image sheet…', vi: 'Đang tạo ảnh sheet…' },
  aiNoImageYet: { en: 'No image yet', vi: 'Chưa tạo ảnh' },
  aiRetryImage: { en: 'Retry image', vi: 'Thử lại ảnh' },
  aiAdded: { en: 'Added', vi: 'Đã thêm' },
  aiAddWithImage: { en: 'Add with image', vi: 'Thêm kèm ảnh' },
  aiAddToList: { en: 'Add to library', vi: 'Thêm vào danh sách' },
  aiNotifyBatchSaved: {
    en: 'Created and saved {count} characters with reference images (close-up + 4 angles).',
    vi: 'Đã tạo và lưu {count} nhân vật kèm ảnh tham chiếu (cận mặt + 4 góc nhìn).',
  },
  aiNotifyAddedWithImage: {
    en: 'Added character "{name}" with its reference image.',
    vi: 'Đã thêm nhân vật "{name}" kèm ảnh tham chiếu.',
  },
  aiNotifyAddedWithoutImage: {
    en: 'Added character "{name}" (no reference image yet).',
    vi: 'Đã thêm nhân vật "{name}" (chưa có ảnh tham chiếu).',
  },
  aiNotifyRetrySaved: {
    en: 'Saved character "{name}" with its reference image.',
    vi: 'Đã lưu nhân vật "{name}" kèm ảnh tham chiếu.',
  },

  // ===== Hộp thoại xuất prompt nhân vật (CharacterPromptModal) =====
  promptModalTitle: { en: 'Character prompt: {name}', vi: 'Prompt nhân vật: {name}' },
  promptDescription: {
    en: 'Paste this prompt into another image or video tool to keep the character’s appearance and voice accurate.',
    vi: 'Dán prompt này vào công cụ tạo ảnh hoặc video khác để giữ đúng ngoại hình và giọng nói của nhân vật.',
  },
  promptLoading: { en: 'Generating prompt…', vi: 'Đang tạo prompt…' },
  promptTextareaLabel: { en: 'Character prompt', vi: 'Prompt nhân vật' },
  promptCopiedNotify: { en: 'Character prompt copied.', vi: 'Đã sao chép prompt nhân vật.' },
  promptCopyError: {
    en: 'Could not copy automatically. Select the text in the box and copy it manually.',
    vi: 'Không sao chép tự động được. Hãy chọn văn bản trong ô rồi sao chép thủ công.',
  },
  promptCopied: { en: 'Copied', vi: 'Đã sao chép' },
  promptCopy: { en: 'Copy prompt', vi: 'Sao chép prompt' },

  // ===== Vùng tạo ảnh minh hoạ (CharacterIllustrate) =====
  illustrationEmptyModels: {
    en: 'No image model yet. Add and classify an image model in API & Models.',
    vi: 'Chưa có model tạo ảnh. Thêm và phân loại model ảnh trong API & Models.',
  },
  illustrationSending: { en: 'Sending request…', vi: 'Đang gửi yêu cầu…' },
  illustrationGenerating: { en: 'Generating image…', vi: 'Đang tạo ảnh…' },
  illustrationGeneratingPercent: {
    en: 'Generating image… {percent}%',
    vi: 'Đang tạo ảnh… {percent}%',
  },
  illustrationNoImage: { en: 'No illustration yet', vi: 'Chưa có ảnh minh hoạ' },
  illustrationGenerate: { en: 'Generate illustration', vi: 'Tạo ảnh minh hoạ' },
  illustrationRegenerate: { en: 'Generate another image', vi: 'Tạo ảnh khác' },
  illustrationCost: {
    en: 'The image uses your API key, may incur costs, and will appear in the Library.',
    vi: 'Ảnh dùng API key của bạn, có thể phát sinh chi phí và sẽ xuất hiện trong Thư viện.',
  },

  // ===== Trình xem ảnh phóng to (dùng chung) =====
  zoomImageTitle: { en: 'View image enlarged', vi: 'Xem ảnh phóng to' },
  zoomImageAria: { en: 'View the enlarged image of {name}', vi: 'Xem ảnh phóng to của {name}' },

  // ===== Lỗi do giao diện tự sinh (không phải văn bản thô từ server) =====
  errorNoAsset: {
    en: 'The task finished but returned no image to use.',
    vi: 'Tác vụ hoàn tất nhưng không có ảnh nào để dùng.',
  },
  errorGenerationTimeout: {
    en: 'Image generation took too long. Please try again.',
    vi: 'Tạo ảnh quá lâu. Hãy thử lại.',
  },
  errorIllustrationFailed: {
    en: 'Illustration generation failed.',
    vi: 'Tạo ảnh minh hoạ thất bại.',
  },
  errorReferenceImageFailed: {
    en: 'Reference image generation failed.',
    vi: 'Tạo ảnh tham chiếu thất bại.',
  },

  // ===== Hộp thoại minh hoạ nhân vật đã lưu (CharacterIllustrateModal) =====
  illustrateModalTitle: {
    en: 'Illustrate character: {name}',
    vi: 'Minh hoạ nhân vật: {name}',
  },
  illustrateModalDescription: {
    en: 'Pick an image model to generate an illustration. Once ready, it automatically becomes the character’s reference image (replacing any previous one).',
    vi: 'Chọn model tạo ảnh để sinh ảnh minh hoạ. Ảnh xong sẽ tự động trở thành ảnh tham chiếu của nhân vật (thay ảnh tham chiếu cũ nếu có).',
  },
  illustrateAttaching: { en: 'Attaching image to character…', vi: 'Đang gắn ảnh vào nhân vật…' },
  illustrateAttachedNotify: {
    en: 'Created and attached a reference image for "{name}".',
    vi: 'Đã tạo và gắn ảnh tham chiếu cho "{name}".',
  },
} as const satisfies Catalog

export type CharactersCatalog = typeof charactersCatalog
