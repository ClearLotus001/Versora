# 工作簿差异优化验证记录

验证日期：2026-10-13。环境：Windows、Intel Core Ultra 7 265KF（20 个逻辑处理器），Electron 生产构建。

## 结果与改动范围

100000 × 200 的三组真实 XLSX 比较均完成加载、真实 Canvas 绘制及交互验证。每侧包含 2000 万非空单元格，测试覆盖稀疏修改、密集修改及大量独立差异区域。

Rust 仍负责解析、规范化、patience/LCS 行对齐和精确比较；Electron 仍启动一次性 Rust 进程。改变的是数据存储、传输及消费方式：流式读取 ZIP/XML 和共享字符串，生成不可变磁盘索引，Electron 按需读取，前端只缓存请求窗口及精确单元格。strict/content 共用规范化数据，保留两种模式各自的比较结果。

桌面工作簿来源统一使用该管线，旧 JSON 包装、全量 DTO 和前端计算 fallback 已删除。没有用提高 XML、堆内存或超时上限规避问题。实现和语义约束见 [架构说明](workbook-artifact-architecture.md)。

原失败原因是工作表 XML 解压后超过 1.2 GB，加上完整 XML、单元格、签名、差异 DTO 和前端模型的连续全量展开。原 XML 条目限制最先触发错误，单独放宽限制不能解决后续内存问题。旧压力基线没有成功加载，因此不能用它计算加载提速百分比。

## 100000 × 200 桌面压力结果

下表采用每组最终生产构建的一次完整运行观测值；sparse 在兼容分支删除后追加复测，采用 `release` 报告。启动至就绪包含 Electron 启动、Rust 准备和真实视口绘制；“应用至绘制”使用前端性能事件，包含窗口读取和绘制完成等待。

| 场景 | 变化单元格 | 独立区域 | 启动至真实绘制就绪 | Rust 准备 | 应用至真实绘制 | 全表尾值搜索与定位 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| sparse | 800 | 800 | 30.312 s | 26.999 s | 0.658 s | 25.472 s |
| dense | 19,899,801 | 1 | 32.518 s | 29.061 s | 0.787 s | 28.269 s |
| islands | 2,233,311 | 2,233,311 | 35.160 s | 30.314 s | 1.696 s | 27.473 s |

每次均验证完整行列数、两侧单元格数量、精确变化数量、GR100000 两侧值、公式栏地址和值、strict/content 切换及三种 Canvas 布局。就绪要求真实数据窗口已经绘制、待处理读取为零；没有截断数据或用占位视图通过测试。islands 最后一行未变化，尾值搜索先关闭“仅差异”，验证完整视图搜索。

GR100000 的 base 为 `value-99999-199`；sparse/dense 的 mine 为 `updated-99999-199`；islands 的 mine 为 `value-99999-199`。

本地原始证据（`output/` 不纳入版本控制）：

- [sparse 最终构建桌面结果](../output/stress/artifact-ui-sparse-release.json)
- [dense 桌面结果](../output/stress/artifact-ui-dense-final.json)
- [islands 桌面结果](../output/stress/artifact-ui-islands-final.json)

## 完整正确性校验

[独立校验器](../scripts/verify-workbook-artifact.ts) 对每组两侧共 4000 万个存储值逐一核对值和坐标，同时校验全部物理行偏移、对齐 pair、变化列 run、标志、统计及区域记录，strict/content 两种模式都通过。

| 场景 | Rust ingest | Rust 对齐与比较 | Rust 总准备 | 含独立校验的总运行时间 |
| --- | ---: | ---: | ---: | ---: |
| sparse | 17.395 s | 14.243 s | 31.638 s | 54.114 s |
| dense | 16.152 s | 13.043 s | 29.196 s | 44.775 s |
| islands | 19.602 s | 12.189 s | 31.791 s | 49.237 s |

这三组是独立 native 校验运行，与桌面运行分开计时；含校验的总运行时间不能当作产品加载耗时。原始报告为 [sparse](../output/stress/artifact-sparse-final/verification.json)、[dense](../output/stress/artifact-dense-final/verification.json)、[islands](../output/stress/artifact-islands-final/verification.json)。

压力输入生成器还检查 ZIP CRC、XML、单元格地址和值、文件 SHA256，保证超大样本本身有效。

## 内存与磁盘

以下为桌面完整运行期间各进程 Windows Peak Working Set，包含模式、布局和全表搜索交互。各进程峰值不一定发生在同一时刻，不能相加当作同时占用；也不能把这些值解释成仅加载阶段的内存。

| 场景 | Rust | Electron 主进程 | Renderer | 最终窗口缓存 |
| --- | ---: | ---: | ---: | ---: |
| sparse | 51.4 MiB | 328.7 MiB | 489.0 MiB | 2,231,848 B |
| dense | 61.5 MiB | 300.5 MiB | 636.9 MiB | 1,523,710 B |
| islands | 212.3 MiB | 678.6 MiB | 1,151.9 MiB | 1,865,566 B |

三个终态缓存的 pending 都为零。窗口与选中/合并锚点缓存共用 24 MiB 预算，精确单元格另有 4 MiB 子预算；单个不可拆分的超长完整值是明确例外。这个预算只约束数据窗口缓存，不是进程总内存上限。全局行、变化和区域索引仍随数据规模增长；223 万独立区域的场景仍有明显内存及前端计算成本。

规范化数据和两种模式索引的磁盘占用分别约 0.994 / 1.034 / 1.231 GiB，另需考虑来源临时文件。通过磁盘索引避免整表值常驻内存是本方案的明确成本。关闭、取消和来源替换的资源生命周期有专门回归覆盖。

每个桌面报告旁的 `.monitor.json` 和 `.memory.jsonl` 保留原始进程监测数据；采样间隔约 0.8–2 s，Rust 峰值取 Windows 进程峰值字段。

## 功能与构建回归

- 最终单元测试：822 通过，0 失败，0 跳过；[日志](../output/stress/artifact-unit-final.log)。
- Rust 必需的 TypeScript 集成测试：29 通过，0 失败，0 跳过；包含独立 Git 历史来源、准确版本值和模式复用；[日志](../output/stress/artifact-rust-integration.log)。
- Rust 原生解析测试、launcher、Clippy `-D warnings` 通过，15 个旧 CLI 比较用例结果一致。
- 浏览器相关回归初次 39 项中 37 项通过，2 项修复后在 17 项重跑中通过；最终构建另有 19 项针对性回归通过。重叠执行次数不作为独立用例数相加。
- 回归覆盖合并、隐藏列、稀疏行、工作表增删/重命名、三布局与冻结、搜索定位、公式/tooltip、复制及完整自动列宽、比较标签、取消和过期请求。
- `npm run verify:static` 的 ESLint、unused exports 和四组类型检查通过；[日志](../output/stress/artifact-static.log)。
- `npm run build:app` 的 renderer/Electron 构建通过；[日志](../output/stress/artifact-build.log)。

小型 5001 × 200 控制组也完成真实桌面验证：启动至绘制 2.556 s，Rust 1.309 s，模式切换 339 ms，布局切换约 65–66 ms。见 [控制组报告](../output/stress/artifact-ui-control-wide.json)。该结果没有配对统计实验，不能据此前后单次数据声称提速百分比。

## 复现

在项目根目录用 PowerShell 7 执行，先完成依赖安装及 Rust、应用构建。生成样本和独立校验消耗大量磁盘与 CPU；以下使用单独的复现输出目录。

```powershell
npm run build:rust
npm run build:app
python scripts/generate-workbook-stress.py --output-dir output/stress/repro --rows 100000 --columns 200 --cases base sparse dense islands
./scripts/monitor-workbook-artifact.ps1 -Base output/stress/repro/base-100000x200.xlsx -Mine output/stress/repro/sparse-100000x200.xlsx -Case sparse -ArtifactDir output/stress/repro-artifact-sparse
npm run benchmark:perf -- --scenario=workbook --base=output/stress/repro/base-100000x200.xlsx --mine=output/stress/repro/sparse-100000x200.xlsx --iterations=1 --expect-workbook-manifest=output/stress/repro/manifest.json --report=output/stress/repro-ui-sparse.json --verify-workbook-interactions --workbook-layouts
```

对 dense/islands 替换 mine 文件名、case 及报告目录即可。生成器、完整校验器和桌面 benchmark 均为项目脚本，不依赖截断或抽样确认结果。

本轮 Rust release parser 的 SHA256 为 `22ABBA766975203B4C823A09D284B2C38BE14332A5BD7CFDF7771F2A7EDE379E`。

## 已知边界

本轮完整超大 XML 流式路径验证针对 XLSX。XLS/XLSB 进入相同的规范化 store，但 calamine 的 Range 读取仍可能全量分配，不能宣称这两种格式的解析内存已经完全有界。

2000 万单元格的完整 JavaScript 正则搜索仍需约 25–28 s，保留原有精确匹配语义；搜索在用户操作时扫描，不阻塞初始视图准备。完整自动列宽也保留全列扫描，未改成抽样。大量独立区域场景仍可能产生前端长任务，不能把加载成功解释成所有操作瞬时完成。

表格中每个条目为单轮观测，文件系统缓存未清空，部分控制/回归任务有重叠运行；不作多轮统计推断。结果证明这些真实样本已完成加载与正确性验证，不构成冷缓存、跨机器或任意输入的性能保证。
