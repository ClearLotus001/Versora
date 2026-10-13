# XLS/XLSB 流式读取验证

桌面 artifact 准备已移除 XLS 全书 Range 和 XLSB 全量 SST 文本常驻。Rust 继续执行解码、规范化、patience/LCS 对齐和精确比较，应用消费同一份 artifact 协议。八组同输入前后测试全部完成，两侧共 **98000000 个单元格**的独立源校验通过；九个二进制夹具的输出与冻结解析器一致。

这次主要解决大文件的读取内存峰值。落盘和有界排序增加 I/O，部分输入耗时上升，不能宣称所有工作簿加载更快。实现职责、API、精确语义和依赖维护见 [流式架构](binary-workbook-streaming-design.md) 与 [依赖记录](../rust/vendor/calamine/VERSORA.md)。

## 最终实现与测量范围

- XLS：固定 `cfb = 0.15.0` 读取可寻址 Workbook/Book stream，逐条 BIFF 事件写入有界外部排序；不构造全书值/公式矩形。排序块最多 65536 条记录、16 MiB 文本，归并 fan-in 16，分层即时压实 run。
- XLSB：固定 calamine 0.31.0 的正式扩展将 SST 逐条交给存储，单元格返回拥有的值或字符串 ID。范围、公式、值保留三个顺序 pass，共用原解码函数。
- 三类 Excel 格式共用 DiskStrings：数据和 12 字节 offset/length 索引均落盘；数据页预算 4 MiB、索引页预算 16 MiB，文本缓存 16 MiB / 4096 条。顺序短读预读页，跳跃短读只读目标字节，大值完整直读；所有读均处理短读和 I/O 错误。
- 桌面 artifact ingest 无普通 Range 回退。原 Reader API 和已有 Text/DiffJson/DiffJsonBoth/DiffJsonStream CLI 合同保留；本次有界读取结论不适用于这些 CLI 模式。

Windows 本机 release 进程完整执行 `--prepare-artifact source source output`，包含两侧解析、artifact 写入和两种模式的比较。每组串行运行 before 再运行 after，各一次；OS 文件缓存未清空，无其他测试解析/构建负载并行。工作集来自 Windows kernel 记录的峰值，private bytes 每 20 ms 采样，临时文件与输出目录大小每 200 ms 采样。计时包含进程启动和完整准备，不包含后续逐坐标 oracle；这些是本机单次数据，不是统计性吞吐保证。

| 解析器 | SHA-256 |
| --- | --- |
| 实施前冻结原二进制 | `d12a41c3f68cce6afcb6cafb7d3de103189c1fae236b92c6217bdffe6b8feaad` |
| 最终流式 release | `0467a6ab0d1ba314d303c3744e47c50b2aca603306c42112c439d1787cc5a593` |

测试期间原 `output/` 忽略目录意外消失，未发现应用或验证脚本删除该父目录的路径，源码完整。冻结原二进制从 Cargo release/deps 恢复，SHA 完全相同，**未使用重建基线**。本报告使用独立 `.tmp-binary-streaming` 目录中重新生成的输入、重新运行的全部前后测量和最终检查。每个输入和源模型的 SHA、原始数值和逐项比较结果保存在 [结构化结果](binary-workbook-streaming-results.json)。

## 同输入前后压力结果

下表单位为 MiB 和秒；每组均使用同一个输入作为两侧。文本组为每侧 10000 × 100，两个角点是数值公式，其余 999998 个单元格引用 SST。每个 SST 项均为唯一的 128 字符文本并实际被引用；置换组采用确定性双射打散引用顺序。

| 输入 | 峰值工作集 before → after | 采样 private bytes before → after | 完整准备耗时 before → after |
| --- | ---: | ---: | ---: |
| XLSB：1 条 SST，高重复 | 17.816 → 17.941 | 10.258 → 10.426 | 2.118 → 2.203 |
| XLSB：100000 条 SST | 58.398 → 23.535 | 51.953 → 14.578 | 2.179 → 2.759 |
| XLSB：999998 条 SST，顺序 ID | 422.699 → 33.574 | 432.199 → 24.711 | 2.419 → 2.691 |
| XLSB：999998 条 SST，置换 ID | 422.781 → 29.879 | 432.281 → 21.020 | 3.135 → 7.793 |
| XLS：10000 × 100，单表 | 99.504 → 20.086 | 90.707 → 11.188 | 1.030 → 1.175 |
| XLS：10000 × 100，四表 | 292.695 → 25.934 | 281.605 → 19.719 | 3.895 → 4.859 |
| XLS：50000 × 200，两表，共 2000 万 cells/侧 | 1476.938 → 43.938 | 1473.480 → 38.348 | 17.294 → 26.676 |
| XLSB：100000 × 200，数字，共 2000 万 cells/侧 | 43.973 → 43.980 | 39.156 → 39.211 | 18.526 → 18.914 |

百万唯一文本的工作集降低约 92.1%，置换引用降低约 92.9%；最大 XLS 降低约 97.0%。数字 XLSB 在上一轮已改成 worksheet 流式读取，几乎没有 SST，所以本次不再表现出显著内存下降；不能拿它替代海量文本的验证。

最初的磁盘方案使用小预算索引和每次 miss 整页读取，百万置换引用在同一输入上耗时 25.850 秒。最终 positional read、固定索引页预算和按访问局部性预读，将该样本降为 7.793 秒。旧全内存表仍更快；最终置换样本约为旧耗时的 2.49 倍，最大 XLS 约增加 54.3%。这是已测量的取舍，未用热点缓存后的重复读取宣称冷加载收益。

## 磁盘与清理

共享字符串数据和索引、排序 run、公式流只写入受管理会话目录；不写到源工作簿旁。正常完成或返回错误通过 RAII 先关闭句柄再清理。强制终止时 Rust Drop 无法运行，沿用 Electron 等待子进程退出后释放会话 lease 的生命周期。

| 最终输入 | 源文件 | 采样 scratch 峰值 | 最终两侧 artifact | 采样输出目录峰值 |
| --- | ---: | ---: | ---: | ---: |
| 百万唯一 SST，顺序 | 10.509 MiB | 133.514 MiB | 268.402 MiB | 370.451 MiB |
| 百万唯一 SST，置换 | 11.952 MiB | 133.514 MiB | 268.402 MiB | 397.511 MiB |
| XLS 2000 万 cells/侧 | 118.237 MiB | 551.565 MiB | 755.480 MiB | 1106.615 MiB |
| XLSB 数字 2000 万 cells/侧 | 100.668 MiB | 26 B | 755.480 MiB | 755.486 MiB |

输出目录采样包含正在生成的 artifact 和 scratch，不包含源文件。200 ms 采样可能漏过瞬时峰值，不能作为磁盘容量硬上限；scratch 峰值与最终 artifact 也不一定同时发生，不能简单相加当作精确峰值。八组最终目录均没有 SST、formula 或 cell-sort scratch 残留。磁盘不足、索引损坏及解析错误返回错误，不发布截断的成功结果。

## 精确结果与回归

每组 before/after 都比较全部十个 `.bin/.idx` 文件的 SHA：两侧 rows/index，以及 strict/content pairs/runs/regions。全部字节一致。清单仅排除 `artifactDir` 和 `perf` 后逐项相等，包含 sheet、范围、metadata、模式与统计。另用独立紧凑源模型解码最终 rows/index，验证所有坐标、值、公式、sheet 顺序、范围、索引、EOF 和两种模式零变化：八组共 98000000 个 cells。期望值不来自 calamine 输出或前后哈希。

真实/边界夹具共九个：date、1904 date、issues、formula、merge、跨 CONTINUE 的 XLS 长文本/富文本，以及置换 SST XLSB。九组与冻结二进制的十文件及清单完全相同；两个边界源模型还独立验证两侧 330 个 cells。故意构造的 XLS 乱序/重复事件只用于语义回归，不当作合法性能输入。

| 最终检查 | 结果与证据 |
| --- | --- |
| Rust workspace 单元测试 | calamine 39、parser 20、launcher 1 全部通过；[日志](../.tmp-binary-streaming/rust-test.log) |
| Workspace fmt / 严格 Clippy | `fmt --all --check` 和 `clippy --workspace --all-targets -- -D warnings`；[Clippy 日志](../.tmp-binary-streaming/rust-clippy.log) |
| JS 单元 | 191 文件，834 项通过，0 失败/跳过；[日志](../.tmp-binary-streaming/final-unit.log) |
| 原生集成 | 5 文件，32 项通过，0 失败/跳过；[日志](../.tmp-binary-streaming/final-native-integration.log) |
| 静态检查 | ESLint、未使用 export、四类 TypeScript 检查通过；[日志](../.tmp-binary-streaming/final-static.log) |
| 应用构建与相关 E2E | 构建通过；工作簿 34 + 搜索/换边/筛选/标签 17，共 51 项通过；[保留的执行记录](../.tmp-binary-streaming/preserved-verification.json) |
| 最终 release 真实小样本桌面 | XLS 44、XLSB 286 个两侧 cells 在 strict/content 模式下各逐项匹配；三布局实际绘制、Unicode/值/公式和完整搜索通过；[XLS](../.tmp-binary-streaming/desktop-xls-boundaries.json)、[XLSB](../.tmp-binary-streaming/desktop-xlsb-permuted.json) |
| 最终 release 超大 XLSB 桌面 | 每侧 100000 × 200；实际加载、strict/content 首中尾检查、三布局末行绘制、完整搜索和结果跳转通过；[完整报告](../.tmp-binary-streaming/desktop-xlsb-20m-navigation.json) |

CI review gates 和 release workflow 均新增 `cargo test --manifest-path rust/Cargo.toml --workspace --bins --lib`，覆盖 vendored decoder 和应用单元测试；Rust lint 同时覆盖 workspace 格式和全部 target 的 Clippy。两个 workflow 的 YAML 和步骤已本地核对，远程 CI 尚未运行。

单元与夹具额外覆盖 Workbook/Book、mini/regular CFB、v3/v4、BIFF5 codepage、1900/1904、SST 字符/富文本/扩展字段跨 CONTINUE、重复坐标与空覆盖、公式缓存 string/bool/error/number。非法 XLSB SST ID 从 panic 改为受控错误，短/缺失记录和存储错误传播；ZIP member 到 EOF 验证真实 CRC 损坏。XLS 原有空/越界 LabelSst 忽略行为保留。存储覆盖混合前向/回退、跨页、大块、尾部短页和物理截断。

## 超大表真实桌面流程

最终 release 通过 Electron 启动本机 Rust，加载每侧 100000 × 200 的数字 XLSB。原生准备耗时 19.066 秒，主进程加载 19.220 秒，应用启动至实际绘制就绪 22.901 秒。strict/content 各检查两侧首、中、尾共 10 个单元格的值和公式；整个输入的 40000000 个单元格已由前述独立源 oracle 全量校验，桌面窗口检查不替代该校验。

横向、竖向和合并三布局均实际通过 Ctrl+G 跳转到第 100000 行并绘制；完整搜索 `19999998` 返回一个结果，点击后准确定位 `GQ100000`、显示对应值，并滚动到末行末列。截图经目视检查，无页面错误。完整验证耗时 34.983 秒，测试应用均已关闭。

内存来自 Electron 的进程指标，和前表的 Rust 子进程测量分开：初次严格模式绘制、像素探针和截图之前，renderer 工作集约 375 MiB，GPU 约 184 MiB。快速切换三布局、截图及搜索跳转的整个验证期间，记录到 renderer 峰值约 1464 MiB、GPU 峰值约 689 MiB；各进程峰值未必同时发生，不能直接相加。这些数值含交互和测试仪器开销，不是静置加载或纯产品内存基准。

早期验证使用整画布 `getImageData`，会创建大像素数组并触发 GPU readback，其较高峰值不作为结论。最终验证每块画布最多读取 9 个单像素，并在探针和截图前记录各阶段指标。只读审查确认画布来自虚拟行窗口，合并组也分块；位图缓存 96 MiB、待生成位图 48 MiB / 2 个、值缓存 24 MiB / 2048 窗口均有边界。行摘要、行映射、差异索引和共享投影仍随行数或差异数增长，值缓存统计不能代表 renderer 总内存。本次不宣称整个 Electron 应用具有固定内存上限。

## 剩余边界

本次消除的是完整 Workbook payload、全书矩阵和全部 SST 文本的读取常驻；CFB/ZIP 元数据、样式/名称、sheet/merge、artifact 行引用和对齐索引仍随对应结构增长。单个超长字符串、完整当前行、排序归并头也要完整保留。缓存预算不等于整个进程的内存上限。

更大 SST 超过固定索引缓存预算时，随机读取仍可能增加 I/O；本次文本高压是百万项，不能推导成任意数量、任意文本长度均有相同耗时。完整正则搜索和精确自动列宽的第一次扫描仍需读取相关全部内容；上一轮已优化其扫描、批量 IPC 和缓存，见 [全量扫描记录](workbook-full-scan-optimization.md)。最终 artifact 仍完整保留全部单元格，没有抽样、截断或另设兼容回退。
