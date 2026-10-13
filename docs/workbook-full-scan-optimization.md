# 工作簿全量扫描优化与验证

本文记录上一轮完整搜索、精确自动列宽、源行读取与 XLS/XLSB worksheet 优化的验证结果，冻结解析器为 `d12a41…`。随后已实施的 XLS 全书缓存和 XLSB SST 流式改造见 [读取库架构](binary-workbook-streaming-design.md)及[最终验证](binary-workbook-streaming-validation.md)；不能将本文旧/新数字当作该后续改造的收益。Rust 始终负责解析、规范化、patience/LCS 对齐和精确比较；没有引入抽样、截断源数据、另一套比较算法或 artifact ingest 兼容回退。以下数据对应同一台 Windows 机器的本地测试，不能作为所有机器的性能保证。

本文保留上一轮测量记录与当时的证据路径；对应 `output/` 原始日志与 artifact 目前未保留在工作区。实施前冻结解析器已从 Cargo release deps 恢复，完整 SHA-256 仍为 `d12a41c3f68cce6afcb6cafb7d3de103189c1fae236b92c6217bdffe6b8feaad`，本轮 before 使用该原始二进制，不使用源码重建基线。[恢复来源](../.tmp-binary-streaming/recovered/parser-d12-recovered.provenance.json)、新输入哈希和独立输出目录中的测量证据见[最终验证报告](binary-workbook-streaming-validation.md)。

## 完整搜索

搜索线程直接读取不可变 artifact 的规范化行与对齐索引，删除主线程逐页构造窗口单元格、变化对象并跨线程复制的链路。六个文件分别使用 1 MiB 顺序预读；按显示顺序仅读取需要搜索的一侧，差异行搜索跳过不参与查询的行。

保持原 JavaScript RegExp、lookbehind、backreference、跨单元格 tab 匹配、值与公式、base/mine 顺序、坐标和 snippet。仍完整计数，显示结果沿用 100000 条上限。snippet 复制为独立 UTF-16 字符串，避免 V8 切片保留整条大行，保留边界处孤立 surrogate 的原字符串值。取消、替换和关闭等待同一个实际线程终止 Promise。

100000 行 × 200 列，单独串行运行旧/新实现；六组查询均校验完整 totalCount、保留数量、顺序及全部结果的 SHA-256：

| 输入与查询 | 优化前 | 优化后 | 精确匹配数 |
| --- | ---: | ---: | ---: |
| sparse 字面搜索 | 23.035 s | 1.578 s | 2 |
| sparse 完整正则 | 23.809 s | 1.524 s | 2 |
| sparse 差异行搜索 | 7.294 s | 0.273 s | 800 |
| dense 字面搜索 | 24.223 s | 2.794 s | 2 |
| dense 完整正则 | 24.920 s | 2.821 s | 2 |
| dense 差异行搜索 | 24.401 s | 3.548 s | 19899801 |

旧实现每次请求 782 个窗口页，新实现为 0。sparse 字面搜索的主线程 event-loop active 时间从 12920.9 ms 降到 9.1 ms；process 峰值 RSS 从 353669120 B 降到 124116992 B。此 RSS 是整个 Node 测试进程与线程之和，不是独立 worker 堆大小。

额外验证 `^ID-` 查询共 100799 个匹配，跨不同源行保留 100000 条结果，在 worker 256 MiB 堆限制下完成；另在 64 MiB 堆下搜索 10000 条各 10000 字符的行，确认短 snippet 不保留全源行。

原始证据位于 `output/stress/search-optimization-comparison.json` 与 `search-{sparse,dense}-{before,after}.json`。正式 after 数据均在最终 UTF-16 复制及精简清单实现上重跑。

## 精确自动列宽与源行读取

选中列共享一次完整扫描，使用独立 Canvas context 和原字体规则测量。达到原有 420 px 上限后，该列后续值不可能改变最终结果，因此停止读取该列；未达到上限的列仍扫描全部行。文本测量缓存为两个有界代际，总预算 2 MiB / 8192 条；完成宽度由不可变 provider 按 sheet、字体加载 epoch、字号、DPR 和缩放身份缓存，关闭时清理。

菜单批量测量与两个面板表头共用唯一批量测量函数和 provider 操作所有权，显式传入 provider 与工作表身份。删除旧行文本扫描以及首行引用推断的兼容分支；空工作表仍测量真实列头，零 IPC。新测量、手动改宽、切换、取消和关闭使旧响应失效。源行读取共享四个并发槽，并支持排队/进行中的调用取消。每约 8 ms 使用 MessageChannel 让出主线程，完成和失败均关闭两端 port。

Electron 源行与视口读取共享 16 MiB 预读缓存，每块通常 1 MiB，按完整底层 Buffer 大小计费。重叠请求共享 pending 块，普通行共用 canonical decoder；超过 4 MiB 的行仍逐 cell 跳过未选字段。相邻/重叠列范围内部合并，返回原请求范围合同；列范围查找使用排序区间的二分查找。

Reader 使用同一份 100000 × 200 sparse artifact，串行完整扫描两侧 40000000 个值和公式，均为 391 页；系统 `fs.read` 次数从 200000 降到 1008，耗时从 14.385 s 降到 9.524 s。完整 SHA-256 均为 `7c1a91289251e0d65004192e69c91aa207a922b6e7a8c026d59822e0622120fb`。旧实现先运行，未清空 OS 文件缓存；此计时是源行读取及校验，不含 Canvas 测量、IPC 或首次 Rust 准备。

该 Reader 测试进程峰值 RSS 从 312389632 B 增至 372989952 B，预读提高吞吐但不代表整个进程内存减少。16 MiB 是已缓存块的预算，进行中的读取缓冲与响应对象另受并发和分页约束。证据为 `output/stress/reader-scan-{before,after}.json`。

真实 Electron、原生 Rust 准备、实际 `window.versora` IPC 和 Canvas，在同一份 100000 × 200 sparse 工作簿上测量，字号为 12 px：

| 测量 | 优化前 | 优化后 | 精确验证 |
| --- | ---: | ---: | --- |
| 选中 8 列首次测量 | 14.803 s / 3128 IPC | 8.345 s / 391 IPC | 两侧 1600000 个值，8 个宽度与旧实现逐项相同 |
| 同 provider 重复测量 8 列 | 未测 | 0.100 ms / 0 新读取 | 全部宽度与首次一致 |
| 首次测量完整 200 列 | 未测 | 170.972 s / 391 IPC | 两侧 40000000 个值全部扫描 |
| 同 provider 重复测量 200 列 | 未测 | 0.300 ms / 0 新读取 | 200 个宽度与首次一致 |

200 列首次测量的源分页等待累计为 65.422 s，最慢单页 200.5 ms；其余约 105.550 s 包含 Canvas 精确字体测量、文本规范化、缓存与调度。首次处理大量唯一短文本仍昂贵，不能把复用缓存后的时间宣称为冷扫描性能。正式桌面测量不使用早期模拟 Canvas 的 CPU benchmark 作为比较数据。

200 ms 采样下，该 200 列测试整个应用的峰值 working set：Browser 428.23 MiB、Renderer/Tab 880.96 MiB；对应 private bytes 为 239.96 / 819.62 MiB。样本包含已经加载的完整 UI、渲染与测量进程，不能等同于列宽缓存大小；没有匹配的 before200 内存基线，不能声称整应用内存降低。原始各进程采样也保留 GPU/Utility 数据。

桌面证据为 `output/stress/autofit-desktop-{before,after}-8.json` 与 `autofit-desktop-after-200.json`。列宽扫描不改变差异比较和显示结果。

## XLS/XLSB 内存

本节是上一轮 worksheet 读取优化的历史结果：当时 XLSB 使用 calamine 公开 cell/formula reader，三个顺序 pass 分别观察真实非空值范围、写稀疏公式流、逐行写规范化值，避免依据可能虚高的 dimension 构造密集 Range；XLS 先写公式流并释放应用层公式 Range 副本，再取得值 Range。公式 scratch 使用 RAII，在成功和错误路径均关闭删除。后续流式扩展已经替换桌面 artifact ingest 的这两个读取入口，消除 XLS 全书 Range 和 XLSB 常驻 SST；下表仍保留该上一轮的对照实现和计时。

| 格式与单侧规模 | 峰值工作集：前 → 后 | 采样峰值 private bytes：前 → 后 | 耗时：前 → 后 |
| --- | ---: | ---: | ---: |
| XLS，10000 × 200 | 240488448 → 192417792 B | 231518208 → 183619584 B | 2.057 → 1.966 s |
| XLSB，10000 × 200 | 159428608 → 18395136 B | 154955776 → 10747904 B | 2.056 → 2.148 s |
| XLSB，100000 × 200 | 1460867072 → 46252032 B | 2030850048 → 41086976 B | 20.026 → 22.377 s |

工作集使用 Windows kernel peak working set，private bytes 每 20 ms 采样。未清空 OS 文件缓存，旧实现先运行，新实现随后运行。XLSB 最大样本工作集下降约 96.8%，耗时增加约 11.7%；额外顺序扫描是明确的内存/耗时取舍。

三组旧/新结果的两侧 rows/index、strict/content pairs/runs/regions 共十个文件均字节一致。100000 × 200 XLSB 的独立源 oracle 完整验证两侧共 40000000 个单元格的坐标、值和公式、行列范围、两端公式、两种模式零变化以及 scratch 清理。七个真实 XLS/XLSB 文件也逐坐标对照旧 Range 路径，覆盖日期系统和公式；另有空行、formula-only、错误清理和虚高 dimension 回归。

证据位于 `output/stress/binary-memory/{xls,xlsb}-10000x200/result.json` 与 `output/stress/binary-memory/xlsb-100000x200/result.json`。最大样本新解析器 SHA-256：`d12a41c3f68cce6afcb6cafb7d3de103189c1fae236b92c6217bdffe6b8feaad`。

## 回归与剩余边界

本节数据对应上一轮冻结解析器与前端的统一验证；后续库内流式扩展的测试计数和最终构建证据见 [流式读取验证](binary-workbook-streaming-validation.md)。

| 验证 | 结果 | 本地证据 |
| --- | --- | --- |
| `npm run verify:static` | ESLint、未使用 export 检查和 renderer/electron/scripts/tests 类型检查通过 | 历史 `output/stress/workbook-scan-static.log` |
| `npm run build:app` | Renderer/Electron 构建通过 | 历史 `output/stress/workbook-scan-build.log` |
| `npm run test:workbook:unit` | 191 文件、834 项通过，0 失败、0 跳过 | 历史 `output/stress/workbook-scan-unit.log` |
| `npm run test:workbook:rust` | 5 文件、32 项通过，0 失败、0 跳过 | 历史 `output/stress/workbook-scan-rust-integration.log` |
| Rust tests、fmt、Clippy | parser 15 项、launcher 1 项通过；fmt 和严格 Clippy 通过 | 历史 `output/stress/workbook-scan-rust-unit.log`、`workbook-scan-rust-lint.log` |
| 工作簿、搜索、筛选/换边、标签及新列宽 UI 回归 | 51 项全部通过，包含菜单多列测量、手动拖宽、表头双击恢复的三个布局 | 历史 `output/stress/workbook-scan-e2e.log` |
| 最终构建真实 Electron 小样本 | 251 × 8、两侧源计数、3 个变化、尾值搜索导航、strict/content、三布局通过 | 历史 `output/stress/workbook-scan-ui-small.json` |
| 最终构建真实 Electron 压力样本 | 100000 × 200 sparse，单侧 20000000 个非空值、800 个变化、GR100000 两侧值、全表搜索导航、strict/content、三布局通过 | 历史 `output/stress/workbook-scan-ui-sparse.json` |
| `git diff --check` | 通过 | 历史 `output/stress/workbook-scan-diff-check.log` |

最终桌面压力样本从启动至初始 ready 为 33.983 s，其中原生准备约 30.762 s；尾值搜索及导航为 2.924 s。此值包含真正桌面启动/界面过程，不能与上文独立 worker 搜索时间直接混用。

源读取回归额外覆盖 600 列中的 300 个交错区间，修复原本超过 256 个不连续区间会失败的缺口。保持 256 行 / 16 MiB 分页预算，统一接受最多 16384 个列范围；部分列达到宽度上限后，剩余 300 个交错列仍继续完整扫描。乱序、重叠和空区间不修改原请求与响应的范围合同，值、公式和随机读取均验证。

正式桌面列宽数据在最终参数清理前取得；清理仅将 provider/工作表身份改为显式参数并删除不可达旧行分支，artifact 扫描、Canvas 测量及缓存算法未变。最终参数清理后的新 UI 用例和整套单元/构建/静态验证全部重跑通过。

- 任意完整正则仍需要扫描相关行，并保留当前行的完整字符串；病态正则由既有超时和线程终止处理。不能将这些查询宣称为索引查询或恒定耗时。
- 自动列宽首次测量未饱和的唯一文本列仍需要完整读取和字体测量；重复调用可复用完成结果。
- 桌面 artifact ingest 已改用 `XlsStream` / `XlsbStream`：XLS 不创建全书 Range，XLSB SST 数据和 ID 索引共用磁盘存储。缓存预算、外排与精确语义见 [读取库架构](binary-workbook-streaming-design.md)，同输入前后压力结果见 [验证报告](binary-workbook-streaming-validation.md)。
- 后续共用 SST 存储的预算为数据页 4 MiB、索引页 16 MiB、文本缓存 16 MiB / 4096 项。索引按 16 KiB 页缓存，数据在邻近顺序读取时预读页，随机未命中直接读取所需文本字节；使用位置读取循环补全短读并传播错误。它与本报告上文 Electron 的源行预读缓存属于不同读取层，不能将两者预算或计时混用。
- 二进制读取仍保留 CFB/ZIP 元数据、样式/名称、merge 元数据、当前行与对齐索引等结构，不能将其宣称为整个进程恒定内存。磁盘 SST 与 XLS 外排增加临时空间和 I/O，随机文本、高重复文本与数字大表需分别评估。
- 现有 Text/DiffJson/DiffJsonBoth/DiffJsonStream CLI 模式继续使用普通 Reader API；其全量读取合同未在本次 artifact/桌面优化中改变。这些入口不作为 artifact 的运行时回退。
- 单个超长值和完整正则当前行是不可拆分的内存边界；预读缓存预算不等于整个 Electron 进程内存上限。
