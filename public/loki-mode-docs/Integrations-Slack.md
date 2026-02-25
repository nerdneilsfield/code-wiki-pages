# Integrations-Slack 模块文档

## 1. 概述

### 1.1 模块功能与定位

Integrations-Slack 模块提供了与 Slack 平台的集成功能，允许系统通过 Slack 进行双向通信。该模块的核心组件是 `SlackAdapter`，它负责将内部系统事件和状态同步到 Slack，并从 Slack 接收用户输入和交互事件。

主要功能包括：
- 从 Slack 线程导入消息作为项目需求文档
- 将系统状态更新同步到 Slack 频道
- 在 Slack 中发布评论和通知
- 处理子任务创建（以格式化列表形式展示）
- 接收并验证 Slack Webhook 事件
- 处理交互式消息和按钮点击

### 1.2 设计理念

该模块采用适配器模式，通过继承 `IntegrationAdapter` 抽象基类来实现标准的集成接口。这种设计使得系统可以轻松地添加新的第三方集成，同时保持统一的接口和行为。模块强调安全性，所有来自 Slack 的请求都会经过签名验证，确保通信的真实性和完整性。

## 2. 架构与组件关系

### 2.1 类层次结构

```mermaid
classDiagram
    class EventEmitter {
        <<nodejs>>
        +on()
        +emit()
    }
    
    class IntegrationAdapter {
        <<abstract>>
        #name: string
        #maxRetries: number
        #baseDelay: number
        #maxDelay: number
        +importProject(externalId)*
        +syncStatus(projectId, status, details)*
        +postComment(externalId, content)*
        +createSubtasks(externalId, tasks)*
        +getWebhookHandler()*
        +withRetry(operation, fn)
    }
    
    class SlackAdapter {
        -_token: string
        -_channel: string
        -_signingSecret: string
        -_client: WebClient
        +constructor(options)
        -_getClient()
        +importProject(externalId)
        +syncStatus(projectId, status, details)
        +postComment(externalId, content)
        +createSubtasks(externalId, tasks)
        +getWebhookHandler()
        -_verifySignature(signingSecret, timestamp, body, signature)
    }
    
    EventEmitter <|-- IntegrationAdapter
    IntegrationAdapter <|-- SlackAdapter
```

### 2.2 主要组件说明

#### SlackAdapter

`SlackAdapter` 是该模块的核心类，负责所有与 Slack 平台的交互。它继承自 `IntegrationAdapter`，实现了标准的集成方法，并添加了 Slack 特定的功能。

## 3. 核心功能详细说明

### 3.1 初始化与配置

**构造函数签名：**
```javascript
constructor(options)
```

**参数说明：**
- `options.token`: Slack 机器人令牌，也可通过环境变量 `LOKI_SLACK_BOT_TOKEN` 设置
- `options.channel`: 默认 Slack 频道，也可通过环境变量 `LOKI_SLACK_CHANNEL` 设置
- `options.signingSecret`: Slack 签名密钥，用于验证请求，也可通过环境变量 `LOKI_SLACK_SIGNING_SECRET` 设置

**工作原理：**
构造函数初始化适配器的基本配置，并设置必要的认证信息。它不会立即创建 Slack 客户端连接，而是采用懒加载策略，在首次需要时才建立连接。

### 3.2 项目导入功能

**方法签名：**
```javascript
async importProject(externalId)
```

**功能说明：**
从指定的 Slack 频道或线程导入消息历史，并将其转换为项目需求文档格式。

**参数：**
- `externalId`: Slack 频道或线程的标识符

**返回值：**
```javascript
{
  title: 'Slack Import: ' + externalId,
  content: messages,  // 合并后的消息文本
  source: 'slack'
}
```

**工作流程：**
1. 获取或创建 Slack 客户端
2. 使用 `conversations.history` API 获取最近 50 条消息
3. 将消息文本合并为一个内容字符串
4. 返回标准化的项目导入对象

### 3.3 状态同步功能

**方法签名：**
```javascript
async syncStatus(projectId, status, details)
```

**功能说明：**
将系统中的项目状态同步更新到 Slack 频道，使用富文本块格式展示。

**参数：**
- `projectId`: 内部项目标识符
- `status`: 当前状态值（如 REASON, ACT, REFLECT, VERIFY, DONE）
- `details`: 额外的状态详情对象

**工作流程：**
1. 获取或创建 Slack 客户端
2. 使用 `blocks.buildStatusBlocks` 构建格式化的 Slack 消息块
3. 将消息发布到配置的 Slack 频道
4. 同时提供纯文本版本作为通知的回退内容

### 3.4 评论发布功能

**方法签名：**
```javascript
async postComment(externalId, content)
```

**功能说明：**
在指定的 Slack 频道或线程中发布评论内容。

**参数：**
- `externalId`: 目标 Slack 频道或线程标识符
- `content`: 要发布的评论文本

**工作流程：**
1. 获取或创建 Slack 客户端
2. 直接使用 `chat.postMessage` API 发布文本消息

### 3.5 子任务创建功能

**方法签名：**
```javascript
async createSubtasks(externalId, tasks)
```

**功能说明：**
由于 Slack 没有原生的子任务概念，此方法将任务列表格式化为有序列表并发布。

**参数：**
- `externalId`: 目标 Slack 频道或线程标识符
- `tasks`: 任务数组，每个任务包含 `title` 属性

**返回值：**
```javascript
[
  { id: task.title, status: 'posted' },
  // ... 更多任务
]
```

**工作流程：**
1. 获取或创建 Slack 客户端
2. 将任务数组格式化为有序列表文本
3. 发布到指定的 Slack 频道或线程
4. 返回任务发布状态数组

### 3.6 Webhook 处理功能

**方法签名：**
```javascript
getWebhookHandler()
```

**功能说明：**
返回一个 HTTP 请求处理函数，用于接收和处理来自 Slack 的 Webhook 事件。

**返回值：**
一个函数 `(req, res) => void`，可作为 Express 或 Node.js HTTP 服务器的请求处理器。

**工作流程：**
1. 检查签名密钥配置，未配置则拒绝请求（401）
2. 收集请求主体，限制最大为 1MB
3. 使用 Slack 签名验证请求的真实性
4. 解析 JSON 有效载荷
5. 根据消息类型进行不同处理：
   - `url_verification`: 响应验证挑战
   - `interactive_message` 或 `block_actions`: 触发 'interaction' 事件
   - `event_callback`: 触发 'event' 事件
6. 发送适当的 HTTP 响应

### 3.7 客户端获取与懒加载

**方法签名：**
```javascript
_getClient()
```

**功能说明：**
私有方法，负责懒加载 Slack Web API 客户端。

**返回值：**
配置好的 Slack `WebClient` 实例。

**异常：**
如果 `@slack/web-api` 包未安装，会抛出明确的错误提示用户安装。

## 4. 集成与依赖关系

### 4.1 内部依赖

- **IntegrationAdapter**: 提供基础的集成接口和重试机制，详情请参考 [Integrations 模块文档](Integrations.md)

### 4.2 外部依赖

- **@slack/web-api**: Slack 官方 Node.js SDK，用于与 Slack API 交互（可选依赖，需要手动安装）
- **./blocks**: 本地模块，提供 Slack 消息块构建功能
- **./webhook-handler**: 本地模块，提供 Slack 签名验证功能

### 4.3 与系统其他部分的交互

```mermaid
sequenceDiagram
    participant System as 系统内部
    participant SlackAdapter as SlackAdapter
    participant Slack as Slack API
    participant User as Slack 用户
    
    System->>SlackAdapter: new SlackAdapter(options)
    System->>SlackAdapter: importProject(channelId)
    SlackAdapter->>Slack: conversations.history()
    Slack-->>SlackAdapter: 消息列表
    SlackAdapter-->>System: 格式化的项目内容
    
    System->>SlackAdapter: syncStatus(projectId, status, details)
    SlackAdapter->>Slack: chat.postMessage(blocks)
    Slack-->>User: 显示状态更新
    
    User->>Slack: 交互操作
    Slack->>SlackAdapter: Webhook 请求
    SlackAdapter->>SlackAdapter: 验证签名
    SlackAdapter->>System: 发出 'interaction' 或 'event'
```

## 5. 使用示例

### 5.1 基本初始化

```javascript
const { SlackAdapter } = require('./src/integrations/slack/adapter');

// 使用环境变量配置
const slackAdapter = new SlackAdapter();

// 或使用显式配置
const slackAdapter = new SlackAdapter({
  token: 'xoxb-1234567890-abcdefghijklmnopqrstuvwxyz',
  channel: '#general',
  signingSecret: 'slack-signing-secret-123456'
});
```

### 5.2 导入项目

```javascript
async function importFromSlack() {
  try {
    const project = await slackAdapter.importProject('C1234567890');
    console.log('导入的项目:', project);
    return project;
  } catch (error) {
    console.error('导入失败:', error);
  }
}
```

### 5.3 同步状态

```javascript
async function updateStatusInSlack() {
  try {
    await slackAdapter.syncStatus(
      'internal-project-123',
      'VERIFY',
      { 
        progress: 85,
        message: '正在验证解决方案...',
        timestamp: new Date().toISOString()
      }
    );
    console.log('状态已同步');
  } catch (error) {
    console.error('状态同步失败:', error);
  }
}
```

### 5.4 设置 Webhook 处理

```javascript
const express = require('express');
const app = express();

// 获取 webhook 处理器
const webhookHandler = slackAdapter.getWebhookHandler();

// 监听 Slack 事件
slackAdapter.on('interaction', (payload) => {
  console.log('收到交互:', payload);
  // 处理交互事件，如按钮点击
});

slackAdapter.on('event', (event) => {
  console.log('收到事件:', event);
  // 处理 Slack 事件，如新消息等
});

// 将处理器注册到 Express 路由
app.use('/slack/webhook', webhookHandler);

app.listen(3000, () => {
  console.log('服务器运行在端口 3000');
});
```

## 6. 配置与部署

### 6.1 环境变量

| 环境变量 | 说明 | 必需 |
|---------|------|------|
| `LOKI_SLACK_BOT_TOKEN` | Slack 机器人令牌 | 是 |
| `LOKI_SLACK_CHANNEL` | 默认 Slack 频道 | 否 |
| `LOKI_SLACK_SIGNING_SECRET` | Slack 签名密钥 | 是（用于 webhook） |

### 6.2 Slack 应用配置

要使用此集成，需要在 Slack 中创建一个应用并配置以下内容：

1. **Bot Token Scopes**:
   - `chat:write` - 发送消息
   - `channels:history` - 读取频道历史
   - `groups:history` - 读取私有组历史（如需要）
   - `im:history` - 读取直接消息历史（如需要）

2. **Event Subscriptions**:
   - 配置请求 URL 为 `https://your-server/slack/webhook`
   - 订阅所需的事件类型

3. **Interactivity & Shortcuts**:
   - 启用交互式组件
   - 配置请求 URL 为 `https://your-server/slack/webhook`

### 6.3 安装依赖

```bash
npm install @slack/web-api
```

## 7. 安全注意事项

### 7.1 签名验证

所有传入的 Slack Webhook 请求都通过 `_verifySignature` 方法进行验证，该方法使用 `verifySlackSignature` 函数确保请求确实来自 Slack。如果没有配置签名密钥或签名验证失败，请求将被拒绝并返回 401 状态码。

### 7.2 载荷大小限制

Webhook 处理器对请求主体大小设置了 1MB 的限制，超过此限制的请求将被拒绝并返回 413 状态码。这是为了防止过大的请求导致内存问题。

### 7.3 错误处理

所有对外 API 调用都通过 `withRetry` 方法包装，提供了自动重试机制，增强了网络错误情况下的健壮性。

## 8. 限制与注意事项

### 8.1 功能限制

1. **子任务支持**: Slack 没有原生的子任务概念，因此 `createSubtasks` 方法只是将任务格式化为列表发布，而不是创建真正的子任务。

2. **导入限制**: `importProject` 方法最多只获取最近 50 条消息，对于更长的线程可能需要分页获取。

### 8.2 错误条件

1. 如果没有安装 `@slack/web-api` 包，尝试使用适配器会抛出错误。
2. 如果没有正确配置令牌或签名密钥，相关功能会失败。
3. 网络问题可能导致 API 调用失败，虽然有重试机制，但最终仍可能失败。

### 8.3 最佳实践

1. 始终使用环境变量或安全的配置管理来存储敏感信息，如令牌和签名密钥。
2. 在生产环境中，确保 webhook 端点使用 HTTPS。
3. 监听 'failure' 事件以处理持续失败的情况。
4. 根据实际需要调整重试参数（`maxRetries`、`baseDelay`、`maxDelay`）。

## 9. 扩展与自定义

虽然当前实现已经覆盖了主要的 Slack 集成场景，但可以通过以下方式进一步扩展：

1. **继承 SlackAdapter**: 创建子类以覆盖或添加特定功能。
2. **自定义消息块**: 修改或扩展 `blocks` 模块以创建更丰富的消息格式。
3. **事件处理**: 通过监听 'interaction' 和 'event' 事件来添加自定义的业务逻辑。
4. **添加新方法**: 根据需要添加与 Slack API 交互的新方法，同时确保使用 `withRetry` 进行包装以保持一致性。

## 10. 相关文档

- [Integrations 模块文档](Integrations.md) - 了解集成模块的整体架构和基类实现
- [Integrations-Jira 文档](Integrations-Jira.md) - 参考 Jira 集成的实现方式
- [Integrations-Linear 文档](Integrations-Linear.md) - 参考 Linear 集成的实现方式
- [Integrations-Teams 文档](Integrations-Teams.md) - 参考 Microsoft Teams 集成的实现方式
