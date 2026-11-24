# DALAT_3D_SIMULATION — Mô Phỏng 3D Toàn Bộ TP. Đà Lạt & Mở Rộng Dần (Cloud 24/7)

> Kiến trúc **1 Task Antigravity Cloud Điều Phối** + **6 Task Gemini Web Chạy Lặp Mỗi 2 Tiếng** trên Google Drive (`NVMe-First + SHA-256 Delta Sync`).
> **Thứ tự ưu tiên cốt lõi:** (1) Địa hình DEM theo lưới Tile → (2) Hồ nước & Thủy văn → (3) Rừng thông 3 lá & Mai Anh Đào → (4) Công trình biểu tượng LOD3/LOD4 → (5) Web 3D Tile Streaming & Mở rộng dần đường phố, nhà dân, vùng lân cận.

- **Google Drive Project Folder:** [`DALAT_3D_SIMULATION`](https://drive.google.com/drive/folders/1qOT1FvYmbqJWgwBSKP4Q8zfVMUqnHuvw) (ID: `1qOT1FvYmbqJWgwBSKP4Q8zfVMUqnHuvw`)
- **Drive `00_STATE` Folder ID:** `14D9jOHsfcd7crFzHAjM1D9p_y2MQmnnx`
- **Cloud NVMe Workspace:** `/home/antigravity/DALAT_3D_SIMULATION`

## Hệ Tọa Độ Khóa Cứng Toàn Dự Án

- **Điểm gốc `(0, 0, 0)`:** Tâm Hồ Xuân Hương (`lat0 = 11.940419`, `lon0 = 108.445259`, `Z0 = 1478.0 m` MSL)
- **Hệ chiếu:** `EPSG:32649` (UTM Zone 49N) & thư viện toán học dùng chung [`03_SOURCE_CODE/shared/dalat_coords.py`](03_SOURCE_CODE/shared/dalat_coords.py)
- **Lưới Tile mở rộng vô hạn:** `2,000 m × 2,000 m / Tile`, mã `T_{E|W}{xx}_{N|S}{yy}` (`T_E00_N00` là tâm)
- **Vòng mở rộng:** `RING_0` (Lõi 6×6 km, 9 tiles) → `RING_1` (Nội đô 14×14 km, 49 tiles: Tuyền Lâm, Trại Mát, Thung lũng Tình Yêu) → `RING_2` (30×30 km: Langbiang, Suối Vàng, Cầu Đất) → `RING_3` (Lạc Dương, Đơn Dương, Đức Trọng, Lâm Hà)

## Phân Công 1 Antigravity Cloud + 6 Task Gemini Web (Chu Kỳ 2 Tiếng)

| Slot | Làn | Nhiệm vụ dựng hình (chạy lặp mỗi 2 tiếng) | Lệch pha khuyến nghị | File Prompt |
| :---: | :--- | :--- | :---: | :--- |
| **0** | `ORCHESTRATOR` | Antigravity Cloud: kéo delta, kiểm định QA, ghép cảnh tổng, duyệt/rework, mở vòng mới | Theo chu kỳ / theo lệnh | `00_STATE/prompts/00_PROMPT_ANTIGRAVITY_CLOUD_ORCHESTRATOR.md` |
| **1** | `TERRAIN` | Địa hình DEM 3D chi tiết, ảnh vệ tinh & lưới Tile mở rộng (T_E00_N00 → RING_0..3) | `+00 phút` | `00_STATE/prompts/01_PROMPT_GEMINI_TASK1_TERRAIN.md` |
| **2** | `WATER_LAKES` | Hồ nước phẳng & thủy văn (Xuân Hương → Chiến Thắng/Cam Ly → Tuyền Lâm → Than Thở → Suối Vàng) | `+10 phút` | `00_STATE/prompts/02_PROMPT_GEMINI_TASK2_WATER_LAKES.md` |
| **3** | `PINE_FLORA` | Cây thông 3 lá, Mai Anh Đào, Dã Quỳ (InstancedMesh) & phủ rừng thông bám đồi dốc | `+20 phút` | `00_STATE/prompts/03_PROMPT_GEMINI_TASK3_PINE_FORESTS.md` |
| **4** | `LANDMARKS` | Công trình nổi bật LOD3/LOD4 (Quảng trường, Thủy Tạ → Ga, CĐSP → Con Gà, Chợ → Dinh I-III → Domaine, Crazy House, Trúc Lâm) | `+30 phút` | `00_STATE/prompts/04_PROMPT_GEMINI_TASK4_LANDMARKS.md` |
| **5** | `WEB3D_EXPANSION` | Web 3D Three.js r128 Tile Streaming, 4 preset sương mù/đèn đêm, đường phố & mở rộng nhà dân mái vệ tinh đợt sau | `+40 phút` | `00_STATE/prompts/05_PROMPT_GEMINI_TASK5_WEB3D_EXPANSION.md` |
| **6 (`ĐÀ LẠT - 00`)** | `ASSET_SOURCING` | Thu thập & chuẩn hóa mô hình 3D có sẵn (cây thông, công trình nổi tiếng, prop ven hồ, PBR CC0) cung cấp cho Task 2, 3, 4, 5 dùng ngay hoặc detail thêm | `+50 phút` | `00_STATE/prompts/06_PROMPT_GEMINI_TASK6_ASSET_SOURCING.md` |

## Lệnh Điều Phối & Ghép Cảnh Nhanh (Tại Antigravity Cloud)

```bash
# Chạy trọn gói 1 chu kỳ: Kéo Drive -> Audit UTF-8 -> Ghép cảnh tổng GLB + QA 4 khung -> Đẩy lên Drive
python3 00_STATE/run_cloud_cycle.py --pull --push

# Duyệt đạt hoặc yêu cầu sửa cho chu kỳ 2 tiếng kế tiếp rồi đồng bộ ngay
python3 00_STATE/run_cloud_cycle.py --approve T1_W1_CORE_TERRAIN_T_E00_N00 --push
python3 00_STATE/run_cloud_cycle.py --rework T4_W1_REGISTRY_AND_LAKE_ICONS --note "Tăng chi tiết cánh Hoa Dã Quỳ" --push

# Chỉ chạy riêng bộ ghép cảnh 3D tổng & kiểm định biên Tile
python3 03_SOURCE_CODE/shared/assemble_dalat_scene.py
```
