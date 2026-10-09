/**
 * Catalog namespace `studio`.
 *
 * Bao phủ toàn bộ chuỗi giao diện của:
 *   - src/pages/StudioPage.tsx
 *   - src/pages/LibraryPage.tsx
 *   - src/pages/ProjectStudio.tsx (ProjectForm, SceneWorkspace, Modal)
 *   - src/components/ProjectTrashDialog.tsx
 *
 * Quy ước:
 *   - Khoá ngữ nghĩa, mỗi khoá có đủ `en` (mặc định) và `vi`.
 *   - Bản `vi` giữ nguyên văn bản đang hiển thị trước khi bật i18n.
 *   - Tham số nội suy dạng `{name}`; xem `interpolate` trong `../translate`.
 *   - KHÔNG đưa nội dung do người dùng/AI/provider sinh ra vào catalog.
 */

import type { Catalog } from '../types'

export const studioCatalog = {
  // ---------------------------------------------------------------------------
  // StudioPage — tiêu đề, chế độ tạo
  // ---------------------------------------------------------------------------
  studioEyebrow: { en: 'Studio', vi: 'Studio' },
  studioHeadingLead: { en: 'Create content ', vi: 'Tạo nội dung ' },
  studioHeadingEmphasis: { en: 'with your own API.', vi: 'với API của bạn.' },
  studioIntro: {
    en: 'Pick a provider and model, then start creating images or videos.',
    vi: 'Chọn provider, model và bắt đầu tạo ảnh hoặc video.',
  },
  openLibrary: { en: 'Open library', vi: 'Mở thư viện' },
  modeImage: { en: 'Create image', vi: 'Tạo ảnh' },
  modeVideo: { en: 'Create video', vi: 'Tạo video' },
  betaBadge: { en: 'BETA', vi: 'BETA' },

  // ---------------------------------------------------------------------------
  // StudioPage — prompt & cấu hình
  // ---------------------------------------------------------------------------
  promptLabel: { en: 'Describe your idea', vi: 'Mô tả ý tưởng' },
  promptCounter: { en: '{count} / {max}', vi: '{count} / {max}' },
  promptPlaceholder: { en: 'Describe what you want to create...', vi: 'Mô tả điều bạn muốn tạo...' },
  manageReferences: { en: 'Manage reference images', vi: 'Quản lý ảnh tham chiếu' },
  configSection: { en: 'Configuration', vi: 'Cấu hình' },
  providerLabel: { en: 'Provider', vi: 'Provider' },
  modelLabel: { en: 'Model', vi: 'Model' },
  sizeLabel: { en: 'Size', vi: 'Kích thước' },
  qualityLabel: { en: 'Quality', vi: 'Chất lượng' },
  qualityDefault: { en: 'Model default (not sent)', vi: 'Mặc định của model (không gửi)' },
  qualityLow: { en: 'Low · Fast', vi: 'Thấp · Nhanh' },
  qualityMedium: { en: 'Medium', vi: 'Trung bình' },
  qualityHigh: { en: 'High', vi: 'Cao' },
  imageCountLabel: { en: 'Images', vi: 'Số ảnh' },
  imageCountOption: { en: '{count} images', enOne: '{count} image', vi: '{count} ảnh' },
  durationLabel: { en: 'Duration', vi: 'Thời lượng' },
  secondsOption: { en: '{count} seconds', vi: '{count} giây' },

  // Kích thước ở StudioPage dùng ký tự "x" (khác ProjectStudio dùng "×").
  studioSizeSquare: { en: '1024x1024 · Square', vi: '1024x1024 · Vuông' },
  studioSizeLandscape1536: { en: '1536x1024 · Landscape', vi: '1536x1024 · Ngang' },
  studioSizePortrait1024: { en: '1024x1536 · Portrait', vi: '1024x1536 · Dọc' },
  studioVideoLandscape: { en: '1280x720 · Landscape', vi: '1280x720 · Ngang' },
  studioVideoPortrait: { en: '720x1280 · Portrait', vi: '720x1280 · Dọc' },

  // Kích thước ở ProjectStudio dùng ký tự "×".
  projectSizeSquare: { en: '1024×1024 · Square', vi: '1024×1024 · Vuông' },
  projectSizeLandscape1536: { en: '1536×1024 · Landscape', vi: '1536×1024 · Ngang' },
  projectSizePortrait1024: { en: '1024×1536 · Portrait', vi: '1024×1536 · Dọc' },
  projectSizeLandscape1280: { en: '1280×720 · Landscape', vi: '1280×720 · Ngang' },
  projectSizePortrait720: { en: '720×1280 · Portrait', vi: '720×1280 · Dọc' },

  noImageModel: { en: 'No image model yet', vi: 'Chưa có model ảnh' },
  noVideoModel: { en: 'No video model yet', vi: 'Chưa có model video' },
  noModelsHint: {
    en: 'Add a provider and classify a model in API & Models to get started.',
    vi: 'Thêm provider và phân loại model trong API & Models để bắt đầu.',
  },
  openApiModels: { en: 'Open API & Models', vi: 'Mở API & Models' },

  // ---------------------------------------------------------------------------
  // StudioPage — nhân vật tham chiếu
  // ---------------------------------------------------------------------------
  characterOptionalLabel: { en: 'Character (optional)', vi: 'Nhân vật (tùy chọn)' },
  charactersInLibrary: { en: '{count} in library', vi: '{count} trong thư viện' },
  charactersLibraryEmpty: { en: 'Library is empty', vi: 'Thư viện đang trống' },
  characterLabel: { en: 'Character', vi: 'Nhân vật' },
  noCharacterAttached: { en: 'No character attached', vi: 'Không gắn nhân vật' },
  characterWithReference: { en: '{name} · with reference image', vi: '{name} · có ảnh tham chiếu' },
  characterDescriptionOnly: { en: '{name} · description only', vi: '{name} · chỉ mô tả' },
  characterReferenceAlt: { en: 'Reference image of {name}', vi: 'Ảnh tham chiếu của {name}' },
  noAppearance: { en: 'No appearance described yet.', vi: 'Chưa mô tả ngoại hình.' },
  noCharacterAppearance: {
    en: 'No appearance described for this character yet.',
    vi: 'Chưa mô tả ngoại hình cho nhân vật này.',
  },
  characterSync: { en: 'Character sync: {name}', vi: 'Đồng bộ nhân vật: {name}' },
  sendReferencePrefix: { en: 'Send the reference image of ', vi: 'Gửi ảnh tham chiếu của ' },
  sendReferenceSuffixContent: {
    en: ' along with the content so the model matches the appearance.',
    vi: ' kèm nội dung để model bám đúng ngoại hình.',
  },
  sendReferenceSuffixImage: {
    en: ' along with the image so the model matches the appearance. Turn off if the provider does not support image editing.',
    vi: ' kèm ảnh để model bám đúng ngoại hình. Tắt nếu provider không hỗ trợ chỉnh sửa ảnh.',
  },
  sendReferenceSuffixVideo: { en: ' along with the video', vi: ' kèm video' },
  noReferenceHint: {
    en: 'This character has no reference image, so this generation relies on the appearance description only.',
    vi: 'Nhân vật này chưa có ảnh tham chiếu, lần tạo chỉ dựa trên mô tả ngoại hình.',
  },
  createCharacterHint: {
    en: 'Create a character with a reference image under Characters to keep the identity consistent.',
    vi: 'Tạo nhân vật kèm ảnh tham chiếu trong mục Nhân vật để giữ nhận diện nhất quán.',
  },
  noReferenceImage: { en: 'No reference image yet', vi: 'Chưa có ảnh tham chiếu' },
  characterNoReferenceWarning: {
    en: 'The character has no reference image, so this generation relies on the appearance description only. Add an image for a more consistent identity.',
    vi: 'Nhân vật chưa có ảnh tham chiếu nên lần tạo này chỉ dựa trên mô tả ngoại hình. Thêm ảnh để giữ nhận diện nhất quán hơn.',
  },
  addReferenceImage: { en: 'Add reference image', vi: 'Thêm ảnh tham chiếu' },
  referenceLimitHint: {
    en: 'The reference image counts toward the limit of {max} input images per generation.',
    vi: 'Ảnh tham chiếu tính vào giới hạn {max} ảnh đầu vào mỗi lần tạo.',
  },

  // ---------------------------------------------------------------------------
  // StudioPage — thông số nâng cao, trạng thái, chi phí
  // ---------------------------------------------------------------------------
  advancedNotice: {
    en: 'Advanced parameters depend on each provider.',
    vi: 'Thông số nâng cao phụ thuộc từng provider.',
  },
  advancedParams: { en: 'Advanced parameters', vi: 'Thông số nâng cao' },
  advancedJsonSummary: { en: 'Advanced parameters (JSON)', vi: 'Tham số nâng cao (JSON)' },
  statusReady: { en: 'Ready', vi: 'Sẵn sàng' },
  statusNoApi: { en: 'API not configured', vi: 'Chưa cấu hình API' },
  sending: { en: 'Sending...', vi: 'Đang gửi...' },
  generateImage: { en: 'Generate image', vi: 'Tạo hình ảnh' },
  generateProjectImage: { en: 'Generate image', vi: 'Tạo ảnh' },
  generateVideo: { en: 'Generate video', vi: 'Tạo video' },
  costNoteWithModel: {
    en: 'Each generation uses your API key and may incur provider costs.',
    vi: 'Mỗi lần tạo sẽ dùng API key của bạn và có thể phát sinh chi phí từ provider.',
  },
  costNoteNoModel: {
    en: 'No provider/model yet. Add a connection in API & Models first.',
    vi: 'Chưa có provider/model. Hãy thêm kết nối trong API & Models trước.',
  },

  // ---------------------------------------------------------------------------
  // StudioPage — kết quả gần đây & thống kê
  // ---------------------------------------------------------------------------
  recentResults: { en: 'Recent results', vi: 'Kết quả gần đây' },
  yourSpace: { en: 'Your space', vi: 'Không gian của bạn' },
  viewAll: { en: 'View all', vi: 'Xem tất cả' },
  kindVideo: { en: 'Video', vi: 'Video' },
  kindImage: { en: 'Image', vi: 'Image' },
  copyPrompt: { en: 'Copy prompt', vi: 'Sao chép prompt' },
  totalCreations: { en: 'Total creations', vi: 'Tổng creations' },
  providerInUse: { en: 'Provider in use', vi: 'Provider đang dùng' },
  notConfigured: { en: 'Not configured', vi: 'Chưa cấu hình' },
  modelSelected: { en: 'Selected model', vi: 'Model đang chọn' },
  canvasEyebrow: { en: 'Your canvas', vi: 'Your canvas' },
  recentCreations: { en: 'Recent creations', vi: 'Creations gần đây' },
  noResultsYet: { en: 'No results yet', vi: 'Chưa có kết quả nào' },
  studioEmptyHint: {
    en: 'Generated images and videos will appear here.',
    vi: 'Kết quả tạo ảnh và video sẽ xuất hiện ở đây.',
  },

  // ---------------------------------------------------------------------------
  // LibraryPage
  // ---------------------------------------------------------------------------
  libraryHeadingLead: { en: 'Library ', vi: 'Thư viện ' },
  libraryHeadingEmphasis: { en: 'of creations.', vi: 'sáng tạo.' },
  libraryIntro: {
    en: 'All your images and videos, stored in one place.',
    vi: 'Mọi hình ảnh và video của bạn, được lưu trữ ở một nơi.',
  },
  createNew: { en: 'Create new', vi: 'Tạo mới' },
  filterAll: { en: 'All', vi: 'Tất cả' },
  filterImages: { en: 'Images', vi: 'Ảnh' },
  filterVideos: { en: 'Videos', vi: 'Video' },
  libraryEmptyHint: { en: 'Start with a small idea in Studio.', vi: 'Bắt đầu với một ý tưởng nhỏ trong Studio.' },
  createFirst: { en: 'Create your first generation', vi: 'Tạo creation đầu tiên' },

  // ---------------------------------------------------------------------------
  // Dùng chung
  // ---------------------------------------------------------------------------
  loadingShort: { en: 'Loading...', vi: 'Đang tải...' },
  close: { en: 'Close', vi: 'Đóng' },
  cancel: { en: 'Cancel', vi: 'Hủy' },
  edit: { en: 'Edit', vi: 'Sửa' },
  deleteAction: { en: 'Delete', vi: 'Xóa' },
  restore: { en: 'Restore', vi: 'Khôi phục' },
  chooseModel: { en: 'Choose a model', vi: 'Chọn model' },
  noSpeaker: { en: 'No speaker', vi: 'Không có người nói' },
  versionSelectedPill: { en: 'Version selected', vi: 'Đã chọn phiên bản' },

  // ---------------------------------------------------------------------------
  // ProjectTrashDialog
  // ---------------------------------------------------------------------------
  trashTitle: { en: 'Move to trash', vi: 'Chuyển vào thùng rác' },
  trashBodyPrefix: { en: 'Project ', vi: 'Dự án ' },
  trashBodySuffix: {
    en: ' will be kept in the trash for 30 days. You can restore it during that time; after that it is permanently deleted.',
    vi: ' sẽ được giữ trong thùng rác 30 ngày. Bạn có thể khôi phục trong thời gian này; sau đó dự án sẽ bị xóa vĩnh viễn.',
  },
  trashKeepResultsNote: {
    en: 'Generated results are kept by default. Projects with running or unknown tasks must wait for those tasks to finish before deletion. Restoring does not re-queue generation.',
    vi: 'Kết quả đã tạo được giữ nguyên mặc định. Dự án còn tác vụ đang chạy hoặc chưa rõ trạng thái phải đợi tác vụ kết thúc trước khi xóa. Khôi phục không tự xếp hàng tạo lại.',
  },
  trashDeleteResultsLabel: {
    en: 'Also delete result files after 30 days',
    vi: 'Xóa cả tệp kết quả sau 30 ngày',
  },
  trashDeleteResultsHint: {
    en: 'This option only takes effect at expiry; it does not delete files right now.',
    vi: 'Tùy chọn này chỉ có hiệu lực khi hết hạn, không xóa tệp ngay bây giờ.',
  },
  trashBusy: { en: 'Moving...', vi: 'Đang chuyển…' },

  // ---------------------------------------------------------------------------
  // ProjectForm
  // ---------------------------------------------------------------------------
  editProject: { en: 'Edit project', vi: 'Sửa dự án' },
  createProject: { en: 'Create project', vi: 'Tạo dự án' },
  projectNameLabel: { en: 'Project name', vi: 'Tên dự án' },
  descriptionLabel: { en: 'Description', vi: 'Mô tả' },
  projectDescriptionPlaceholder: { en: 'A short story about...', vi: 'Một câu chuyện ngắn về…' },
  styleLabel: { en: 'Shared style', vi: 'Phong cách chung' },
  stylePlaceholder: { en: 'Watercolor cinema, warm light...', vi: 'Điện ảnh màu nước, ánh sáng ấm…' },
  projectLanguageLabel: { en: 'Language', vi: 'Ngôn ngữ' },
  projectFormNotice: {
    en: 'Style and language are combined into the prompt of every image and scene in the project, which keeps things consistent.',
    vi: 'Phong cách và ngôn ngữ được ghép vào prompt của mọi ảnh và cảnh trong dự án, giúp giữ tính nhất quán.',
  },
  saveProject: { en: 'Save project', vi: 'Lưu dự án' },

  // ---------------------------------------------------------------------------
  // ProjectStudio — dashboard dự án
  // ---------------------------------------------------------------------------
  projectStudioEyebrow: { en: 'Project studio', vi: 'Project studio' },
  projectStudioTitle: { en: 'Creative projects', vi: 'Dự án sáng tạo' },
  projectStudioIntro: {
    en: 'Each project keeps a shared style, characters and voices for every image and video.',
    vi: 'Mỗi dự án giữ phong cách, nhân vật và giọng nói dùng chung cho mọi ảnh và video.',
  },
  refresh: { en: 'Refresh', vi: 'Làm mới' },
  noModelsConfigured: { en: 'No model is configured yet', vi: 'Chưa có model nào được cấu hình' },
  noModelsConfiguredHint: {
    en: 'Add a provider and classify models before creating content.',
    vi: 'Thêm provider và phân loại model trước khi tạo nội dung.',
  },
  searchProjectsPlaceholder: { en: 'Search projects…', vi: 'Tìm dự án…' },
  projectsTab: { en: 'Projects', vi: 'Dự án' },
  trashTab: { en: 'Trash', vi: 'Thùng rác' },
  showArchivedLabel: { en: 'Show archived projects', vi: 'Hiện dự án lưu trữ' },
  trashSummary: {
    en: 'Trash · Restore projects within 30 days before they are permanently deleted. Results are kept unless you chose to delete the files as well.',
    vi: 'Thùng rác · Khôi phục dự án trong 30 ngày trước khi bị xóa vĩnh viễn. Kết quả được giữ lại trừ khi bạn đã chọn xóa cả tệp.',
  },
  loadingProjects: { en: 'Loading projects…', vi: 'Đang tải dự án…' },
  noContent: { en: 'No content yet', vi: 'Chưa có nội dung' },
  archivedBadge: { en: 'Archived', vi: 'Đã lưu trữ' },
  archiveAction: { en: 'Archive', vi: 'Lưu trữ' },
  permanentDeleteAt: { en: 'Permanently deleted: {date}', vi: 'Xóa vĩnh viễn: {date}' },
  after30Days: { en: 'After 30 days', vi: 'Sau 30 ngày' },
  purgeDeletesResults: {
    en: 'Result files will be deleted at expiry.',
    vi: 'Sẽ xóa cả tệp kết quả khi hết hạn.',
  },
  purgeKeepsResults: {
    en: 'Result files will be kept at expiry.',
    vi: 'Giữ lại tệp kết quả khi hết hạn.',
  },
  trashEmptyTitle: { en: 'Trash is empty', vi: 'Thùng rác trống' },
  trashEmptyHint: { en: 'No projects match.', vi: 'Không có dự án nào phù hợp.' },
  createNewProject: { en: 'Create a new project', vi: 'Tạo dự án mới' },
  startProjectHint: {
    en: 'Start a story, add characters and keep the voices consistent throughout.',
    vi: 'Bắt đầu một câu chuyện, thêm nhân vật và giữ giọng nói xuyên suốt.',
  },
  projectList: { en: 'Project list', vi: 'Danh sách dự án' },
  noDescription: { en: 'No description.', vi: 'Chưa có mô tả.' },
  characterCount: { en: '{count} characters', enOne: '{count} character', vi: '{count} nhân vật' },
  sceneCount: { en: '{count} scenes', enOne: '{count} scene', vi: '{count} cảnh' },
  archivedProjectNotice: {
    en: 'This project is archived. Restore it before creating new content.',
    vi: 'Dự án đang ở trạng thái lưu trữ. Khôi phục trước khi tạo nội dung mới.',
  },
  tabImagesAria: { en: 'Images', vi: 'Ảnh' },
  tabCharactersAria: { en: 'Characters', vi: 'Nhân vật' },
  tabScenesAria: { en: 'Video scenes', vi: 'Cảnh video' },
  loadingProjectDetails: { en: 'Loading project content…', vi: 'Đang tải nội dung dự án…' },

  // ---------------------------------------------------------------------------
  // ProjectStudio — tab ảnh
  // ---------------------------------------------------------------------------
  createProjectImage: { en: 'Create an image in the project', vi: 'Tạo ảnh trong dự án' },
  imageModelLabel: { en: 'Image model', vi: 'Model ảnh' },
  imagePromptLabel: { en: 'Image description', vi: 'Mô tả ảnh' },
  imagePromptPlaceholder: {
    en: 'A pine forest in the early morning, mist...',
    vi: 'Khu rừng thông buổi sớm, sương mù…',
  },
  sourceImagesLabel: { en: 'Source images (image-to-image)', vi: 'Ảnh nguồn (tạo ảnh từ ảnh)' },
  removeSourceImageAria: { en: 'Remove source image', vi: 'Xóa ảnh nguồn' },
  addImage: { en: 'Add image', vi: 'Thêm ảnh' },
  sourceImagesHintPrefix: {
    en: 'Up to {max} images. When source images are present, the app calls',
    vi: 'Tối đa {max} ảnh. Khi có ảnh nguồn, ứng dụng gọi',
  },
  sourceImagesHintSuffix: {
    en: ' to create a new image from it. The model must support this endpoint.',
    vi: ' để tạo ảnh mới từ ảnh đó. Model phải hỗ trợ endpoint này.',
  },
  projectImagesPanel: { en: 'Images in the project', vi: 'Ảnh trong dự án' },
  imageCountBadge: { en: '{count} images', enOne: '{count} image', vi: '{count} ảnh' },
  noImagesTitle: { en: 'No images yet', vi: 'Chưa có ảnh nào' },
  noImagesHint: {
    en: 'Enter a description and press Generate image. Images keep the shared style of the project.',
    vi: 'Nhập mô tả và bấm Tạo ảnh. Ảnh sẽ giữ phong cách chung của dự án.',
  },

  // ---------------------------------------------------------------------------
  // ProjectStudio — tab nhân vật
  // ---------------------------------------------------------------------------
  charactersVoicesTitle: { en: 'Characters and voices', vi: 'Nhân vật và giọng nói' },
  charactersVoicesHint: {
    en: 'A voice is saved once per character and reused in every scene.',
    vi: 'Giọng nói được lưu một lần cho mỗi nhân vật và dùng lại ở mọi cảnh.',
  },
  addCharacter: { en: 'Add character', vi: 'Thêm nhân vật' },
  sharedLibraryScope: { en: 'Shared library', vi: 'Thư viện dùng chung' },
  projectScope: { en: 'In the project', vi: 'Trong dự án' },
  noVoiceProfile: { en: 'No voice profile yet', vi: 'Chưa có hồ sơ giọng nói' },
  noCharactersTitle: { en: 'No characters yet', vi: 'Chưa có nhân vật' },
  noCharactersHint: {
    en: 'Add characters with an appearance and a voice profile to reuse across video scenes.',
    vi: 'Thêm nhân vật kèm ngoại hình và hồ sơ giọng nói để dùng chung cho các cảnh video.',
  },

  // ---------------------------------------------------------------------------
  // ProjectStudio — tab cảnh
  // ---------------------------------------------------------------------------
  videoSceneSequence: { en: 'Video scene sequence', vi: 'Chuỗi cảnh video' },
  videoSceneSequenceHint: {
    en: 'Order the scenes; each scene has one speaking character and a fixed voice profile.',
    vi: 'Sắp xếp thứ tự cảnh, mỗi cảnh một nhân vật nói và một hồ sơ giọng cố định.',
  },
  addScene: { en: 'Add scene', vi: 'Thêm cảnh' },
  characterFallback: { en: 'Character', vi: 'Nhân vật' },
  editSceneAria: { en: 'Edit scene {title}', vi: 'Sửa cảnh {title}' },
  moveSceneUpAria: { en: 'Move scene {title} up', vi: 'Đưa cảnh {title} lên' },
  moveSceneDownAria: { en: 'Move scene {title} down', vi: 'Đưa cảnh {title} xuống' },
  noScenesTitle: { en: 'No scenes yet', vi: 'Chưa có cảnh nào' },
  noScenesHint: {
    en: 'Add the first scene, choose a speaking character and enter the dialogue.',
    vi: 'Thêm cảnh đầu tiên, chọn nhân vật nói và nhập lời thoại.',
  },
  noVideoModelHint: {
    en: 'At least one video model classified in API & Models is required.',
    vi: 'Cần ít nhất một model video đã phân loại trong API & Models.',
  },

  // ---------------------------------------------------------------------------
  // ProjectStudio — hàng loạt cảnh & ảnh minh hoạ storyboard
  // ---------------------------------------------------------------------------
  createImageShortcut: { en: 'Create image', vi: 'Tạo ảnh' },
  tabImagesHint: {
    en: 'Create standalone images for this project. Timeline illustrations come from the AI script planner, not from here.',
    vi: 'Tạo ảnh riêng cho dự án. Ảnh minh hoạ timeline đến từ phần Tạo kịch bản AI, không phải từ đây.',
  },
  sceneCoverIllustration: { en: 'Timeline illustration', vi: 'Ảnh minh hoạ timeline' },
  sceneCoverIllustrationAria: {
    en: 'Illustration of scene {title} copied from the AI script planner',
    vi: 'Ảnh minh hoạ cảnh {title} sao chép từ Tạo kịch bản AI',
  },
  sceneSelectAria: { en: 'Select scene {title}', vi: 'Chọn cảnh {title}' },
  sceneApprovalAria: { en: 'Approve scene {title}', vi: 'Duyệt cảnh {title}' },
  sceneApprovedLabel: { en: 'Approved', vi: 'Đã duyệt' },
  sceneWaitingApproval: {
    en: 'Waiting for approval — no video has been created yet.',
    vi: 'Đang chờ duyệt — chưa tạo video nào.',
  },
  sceneGenerateVideo: { en: 'Generate video', vi: 'Tạo video' },
  sceneChooseModel: { en: 'Choose a video model', vi: 'Chọn model video' },
  sceneStatusQueued: { en: 'Queued', vi: 'Đang chờ' },
  sceneStatusRunning: { en: 'Running {progress}%', vi: 'Đang chạy {progress}%' },
  sceneStatusFailed: { en: 'Failed', vi: 'Thất bại' },
  sceneVersionCount: { en: '{count} versions', enOne: '{count} version', vi: '{count} phiên bản' },
  sceneSelectedVersion: { en: 'Selected version', vi: 'Đã chọn phiên bản' },
  sceneBulkTitle: { en: 'Bulk actions', vi: 'Thao tác hàng loạt' },
  sceneBulkSelected: { en: '{count} scenes selected', enOne: '{count} scene selected', vi: 'Đã chọn {count} cảnh' },
  sceneBulkApprove: { en: 'Approve selected', vi: 'Duyệt cảnh đã chọn' },
  sceneBulkUnapprove: { en: 'Unapprove selected', vi: 'Bỏ duyệt cảnh đã chọn' },
  sceneBulkAssignModel: { en: 'Assign model', vi: 'Gán model' },
  sceneBulkAssignModelHint: {
    en: 'Applies to selected scenes, or to every scene without a model when nothing is selected.',
    vi: 'Áp dụng cho cảnh đã chọn, hoặc cho mọi cảnh chưa có model khi không chọn cảnh nào.',
  },
  sceneBulkGenerate: { en: 'Generate for approved scenes', vi: 'Tạo cho các cảnh đã duyệt' },
  sceneBulkGenerateHint: {
    en: 'Marks approved scenes for generation; the worker then queues them one after another.',
    vi: 'Đánh dấu các cảnh đã duyệt để tạo; worker sẽ xếp hàng lần lượt.',
  },
  sceneBulkCostWarning: {
    en: 'Generation uses your API key and may incur provider charges.',
    vi: 'Tạo nội dung dùng API key của bạn và có thể phát sinh phí từ provider.',
  },
  sceneBulkNoVideoModel: {
    en: 'Add and classify a video model in API & Models before generating.',
    vi: 'Hãy thêm và phân loại model video trong API & Models trước khi tạo.',
  },
  sceneBulkNeedsSelection: {
    en: 'Select at least one scene first.',
    vi: 'Hãy chọn ít nhất một cảnh trước.',
  },
  sceneBulkNoModelSelected: {
    en: 'Choose a video model to assign.',
    vi: 'Hãy chọn model video để gán.',
  },
  sceneBulkNoApproved: {
    en: 'No approved scene is ready to generate.',
    vi: 'Chưa có cảnh nào đã duyệt để tạo.',
  },

  // ---------------------------------------------------------------------------
  // SceneWorkspace — ảnh minh hoạ storyboard
  // ---------------------------------------------------------------------------
  sceneIllustrationTitle: { en: 'Storyboard illustration', vi: 'Ảnh minh hoạ storyboard' },
  sceneIllustrationHint: {
    en: 'Illustration only: this image comes from the AI script planner timeline and is NOT sent to the video model.',
    vi: 'Chỉ là ảnh minh hoạ: ảnh này đến từ timeline của Tạo kịch bản AI và KHÔNG được gửi cho model video.',
  },
  sceneIllustrationEmpty: {
    en: 'No illustration yet. Generate one in the AI script planner timeline, or upload a replacement here.',
    vi: 'Chưa có ảnh minh hoạ. Hãy tạo trong timeline của Tạo kịch bản AI, hoặc tải ảnh thay thế ở đây.',
  },
  sceneIllustrationSaveFirst: {
    en: 'Save the scene before adding an illustration.',
    vi: 'Hãy lưu cảnh trước khi thêm ảnh minh hoạ.',
  },
  sceneIllustrationPreviewAria: {
    en: 'Enlarge the illustration of scene {title}',
    vi: 'Phóng to ảnh minh hoạ của cảnh {title}',
  },
  sceneIllustrationReplace: { en: 'Replace image', vi: 'Thay ảnh' },
  sceneIllustrationUploading: { en: 'Uploading…', vi: 'Đang tải lên…' },
  sceneIllustrationRemove: { en: 'Remove image', vi: 'Xoá ảnh' },
  sceneIllustrationReadOnly: {
    en: 'Archived projects cannot change illustrations.',
    vi: 'Dự án đã lưu trữ không đổi được ảnh minh hoạ.',
  },
  notifyIllustrationUpdated: { en: 'Scene illustration updated.', vi: 'Đã cập nhật ảnh minh hoạ của cảnh.' },
  notifyIllustrationRemoved: { en: 'Scene illustration removed.', vi: 'Đã xoá ảnh minh hoạ của cảnh.' },
  notifyScenesApproved: { en: 'Scenes approved.', vi: 'Đã duyệt các cảnh.' },
  notifyScenesUnapproved: { en: 'Scenes unapproved.', vi: 'Đã bỏ duyệt các cảnh.' },
  notifyScenesModelAssigned: { en: 'Video model assigned to scenes.', vi: 'Đã gán model video cho các cảnh.' },
  notifyScenesQueued: {
    en: 'Approved scenes are marked for generation; the worker queues them sequentially.',
    vi: 'Các cảnh đã duyệt được đánh dấu để tạo; worker sẽ xếp hàng lần lượt.',
  },

  // ---------------------------------------------------------------------------
  // SceneWorkspace
  // ---------------------------------------------------------------------------
  stepSceneContent: { en: '1 · Scene content', vi: '1 · Nội dung cảnh' },
  stepPreviewPrompt: { en: '2 · Preview prompt', vi: '2 · Xem trước prompt' },
  stepGenerateVideo: { en: '3 · Generate video', vi: '3 · Tạo video' },
  editingScene: { en: 'Editing scene', vi: 'Cảnh đang sửa' },
  newScene: { en: 'New scene', vi: 'Cảnh mới' },
  noVideoModelNoticePrefix: {
    en: 'Add a provider and classify at least one model as ',
    vi: 'Thêm provider và phân loại ít nhất một model thành ',
  },
  noVideoModelNoticeSuffix: {
    en: ' in API & Models to create scenes.',
    vi: ' trong API & Models để tạo được cảnh.',
  },
  sceneTitleLabel: { en: 'Scene name', vi: 'Tên cảnh' },
  sceneTitlePlaceholder: { en: 'Morning in Da Lat', vi: 'Buổi sáng ở Đà Lạt' },
  scenePromptLabel: { en: 'Description / action', vi: 'Mô tả / hành động' },
  scenePromptPlaceholder: {
    en: 'An walks through a pine forest, morning mist, camera follows...',
    vi: 'An đi qua rừng thông, sương sớm, máy quay theo chân…',
  },
  sceneBackgroundLabel: { en: 'Setting', vi: 'Bối cảnh' },
  sceneBackgroundPlaceholder: {
    en: 'Example: a beach at sunset, gentle waves, golden light',
    vi: 'Ví dụ: bãi biển lúc hoàng hôn, sóng nhẹ, ánh vàng',
  },
  speakerLabel: { en: 'One speaking character', vi: 'Một nhân vật nói' },
  dialogueLabel: { en: 'Dialogue', vi: 'Lời thoại' },
  dialoguePlaceholder: { en: 'Hello Da Lat.', vi: 'Chào Đà Lạt.' },
  videoModelLabel: { en: 'Video model', vi: 'Model video' },
  sceneVoiceNotice: {
    en: 'Each scene has exactly one speaking character. The model receives that character voice profile, but the prompt cannot lock the voice identity and does not guarantee lip sync.',
    vi: 'Mỗi cảnh chỉ có một nhân vật nói. Model sẽ nhận đúng hồ sơ giọng của nhân vật đó, nhưng prompt không khóa được danh tính giọng và không bảo đảm khớp miệng.',
  },
  promptPreviewTitle: { en: 'Prompt sent to the provider', vi: 'Prompt sẽ gửi cho provider' },
  saveAndPreview: { en: 'Save & preview prompt', vi: 'Lưu & xem trước prompt' },
  saveScene: { en: 'Save scene', vi: 'Lưu cảnh' },
  generateOrRetry: { en: 'Generate / retry a new version', vi: 'Tạo / thử lại phiên bản mới' },
  generatingVideo: { en: 'Generating video…', vi: 'Đang tạo video…' },
  sceneVersionsTitle: { en: 'Scene versions', vi: 'Phiên bản của cảnh' },
  versionCount: { en: '{count} versions', enOne: '{count} version', vi: '{count} phiên bản' },
  selecting: { en: 'Selecting', vi: 'Đang chọn' },
  selectVersion: { en: 'Select this version', vi: 'Chọn phiên bản này' },
  noVersionsTitle: { en: 'No versions yet', vi: 'Chưa có phiên bản nào' },
  noVersionsHintPrefix: { en: 'Preview the prompt, then press ', vi: 'Xem trước prompt rồi bấm ' },
  noVersionsHintSuffix: { en: '. The result will appear here.', vi: '. Kết quả sẽ xuất hiện ở đây.' },

  // ---------------------------------------------------------------------------
  // Lỗi do ứng dụng tự sinh (không phải lỗi thô từ API/AI)
  // ---------------------------------------------------------------------------
  advancedParamsMustBeObject: {
    en: 'Advanced parameters must be a JSON object.',
    vi: 'Tham số nâng cao phải là một JSON object.',
  },
  sceneTitleRequired: { en: 'Enter a scene name.', vi: 'Điền tên cảnh.' },
  scenePromptRequired: {
    en: 'Enter a description / action for the scene.',
    vi: 'Điền mô tả / hành động cho cảnh.',
  },
  sceneModelRequired: { en: 'Choose a video model for the scene.', vi: 'Chọn model video cho cảnh.' },
  sceneDialogueNeedsCharacter: {
    en: 'A scene with dialogue needs a speaking character.',
    vi: 'Cảnh có lời thoại cần chọn một nhân vật nói.',
  },
  previewBeforeGenerate: {
    en: 'Preview the prompt before generating a video.',
    vi: 'Hãy xem trước prompt trước khi tạo video.',
  },
  characterDeleteFailed: { en: 'Could not delete the character.', vi: 'Không xóa được nhân vật.' },
  requestCancelled: { en: 'The request was cancelled', vi: 'Yêu cầu đã bị hủy' },
  unknownError: { en: 'An unknown error occurred', vi: 'Đã xảy ra lỗi không xác định' },

  // ---------------------------------------------------------------------------
  // Thông báo (toast) — dịch tại thời điểm hành động
  // ---------------------------------------------------------------------------
  notifyPromptCopied: { en: 'Prompt copied.', vi: 'Đã sao chép prompt.' },
  notifyRequestSent: {
    en: 'Request sent. Results will appear once the provider finishes.',
    vi: 'Đã gửi yêu cầu. Kết quả sẽ xuất hiện khi provider xử lý xong.',
  },
  notifyRequestQueued: {
    en: 'Generation request sent. Results update automatically.',
    vi: 'Đã gửi yêu cầu tạo. Kết quả sẽ tự cập nhật.',
  },
  notifyProjectTrashed: {
    en: 'Project moved to trash. You can restore it within 30 days.',
    vi: 'Đã chuyển dự án vào thùng rác. Bạn có thể khôi phục trong 30 ngày.',
  },
  notifyProjectRestored: {
    en: 'Project restored. Generation tasks do not run again automatically.',
    vi: 'Đã khôi phục dự án. Các tác vụ tạo không tự chạy lại.',
  },
  notifyProjectUpdated: { en: 'Project updated.', vi: 'Đã cập nhật dự án.' },
  notifyProjectCreated: {
    en: 'Project created. Add characters to keep voices consistent.',
    vi: 'Đã tạo dự án. Thêm nhân vật để giữ giọng nói nhất quán.',
  },
  notifyProjectArchived: { en: 'Project archived.', vi: 'Đã lưu trữ dự án.' },
  notifyProjectUnarchived: { en: 'Project restored.', vi: 'Đã khôi phục dự án.' },
  notifyCharacterUpdated: {
    en: 'Character updated. Existing scenes keep their old prompts.',
    vi: 'Đã cập nhật nhân vật. Các cảnh đã tạo vẫn giữ prompt cũ.',
  },
  notifyCharacterAdded: { en: 'Character added.', vi: 'Đã thêm nhân vật.' },
  notifyCharacterDeleted: { en: 'Character deleted.', vi: 'Đã xóa nhân vật.' },
  notifySceneSaved: { en: 'Scene saved.', vi: 'Đã lưu cảnh.' },
  notifyVersionSelected: {
    en: 'Main version selected for the scene.',
    vi: 'Đã chọn phiên bản chính cho cảnh.',
  },
  notifyResultDeleted: { en: 'Result removed from the project.', vi: 'Đã xóa kết quả khỏi dự án.' },
} as const satisfies Catalog

export type StudioCatalog = typeof studioCatalog

/** Khoá hợp lệ của namespace `studio`. */
export type StudioKey = keyof StudioCatalog & string
