# XLS/XLSB 读取库流式架构

XLS 全书 Range 缓存与 XLSB 共享字符串表的流式改造已实施。生产 artifact 准备使用固定版本 calamine 的正式扩展：XLS 通过 CFB 可寻址流逐表输出事件，XLSB 将共享字符串直接交给磁盘存储。Rust 继续负责解码、规范化、patience/LCS 对齐和精确比较，Electron/前端消费现有不可变 artifact，协议与比较算法未改变。

本文说明实现和语义边界。最终前后压力对比、独立源校验与回归结果见 [XLS/XLSB 流式读取验证](binary-workbook-streaming-validation.md)。文末的 d12a41… 数据是实施前基线，不是新实现结果。

## 依赖与职责

`rust/vendor/calamine` 固定 calamine 0.31.0，upstream revision 为 `348325728e671db2604a6e96beacf507edaef465`，保留 MIT 许可证；Cargo 使用 repository path 与精确版本。XLS 容器读取使用固定的 `cfb = 0.15.0`。来源、API 和升级验证约束见 [依赖维护记录](../rust/vendor/calamine/VERSORA.md)。

依赖扩展负责 BIFF/BIFF12 解释及源格式语义，应用层负责存储、格式化、排序和 canonical artifact。新旧接口复用字符串、值、日期、格式与公式解码函数，没有在应用层另写一套 BIFF 解释器。普通 Reader/Range API 保留给库使用者、现有 Text/DiffJson/DiffJsonBoth/DiffJsonStream CLI 模式和测试 oracle；桌面使用的 artifact ingest 只调用新流式接口，不设置 Range 回退。本次有界读取的范围是 artifact/桌面准备，不能扩展为全部 CLI 模式。

依赖升级需单独验证，避免同时改变日期、空字符串、公式或合并单元格语义。公开流式接口可向上游提交；升级到没有相同接口的 upstream 版本不能替代本地扩展。

## 原内存增长原因

两项缓存发生在原读取库初始化期间，应用在构造完成后释放对象已经错过峰值。

| 格式 | calamine 0.31.0 原实现 | 本次 artifact 实现 |
| --- | --- | --- |
| XLSB | SST 解码为 Vec<String>；cell reader 借用整张表的文本 | SST 逐条写入注入的 SharedStrings；cell 返回拥有的值或 SST ID |
| XLS | 完整读取 Workbook/Book payload，构造时解析所有 sheet 的值与公式 Range | CFB 可寻址流读取 globals 与单个 sheet，输出事件，不创建全书 Range |

源码依据：[XLSB 原 SST 与初始化](https://github.com/tafia/calamine/blob/v0.31.0/src/xlsb/mod.rs#L153)、[文本借用](https://github.com/tafia/calamine/blob/v0.31.0/src/xlsb/cells_reader.rs#L23)、[XLS 全书缓存](https://github.com/tafia/calamine/blob/v0.31.0/src/xls.rs#L164)、[完整 CFB stream 与扇区缓存](https://github.com/tafia/calamine/blob/v0.31.0/src/cfb.rs#L78)。

原 XLS 的 CFB/Workbook 字节在初始化返回前释放；原始 payload、全书 Range 与单表副本并非始终同时驻留。上一轮提前释放应用层公式 Range 副本减少了叠加，但没有消除初始化峰值、完整 Workbook payload 或单表密集矩形。

调查过的 calamine 0.36.1（revision `0a24c2a9f1e38c0932c1299e633270dc730db505`）和调查时 master 仍没有关闭这些缓存的公开接口。rxls 0.1.4 的共享字符串和单元格也采用全量模型，且公式/日期行为不等同，不能直接替换并满足本次目标。

## 共用磁盘共享字符串存储

依赖新增 `calamine::stream::SharedStrings`，提供 fallible push(String)、get(id) -> Option<String>、len() 和 is_empty()。调用方取得拥有的字符串，不能保留对可淘汰缓存的借用。解码器决定 ID、空项和源格式语义，存储实现决定缓冲、落盘及清理。

`rust/src/workbook/artifact/strings.rs` 中的 DiskStrings 由 OpenXML、XLS 和 XLSB 共用。UTF-8 数据与每项 12 字节的 offset/length 索引都写入会话目录；没有随 SST 数量增长的常驻 offset 列表。append 阶段完成后 seal 刷出写缓冲，读取阶段使用以下预算：

| 缓存 | 页大小/条数 | 预算 |
| --- | --- | --- |
| 文本数据页 | 16 KiB × 256 页 | 4 MiB |
| offset/length 索引页 | 16 KiB × 1024 页 | 16 MiB |
| 已解析文本 | 最多 4096 项 | 16 MiB 字符串容量 |

固定页数约束底层字节分配；索引持续使用页预读，1024 页预算可容纳百万项的 12 字节索引，但更大 SST 也不继续扩充缓存。文本缓存使用 FIFO，先淘汰再复制。单条超过文本缓存预算的字符串仍完整返回，但不缓存。

数据页按读取位置决定预读：命中缓存时直接取字节；未命中且在前次读取终点之后一页范围内的短读取预读 16 KiB 页；跳跃、回退或未缓存且至少一页的读取直接读取当前请求的剩余字节。随机 128 字节文本因而无需为每次 miss 读取整个 16 KiB 页；邻近顺序 ID 仍复用页预读。位置判断只选择 I/O 策略，不省略任何字符串字节。

底层 `read_exact_at` 在 Unix 使用 `FileExt::read_at`，Windows 使用 `FileExt::seek_read`，循环补全短读，重试 Interrupted，零字节读报 UnexpectedEof，其余错误原样传播。页缓存、文本缓存以外还有写缓冲、缓存元数据、当前返回的字符串及调用方当前行，这些预算不是进程内存上限。

磁盘索引或文本截断、非法 extent、无效 UTF-8、读取/写入失败都返回错误。extent 在分配文本前验证，存储损坏不能伪装成空字符串或缺失源值。正常完成或错误退出时先关闭文件，再通过 RAII 删除 .sst.bin/.sst.idx。

## XLSB：注入 SST 与 cell ID

`XlsbStream::new(reader, &mut strings)` 要求空存储，将现有 SST 解码器的每一项直接交给 SharedStrings，内部普通 Xlsb 的文本 Vec 保持为空。样式与 workbook 元数据继续使用共用解码器。

`worksheet_cells_reader(name)` 返回 XlsbStreamCellsReader，提供 next_cell()、next_formula() 和声明的 dimensions()。值为 `XlsbCellValue::Value(Data)` 或 `SharedStringId(usize)`，ID 保留原顺序，包括指向空文本的 ID。

生产 artifact ingest 保留三个顺序 pass：观察真实值范围、写稀疏公式 scratch、逐行解析值并写 canonical rows。bounds pass 只读取类型与坐标，不读取 SST 文本；共享空字符串仍是值 cell，参与范围。DIMENSIONS 不用于分配密集矩形。值和公式仍使用同一套解码逻辑，cached value、公式范围与既有规范化行为不改变。

非法 SST ID 从原来可能越界 panic 改为受控解析错误。SST 数量不足、短记录和存储错误同样失败。只有实际 ZIP FileNotFound 才表示可选 SST/styles 缺失，其余容器错误不能当成可选成员不存在。

ZIP 在 member EOF 才完成 CRC 检查。SST、styles、workbook 和 worksheet 值/公式读取到逻辑结束时，通过固定 8 KiB 缓冲继续读到 member EOF，传播 CRC、解压及截断错误，不分配完整 member。调用方提前放弃一个 reader 并不表示完成验证；生产 pass 会消费到完成或报错。

## XLS：可寻址容器与工作表事件

`XlsStream::new` / `new_with_options` 使用 `cfb::CompoundFile` 提供的 Workbook 或 Book Read + Seek stream。CFB 容器在 stream 生命周期内保持有效，支持 mini-stream、regular stream 和 CFB v3/v4。原 0.31 CFB 实现拒绝的有效 v4 容器由成熟容器库支持，这是明确增加的接受范围。

record cursor 使用 64 KiB BufReader，只持有当前 BIFF 记录 payload；SST/CONTINUE 按需消费，不收集全部 CONTINUE。globals 保存 sheet 名称、顺序、offset、样式、日期系统和公式所需名称，SST 写入共用存储；不保留完整 Workbook payload 或所有 sheet 的 Range。必要 FAT、目录、样式和名称仍随文件结构增长。

`sheets_metadata()` / `metadata()` 返回元数据，`read_sheet(index, strings, sink)` 按 BoundSheet offset 逐表读取。XlsSheetSink 的 value、formula、merge 接收原记录顺序中的独立事件。复用 codepage、UTF-16、富文本、NUMBER/RK、公式、1900/1904 日期和 merge 解码。cached string 的后续 STRING 与前面的公式位置关联。

重复 SST 记录原本替换当前 SST；流式接口使用新追加段的起点与长度保持该行为，不重置公共 append-only 存储。XLS 的空 LabelSst、越界 LabelSst 和 BIFF BLANK 沿用原来忽略语义；LABEL/STRING 等实际输出的空值事件仍可覆盖先前值。合法 ID 在磁盘存储中缺失是存储错误，不能按越界源 ID 忽略。

### 有界外排与逐行输出

旧 `Range::from_sparse` 接受任意源记录顺序，重复坐标按最后写入覆盖。生产 sink 将 `(row, column, channel, sourceOrdinal, text)` 写入有界外排器，不假定源记录已排序。

排序块最多 65536 个事件，文本容量预算 16 MiB；单条超预算文本独立处理，完整保留。归并 fan-in 为 16，输入缓冲每个 64 KiB、输出缓冲 1 MiB。增量分层归并限制每层运行文件数，没有全部 cell offset 或全部历史 run 的常驻列表。值与公式 channel 分别按坐标、ordinal 合并，最后事件获胜，空值覆盖事件不提前删除。

bounds 在源 value 事件进入外排前观察，保持旧 Range 范围语义。公式仅写入值 bounds 内，不扩展范围。排序后的当前行沿用 format_cell、normalize_field 与 RowWriter；去掉真正尾部值和公式均为空的 cell，保留范围内空行与原行号。sheet 顺序、merge 元数据、raw line、strict/content signature、数值/日期/错误显示与公式前导 = 都沿用现有合同。

XLS 不支持的公式仍输出既有 Unrecognised formula ... 文本，XLSB 公式解析失败仍报错。二进制格式的隐藏列仍为明确空列表，XLSB merge 元数据沿用既有合同；这些未新增元数据能力。排序 run 与公式 scratch 在完成/错误时关闭后删除。

## 内存、磁盘和生命周期边界

本次消除了按全部 SST 文本、所有 sheet 密集矩形与完整 Workbook payload 增长的常驻缓存。工作集仍包括 CFB/ZIP 元数据、样式/公式名称、sheet/merge 元数据、当前字符串/行、artifact 行引用及 Rust 对齐索引；排序层级也随 run 数增长。不能宣称整个 native 或 Electron 进程为恒定内存。

落盘增加临时空间与 I/O。SST 数据/索引、排序 run、最终 artifact 的用量和吞吐需结合输入分布报告，随机 SST ID 与高重复/顺序 ID 的代价不同。内存下降不保证每个输入同时提速，正式结果见 [验证报告](binary-workbook-streaming-validation.md)。

scratch 使用现有 managed 会话目录，不在源工作簿旁生成文件。正常完成、解码失败和写入失败通过 RAII 关闭/删除；强制终止进程不会执行 Rust Drop，取消由 Electron 等待实际进程退出和句柄关闭后清理 session lease。最终 artifact 继续沿用现有会话生命周期。

磁盘不足或写入失败必须明确报错，完整准备结束前不会发布 complete 清单，也不能发布截断结果。

## 验证方法

本轮 before 使用从 Cargo release deps 恢复的实施前冻结解析器，完整 SHA-256 与历史 `d12a41…` 基线相同，不使用源码重建基线。对同一个合法输入比较全部 artifact .bin/.idx 字节与清单语义，仅排除 artifact 目录和耗时字段。另用独立源模型逐坐标校验两侧值、公式、行索引、sheet 顺序/范围和 EOF，避免共用解码器的旧 Range oracle 成为唯一正确性依据。

| 维度 | 覆盖目标 |
| --- | --- |
| XLSB 文本 | 唯一/重复 SST、百万顺序/置换 ID、Unicode/空串、非法 ID、短/缺失/截断 SST、ZIP CRC 损坏 |
| XLS | 单表/多表、乱序/重复坐标、空覆盖、CONTINUE 的字符/富文本边界、BIFF5 codepage、缓存公式类型、日期系统 |
| 容器 | Workbook/Book、mini/regular stream、CFB v3/v4、ZIP 错误传播；原不支持/加密错误 |
| 资源 | Windows kernel peak working set、20 ms private bytes 采样、完整准备耗时、磁盘 scratch 和正常清理 |
| 存储读取 | 页内/跨页、跳跃/回退、顺序/大块读取、尾部短页、逻辑范围和实际文件截断；各策略返回相同字节 |
| 桌面 | Rust → artifact → IPC → 显示、值/公式、strict/content、搜索/导航、自动列宽、换边/筛选/关闭的相关回归 |

`streaming_boundaries.xls` 包含故意构造的乱序与重复生产者事件，用于旧结果语义回归；不将它当作合法高压性能样本。对应独立 .expected.json 由冻结解析器与源记录逐项核实。XLSB 置换夹具与压力生成器使每个声明的 SST 项实际被引用，避免靠大量未使用文本制造虚假的内存对比。

XLS 单 sheet 上限为 65536 行 × 256 列，10 万行压力按多表组织；XLSB 可直接使用 100000 × 200。数字大表和文本 SST 样本分别验证，不能互相替代。实际完成的用例、计数和数据见 [验证报告](binary-workbook-streaming-validation.md)。

## 实施前冻结基线

以下五组使用实施前生产 release 解析器 `d12a41c3f68cce6afcb6cafb7d3de103189c1fae236b92c6217bdffe6b8feaad`。同一个输入作为两侧进行真实 artifact 准备，Windows kernel 记录 peak working set，private bytes 每 20 ms 采样，未清空 OS 文件缓存。表中不同文本分布不是新旧实现的对比。

XLSB 每组为单侧 10000 × 100，共 1000000 cells；两个角点保留数值公式，其余 999998 个 cell 引用 SST。每条 SST 文本为 128 个 ASCII 字符，所有 SST 项唯一且至少被引用一次。每个 XLS sheet 同样为 10000 × 100，表间数值不同；两端公式保留 xlwt 的空 cached value。

| 基线输入 | 源文件 | 峰值工作集 | 采样峰值 private bytes | 准备耗时 |
| --- | ---: | ---: | ---: | ---: |
| XLSB：1 条 SST，重复引用 | 0.348 MiB | 18.023 MiB | 10.465 MiB | 3.192 s |
| XLSB：100000 条 SST | 5.811 MiB | 57.918 MiB | 51.164 MiB | 2.826 s |
| XLSB：999998 条 SST，全部不同 | 10.509 MiB | 422.820 MiB | 432.469 MiB | 2.907 s |
| XLS：1 张 sheet，共 1000000 cells/侧 | 6.060 MiB | 99.645 MiB | 91.148 MiB | 1.009 s |
| XLS：4 张 sheet，共 4000000 cells/侧 | 24.227 MiB | 292.680 MiB | 285.965 MiB | 3.868 s |

五组独立源 oracle 共验证两侧 16000000 cells 的坐标、值、公式、行索引、sheet 顺序/范围、EOF、strict/content 零变化和公式 scratch 清理。三组文本 XLSB 最终 artifact 都约 268.402 MiB，重复字符串未使源单元格省略。native 峰值包含解码、分配器和 artifact/对齐结构，不能全部归为 SST 原始文本。

这些数据确认原实现的唯一 SST 数量和 XLS sheet 数量是内存增长维度；本机基线没有失败，不代表所有更大文件或低内存机器均可完成。以上数字保留自上一轮基线报告，历史原始目录为 `output/stress/binary-cache-baseline`；该目录的原始日志与 artifact 目前未保留在工作区。冻结解析器已从 `rust/target/release/deps` 恢复到 `.tmp-binary-streaming/recovered/parser-d12-recovered.exe`，完整 SHA-256 与上文历史基线完全一致。[恢复来源记录](../.tmp-binary-streaming/recovered/parser-d12-recovered.provenance.json)明确标记 `reconstructed: false`；本轮同输入前后测量使用该原始二进制。新生成输入的哈希、最终解析器 SHA 和本轮结果见 [验证报告](binary-workbook-streaming-validation.md)。

## 可复现工具

- scripts/generate-binary-workbook-stress.py：XLS --sheets；XLSB --shared-strings / --string-length / --shared-string-order=sequential|permuted；--expected-source 保存紧凑源模型。
- scripts/benchmark-binary-workbook-memory.py：--current 测单实现，--before / --after 比较同输入两个实现的全部 .bin/.idx 和清单语义。测量与源校验分离。
- scripts/verify-binary-workbook-source.py：--artifact / --expected-source 独立校验数字、顺序/置换 SST、多表 XLS 和边界夹具。
- scripts/generate-binary-workbook-edge-fixtures.py：重建用于记录语义回归的二进制边界夹具。

XLS 生成器的 xlwt==1.3.0 仅用于测试，不是生产依赖。示例置换 SST 输入及前后比较：

~~~powershell
python scripts/generate-binary-workbook-stress.py --format xlsb --rows 10000 --columns 100 --shared-strings 999998 --string-length 128 --shared-string-order permuted --output .tmp-binary-streaming/xlsb-permuted.xlsb --expected-source .tmp-binary-streaming/xlsb-permuted.source.json
python scripts/benchmark-binary-workbook-memory.py --before .tmp-binary-streaming/recovered/parser-d12-recovered.exe --after .tmp-binary-streaming/parser-after-tuned.exe --source .tmp-binary-streaming/xlsb-permuted.xlsb --output .tmp-binary-streaming/final/xlsb-permuted
python scripts/verify-binary-workbook-source.py --artifact .tmp-binary-streaming/final/xlsb-permuted/after --expected-source .tmp-binary-streaming/xlsb-permuted.source.json
~~~

上一轮搜索、精确列宽、源行 Reader 与 worksheet 读取优化的历史数据见 [工作簿全量扫描优化与验证](workbook-full-scan-optimization.md)。
