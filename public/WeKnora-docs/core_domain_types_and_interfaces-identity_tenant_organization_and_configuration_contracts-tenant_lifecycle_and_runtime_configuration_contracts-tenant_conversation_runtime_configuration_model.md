# Tenant Conversation Runtime Configuration Model 深度解析

## 1. 模块概述

### 问题空间

在多租户的智能对话系统中，每个租户都有独特的业务场景、对话风格和交互偏好。如果为每个租户硬编码一套对话逻辑，会导致系统僵化、维护成本激增；如果完全不做配置，又无法满足不同租户的个性化需求。

`tenant_conversation_runtime_configuration_model` 模块正是为了解决这个问题而设计的。它提供了一套灵活的配置模型，让租户可以在运行时动态调整对话系统的行为，而无需修改代码或重新部署。

### 核心价值

这个模块的核心价值在于**将对话系统的行为参数化**，使得：
- 租户可以根据自己的业务需求定制对话体验
- 系统可以在不重启的情况下应用新的配置
- 不同租户可以共享同一套代码逻辑，但拥有完全不同的行为表现

## 2. 核心组件解析

### ConversationConfig 结构体

`ConversationConfig` 是本模块的核心数据结构，它封装了对话系统在"正常模式"下的所有可配置参数。

```go
type ConversationConfig struct {
	// 系统提示词相关
	Prompt          string `json:"prompt"`
	ContextTemplate string `json:"context_template"`
	
	// 模型生成参数
	Temperature        float64 `json:"temperature"`
	MaxCompletionTokens int     `json:"max_completion_tokens"`
	
	// 检索策略参数
	MaxRounds            int     `json:"max_rounds"`
	EmbeddingTopK        int     `json:"embedding_top_k"`
	KeywordThreshold     float64 `json:"keyword_threshold"`
	VectorThreshold      float64 `json:"vector_threshold"`
	RerankTopK           int     `json:"rerank_top_k"`
	RerankThreshold      float64 `json:"rerank_threshold"`
	EnableRewrite        bool    `json:"enable_rewrite"`
	EnableQueryExpansion bool    `json:"enable_query_expansion"`
	
	// 模型配置
	SummaryModelID string `json:"summary_model_id"`
	RerankModelID  string `json:"rerank_model_id"`
	
	// 回退策略
	FallbackStrategy string `json:"fallback_strategy"`
	FallbackResponse string `json:"fallback_response"`
	FallbackPrompt   string `json:"fallback_prompt"`
	
	// 查询重写提示词
	RewritePromptSystem string `json:"rewrite_prompt_system"`
	RewritePromptUser   string `json:"rewrite_prompt_user"`
}
```

#### 设计意图

这个结构体的设计体现了**分层配置**的思想：

1. **基础交互层**（Prompt, ContextTemplate）：定义对话的基本风格和上下文呈现方式
2. **生成控制层**（Temperature, MaxCompletionTokens）：控制模型输出的随机性和长度
3. **检索策略层**（MaxRounds, EmbeddingTopK 等）：配置知识检索的行为和过滤策略
4. **模型选择层**（SummaryModelID, RerankModelID）：指定不同任务使用的模型
5. **容错处理层**（FallbackStrategy 等）：定义系统在不确定情况下的行为
6. **查询优化层**（RewritePromptSystem 等）：配置查询重写的提示词

#### 数据库序列化

`ConversationConfig` 实现了 `driver.Valuer` 和 `sql.Scanner` 接口，这使得它可以直接作为 JSONB 类型存储在数据库中：

```go
func (c *ConversationConfig) Value() (driver.Value, error) {
	if c == nil {
		return nil, nil
	}
	return json.Marshal(c)
}

func (c *ConversationConfig) Scan(value interface{}) error {
	if value == nil {
		return nil
	}
	b, ok := value.([]byte)
	if !ok {
		return nil
	}
	return json.Unmarshal(b, c)
}
```

这种设计有几个明显的优势：
- **灵活性**：可以添加新字段而不改变数据库 schema
- **查询能力**：PostgreSQL 的 JSONB 类型支持索引和查询
- **向后兼容**：旧版本的 JSON 可以被新版本的结构体解析

## 3. 与 Tenant 模型的关系

`ConversationConfig` 是 `Tenant` 结构体的一个字段，但需要注意的是，它已经被标记为**废弃**：

```go
// Tenant 结构体中的相关字段
// Deprecated: ConversationConfig is deprecated, use CustomAgent (builtin-quick-answer) config instead.
// This field is kept for backward compatibility and will be removed in future versions.
ConversationConfig *ConversationConfig `yaml:"conversation_config" json:"conversation_config" gorm:"type:jsonb"`
```

### 设计变迁

这反映了系统架构的一个重要演进：
1. **早期设计**：对话配置直接作为 Tenant 的一部分
2. **当前设计**：转向使用 CustomAgent 配置（特别是 builtin-quick-answer）
3. **过渡期**：保留 ConversationConfig 以确保向后兼容

这种逐步迁移的策略在大型系统中很常见，它平衡了创新和稳定性。

## 4. 数据流程

虽然这个模块主要是数据结构定义，但它在整个系统中的数据流向可以描述为：

1. **配置加载**：系统从数据库加载 Tenant 记录，其中包含 ConversationConfig
2. **配置传播**：配置被传递到对话处理管道的各个组件
3. **行为控制**：各个组件根据配置调整自己的行为
4. **动态更新**：租户可以通过 API 更新配置，新配置会在下次对话时生效

## 5. 设计决策与权衡

### 决策 1：使用 JSONB 存储配置

**选择**：将 ConversationConfig 作为 JSONB 存储在数据库中，而不是拆分成独立的表和字段。

**理由**：
- 配置结构可能频繁变化，JSONB 避免了频繁的数据库迁移
- 不同租户可能有不同的配置子集，JSONB 稀疏存储更高效
- PostgreSQL 的 JSONB 支持索引和查询，仍然可以进行高效的配置筛选

**权衡**：
- 失去了关系型数据库的强类型约束
- 无法利用外键等关系型特性
- 查询复杂配置时性能可能不如传统表结构

### 决策 2：完整的配置结构体 vs 灵活的 map

**选择**：定义完整的 ConversationConfig 结构体，而不是使用 map[string]interface{}。

**理由**：
- 提供了清晰的配置文档和类型安全
- 支持 IDE 的代码补全和重构
- 可以在编译时捕获类型错误

**权衡**：
- 添加新配置项需要修改代码
- 不够灵活，无法支持完全自定义的配置项

### 决策 3：标记为废弃但保留

**选择**：将 ConversationConfig 标记为废弃，但在代码中保留。

**理由**：
- 给现有用户充足的迁移时间
- 避免突然的破坏性变更
- 可以逐步引导用户使用新的 CustomAgent 配置

**权衡**：
- 代码库中存在两套配置系统，增加了维护成本
- 新开发者可能会困惑应该使用哪套系统
- 需要同时维护两套配置的处理逻辑

## 6. 使用指南

### 基本使用

虽然 ConversationConfig 已被标记为废弃，但在过渡期内仍然可以使用：

```go
// 创建一个简单的对话配置
config := &tenant.ConversationConfig{
    Prompt:          "你是一个乐于助人的助手。",
    ContextTemplate: "上下文信息：\n{{.Context}}",
    Temperature:     0.7,
    EmbeddingTopK:   5,
}

// 关联到租户
tenant.ConversationConfig = config
```

### 迁移建议

对于新代码，建议使用 CustomAgent 配置而不是 ConversationConfig。系统正在向更灵活的代理配置模型迁移，ConversationConfig 将在未来版本中被移除。

## 7. 注意事项与边缘情况

### 向后兼容性

- 当从旧版本的 JSON 解析到新版本的结构体时，新增字段会被设置为零值
- 当从新版本的 JSON 解析到旧版本的结构体时，多余字段会被忽略
- 这种行为是由 Go 的 JSON 包默认处理的，通常是安全的

### nil 处理

- ConversationConfig 的 Value 方法会处理 nil 指针，返回 nil 而不是报错
- Scan 方法也会处理 nil 输入，不会修改目标对象
- 这种设计使得数据库中的 NULL 值可以正确映射到 Go 的 nil 指针

### 废弃状态

- 虽然 ConversationConfig 仍然可用，但应该避免在新代码中使用
- 查看相关的 CustomAgent 文档，了解新的配置方式
- 计划在未来的版本中移除这个字段，现有用户需要做好迁移准备

## 8. 相关模块

- [Tenant Core Models](core_domain_types_and_interfaces-identity_tenant_organization_and_configuration_contracts-tenant_lifecycle_and_runtime_configuration_contracts-tenant_core_and_retrieval_engine_models.md)
- [Custom Agent Configuration](core_domain_types_and_interfaces-identity_tenant_organization_and_configuration_contracts-custom_agent_and_skill_capability_contracts.md)
