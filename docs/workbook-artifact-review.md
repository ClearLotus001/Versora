# 工作簿生产管线审查与清理

审查日期：2026-10-13。范围为 Rust 准备、Electron 来源与生命周期、IPC 合同、Renderer provider、三种 Canvas 布局及相关操作。

## 审查方法

从实际桌面入口追踪可达调用，分别核对本地文件、独立 Git/SVN 历史来源及工作副本。工作簿进入 artifact 后提前返回；文本来源进入独立文本分析服务。测试对某个模块有引用，不等于该模块仍有生产用途，因此额外检查了仅被旧测试调用的实现。

保留 Rust 的解析、规范化、patience/LCS 行对齐和精确比较职责；本轮没有替换这些算法。

## 清理的开发残留

| 残留 | 清理依据和处理 |
| --- | --- |
| 旧 workbook worker 与异步 metadata worker | 已无生产调用；删除 worker、client、请求协议及只测试废弃 worker 的用例 |
| 全量 workbook snapshot/DTO、JSON/JSONL 归一化、双模式 fallback | 桌面工作簿入口已统一提前进入 artifact，旧分支不可达；删除 Electron 旧桥接与准备逻辑 |
| 重复 JS 区域投影和 gzip/coverage 缓存 | 仅服务旧 DTO 链；删除 `workbookProjection.ts`、相关缓存和孤立辅助函数 |
| Renderer 多路 sections/delta/region 模型和原始工作簿字节解析 | 实际桌面和浏览器工作簿均使用显式 provider；清理旧分支，小型 XML/ZIP 对照解析器移到 `tests/fixtures` |
| 文本 payload 的 bytes/metadata 和解析指标 | 构造时分别恒为 null、0；内部文本模型只保留内容、读取耗时和字节长度 |
| 区域分页 IPC、搜索 hiddenColumns 请求选项 | 无真实生产消费者；导航使用 descriptor 紧凑索引，原隐藏列搜索语义继续保留 |
| 孤立 snapshot peek 和临时文件辅助接口 | 无生产或内部调用；删除实现及只验证该孤立入口的用例 |
| 开发启动中的 JS fallback 策略和文案 | 工作簿已经要求原生解析器；缺失时构建，失败明确停止，并同步更新中英文 README |
| `.sst.bin/.sst.idx` | 只用于解析共享字符串；关闭句柄后删除，成功和解析错误路径均覆盖 |

旧实现的测试已改为真实 artifact、实际 preload 合同或紧凑索引验证。仍有用途的独立语义对照测试保留。

## 修复的功能缺口

| 触发条件 | 修复行为 |
| --- | --- |
| 工作簿换边进入纯文本 swap 路径 | 原生比较重新准备正确方向；浏览器 fixture 重建反向 artifact，数据与版本标签一致 |
| IPC 把首次来源路径覆盖到换边结果 | 使用不可变的来源与输入快照映射，按当前结果每侧路径投影，连续换边保持正确方向 |
| 双文件 Git/SVN 已选历史版本后换边 | 原生操作整体交换来源 context 与已选版本，候选准备成功时提交来源与 artifact；失败保留旧结果 |
| 本地文件或 SVN 历史读取失败被包装为文件正文 | 读取失败直接进入加载错误流程，不缓存错误正文，不提交失败的来源候选；不存在的一侧仍表示真实新增或删除 |
| 相同来源的只读请求加入候选准备 | 共享计算但保留来源事务的提交检查，不能跳过取消、关闭或来源过期判断 |
| 多个 SVN 标签排队准备、各自 peg 版本不同 | 调度器捕获调用者异步上下文，排队后仍使用该请求对应的来源与版本 |
| 首张工作表为空，或使用仅新增/仅删除等筛选 | 显式识别 provider，按对应结构变化类型筛选，避免保留不匹配的工作表 |
| 仅一侧存在跨视口合并，锚点滚动至视口之外 | 补齐锚点所在对齐行的双侧窗口，生成准确差异样式 |
| 搜索遇读取失败、worker 异常或超时 | 非取消错误进入现有错误提示；取消和过期结果继续忽略 |
| 关闭标签或替换工作簿版本 | 释放 renderer provider、窗口缓存及 fixture 资源，过期响应不能恢复缓存 |
| 工作簿之后的文本加载失败或请求过期 | 保留当前工作簿引用，普通、缓存和预计算文本都在成功提交之后清空引用 |
| 自动列宽读取大量来源页 | 与窗口读取共用受控并发；仍扫描完整列并保留原测量规则 |

## 必须保留的职责

独立 Rust CLI 的文本、metadata、JSON/JSONL 输出属于已有可调用接口。XLS/XLSB 的 calamine 是真实格式适配。重命名候选中的顺序距离用于相同分数时的确定性排序，删除会改变结果。这些均不能仅因为文件或变量名包含 legacy/fallback 就直接移除。

多来源快照流写入、strict/content 两套比较索引、受控临时目录、读取 drain、取消、失败保留旧可用结果及 JavaScript 正则搜索 worker，都有实际生产消费者。

小型浏览器 fixture 和 JS 比较纯函数服务于测试及独立语义对照。文本分析的现有按模式载荷合同服务于文本 IPC、紧凑传输和换边；它不再包含工作簿 DTO。

## 验证入口与证据

本轮最终代码的验证结果：

| 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| Rust parser/launcher、fmt、Clippy `--all-targets -- -D warnings` | parser 11 项、launcher 1 项通过；格式和严格检查通过，release 构建通过 | [release 构建日志](../output/stress/artifact-review-rust-build.log) |
| `npm run verify:static` | ESLint、未使用 export 检查、renderer/electron/scripts/tests 四套类型检查通过 | [静态检查日志](../output/stress/artifact-review-static.log) |
| `npm run test:workbook:unit` | 190 个测试文件、802 项全部通过，0 失败、0 跳过；含真实 preload/IPC、本地与独立 Git/SVN 历史、错误回滚及队列上下文 | [单元测试日志](../output/stress/artifact-review-unit.log) |
| `npm run test:workbook:rust` | 5 个测试文件、30 项全部通过，0 失败、0 跳过；含原生换边、候选提交、只读共享、取消和跨会话 SVN peg | [Rust 集成测试日志](../output/stress/artifact-review-rust-integration.log) |
| `npm run build:app` | Renderer 与 Electron 最终构建通过 | [构建日志](../output/stress/artifact-review-build.log) |
| 工作簿、筛选/换边、搜索和比较标签浏览器回归 | 48 项全部通过；含所选历史版本原生换边合同、冻结列、快速滚动、稀疏行、搜索故障提示和标签关闭 | [界面回归日志](../output/stress/artifact-review-e2e.log) |
| 真实 Electron、Rust 小样本 | 251 × 8，每侧 2008 个非空单元格；3 个变化、H251 两侧真实值、尾部搜索导航、strict/content 和三布局均通过 | [桌面报告](../output/stress/artifact-review-ui-small.json)、[日志](../output/stress/artifact-review-ui-small.log) |
| 真实 Electron 连续原生换边 | H251 两侧值与完整路径/表头一次交换、二次恢复；同会话、每次新 artifact，无渲染错误 | [换边报告](../output/stress/artifact-review-swap-result.json)、[日志](../output/stress/artifact-review-swap-check.log) |
| `git diff --check` | 通过 | 本地执行结果 |

浏览器用例已适配按窗口异步读取的就绪状态，关闭按钮使用可访问名称定位；正文配色断言遵循当前中性正文主题，表头版本色、差异、选择和边界断言继续保留。原来仅检验旧 helper 名称的架构断言也已改为实际 provider 搜索和取消职责。

原生 IPC 回归还覆盖原始输入删除后使用快照、损坏 XML 时保留旧 artifact、独立仓库历史随文件移动、工作副本 special ID 重绑定，以及成功/失败后排队请求保留各自来源上下文。真实桌面验证确认 `nativeBridge/nativeSwapBridge` 存在、`e2eBridge` 关闭；浏览器 mock 合同不替代这项验证。

最终 Rust parser SHA256：`287B9C029617A8E62781370AEDFD553479CA85C885FE19FE931F3BC23FCD9E1D`。日志与桌面报告位于本地忽略目录。

## 性能边界

此前完整 100000 × 200 压力验证的输入、全量正确性和观测耗时保留在 [压力验证记录](workbook-artifact-validation.md)。本轮新增审查关注功能边界与实际不可达代码清理，不能把前一轮压力耗时解释为对所有新代码的重新测量。

XLS/XLSB 解析库内部全量 Range 的内存边界仍存在。超大表的完整正则搜索和自动列宽仍需要全量扫描；大量独立区域的全局索引也仍随规模增长。这些是已知性能边界，不能用兼容回退或截断数据掩盖。

上述测试与边界描述对应本次审查时的版本。随后对搜索、列宽、源行读取和二进制格式的优化及新测量见[全量扫描优化验证](workbook-full-scan-optimization.md)；XLSB 已消除工作表 dense Range，但库内共享字符串表边界仍存在。
