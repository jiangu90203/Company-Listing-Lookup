# 公司上市櫃快查｜GitHub Pages 版 v1.3.0

延續 Windows v1.2 的公司身分查核與已查證關聯，改為可直接發布到 GitHub Pages 的純靜態網站。不需要安裝程式、API 金鑰、付費代理或額外伺服器。

## 最快上線：上傳檔案後開啟 Pages

1. 將 ZIP **完整解壓縮**。不要直接上傳 ZIP。
2. 在 GitHub 建立一個新 repository，或開啟要放這個工具的 repository。此套件不依賴固定 repository 名稱。
3. 把解壓後的 **index.html、assets、data、vendor、examples、.nojekyll** 放在 repository 根目錄並 Commit 到 `main`。必須上傳資料夾內的檔案，避免多包一層 `CompanyQuickCheck...` 資料夾。GitHub 網頁版可使用 Add file → Upload files 拖入整包解壓內容；若看不到 `.github`，可使用 GitHub Desktop 上傳。
4. 進入 **Settings → Pages → Build and deployment**，Source 選 **Deploy from a branch**；Branch 選 `main`，資料夾選 `/(root)`，按 Save。
5. 等待 GitHub 顯示發布完成，點選 Pages 頁面的 **Visit site**。從該網址開啟即可使用；不要雙擊本機 `index.html`。

此方式立刻可用，但資料只會在你更新 `data/` 並重新發布後改變。若要自動更新，改用下一節。

## 建議設定：官方名單自動更新

套件包含 `.github/workflows/pages.yml`。請將 **整包內容（含 .github、scripts、tests、package.json）** 上傳到 `main`。

1. 到 **Settings → Pages**，Source 改選 **GitHub Actions**。
2. 到 **Actions**，若出現工作流程尚未啟用，先啟用。選擇 **Update public data and deploy Pages**，點選 **Run workflow → Run workflow**。
3. 等 build、deploy 都顯示綠色完成，到 Settings → Pages 點選 **Visit site**。

這個工作流程會：

- 在推送到 `main`、手動執行及平日台灣時間 08:15 排程時，下載四份官方名單。GitHub 排程可能延後，不是即時行情服務。
- 驗證欄位、出表日期、筆數及重複代號，來源失敗時保留前次可用名單，不以空名單覆蓋。
- 執行 Node.js 與 Python 自動測試，再部署靜態檔案。
- 嘗試將最新資料寫回 `data/`，方便日後下載使用。若分支保護拒絕推送，當次部署仍使用已更新資料，並在 Actions 顯示警告。

使用 GitHub 自動提供的 `GITHUB_TOKEN`；不需手動建立或貼上 Token。工作流程只有更新公開名單時需要 repository 的 contents 寫入權限；Pages 部署需要 pages、id-token 寫入權限。

預設分支若不叫 `main`，請修改 `.github/workflows/pages.yml` 中的 `branches: [main]`。排程只在預設分支執行；GitHub 可能停用長期沒有活動的 repository 排程，發現資料未更新時可手動 Run workflow 並確認排程已啟用。

## 已有網站要更新

- 覆蓋相同路徑的 `index.html`、`assets/`、`data/`、`vendor/` 與相關設定，並 Commit／Push 到 Pages 使用的分支。
- 新版放在另一個子資料夾但仍開原網址，會繼續看到原版。若要保留歷史版，請把歷史版放在 `archive/`，目前版本仍放在發布根目錄。
- 更新後確認 Actions／Pages 部署成功，再以 Ctrl+F5 重新整理。畫面右上角應為 **網頁版 1.3.0**。
- 本版沒有 Service Worker；不會保留背景離線快取。頁面仍可能受 GitHub 與瀏覽器的正常 HTTP 快取影響。

## 使用方式

### 單筆查詢

輸入完整或部分公司名稱、官方簡稱或 8 碼統編。名稱不完整時點選建議公司；不會將第一筆近似候選自動套用為正確公司。也可輸入股票代號查找候選。

畫面分開顯示本體掛牌身分、統編、股票代號及已查證關聯，並提供來源連結和複製結果。已查證子公司／分公司不會沿用掛牌公司的股票代號當作自己掛牌。

勾選「網路補查一般公司」後，查詢按鈕才會把名稱或統編傳到 `company.g0v.ronny.tw`；不會隨每個輸入字元自動傳送。補查來源為民間整理政府資料，可能有更新落差。無法連線或跨來源限制會顯示「暫時無法確認」，不視為確認未上市。

### 批次比對

1. 切換「試算表批次比對」，拖入 XLSX、XLS、UTF-8／UTF-16 CSV、TSV，也可直接貼上 Excel／Google 試算表多欄名單。
2. 確認工作表、公司欄、統編欄與開始／結束列。沒有統編欄就選「無此欄位」，**shop id 不會自動當成統編**。也支援僅統編的一欄名單。
3. 預覽會分列待比對、缺少名稱及排除列。按「開始批次比對」。未命中公司可選擇開啟網路補查；只傳每列公司名稱或統編，不傳整份檔案。
4. 待確認列按「核對」查看候選、地址與統編，確認同一法律主體後再採用。
5. 選「只貼分類」或「分類＋來源」，按「複製貼回結果」，**從畫面指定的原表起始列貼到空白欄**。貼回前請取消原表篩選；不要先排序、刪列或只複製篩選後的部分原表。

分批標題及真正空白列不查詢，但輸出保留空格。有店名／shop id 卻缺公司名稱時列為「缺少公司名稱」。合併儲存格不自動向下填入；隱藏列仍依原位置保留。

同一家公司多個門店會保留每列；同批重複查詢只處理一次。網路補查會節流並快取本次分頁內的結果。停止時保留完成結果，未處理列標為已取消，仍可匯出。

畫面篩選及分頁不會改變複製／匯出範圍。變更匯入檔案或比對條件後，舊結果會隱藏，必須重新比對。

### 輸出

| 格式 | 用途 |
| --- | --- |
| 複製貼回 | 1／2 欄，包含 Unicode 文字與 HTML 表格；保留空白列 |
| 貼回 TSV | UTF-8 BOM，沒有欄名，依畫面指定原表起始列貼上 |
| Excel | 完整報告＋分類貼回＋分類來源貼回三張工作表；統編保留為文字 |
| 完整 CSV | 26 個查核欄位，保留原輸入、原統編、候選、來源、關聯與核對說明 |

瀏覽器禁止剪貼簿時，會開啟可手動全選的文字視窗。CSV 如用 Excel 直接開啟，統編可能被 Excel 自動移除前導零；建議使用 Excel 匯出，或將 CSV 統編欄指定為文字匯入。完整 CSV 不適合直接整份覆蓋原表。

## 資料、範圍與隱私

- 隨附官方名單：上市 1,098、上櫃 898、興櫃 374、其他公開發行 302 家；出表日期皆為 **2026/11/18**，於 2026/11/19 取得。以網站畫面顯示日期為準，不把下載時間當成官方出表日期。
- 官方來源：https://data.gov.tw/dataset/18419 、https://data.gov.tw/dataset/25036 、https://data.gov.tw/dataset/28568 、https://data.gov.tw/dataset/28567 。
- `data/relationships_verified.json` 延用 Windows v1.2 已查證案例，查證日 **2026/11/11**。包含明基健康生活、保瑞聯邦及新竹分公司、台南開曼分公司、漢來美食高雄分公司、克麗緹娜行銷台灣分公司等，**不是完整的子公司或集團關係資料庫**。超過 90 天改列待複核；官方名單自動更新不會自動重新查證企業關係。
- 原表填寫的市場或股票代號，只用來核對差異，不直接當作判定依據。
- 「未查得上市櫃紀錄」只表示目前載入名單沒有命中，不等同已證明未上市櫃。歷史下市日期、完整股權、非台灣市場不在查核範圍。
- 匯入的檔案及結果保存在分頁記憶體，不上傳、不寫入網站伺服器；關閉分頁後清除。沒有分析追蹤、沒有自動讀取剪貼簿。按複製才會寫入剪貼簿。
- GitHub Pages 網站的程式與公開名單會發布到網站上，**請不要把內部原始商家名單或查核報告放進 repository**。本發布包未包含先前提供的內部附件、比對報告或測試輸出。

## 本機維護與驗證

一般使用者只需發布檔案，不需執行下列命令。

```sh
# 本機預覽（Python 3）
python -m http.server 8080
# 瀏覽器開啟 http://localhost:8080/

# 維護者更新公開名單
python scripts/update_data.py

# 自動測試：Node.js 22+、Python 3.12+，不需 npm install
node --test tests/*.test.mjs
python -m unittest discover -s tests -p 'test_*.py'

# 產生只有公開執行檔案的 _site 目錄
python scripts/make_site.py
```

已執行 21 項 Node.js 測試（含 3 項既有附件回歸）及 4 項 Python 名單驗證測試。未提供附件路徑時，3 項私有附件回歸會跳過；其他 18 項不需任何內部檔案即可執行。

已在瀏覽器驗證名稱建議、單筆查詢、分批空白列、人工採用候選、XLSX 檔案匯入、貼回剪貼簿、Excel 下載及專案子路徑載入。**尚未發布到使用者的 GitHub repository，GitHub Actions 雲端執行仍須首次發布後確認。**

## 授權

程式碼依 MIT 授權，詳見 `LICENSE`。SheetJS CE 0.20.3 為 Apache-2.0 授權，完整元件與授權隨附於 `vendor/`；來源 https://cdn.sheetjs.com/ 。官方資料依「政府資料開放授權條款－第 1 版」使用：https://data.gov.tw/license 。原始資料、登記內容及民間服務權利屬各提供者。
