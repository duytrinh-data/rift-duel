# RIFT DUEL — 3D Real-Time Online Platform Brawler

**RIFT DUEL** là game đối kháng 3D thời gian thực dành cho 2 người chơi online trên trình duyệt (lấy cảm hứng từ nhịp độ tích sát thương % và đánh văng khỏi sàn đấu của *Brawlhalla*, nhưng di chuyển và chiến đấu trong không gian **3D thật** trên mặt phẳng `X/Z` và trục độ cao `Y`).

- **Frontend:** Vite + TypeScript + Three.js (triển khai trên **Netlify**).
- **Multiplayer Server:** Node.js + TypeScript + Colyseus WebSocket authoritative server (triển khai trên **Render**).
- **Shared Core:** Logic mô phỏng 60Hz kinematic 3D, va chạm capsule/sphere 3D, công thức knockback, vũ khí nhặt/ném và luật trận đấu dùng chung giữa Client và Server.
- **Điều khiển 100% bằng bàn phím:** Không yêu cầu chuột ở bất kỳ màn hình nào (từ trang chủ, nhập tên, tạo/vào phòng, copy link mời, chọn nhân vật, Ready, chiến đấu đến Rematch).

---

## 1. Bảng Phím Điều Khiển (100% Keyboard)

### Trong Trận Đấu (Gameplay)
| Phím (`KeyboardEvent.code`) | Hành động |
|---|---|
| `W` / `A` / `S` / `D` (hoặc Phím Mũi Tên) | Di chuyển tự do trên mặt phẳng sàn đấu 3D (`X/Z`) theo hướng camera cố định |
| `Space` | Nhảy theo trục `Y` (hỗ trợ **1 lần nhảy mặt đất + 2 lần nhảy trên không**, có jump buffer & coyote time) |
| `Shift` (`ShiftLeft` / `ShiftRight`) | **Dodge (Né)** có khung bất tử (i-frames) và hồi chiêu: đang di chuyển sẽ lướt né theo hướng, đứng yên sẽ **Spot Dodge** tại chỗ |
| `J` (`KeyJ`) | **Light Attack (Đánh nhẹ):** Ra đòn nhanh, mở combo (khác nhau giữa mặt đất / trên không và tay không / cầm kiếm) |
| `K` (`KeyK`) | **Heavy Attack (Đánh mạnh):** Startup/recovery dài hơn, lực hất văng (knockback) cực mạnh để kết liễu |
| `L` (`KeyL`) | **Recovery Attack:** Đòn thăng thiên hỗ trợ quay lại sàn đấu khi bị đánh văng ra vực (giới hạn 1 lần trên không, hồi lại khi chạm đất) |
| `E` (`KeyE`) | **Nhặt / Ném Vũ Khí (Rift Blade):** Đứng gần kiếm trên sàn bấm `E` để nhặt; đang cầm kiếm bấm `E` để phóng kiếm 3D về phía đối thủ |
| `Escape` | Mở / Đóng menu Tùy chọn (Âm thanh, Âm lượng, Đồ họa Cao/Thấp, Rung Camera) mà không làm dừng trận online của đối thủ |

### Trong Menu, Phòng Chờ & Màn Kết Quả
| Phím | Hành động |
|---|---|
| `Tab` hoặc `↑` `↓` `←` `→` | Di chuyển vệt sáng chọn nút / ô nhập liệu |
| `Enter` | Xác nhận / Kích hoạt nút đang chọn |
| `C` (trong Phòng chờ) | Sao chép ngay **Link Mời Bạn (`?room=ABC123`)** vào bộ nhớ tạm |
| `1` / `2` (trong Phòng chờ) | Chọn nhanh ngoại hình đấu sĩ **Aether Vanguard (Cyan)** hoặc **Crimson Reaver (Đỏ Cam)** |
| `R` (trong Phòng chờ / Kết quả) | Bấm **SẴN SÀNG (Ready)** hoặc đồng ý **ĐẤU LẠI (Rematch)** |
| `M` / `-` / `+` / `G` / `V` (trong Menu `Esc`) | Bật/tắt âm thanh (`M`), giảm/tăng âm lượng (`-`/`+`), đổi đồ họa Cao/Thấp (`G`), bật/tắt rung camera (`V`) |

---

## 2. Cách Chạy & Kiểm Thử Local

### Yêu cầu hệ thống
- **Node.js** `>= 20.x` và `npm`.

### Cài đặt và chạy
```bash
# 1. Di chuyển vào thư mục dự án
cd "d:/Duy AI OS/rift-duel"

# 2. Cài đặt dependencies
npm install

# 3. Chạy đồng thời Server (cổng 2567) và Client (cổng 5173)
npm run dev
```
- Mở trình duyệt tại `http://localhost:5173`.
- Để thử nghiệm 2 người chơi trên cùng máy:
  1. Mở cửa sổ 1 tại `http://localhost:5173`, bấm `Enter` vào **Tạo Phòng Đấu Mới**.
  2. Bấm phím `C` để copy link mời (dạng `http://localhost:5173/?room=ABC123`).
  3. Mở cửa sổ 2 (hoặc tab Ẩn danh) dán link đó vào, bấm `Enter` để vào phòng.
  4. Cả hai bấm phím `R` (hoặc `Enter` vào nút **SẴN SÀNG**) để đếm ngược và chiến đấu!

### Các lệnh kiểm tra chất lượng (Typecheck, Unit Test, E2E Test, Production Build)
```bash
# Kiểm tra kiểu TypeScript cho cả Client và Server
npm run typecheck

# Chạy Unit Tests kiểm chứng logic combat 3D, knockback, dodge, KO, timeout, hòa
npm run test:unit

# Chạy Playwright E2E Multiplayer Tests (3 browser contexts độc lập kiểm tra tạo phòng, link mời, phòng đầy, mã sai, độ trễ mạng, mất kết nối & kết nối lại, KO & Rematch)
npm run test:e2e

# Build bản Production cho cả Frontend (client/dist) và Backend (server/dist)
npm run build
```

---

## 3. Hướng Dẫn Triển Khai Online (Render + Netlify)

Kiến trúc triển khai tách biệt:
- **Render Web Service** chạy authoritative Colyseus server qua giao thức `wss://`.
- **Netlify** phục vụ static frontend + 3D assets (`.glb`, `.ogg`) và kết nối tới Render qua biến môi trường `VITE_GAME_SERVER_URL`.

### Bước 1: Deploy Server Multiplayer lên Render
1. Đẩy thư mục dự án `rift-duel` lên GitHub repository.
2. Đăng nhập [Render Dashboard](https://dashboard.render.com) → **New +** → **Web Service** (hoặc **Blueprint** để đọc tự động file `render.yaml`).
3. Nếu cấu hình thủ công:
   - **Build Command:** `npm install && npm run build:server`
   - **Start Command:** `npm run start:server`
   - **Health Check Path:** `/health`
   - **Environment Variables:**
     - `NODE_ENV` = `production`
     - `ALLOWED_ORIGINS` = `https://<ten-site-cua-ban>.netlify.app`
4. Sau khi Render deploy xong, copy URL của service (ví dụ: `https://rift-duel-server.onrender.com`).

### Bước 2: Deploy Frontend lên Netlify
1. Đăng nhập [Netlify](https://app.netlify.com) → **Add new site** → **Import an existing project** từ GitHub repository trên.
2. Netlify sẽ tự động nhận diện file `netlify.toml` (`command = "npm run build:client"`, `publish = "client/dist"`).
3. Trong mục **Site configuration → Environment variables**, thêm biến:
   - `VITE_GAME_SERVER_URL` = `wss://<ten-service-render-cua-ban>.onrender.com`
4. Bấm **Deploy site**. Khi hoàn tất, người chơi chỉ cần mở duy nhất đường link `https://<ten-site-cua-ban>.netlify.app`, tạo phòng và gửi link `?room=ABC123` cho bạn bè cùng chơi!

> **Lưu ý về gói Free của Render:** Nếu server Render ở gói miễn phí bị sleep sau 15 phút không có người chơi, khi người chơi mở link Netlify và bấm Tạo/Vào phòng, giao diện RIFT DUEL sẽ tự động ping `/health`, hiển thị trạng thái *"Đang kiểm tra / đánh thức máy chủ trận đấu..."* kèm cơ chế tự thử lại (retry). Vì server lưu phòng trong RAM, nếu server khởi động lại thì các mã phòng cũ sẽ hết hạn và hiển thị thông báo rõ ràng.
