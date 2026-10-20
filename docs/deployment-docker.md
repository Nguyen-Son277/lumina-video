# Triển khai Docker trên VPS + Cloudflare Tunnel

Ứng dụng chạy production bằng **Docker Compose**: một container Express phục vụ cả giao diện và API, một container `cloudflared` tùy chọn. Không cần cài Node, pnpm, SQLite, Nginx hoặc ffmpeg trên VPS.

```text
Trình duyệt -- HTTPS --> Cloudflare -- Tunnel --> cloudflared --> app:8787
                                                                |
                                                         volume app_data
                                                         SQLite + media
```

## 1. Chuẩn bị

- VPS Linux có Docker Engine và plugin Docker Compose v2 trở lên, Git và quyền chạy Docker. Không cấp quyền Docker cho người không tin cậy vì quyền này tương đương root.
- Image dùng Node 24 LTS (Debian), hỗ trợ kiến trúc amd64/arm64. Bắt đầu với khoảng 2 CPU, 2–4 GB RAM; ffmpeg, build và số tác vụ đồng thời có thể cần nhiều hơn. Theo dõi dung lượng vì ảnh/video lưu trên ổ VPS.
- Có domain đang dùng DNS Cloudflare và quyền quản lý Cloudflare Zero Trust/Tunnels nếu muốn truy cập Internet.
- Cho phép kết nối outbound HTTPS để tải image/package và gọi provider; tunnel cần outbound cổng `7844` UDP (QUIC) hoặc TCP (HTTP/2). **Không cần mở inbound 80/443/8787** cho ứng dụng. Giữ cổng SSH của VPS được bảo vệ.

Kiểm tra:

```bash
docker --version
docker compose version
docker info
```

Nếu thiếu Docker, cài Docker Engine + Compose plugin theo [hướng dẫn chính thức](https://docs.docker.com/engine/install/). Không chạy Vite dev server trên VPS production.

## 2. Clone và tạo cấu hình

Thay `URL_REPOSITORY` bằng URL repository của bạn:

```bash
git clone "URL_REPOSITORY" web-gen-ai
cd web-gen-ai
cp .env.docker.example .env.docker
chmod 600 .env.docker

# Chỉ in khóa mới ra terminal. Dán kết quả vào APP_ENCRYPTION_KEY ở bước sau.
docker run --rm node:24-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Mở [cấu hình Docker](../.env.docker.example) đã sao chép bằng trình soạn thảo trên VPS, ví dụ `nano .env.docker`, rồi điền:

```dotenv
APP_ENCRYPTION_KEY=<khóa-base64-vừa-sinh>
SUPER_ADMIN_EMAILS=ban@example.com
APP_ORIGIN=http://127.0.0.1:8787
COOKIE_SECURE=false
APP_LOCAL_PORT=8787
CLOUDFLARE_TUNNEL_TOKEN=
PROVIDER_MODE=live
```

- `SUPER_ADMIN_EMAILS` có thể là nhiều email, phân tách dấu phẩy. Env **không tạo mật khẩu/tài khoản**; bạn sẽ đăng ký admin trên giao diện. Email admin có thể ngoài `@gigone.com`; tài khoản thường hiện chỉ đăng ký bằng `@gigone.com` và cần admin duyệt.
- **Giữ nguyên `APP_ENCRYPTION_KEY` suốt vòng đời dữ liệu.** Đổi hoặc mất khóa sẽ không giải mã được API key provider đã lưu. Không chạy lại bước sinh khóa khi cập nhật.
- Không commit hoặc chia sẻ file cấu hình thật, token tunnel, kết quả `docker inspect` hay output `docker compose config` (có thể chứa secret). Cấu hình thật đã được Git và Docker build bỏ qua.
- Mọi lệnh bên dưới đều dùng `--env-file .env.docker`: Compose không tự đọc file này. File `.env` dành cho phát triển không được copy vào image. Nếu shell đang export các biến cùng tên thì chúng có thể ghi đè file cấu hình; hãy dùng shell sạch/unset các biến cũ.

## 3. Khởi tạo admin trước khi public

**Quan trọng:** ứng dụng hiện chưa xác minh quyền sở hữu email đăng ký. Không bật tunnel hoặc công khai ứng dụng trước khi đăng ký xong email admin.

Trên VPS:

```bash
# -q chỉ kiểm tra cấu hình, không in secret ra màn hình.
docker compose --env-file .env.docker config -q
docker compose --env-file .env.docker up -d --build --wait app
docker compose --env-file .env.docker ps
curl --fail http://127.0.0.1:8787/api/health
```

Kết quả health trả `{"ok":true,"mode":"live"}`. Nếu đã có tiến trình khác dùng cổng `8787`, đổi `APP_LOCAL_PORT` và cổng trong `APP_ORIGIN` cho khớp; cổng bên trong container vẫn là `8787`.

Trên **máy tính của bạn**, mở terminal và tạo SSH port-forward:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@IP_VPS
```

Mở <http://127.0.0.1:8787> trên trình duyệt máy tính, vào **Đăng ký**, nhập đúng email admin đã cấu hình và tự đặt mật khẩu 10–200 ký tự. Admin được tự động duyệt. Những lần sau dùng **Đăng nhập**, không đăng ký lại. Giữ terminal SSH mở trong lúc thực hiện.

Cổng app chỉ bind `127.0.0.1` trên VPS, nên `http://IP_VPS:8787` từ Internet **không truy cập được** — đây là chủ đích. Khi chạy Docker ngay trên máy cá nhân, bỏ qua SSH và mở localhost trực tiếp. Nếu port-forward dùng cổng máy tính khác, cần đổi `APP_ORIGIN` cho đúng origin mà trình duyệt đang mở.

## 4. Gắn Cloudflare Tunnel và domain HTTPS

Dùng **remotely-managed tunnel** với token, không cần `cert.pem`, file credentials JSON hoặc cài `cloudflared` trên host.

1. Vào Cloudflare Zero Trust → **Networks / Connectors / Tunnels** (tên menu có thể thay đổi) → tạo **Cloudflared tunnel**, đặt tên tùy ý.
2. Ở bước chọn môi trường, chọn Docker và sao chép **chỉ phần token** từ lệnh Cloudflare cung cấp. Không chạy lệnh `docker run` đó vì Compose sẽ quản lý connector.
3. Thêm **Published application / Public hostname**:
   - Hostname ví dụ: `studio.example.com`.
   - Service type: **HTTP**.
   - URL: **`app:8787`**, tương đương `http://app:8787`.
   - Không dùng `localhost:8787`: bên trong `cloudflared`, localhost là chính connector, không phải app.
   - Không bật HTTPS tới origin vì app dùng HTTP trong Docker network. HTTPS được kết thúc tại Cloudflare.
4. Cloudflare tạo/cấu hình DNS cho hostname của tunnel. Xử lý bản ghi DNS trùng nếu dashboard báo xung đột.
5. Sau khi admin đã được tạo, sửa cấu hình trên VPS:

```dotenv
APP_ORIGIN=https://studio.example.com
COOKIE_SECURE=true
CLOUDFLARE_TUNNEL_TOKEN=<token-của-tunnel>
```

`APP_ORIGIN` phải đúng tên miền HTTPS dùng trên trình duyệt, không kèm path hoặc dấu `/` cuối. Chỉ hỗ trợ một origin cấu hình cho app; nếu dùng domain phụ khác hãy redirect về domain chính ở Cloudflare.

Khởi động lại app với cấu hình mới rồi bật tunnel:

```bash
docker compose --env-file .env.docker config -q
docker compose --env-file .env.docker up -d --wait app
docker compose --env-file .env.docker --profile tunnel up -d
docker compose --env-file .env.docker --profile tunnel ps
docker compose --env-file .env.docker --profile tunnel logs --tail=100 cloudflared
```

Mở `https://studio.example.com`, đăng nhập lại rồi kiểm tra đăng ký/duyệt tài khoản, API và tải media. Cookie localhost không được chuyển sang domain mới. Có thể đóng SSH port-forward sau khi kiểm tra xong.

**Token trống hoặc sai:** chế độ app-only không cần token; khi bật profile `tunnel`, `cloudflared` sẽ báo lỗi trong log/không kết nối nếu token thiếu hoặc không hợp lệ. `config -q` không kiểm chứng token với Cloudflare. Không coi việc lệnh `up -d` thành công là tunnel đã kết nối: phải kiểm tra log, trạng thái connector trên dashboard và truy cập URL thật.

- Không cần mở cổng host cho `cloudflared`, không mount Docker socket.
- Cấu hình image Cloudflare được ghim theo digest trong [Compose](../compose.yaml). Có thể cập nhật qua `CLOUDFLARED_IMAGE` bằng tag/digest chính thức đã kiểm tra; `docker compose pull` một mình không đổi digest đã ghim.
- Có thể đặt thêm Cloudflare Access để hạn chế người truy cập. Nếu bật Access, lưu ý các provider cần tải URL `/api/provider-media/...` từ Internet có thể bị chặn bởi trang đăng nhập Access; phải thiết kế policy phù hợp, không vô tình công khai các API còn lại.

## 5. Vận hành và cập nhật

Ứng dụng và tunnel tự khởi động lại sau lỗi/reboot nhờ `restart: unless-stopped` (Docker daemon cũng phải tự khởi động theo máy). Compose healthcheck báo app unhealthy nhưng không tự restart chỉ vì unhealthy; kiểm tra log và xử lý nguyên nhân.

```bash
# Trạng thái và log (Ctrl+C để ngừng xem log, không dừng container).
docker compose --env-file .env.docker --profile tunnel ps
docker compose --env-file .env.docker --profile tunnel logs -f --tail=100 app cloudflared

# Cập nhật: sao lưu trước, rồi lấy code và build lại.
git pull
docker compose --env-file .env.docker build --pull app
docker compose --env-file .env.docker up -d --wait app
docker compose --env-file .env.docker --profile tunnel up -d

# Thay đổi .env.docker: dùng up để Compose tạo lại container khi env đổi.
# Chỉ "restart" không nạp lại env.
docker compose --env-file .env.docker up -d --wait app
docker compose --env-file .env.docker --profile tunnel up -d

# Dừng dịch vụ, giữ nguyên dữ liệu.
docker compose --env-file .env.docker --profile tunnel down
```

Migrations SQLite chạy tự động lúc app khởi động. **Không chạy nhiều replica app** hoặc cho hai backend dùng chung volume: SQLite và worker hiện được thiết kế cho một app instance.

**Trước khi cập nhật/backup/dừng:** hạn chế người tạo tác vụ mới và chờ các tác vụ đang chạy, đặc biệt **xuất video**, hoàn tất. Worker chờ vòng xử lý hiện tại trước khi thoát; `APP_STOP_GRACE_PERIOD=1h` cho phép Docker chờ tối đa một giờ (khi rảnh app thoát ngay), không phải bảo đảm hoàn thành mọi workload. Tăng khoảng chờ nếu tăng timeout hoặc lượng việc. Không dùng `kill`, `down -t` ngắn hoặc reboot cưỡng bức khi đang xử lý: backend hiện chưa tự khôi phục export bị ngắt ở trạng thái `running`, có thể làm người dùng không xuất tiếp được. Đây là giới hạn runtime hiện có cần sửa riêng; Docker volume không tự sửa trạng thái tác vụ.

`APP_LOCAL_PORT` chỉ đổi cổng host. `PORT`, `DATABASE_PATH`, `MEDIA_DIR`, `FFMPEG_PATH` đã được Compose cố định trong container. Những giới hạn khác có trong [mẫu cấu hình](../.env.docker.example). `ALLOW_PRIVATE_PROVIDER_URLS=false` bảo vệ khỏi provider URL nội bộ; không bật tùy tiện trên môi trường public.

### Dữ liệu lưu ở đâu?

- Named volume `app_data` chứa `/app/data/app.db`, các file WAL/SHM nếu có, và toàn bộ `/app/data/media`.
- Với project name mặc định, tên volume là `lumina-studio_app_data`; dùng `docker volume inspect lumina-studio_app_data` để xem thông tin. Không sửa trực tiếp nội dung volume trong khi app chạy.
- Dữ liệu `data/` của bản chạy trực tiếp trên host **không tự nhập** vào volume. Khi chuyển dữ liệu cũ, dừng backend cũ, sao lưu/import cả SQLite và media, giữ cùng khóa mã hóa.
- `up --build`, `--force-recreate` và `down` thông thường giữ volume. **`docker compose down -v` và thao tác xóa/prune volume có thể xóa dữ liệu vĩnh viễn.**
- Nếu đổi Compose project name (`-p`), bạn sẽ dùng volume khác và trông như mất dữ liệu. Dùng project name nhất quán; mặc định được đặt trong Compose.

## 6. Backup và restore

### Backup nhất quán

Dừng app trước khi sao chép SQLite và media để tránh snapshot lệch giữa DB và file. Tạo bản sao trước mỗi lần cập nhật, lưu thêm bản mã hóa ở ngoài VPS. Không chỉ sao chép riêng `app.db` khi database đang chạy WAL.

```bash
mkdir -p backups
chmod 700 backups

docker compose --env-file .env.docker --profile tunnel stop cloudflared app

# Dùng chính image app, chạy tar thay vì backend; không cài thêm công cụ trên host.
BACKUP_NAME="lumina-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose --env-file .env.docker run --rm --no-deps --user 0:0 \
  --cap-add DAC_OVERRIDE \
  --volume "$PWD/backups:/backup" --entrypoint tar app \
  -czf "/backup/$BACKUP_NAME" -C /app/data .

# Cấu hình chứa khóa giải mã và token: bảo vệ như secret, không commit.
cp -p .env.docker backups/.env.docker
chmod 600 backups/.env.docker

docker compose --env-file .env.docker up -d --wait app
docker compose --env-file .env.docker --profile tunnel up -d
```

Kiểm tra lệnh backup kết thúc thành công và archive tồn tại trước khi cập nhật. Thư mục `backups/` được Git/build bỏ qua; file archive có thể thuộc root vì container backup chạy root. Các lệnh bảo trì cấp thêm capabilities tạm thời vì service app bình thường bỏ toàn bộ capabilities; backend vẫn chạy non-root và không có các quyền này. Lưu bản sao này ở nơi an toàn ngoài VPS, không đặt trong thư mục web public. Bảo quản khóa mã hóa lâu dài; token tunnel có thể rotate nhưng khóa mã hóa app không được thay tùy ý.

### Restore sang volume mới

Thử restore vào **project name mới** để không ghi đè volume đang dùng. Dừng bản cũ trước để tránh hai app/connector hoạt động đồng thời. Chuẩn bị đúng phiên bản code/image tương thích với database trong backup, đặt archive vào thư mục `backups/`, khôi phục cấu hình chứa **đúng khóa mã hóa cũ** vào file thật rồi chạy:

```bash
# Nếu bản cũ đang chạy trên cùng VPS:
docker compose --env-file .env.docker --profile tunnel down

# Thay tên archive bằng bản sao đã kiểm tra. Tar giữ quyền của user node (UID 1000).
docker compose -p lumina-restored --env-file .env.docker run --rm --no-deps --user 0:0 \
  --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER \
  --volume "$PWD/backups:/backup:ro" --entrypoint tar app \
  -xzpf /backup/lumina-data-YYYYMMDDTHHMMSSZ.tar.gz -C /app/data

docker compose -p lumina-restored --env-file .env.docker up -d --wait app
docker compose -p lumina-restored --env-file .env.docker --profile tunnel up -d
```

Project mới phải có volume trống ở lần restore đầu; không giải nén chồng lên dữ liệu cũ vì file thừa có thể còn lại. Sau restore, kiểm tra tài khoản, provider, lịch sử và media. Mọi lệnh vận hành tiếp theo phải thêm `-p lumina-restored` nếu tiếp tục dùng project này. Giữ bản cũ đến khi nghiệm thu, không xóa volume ngay.

## 7. Xử lý lỗi

| Hiện tượng | Cách kiểm tra/xử lý |
| --- | --- |
| Compose báo thiếu khóa/email admin | Điền `APP_ENCRYPTION_KEY` và `SUPER_ADMIN_EMAILS`; luôn truyền `--env-file .env.docker`. Key phải là base64 của đúng 32 byte. Backend từ chối key không hợp lệ. |
| App không healthy hoặc dừng | Xem `logs app`; kiểm tra dung lượng, cấu hình và quyền volume. Healthcheck gọi nội bộ `/api/health` nên không cần domain/tunnel. |
| `EACCES` khi ghi dữ liệu | Named volume mới có quyền UID/GID 1000 của user `node`. Nếu import dữ liệu cũ, dừng app rồi dùng `docker compose --env-file .env.docker run --rm --no-deps --user 0:0 --cap-add DAC_OVERRIDE --cap-add CHOWN --entrypoint chown app -R 1000:1000 /app/data`, sau đó chạy lại. Không sửa bằng cách chạy backend root hoặc `chmod 777`. |
| Đăng nhập/POST báo Origin không được phép | `APP_ORIGIN` phải khớp scheme/hostname/port thực tế; chạy `up -d app` sau khi sửa env. Không dùng localhost khi origin đã đổi sang domain. |
| Cookie/session không giữ | Domain HTTPS cần `COOKIE_SECURE=true`; bootstrap HTTP cần `false`. Kiểm tra truy cập đúng hostname, không dùng IP HTTP của VPS khi đã bật Secure. |
| Cloudflare 502 | Kiểm tra app healthy, log connector và service URL là `http://app:8787`. `localhost` hoặc HTTPS tới app là sai trong cấu hình này. |
| Tunnel disconnected/1033 | Kiểm tra token, connector trên dashboard, DNS và firewall outbound 7844 TCP/UDP. Không cần mở 8787 inbound. |
| Upload bị 413 | Có cả giới hạn ứng dụng và giới hạn request của gói Cloudflare. Upload video mặc định của app là 200 MiB nhưng gói Cloudflare có thể thấp hơn; tăng biến app không vượt được giới hạn Cloudflare. |
| Lệnh provider lâu bị timeout | Tác vụ tạo nội dung được app xử lý bằng worker; một số endpoint gọi LLM đồng bộ vẫn có thể chạm timeout proxy. Kiểm tra log, giới hạn provider và `IMAGE_REQUEST_TIMEOUT_MS`; Cloudflare Tunnel không tự loại bỏ timeout của Cloudflare. |
| Provider không lấy được ảnh/media | Kiểm tra domain public, `APP_ORIGIN`, quyền truy cập media và policy Cloudflare Access/WAF. Không whitelist rộng toàn bộ API chỉ để vượt Access. |
| Tạo lại container trông như mất dữ liệu | Kiểm tra đúng project name/volume, không dùng `down -v`; thư mục `data/` ngoài host không phải named volume. |
| Cập nhật thất bại/migration lỗi | Giữ log và backup; không xóa database để khắc phục. Khôi phục code/image cùng dữ liệu tương thích. |

App đang tin cậy proxy headers theo cấu hình backend hiện có. Giữ cổng origin ở localhost và chỉ dùng các proxy/connector tin cậy; không đổi port binding thành `0.0.0.0:8787:8787` hoặc mở origin trực tiếp lên Internet.

### Giới hạn bảo mật hiện có của backend

Docker/Tunnel không sửa cách lấy IP trong [rate limiter](../server/lib/rateLimit.ts#L58-L63): backend đang tin giá trị đầu của `X-Forwarded-For`. [Cloudflare có thể giữ header sẵn có và thêm IP vào cuối](https://developers.cloudflare.com/fundamentals/reference/http-headers/#x-forwarded-for), nên giới hạn đăng nhập/đăng ký theo IP có thể bị né bằng header giả. Đóng cổng origin **không tự khắc phục** điểm này. Trước khi cho người không tin cậy truy cập, dùng Cloudflare Access giới hạn danh tính hoặc quy tắc rate-limit ở edge phù hợp với gói của bạn; không coi rate limiter hiện tại là lớp chống brute-force đáng tin cậy. Việc sửa chính sách proxy và xác thực IP ở backend cần một thay đổi riêng có kiểm thử, không nằm trong cấu hình Docker này.

## Checklist nghiệm thu

- [ ] App healthy, truy cập được frontend và `/api/health`.
- [ ] Admin được đăng ký trước khi bật public route.
- [ ] Domain HTTPS mở được, đăng nhập/duyệt tài khoản hoạt động.
- [ ] Connector Connected trên Cloudflare; URL service là `http://app:8787`.
- [ ] Thử thêm provider và một tác vụ thật; giới hạn/tính phí phụ thuộc provider của bạn.
- [ ] Database và media còn sau khi tạo lại container.
- [ ] Có backup đã thử restore và bản sao khóa mã hóa ngoài VPS.
- [ ] Origin không mở public trực tiếp; `.env.docker` và backup không nằm trên Git.
- [ ] Có Access hoặc bảo vệ rate-limit ở edge trước khi cho người không tin cậy truy cập.
