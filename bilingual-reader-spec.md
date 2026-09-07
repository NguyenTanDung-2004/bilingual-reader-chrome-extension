# Spec & System Design: Bilingual Reader Chrome Extension

## 1. Tổng quan Dự án

- **Tên dự án (Tạm gọi):** Bilingual Reader Extension
- **Mục tiêu:** Tiện ích mở rộng Chrome (Manifest V3) giúp người dùng học ngoại ngữ/đọc báo bằng cách hiển thị trang web dạng **Chế độ đọc Song ngữ (Bilingual Reader View)** với 2 bên song song (Gốc & Dịch).
- **Triết lý cốt lõi:**
  - **Client-Side/Local-First:** Toàn bộ quá trình bóc tách DOM, tách câu và quản lý dữ liệu chạy trực tiếp trên máy người dùng.
  - **Free Operating Cost:** Không phụ thuộc vào bất kỳ server backend trung gian nào. Trình duyệt tự gửi API dịch từ máy người dùng.
  - **Tập trung vào Trải nghiệm Học tập:** Khác với Chrome Translate mặc định (thay đè chữ gốc), extension hỗ trợ đối chiếu câu-với-câu và đồng bộ highlight để người dùng học từ vựng/ngữ pháp.

---

## 2. Các Tính năng Chính (Features)

1. **Chế độ Đọc sạch Song ngữ (Bilingual Reader Mode)**
   - Bóc tách toàn bộ rác (quảng cáo, sidebar, menu, footer), chỉ giữ lại nội dung chính (Tiêu đề, Văn bản, Hình ảnh).
   - Dựng lại giao diện 2 cột sạch: Cột trái (Ngôn ngữ gốc) — Cột phải (Ngôn ngữ dịch).

2. **Dịch theo từng câu (Sentence-Level Translation)**
   - Tách văn bản thành từng câu chính xác bằng trình tách câu tích hợp sẵn của trình duyệt (`Intl.Segmenter`).
   - Dịch gộp theo mảng (Batch Requests) qua API để tránh bị chặn IP và tối ưu tốc độ.

3. **Tương tác Đồng bộ (Sync Highlight & Scroll)**
   - **Đồng bộ Cuộn (Scroll):** Cuộn cột gốc thì cột dịch cuộn theo tương ứng để câu dịch luôn ngang hàng với câu gốc.
   - **Đồng bộ Highlight Câu:** Di chuột/Click vào một câu bên cột này thì câu tương ứng bên cột kia tự động sáng lên (thông qua `data-sentence-id`).
   - **Đồng bộ Highlight Cụm từ (Phrase Alignment):** Bôi đen một cụm từ trong câu gốc → Hệ thống tra cứu/tính toán để highlight cụm nghĩa tương ứng ở câu dịch.

4. **Lưu trữ Cục bộ (Local Storage & Anki Export)**
   - Cho phép chọn và lưu lại các cặp từ/cụm từ/câu đã chọn.
   - Lưu trữ hoàn toàn trên ổ cứng (`chrome.storage.local`).
   - Xuất danh sách từ đã lưu dưới dạng file `.CSV` để import vào **Anki**.

---

## 3. Rủi ro Kỹ thuật Cần Làm rõ Trước Khi Code

### 3.1. Nguồn API dịch ("Free Operating Cost")
Google Translate / DeepL đều tính phí theo ký tự sau một ngưỡng miễn phí nhỏ. Để thực sự "free" và không qua backend trung gian, có 2 hướng:

- **Endpoint dịch không chính thức của Google Translate** — cách nhiều extension miễn phí hiện dùng.
  - Rủi ro: có thể bị Google chặn IP nếu gọi quá nhiều; không ổn định lâu dài vì Google có thể thay đổi bất cứ lúc nào.
- **Người dùng tự nhập API key riêng** (Google Cloud Translation / DeepL API).
  - Ổn định hơn, đúng tinh thần "client-side", nhưng người dùng phải trả phí nếu dùng nhiều.

**→ Cần quyết định ngay từ đầu** vì nó ảnh hưởng trực tiếp đến cách viết phần gọi API (background/service worker).

### 3.2. Phrase Alignment (mục 2.3, ý cuối)
Đây là bài toán **word/phrase alignment**, thuộc lĩnh vực NLP riêng (cần embedding đa ngôn ngữ hoặc mô hình alignment), không thể tính bằng JS thuần đơn giản. 3 hướng khả thi:

- **Bỏ qua ở v1**, chỉ làm sentence-level alignment (đã đủ giá trị học tập).
- Dùng model alignment chạy ngay trong trình duyệt qua **transformers.js** (mô hình nhỏ như LaBSE hoặc SimAlign) — chạy client-side nhưng nặng, tải model vài chục MB.
- Dùng API dịch có trả kèm alignment (một số API nâng cao của Google Cloud Translation hỗ trợ, nhưng phức tạp và thường có phí).

**→ Đề xuất:** để "Phase 2 / Nice-to-have", tập trung làm chắc sentence-level trước.

### 3.3. `Intl.Segmenter`
Lựa chọn đúng, nhưng chỉ hỗ trợ từ Chrome 87+ trở lên (không vấn đề gì vì extension build cho Chrome).

### 3.4. `chrome.storage.local`
Giới hạn khoảng 10MB — đủ cho text nhưng nếu sau này muốn lưu cả câu dài + audio thì cần tính đến **IndexedDB** thay thế.

---

## 4. Câu hỏi Cần Quyết định Trước Khi Bắt Đầu Code

- [ ] **API dịch:** Dùng endpoint không chính thức của Google Translate, hay bắt người dùng nhập API key riêng (Google Cloud/DeepL)?
- [ ] **Phrase Alignment:** Làm ở v1 hay để Phase 2?
- [ ] **Ngôn ngữ hỗ trợ ban đầu:** Cặp ngôn ngữ nào (ví dụ Anh ↔ Việt)? Có cần hỗ trợ nhiều cặp ngôn ngữ cùng lúc không?
- [ ] **Lưu trữ dài hạn:** Dùng `chrome.storage.local` hay chuyển sang IndexedDB ngay từ đầu để tránh giới hạn 10MB?
- [ ] **Đồng bộ cuộn (scroll sync):** Bắt buộc ở v1 hay để sau (vì đây là phần dễ gây giật/lag nếu 2 cột lệch số dòng)?
- [ ] **Giao diện Popup/Side Panel:** Có cần màn hình quản lý danh sách từ đã lưu ngay trong v1, hay chỉ cần nút "lưu" + export CSV là đủ?

---

## 5. Yêu cầu Kỹ thuật (Tổng hợp)

- Nền tảng: Chrome Extension (Manifest V3).
- **Content script:** chèn vào trang web để trích xuất nội dung (Readability-style), tách câu, dựng giao diện 2 cột.
- **Background/service worker:** gọi API dịch (batch requests).
- **Popup/side panel:** xem danh sách từ/câu đã lưu, xuất CSV cho Anki.
- Xử lý trường hợp 1 câu gốc dịch ra nhiều câu (hoặc ngược lại) — ưu tiên dịch từng câu riêng lẻ để tránh vấn đề alignment lệch.
