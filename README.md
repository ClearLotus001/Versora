# Versora

[![CI](https://github.com/ClearLotus001/Versora/actions/workflows/ci-review-gates.yml/badge.svg)](https://github.com/ClearLotus001/Versora/actions/workflows/ci-review-gates.yml)
[![Latest release](https://img.shields.io/github/v/release/ClearLotus001/Versora?display_name=tag)](https://github.com/ClearLotus001/Versora/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](https://github.com/ClearLotus001/Versora/releases/latest)
[![License](https://img.shields.io/github/license/ClearLotus001/Versora)](./LICENSE)

[中文](./README.md) · [English](./README.en.md)

**看清每一次变化。** Versora 是一款面向 Windows 的开源文件差异审阅工具，可在同一工作台中比较文本、Excel 工作簿、Git 版本和 SVN 修订。

它既能直接比较两份本地文件，也能识别每一侧的版本控制来源，在不切换工具的情况下查看历史版本、工作副本改动和行级归属。

## 获取 Versora

前往 [GitHub Releases](https://github.com/ClearLotus001/Versora/releases/latest) 下载最新版 Windows 安装包。安装版支持：

- 中文与英文界面
- 应用内检查、下载和安装更新
- 可选的 TortoiseSVN 外部 Diff Viewer 接入

## 快速开始

安装并启动后，从首页选择一种工作方式：

| 入口 | 适用场景 | Versora 的行为 |
|---|---|---|
| **打开工作副本文件** | 审阅单个受版本控制的文件或本地文件 | 自动识别来源；比较仓库版本与工作副本，或直接打开本地内容 |
| **对比两份文件** | 比较任意两份本地文本或工作簿 | 分别识别左右来源；两份文件需具有相同扩展名 |
| **接入 TortoiseSVN** | 从 TortoiseSVN 直接打开差异 | 配置全部文件、仅文本或仅工作簿模式 |

进入差异视图后，可切换布局、搜索内容、跳转差异块；当文件来自 Git 或 SVN 时，还可以通过顶部版本选择器查看历史版本。

每次打开比较都会新增一个文件标签页。在标签栏中可切换或关闭比较；切回已打开的文件时，会恢复它的版本、搜索、布局、滚动位置和工作表状态，无需重新加载。点击 **新增比较** 或 **首页** 可继续打开文件，并保留已有标签。

## 功能概览

### 文本比较

- 统一、左右分栏和上下分栏三种布局
- 行级与字符级差异高亮
- 语法着色和空白字符显示
- 未变化区域折叠、全文搜索、行号跳转和差异导航
- 文本选择、复制和行范围操作
- Git/SVN 来源标识与行级归属信息

### Excel 工作簿比较

- 面向 `.xlsx`、`.xlsm`、`.xltx`、`.xltm` 的专用表格视图
- 识别工作表、行、列、单元格和公式变化
- 严格模式与内容模式：可选择保留或忽略纯空白差异
- 公式栏、冻结窗格、隐藏行列、工作表标签和差异区域导航
- 迷你地图与多种工作簿布局
- Rust 加速解析与差异计算
- 通过虚拟滚动和按需渲染流畅浏览大型差异

### Git、SVN 与本地文件

| 来源 | 默认比较 | 历史版本 | 行级归属 |
|---|---|---|---|
| Git 工作区文件 | 仓库版本 ↔ 当前工作区 | 文件提交、`HEAD`、工作区 | Git blame |
| SVN 工作副本 | 仓库修订 ↔ 工作副本 | 修订历史、工作副本 | SVN blame |
| 普通本地文件 | 直接使用所选本地内容 | 不提供 | 不显示 |

两份文件对比时，每一侧都会独立检测来源。例如，可以让 Git 历史版本与普通本地文件对比，或让两侧分别切换各自的版本。

> **安全边界：** Versora 的 Git 操作均为只读。应用不会执行 `checkout`、`add`、`commit` 或 `reset`，也不会修改仓库状态。

## 使用说明

### 审阅工作副本文件

1. 在首页选择 **打开工作副本文件**。
2. 选择 Git、SVN 或普通本地文件。
3. 等待 Versora 检测来源并准备默认比较。
4. 使用顶部版本选择器切换历史版本；普通本地文件不会显示版本选择器。

### 比较两份本地文件

1. 在首页选择 **对比两份文件**。
2. 拖入或选择基准文件与对比文件。
3. 确保两份文件的扩展名相同，且不是同一个文件。
4. 选择 **开始对比**。

如果某一侧属于 Git 或 SVN 工作副本，Versora 会保留该侧的历史版本切换能力。

### 接入 TortoiseSVN

在 Windows 安装版首页选择 **接入 TortoiseSVN**，再按需要选择全部文件、仅文本或仅工作簿模式。配置完成后，从 TortoiseSVN 发起的对应文件比较会直接在 Versora 中打开。

从 **Show log** 连续打开不同文件的差异时，Versora 会在同一窗口新增标签页，已有比较不会被覆盖。标签页保留到关闭该标签或退出程序。

## 支持范围与项目边界

| 项目 | 当前支持 |
|---|---|
| 操作系统 | Windows |
| 界面语言 | 简体中文、English |
| 文本 | 本地可读取的文本文件；双文件比较要求扩展名相同 |
| 工作簿 | OOXML 格式：`.xlsx`、`.xlsm`、`.xltx`、`.xltm` |
| 版本控制 | Git 工作区、SVN 工作副本与修订历史 |
| 外部集成 | TortoiseSVN Diff Viewer |

Versora 当前专注于**审阅变化**，暂不包含目录树比较、三方比较、可编辑合并、自动解决冲突或版本库写操作。

## 本地开发

### 环境要求

- Windows
- Node.js 24+
- npm
- Rust stable（工作簿解析与比较、完整验证和 Windows 安装包构建需要）

桌面工作簿使用 Rust 解析与比较，并通过磁盘索引按需读取数据。`npm run dev:app` 启动前需要可用的原生解析器；产物缺失时会尝试构建，构建失败会报告错误并停止启动。

### 启动开发环境

```bash
git clone https://github.com/ClearLotus001/Versora.git
cd Versora
npm ci
npm run dev:app
```

`dev:app` 会先检查或构建工作簿解析器，再启动 Vite、Electron 和 Electron 主进程的监听编译。

npm 12 需要先批准依赖的安装脚本；本项目已在 `package.json` 中批准 Electron 和 esbuild。如果依赖是在批准前安装的，启动时出现 `Electron failed to install correctly`，请运行 `npm rebuild electron esbuild`，然后重新运行 `npm run dev:app`。

### 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev:app` | 启动完整桌面开发环境 |
| `npm run verify:static` | 运行 ESLint、未使用导出检查和 TypeScript 检查 |
| `npm run test:workbook:unit` | 运行不依赖 Rust 产物的 Node 测试 |
| `npm run test:workbook:rust` | 构建原生产物并运行 Rust 集成测试 |
| `npm run test:e2e` | 运行 Playwright 端到端测试 |
| `npm run verify:ci` | 复现 CI 的静态检查、Rust 检查、测试与应用构建 |
| `npm run build:app` | 构建渲染进程和 Electron 主进程 |
| `npm run build:win` | 构建 Windows 安装包与更新资产 |

完整浏览器回归按需运行：可以执行 `npm run test:e2e`，或在 GitHub Actions 的 [Browser E2E 工作流](./.github/workflows/browser-e2e.yml)中手动触发。推送和 PR 的自动 CI 继续运行静态检查、工作簿单元测试、Rust 集成测试、性能检查和 Windows 打包检查。

## 架构

Versora 将“内容来自哪里”与“如何比较和渲染”分离：

```text
本地文件 ─┐
Git 对象  ─┼─> 来源物化 ─> DiffData ─> 文本/工作簿分析 ─> 查看器
SVN 修订  ─┤
外部 CLI  ─┘
```

主要技术栈：Electron、React、TypeScript、Vite、Tailwind CSS、Rust 和 Playwright。

```text
Versora/
├── electron/       # Electron 主进程、Git/SVN 来源、安装与更新
├── shared/         # 主进程与渲染进程共享契约
├── src/            # React 界面、文本与工作簿查看器
├── rust/           # 工作簿解析与差异计算
├── tests/          # 单元、契约与端到端测试
├── scripts/        # 构建、验证与发布脚本
└── docs/           # 架构与视觉语义文档
```

延伸阅读：

- [比较来源架构](./docs/comparison-sources.md)
- [工作簿视觉语义](./docs/workbook-visual-semantics.md)

## 参与贡献

Issue 与 Pull Request 均欢迎。提交变更前请：

1. 从 `main` 创建范围明确的分支。
2. 为行为变化补充或更新测试。
3. 至少运行 `npm run verify:static` 和与改动相关的测试。
4. 按 [Pull Request 模板](./.github/pull_request_template.md) 记录影响范围、验证证据和回滚方案。

## 发布

`package.json` 中的版本必须与 Git tag 一致。推送 `v*` 标签后，[Release 工作流](./.github/workflows/release.yml) 会运行静态检查、Node 测试、Rust 测试和应用构建，然后发布 Windows 安装包及自动更新资产。

```bash
npm version patch --no-git-tag-version
git add -A
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

## 许可证

Versora 基于 [MIT License](./LICENSE) 开源。
