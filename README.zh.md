# dsh-kanban — DeepSeek Harness 任务看板插件

[English](README.md) | 中文

DeepSeek Harness Web GUI 的热插拔任务看板插件，提供任务管理、拖拽排序、状态跟踪和持久化存储。

## 功能特性

- 📋 **看板视图** - 直观的多列看板布局（待规划/待办/进行中/评审中/已完成）
- 🖱️ **拖拽排序** - 支持任务在列之间拖拽移动
- 🤖 **自动任务** - 定时把待办任务作为后续对话轮次投递给 DSH AI 执行（`sessionController` 官方路径，新建独立会话/追加轮次两种模式），AI 通过原生 `kanban_*` 工具回写状态，完成进「评审中」由人工归档
- ☁️ **远端同步** - 飞书多维表格 / 企业微信文档（智能表格）双后端：手动导入导出、定时自动拉取、AI 完成时自动推回
- 🏷️ **优先级标签** - 低/中/高/紧急四个优先级
- 📅 **截止日期** - 为任务设置截止时间
- 🔍 **任务描述** - 为任务添加详细描述
- 💾 **持久化存储** - SQLite（WAL）本地存储

### 自动任务工作方式

1. 插件启动时注册六个原生模型工具（`kanban_list / claim / progress / comment / complete / fail`）和一段系统提示词工作流指引
2. 定时器触发时，调度器从「待办」列取第一个任务，按配置的**执行方式**投递给 AI：
   - **每个任务新建独立会话**（默认）：经 `sessionController.create()`（GUI 同款官方入口）为任务开一条新对话并自动挂到任务所属项目下；投递消息只含标题和描述。
   - **投递到现有会话**：通过 `agent.followup()` 把任务作为后续轮次追加到当前空闲的会话（都不空闲则选最新会话，排队执行）。
3. AI 在会话中执行任务，用 `kanban_*` 工具回报进度、记录结果
4. 事件驱动兑现（监听 `session/event`）：轮次干净结束 → 任务自动移入「评审中」（附 AI 结果摘要），人工评审后拖入「已完成」；AI 明确标记失败 → 保持进行中等重试；基础设施错误 → 自动回「待办」下个周期重试
5. 带**执行会话**的任务，在看板点击卡片可直接跳转对应对话

### 远端同步（飞书 / 企业微信）

- 「同步」弹窗中选择后端：**飞书多维表格**或**企业微信文档（智能表格）**，分别保存凭证配置
- 手动「导入 / 导出」+ 可选的**定时自动拉取**（间隔分钟数，0 关闭）：远端新增/修改的任务按记录 id 增量更新到看板（不覆盖看板侧状态流转）
- **完成时自动推回**：AI 完成任务工作（进入评审中）时自动把该任务推回远端表格
- 企业微信前置条件：企业管理后台创建自建应用（拿到 corpid + secret，应用需具备文档权限并配置可信 IP），智能表格文档需对该应用可访问；表格列按标题匹配（标题/描述/状态/优先级/负责人/截止日期/项目）
- 飞书前置条件：飞书开放平台自建应用 + 多维表格（appToken + tableId）

注意：没有任何活跃会话且模式为「投递到现有会话」时，任务保留在「待办」，下一个周期重试；「新建独立会话」模式不依赖已打开的会话。

## 快速开始

### 安装

```bash
# 从 GitHub 源码安装（推荐）
dsh plugin --profile web add github:15217814598/dsh-kanban

# 或从本地目录安装（开发模式）
dsh plugin --profile web add link:/path/to/dsh-kanban
```

> 要求 DeepSeek Harness ≥ 0.2.1-rc.3（使用 sessionController 投递、session/event 事件与原生工具注册）。

### 使用方法

1. 启动 DSH Web GUI
2. 在侧边栏或顶部导航找到"任务看板"入口
3. 点击"+"按钮或在输入框中输入任务标题创建新任务
4. 拖拽任务卡片在列之间移动
5. 点击任务卡片上的编辑按钮修改任务详情

## API 端点

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/dsh-kanban/tasks` | 获取所有任务 |
| GET | `/api/dsh-kanban/tasks/:id` | 获取单个任务 |
| POST | `/api/dsh-kanban/tasks` | 创建新任务 |
| PUT | `/api/dsh-kanban/tasks/:id` | 更新任务 |
| PATCH | `/api/dsh-kanban/tasks/:id/move` | 移动任务 |
| DELETE | `/api/dsh-kanban/tasks/:id` | 删除任务 |

### 请求示例

**创建任务**

```json
POST /api/dsh-kanban/tasks
{
  "title": "完成项目文档",
  "description": "编写 README 和 API 文档",
  "priority": "high",
  "tags": ["文档", "项目"],
  "dueDate": "2026-09-01"
}
```

**移动任务**

```json
PATCH /api/dsh-kanban/tasks/:id/move
{
  "status": "in-progress",
  "order": 0
}
```

## 配置

在 `cordis.patch.yml` 中：

```yaml
- insert:
    - id: kanban
      name: 'dsh-kanban'
      config:
        enabled: true
        maxTasks: 1000
        columns:
          - id: todo
            title: '待办'
            color: '#6b7280'
          - id: in-progress
            title: '进行中'
            color: '#3b82f6'
          - id: done
            title: '已完成'
            color: '#22c55e'
```

## 数据存储

- **数据库**: SQLite（`node:sqlite` DatabaseSync，零原生依赖），路径 `$DSH_HOME/dsh-kanban.db`（`DSH_HOME` 缺省为 `~/.dsh`，与 DSH 官方路径解析一致）
- **日志模式**: WAL + `synchronous=NORMAL`，插件卸载时 checkpoint 并关闭
- **配置存储**: 自动任务与飞书配置保存在同库 `settings` 表，重启后自动加载
- **旧数据迁移**: 首次启动自动导入 `dsh-kanban.json`（及 auto-task / feishu 旧配置文件），原文件改名为 `.bak` 保留

## 开发

```bash
# 安装依赖
npm install

# 构建（服务端 tsc + 客户端 esbuild）
npm run build

# 分步构建
npm run build:server
npm run build:client
```

## 许可证

MIT
