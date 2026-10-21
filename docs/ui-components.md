# Shared UI và ranh giới component

Lumina dùng React, native HTML controls và CSS hiện có; không thêm UI framework.
Mục tiêu là chia sẻ phần trình bày lặp lại, không hợp nhất các state machine có
quy tắc nghiệp vụ khác nhau.

## Cấu trúc

- `src/components/ui/`: Button/IconButton/CloseButton, Field/SelectControl,
  PageHeading, LoadingState/EmptyState/InlineNotice/Toast, DialogFrame và
  useModalLayer.
- `src/components/generation/`: CreationCard/GenerationProgress/status, video
  provider dispatcher, provider/model fields, source-image strip và preview adapter.
- `src/components/settings/`: connection fields, model price editor và submit guard.
- `src/components/usage/`: kind/outcome selectors và metric card.
- `src/components/project/ProjectBrowser.tsx`: dashboard trình bày, không fetch/mutate.
- `src/hooks/`: autosize textarea và scroll-to-bottom với trigger do caller chọn.
- `src/components/Common.tsx`: compatibility exports; code mới nên import từ module
  UI hoặc generation cụ thể.

## Native contracts

`Button` mặc định `type="button"`. Nút gửi form phải khai báo `type="submit"`.
Props native, `aria-*`, `data-*` và ref được chuyển tới phần tử HTML thật.
`IconButton` cần `label`; `CloseButton` dùng `.close-button` và icon X được ẩn khỏi
accessibility tree. Không đổi chuẩn vùng bấm nút đóng 44×44px.

`className` là **thay thế chính xác** class mặc định, không tự nối một class UI mới.
Điều này giữ các selector/direct-child của CSS và E2E hiện hữu. Caller có thể dùng
variant primary/secondary/ghost/danger khi không cần class feature riêng.

`Field` là native label bao control. Caller vẫn sở hữu validation, IDs và liên kết
`aria-describedby`/`aria-invalid` của control. `labelWrapper={false}` giữ text trực
tiếp trong các form legacy. `SelectControl` giữ callback `onChange(value, event)`;
không thay native select bằng custom listbox.

`PageHeading` nhận title/description/eyebrow/actions dạng slot. `intro` giữ được
markup và heading riêng; không ép account, dashboard hay workspace vào một độ rộng.

`LoadingState` mặc định có `role="status"`/live polite; `EmptyState` không tự trở
thành thông báo trạng thái. Khi chuyển markup legacy, có thể truyền children và
class chính xác. `InlineNotice` không tự chọn role. Toast chỉ dùng tone lỗi khi
caller biết đây là lỗi, không suy đoán từ nội dung chuỗi.

## Dialog ownership

`DialogFrame` chỉ tạo backdrop/panel. Caller giữ header, body, form và footer là
các direct children hiện có, đồng thời cung cấp accessible name/description.

- `closeDisabled`: chặn backdrop và Escape; caller cũng phải disable nút đóng/hủy.
- `closeOnBackdrop` và `closeOnEscape`: chính sách explicit của từng feature.
- `portal`: mặc định false để không âm thầm đổi DOM/layout legacy.
- `enabled={false}`: không thêm keyboard/focus owner. Chỉ dùng khi giữ owner cũ
  hoặc chưa migrate hành vi; không được bật hook cũ và hook mới cùng lúc.

`useModalLayer` quản lý stack chung, scroll lock, focus containment, focus restore
và chỉ lớp trên cùng nhận Escape. Drawer chỉ đăng ký khi mở. Hook nhường bàn phím
và focus cho native `dialog:modal`; native generation preview tiếp tục dùng
`showModal()` và cancel guard của chính nó.

`SceneEditorModal` vẫn là shell chuyên biệt: dirty confirmation, suspended/native
preview, lightbox và phục hồi vị trí scroll không bị thay bằng DialogFrame chung.
Timeline/proposal drawers cũng giữ chính sách riêng. Mobile sidebar đóng scope
focus trước khi gọi navigation guard có thể mở một dialog khác.

## Nghiệp vụ vẫn ở caller

- `VideoProviderControls` chỉ chọn component Higgsfield/Agnes/OpenAI. Model switch,
  defaults, validation, media consent và persistence không thuộc dispatcher.
- `controlKey` remount mọi video control; `higgsfieldKey` chỉ remount upload-owning
  Higgsfield. Giữ chính sách cũ của từng caller khi migrate.
- `ProviderModelFields` không tự chọn model thay thế khi model đã lưu bị xóa/tắt.
- `SourceImageStrip` hiển thị thumbnail/remove/add; caller giữ upload lifecycle,
  giới hạn, scope và sự khác nhau giữa upload IDs và generated asset IDs.
- Canvas video controls không cho upload/consent/input-mode như Quick/Scene;
  không thay chúng bằng full provider controls hoặc gộp các sanitizer.
- Usage personal/admin chia sẻ controls và cards, không chia sẻ pagination/fetch
  vì default range, abort và debounce khác nhau.
- Generation cards giữ polling, postprocess, retry/cancel và stale-parent guard.
  Progress chỉ dùng phần trăm thật từ provider, không bịa tiến độ.

## CSS và i18n

`src/main.tsx` nạp tokens → UI CSS → legacy CSS; feature CSS vẫn có scope riêng.
Token `--ui-*` additive, không thay các token palette/readability đang hiệu lực.
Không thêm global reset hoặc override `.active`/`input`/`label` để chữa một feature.
Portal phải có class scope trên chính portal root, không dựa vào app-shell ancestor.

Nội dung UI được dịch tại render. Error giữ object gốc hoặc descriptor; nội dung
user/AI/provider không bị dịch lại. Giá trị enum, ID và payload API không đổi.

## Kiểm thử

- `pnpm run typecheck`, `pnpm run check:i18n`, `pnpm run build`.
- `tests/sharedUi.spec.ts`: native props/ref/type, labels, summary focus, busy,
  nested shared/native modal ownership.
- `tests/appLifecycle.spec.ts`: catalog account lifetime, lazy Canvas, navigation
  save guard và dirty mobile navigation.
- `tests/sidebar.spec.ts`: inert drawer, keyboard focus và desktop-collapse → mobile.
- Các suite generation/settings/modal/usage hiện có tiếp tục là regression contract.
- `pnpm run verify`: đầy đủ typecheck, i18n, backend, build và E2E mock cô lập.

Không dùng database/media của developer hoặc provider trả phí để kiểm UI.
Screenshots do các test tạo là evidence, không phải pixel-golden cần cập nhật hàng loạt.
