# Bilingual Reader (Chrome Extension, MV3)

Doc sach song ngu 2 cot (goc | dich) cho bat ky trang web nao, dich theo tung
cau, dong bo highlight 2 chieu, luu tu vung va xuat CSV de import vao Anki.
Ban ca nhan, chi chay bang "Load unpacked" - khong nham Chrome Web Store.

## Canh bao ve quyen rieng tu (R10)

Khi ban bat Bilingual Reader tren mot trang, **toan bo noi dung van ban cua
trang do se duoc gui ra endpoint dich khong chinh thuc cua Google**
(`translate.googleapis.com`) de dich tung cau. Dieu nay dung ngay ca voi
trang sau dang nhap (email, tai lieu noi bo, ...).

- Chi bam icon extension tren nhung trang ma ban dong y noi dung duoc gui
  di dich.
- Options > "Danh sach domain bi chan" mac dinh da chan `mail.google.com`,
  `*.atlassian.net`, va `localhost` - reader se tu choi mo tren cac domain
  nay. Ban co the them domain khac vao danh sach.
- Day la endpoint **khong chinh thuc**: khong co SLA, Google co the thay doi
  hoac chan bat ky luc nao ma khong bao truoc.

## Cai dat / build

```bash
npm install
npm run build       # -> dist/
npm run watch       # esbuild --watch (build lai code khi sua file .ts)
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

## Load vao Chrome

1. `npm run build`
2. Mo `chrome://extensions`, bat "Developer mode".
3. "Load unpacked" -> chon thu muc `dist/`.
4. Vao mot trang bai viet bat ky -> bam icon extension -> "Mo Bilingual
   Reader" trong popup.

Sau khi sua code, chay lai `npm run build` (hoac dung san `npm run watch`)
roi bam nut reload cua extension trong `chrome://extensions`.

## Kien truc (tom tat)

- **Content script** (`src/content`): chi bom vao trang khi nguoi dung bam
  mo reader (khong khai bao `content_scripts` tinh trong manifest). Bóc
  tach DOM song thanh `ArticleDoc` bang `@mozilla/readability`, co fallback
  heuristic (`<main>`/`<article>`/khoi text dai nhat) khi Readability that
  bai.
- **Reader page** (`src/reader`): la "orchestrator" - so huu toan bo vong
  doi dich (uu tien viewport, batch, concurrency, retry/backoff, cache
  ghi-doc debounce). Render bang mot CSS Grid duy nhat (khong co JS dong
  bo cuon).
- **Service worker** (`src/background`): proxy mong, khong giu state giua
  cac message (MV3 co the kill SW bat ky luc nao) - chi lam 2 viec: mo
  reader (inject + luu doc + dieu huong tab), va dich 1 batch (doc cache ->
  goi provider cho phan mieng cache-miss -> tra ve).
- **Translation provider** (`src/translation`): dang sau interface
  `TranslationProvider`; hien tai chi co `google-gtx.ts` (endpoint khong
  chinh thuc cua Google Translate).
- **Storage** (`src/storage`): la lop duy nhat dung `chrome.storage`/
  IndexedDB. Settings + tu vung dung `chrome.storage.local` (vinh vien);
  ban thao ArticleDoc dung `chrome.storage.session` (RAM, theo tabId); cache
  ban dich dung File System Access API (thu muc nguoi dung chon) voi fallback
  tu dong sang OPFS, roi fallback sang Map trong bo nho neu ca hai khong
  dung duoc - cache luon la tuy chon, khong bao gio chan luong doc.

Xem `bilingual-reader-spec.md` de biet boi canh/spec goc, va lich su hoi
thoai/report trien khai (trong session tao ra du an nay) de biet chi tiet
cac quyet dinh da chot.
