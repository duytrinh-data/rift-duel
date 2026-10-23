# ASSET MANIFEST — RIFT DUEL

Tài liệu này liệt kê toàn bộ các asset 3D (`.glb`) và âm thanh (`.ogg`) thực tế được tải và đóng gói cục bộ trong `client/public/assets/` của dự án **RIFT DUEL**. Không có bất kỳ model hoặc audio nào bị hotlink từ bên ngoài lúc runtime.

---

## 1. Ghi chú khảo sát nguồn ứng viên & Lựa chọn kỹ thuật

Trước khi chốt danh mục asset, chúng tôi đã kiểm tra các nguồn ứng viên trong đề bài (`quaternius.itch.io/lowpoly-animated-knight`, `quaternius.com/packs/rpgcharacters.html`, `quaternius.itch.io/ultimate-platformer-pack`, `quaternius.com/packs/universalbasecharacters.html`, `quaternius.itch.io/universal-animation-library`) cùng kho CC0 chính thức của **KayKit (Kay Lousberg)** và **Kenney.nl**:
- Các trang pack trên `quaternius.com` trỏ về thư mục Google Drive yêu cầu phiên tải tương tác qua trình duyệt và tách rời FBX/Blend ở một số bộ cũ.
- Bộ **KayKit Adventurers Character Pack (1.0)** và **KayKit Dungeon Remastered Pack (1.0)** (cùng chuẩn CC0 1.0 Public Domain trên kho GitHub chính thức của Kay Lousberg) cung cấp trực tiếp định dạng **binary `.glb` chuẩn cho WebGL/Three.js** với **cùng một bộ xương `Rig` và 76 clip animation in-place nhúng sẵn** (`Idle`, `Unarmed_Idle`, `Running_A`, `Jump_Start`, `Jump_Idle`, `Jump_Land`, `Dodge_Forward/Backward/Left/Right`, `Unarmed_Melee_Attack_Punch_A/B`, `Unarmed_Melee_Attack_Kick`, `1H_Melee_Attack_Slice_Horizontal`, `1H_Melee_Attack_Slice_Diagonal`, `1H_Melee_Attack_Chop`, `2H_Melee_Attack_Spin`, `PickUp`, `Throw`, `Hit_A`, `Hit_B`, `Death_A`, `Cheer`).
- Nhờ dùng chung một skeleton chuẩn (`Rig`) cho cả hai đấu sĩ (**Aether Vanguard** — `knight.glb` và **Crimson Reaver** — `barbarian.glb`), game triệt tiêu hoàn toàn sai số retarget animation, giữ cân bằng tuyệt đối về hurtbox/hitbox và thời gian đòn đánh.

---

## 2. Danh sách Model 3D Nhân vật & Vũ khí (`client/public/assets/models/`)

| Tên Asset & Vai trò trong Game | File cục bộ | Tác giả | URL Nguồn Chính Thức | License & Attribution | Kiểm tra & Thao tác chỉnh sửa / tích hợp |
|---|---|---|---|---|---|
| **Aether Vanguard (Fighter 1)** — Đấu sĩ giáp hiệp sĩ phong cách Cyan Aether | `client/public/assets/models/knight.glb` | Kay Lousberg (KayKit) | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 | **CC0 1.0 Universal** (Public Domain) — Không bắt buộc ghi nguồn, ghi nhận tác giả Kay Lousberg | Đã kiểm tra: nhúng sẵn texture `knight_texture.png` và 76 clip animation in-place trên bộ xương `Rig`. Lúc runtime: chuẩn hóa scale, ẩn các mesh khiên/kiếm mặc định trên `handslot.l`/`handslot.r` khi đánh tay không; phủ rim/emissive sắc **Cyan (`#00f0ff`)**; gắn mesh kiếm vào bone `handslot.r` khi nhặt vũ khí. |
| **Crimson Reaver (Fighter 2)** — Đấu sĩ giáp chiến binh phong cách Đỏ Cam / Tím Hư Không | `client/public/assets/models/barbarian.glb` | Kay Lousberg (KayKit) | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 | **CC0 1.0 Universal** (Public Domain) — Không bắt buộc ghi nguồn, ghi nhận tác giả Kay Lousberg | Đã kiểm tra: nhúng sẵn texture `barbarian_texture.png` và 76 clip animation in-place cùng bộ xương `Rig` với `knight.glb`. Lúc runtime: ẩn vũ khí mặc định (`1H_Axe`, `2H_Axe`, `Mug`, `Barbarian_Round_Shield`), phủ rim/emissive sắc **Đỏ Cam (`#ff4d29`) / Tím (`#b829ff`)**, và gắn kiếm Rift Blade vào `handslot.r` khi nhặt vũ khí. |
| **Rift Blade & Gold Relic Emblem (Weapon Pickup / Thrown Sword)** | `client/public/assets/models/sword_shield_gold.glb` (kết hợp mesh `2H_Sword` tách từ `knight.glb`) | Kay Lousberg (KayKit) | https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0 | **CC0 1.0 Universal** (Public Domain) | Dùng làm biểu tượng bệ phóng vũ khí và kết hợp mesh kiếm `2H_Sword` có phủ shader/material phát sáng năng lượng Cyan/Gold để người chơi nhìn rõ khi kiếm rơi trên sàn hoặc bay trong không gian 3D. |

---

## 3. Danh sách Model 3D Sàn đấu — Rift Sanctum Arena (`client/public/assets/models/`)

| Tên Asset & Vai trò | File cục bộ | Tác giả | URL Nguồn Chính Thức | License & Attribution | Thao tác chuyển đổi / lắp ghép |
|---|---|---|---|---|---|
| **Đá nền sàn đấu chính (Large Stone Floor Tile)** | `client/public/assets/models/floor_tile_large.glb` | Kay Lousberg (KayKit) | https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0 | **CC0 1.0 Universal** (Public Domain) | Ghép dạng lưới tạo mặt phẳng sàn đấu 3D (`X/Z`), bật `receiveShadow = true`, kết hợp đường viền rune phát sáng. |
| **Đá lát hoa văn cổ (Decorated Floor Tile)** | `client/public/assets/models/floor_tile_small_decorated.glb` | Kay Lousberg (KayKit) | https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0 | **CC0 1.0 Universal** (Public Domain) | Đặt tại tâm sàn đấu (vùng spawn Rift Blade) và các điểm mốc định hướng không gian. |
| **Khối đế đá nổi (Floating Stone Foundation)** | `client/public/assets/models/floor_foundation_allsides.glb` | Kay Lousberg (KayKit) | https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0 | **CC0 1.0 Universal** (Public Domain) | Xếp tạo phần thân khối đá cổ lơ lửng giữa vực sâu (abyss), giúp nhìn rõ cạnh sàn đấu (`±X`, `±Z`). |
| **Trụ đá cổ khắc hoa văn (Decorated Pillar & Column)** | `client/public/assets/models/pillar_decorated.glb`, `client/public/assets/models/column.glb`, `client/public/assets/models/barrier_column.glb` | Kay Lousberg (KayKit) | https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0 | **CC0 1.0 Universal** (Public Domain) | Đặt ở rìa Bắc (phía xa camera) và các đảo đá lơ lửng xung quanh vực, tuyệt đối không đặt chắn phía Nam (gần camera) để không che khuất tầm nhìn đấu sĩ. |
| **Đuốc năng lượng (Lit Torch)** | `client/public/assets/models/torch_lit.glb` | Kay Lousberg (KayKit) | https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0 | **CC0 1.0 Universal** (Public Domain) | Gắn ở hai góc Bắc của sàn đấu kèm PointLight và hạt lửa/năng lượng. |

---

## 4. Danh sách Âm thanh & Sound Effects (`client/public/assets/audio/`)

| Tên File | Vai trò âm thanh trong Game | Tác giả | URL Nguồn Chính Thức | License & Attribution | Ghi chú tích hợp |
|---|---|---|---|---|---|
| `chop.ogg` | Tiếng chém/đánh trúng Light Attack | Kenney Vleugels (Kenney.nl) | https://kenney.nl/assets/rpg-audio | **CC0 1.0 Universal** | Phát kèm biến thiên pitch và lớp synth va chạm khi trúng đòn nhẹ. |
| `pot_clank.ogg` | Tiếng va chạm kim loại / Heavy Attack & Đỡ đòn | Kenney Vleugels (Kenney.nl) | https://kenney.nl/assets/rpg-audio | **CC0 1.0 Universal** | Kết hợp sub-bass impact cho Heavy Attack & Sword Hit. |
| `plate_break.ogg` | Tiếng nổ KO khi đối thủ văng khỏi Blast Zone | Kenney Vleugels (Kenney.nl) | https://kenney.nl/assets/impact-sounds | **CC0 1.0 Universal** | Phát khi sự kiện `ko` kích hoạt. |
| `pickup.ogg` | Tiếng nhặt kiếm Rift Blade (`E`) | Kenney Vleugels (Kenney.nl) | https://kenney.nl/assets/rpg-audio | **CC0 1.0 Universal** | Phát khi đấu sĩ nhặt kiếm trên sàn. |
| `drop.ogg` | Tiếng ném kiếm / vũ khí rơi | Kenney Vleugels (Kenney.nl) | https://kenney.nl/assets/impact-sounds | **CC0 1.0 Universal** | Phát khi ném kiếm hoặc kiếm chạm đất. |
| `footstep1.ogg`, `footstep2.ogg` | Tiếng bước chân trên mặt đá & tiếp đất | Kenney Vleugels (Kenney.nl) | https://kenney.nl/assets/rpg-audio | **CC0 1.0 Universal** | Phát theo chu kỳ di chuyển trên sàn và khi tiếp đất (`Jump_Land`). |
| `bell.ogg`, `order_complete.ogg` | Chuông đếm ngược (`3, 2, 1, FIGHT!`) & Kết thúc trận | Kenney Vleugels (Kenney.nl) | https://kenney.nl/assets/interface-sounds | **CC0 1.0 Universal** | Đồng bộ theo thời gian đếm ngược của server. |
| `click.ogg`, `error.ogg` | Điều hướng menu bàn phím (`Tab`/`Arrows`/`Enter`) & Báo lỗi phòng | Kenney Vleugels (Kenney.nl) | https://kenney.nl/assets/interface-sounds | **CC0 1.0 Universal** | Chỉ kích hoạt sau thao tác phím hợp lệ đầu tiên của người chơi (tuân thủ Browser Autoplay Policy). |
