# FAQ 和问题生成配置模块深度解析

## 1. 模块概览

这个模块解决了知识库系统中两个核心问题：如何优化 FAQ 知识库的检索策略，以及如何通过生成问题来提升文档知识库的召回率。想象一下，当用户提问时，系统需要理解用户的意图，但 FAQ 可能只有标准问题，而文档内容可能没有明确的问题形式。这个模块就像是一个"问题翻译官"和"索引策略师"，它让系统能够更好地匹配用户查询与知识库内容。

## 2. 核心组件详解

### 2.1 FAQConfig - FAQ 索引策略配置

**设计意图**：`FAQConfig` 专门为 FAQ 类型知识库设计，解决的核心问题是：如何索引 FAQ 才能最有效地匹配用户的真实查询？

```go
type FAQConfig struct {
    IndexMode         FAQIndexMode         `yaml:"index_mode"          json:"index_mode"`
    QuestionIndexMode FAQQuestionIndexMode `yaml:"question_index_mode" json:"question_index_mode"`
}
```

**核心配置项**：

- **IndexMode**: 控制是否将答案纳入索引
  - `FAQIndexModeQuestionOnly`: 仅索引问题（包括相似问题），适合答案较短或答案会随时间变化的场景
  - `FAQIndexModeQuestionAnswer`: 同时索引问题和答案，适合答案包含丰富语义信息的场景

- **QuestionIndexMode**: 控制标准问题与相似问题的索引方式
  - `FAQQuestionIndexModeCombined`: 合并索引，适合相似问题与标准问题语义高度一致的情况
  - `FAQQuestionIndexModeSeparate`: 分别索引，适合需要细粒度控制检索权重的场景

**设计亮点**：这个配置体现了"索引策略分层"的思想——第一层决定是否包含答案，第二层决定问题的组织方式，让用户可以根据 FAQ 的特性灵活调整。

### 2.2 QuestionGenerationConfig - 文档问题生成配置

**设计意图**：`QuestionGenerationConfig` 解决的是文档知识库的"语义缺口"问题——文档内容通常是陈述性的，而用户查询通常是疑问性的，直接匹配效果不佳。通过为每个文档块生成问题，我们可以在索引时就建立起"文档内容→可能的问题"的映射。

```go
type QuestionGenerationConfig struct {
    Enabled bool `yaml:"enabled"  json:"enabled"`
    // Number of questions to generate per chunk (default: 3, max: 10)
    QuestionCount int `yaml:"question_count" json:"question_count"`
}
```

**核心配置项**：

- **Enabled**: 开关控制，是否启用问题生成功能
- **QuestionCount**: 每个文档块生成的问题数量（默认 3 个，最多 10 个）

**设计权衡**：为什么限制在最多 10 个问题？这里体现了"召回率 vs 索引成本"的平衡——生成更多问题可能会提高召回率，但也会增加 LLM 调用成本、索引存储成本和检索时的计算成本。默认 3 个是经过实践验证的平衡点。

### 2.3 KnowledgeBase 结构体中的集成

这两个配置都作为 `KnowledgeBase` 结构体的可选字段，体现了"配置即数据"的设计理念——知识库的行为由其配置数据决定，而不是硬编码逻辑。

```go
type KnowledgeBase struct {
    // ... 其他字段 ...
    FAQConfig *FAQConfig `yaml:"faq_config" json:"faq_config" gorm:"column:faq_config;type:json"`
    QuestionGenerationConfig *QuestionGenerationConfig `yaml:"question_generation_config" json:"question_generation_config" gorm:"column:question_generation_config;type:json"`
    // ... 其他字段 ...
}
```

### 2.4 EnsureDefaults 方法 - 配置默认值保障

**设计意图**：`EnsureDefaults` 方法解决了"配置完整性"问题——确保知识库始终有合理的默认配置，避免因配置缺失导致的运行时错误或意外行为。

```go
func (kb *KnowledgeBase) EnsureDefaults() {
    if kb == nil {
        return
    }
    if kb.Type == "" {
        kb.Type = KnowledgeBaseTypeDocument
    }
    if kb.Type != KnowledgeBaseTypeFAQ {
        kb.FAQConfig = nil
        return
    }
    if kb.FAQConfig == nil {
        kb.FAQConfig = &FAQConfig{
            IndexMode:         FAQIndexModeQuestionAnswer,
            QuestionIndexMode: FAQQuestionIndexModeCombined,
        }
        return
    }
    if kb.FAQConfig.IndexMode == "" {
        kb.FAQConfig.IndexMode = FAQIndexModeQuestionAnswer
    }
    if kb.FAQConfig.QuestionIndexMode == "" {
        kb.FAQConfig.QuestionIndexMode = FAQQuestionIndexModeCombined
    }
}
```

**设计亮点**：这个方法体现了"防御性编程"的思想——它不仅设置默认值，还会根据知识库类型清理不相关的配置（非 FAQ 类型知识库会清空 FAQConfig），确保配置的一致性。

## 3. 数据持久化设计

这个模块的一个重要特点是所有配置都实现了 `driver.Valuer` 和 `sql.Scanner` 接口，这意味着它们可以直接作为 JSON 字段存储在数据库中。

```go
// Value implements the driver.Valuer interface
func (c QuestionGenerationConfig) Value() (driver.Value, error) {
    return json.Marshal(c)
}

// Scan implements the sql.Scanner interface
func (c *QuestionGenerationConfig) Scan(value interface{}) error {
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

**设计权衡**：使用 JSON 字段存储配置而不是独立表，体现了"灵活性 vs 查询能力"的平衡——JSON 字段提供了极大的配置灵活性，不需要修改数据库 schema 就能添加新配置项，但牺牲了对配置字段的复杂查询能力。对于配置数据来说，这是一个合理的选择，因为我们很少需要按配置字段查询知识库。

## 4. 依赖关系与架构角色

这个模块在整个系统中扮演着"配置契约"的角色，它定义了知识库检索行为的配置结构，但本身不包含业务逻辑。它的主要消费者包括：

- **知识库管理服务**：负责创建和更新知识库配置
- **检索引擎**：根据配置决定如何索引和检索内容
- **文档处理管道**：在处理文档时根据配置生成问题
- **FAQ 导入服务**：根据配置决定如何索引 FAQ 内容

## 5. 设计决策与权衡

### 5.1 为什么将 FAQ 配置和问题生成配置放在一起？

这两个配置看似服务于不同类型的知识库（FAQ 类型和文档类型），但它们本质上都是解决"如何让用户查询更好地匹配知识库内容"的问题。将它们放在一起，体现了"问题空间聚合"的设计思想——它们都是检索优化策略的不同表现形式。

### 5.2 为什么使用枚举类型而不是布尔值？

对于索引模式，使用枚举类型（`FAQIndexMode`、`FAQQuestionIndexMode`）而不是多个布尔值，体现了"互斥状态建模"的设计思想——这些模式是互斥的，使用枚举可以确保配置的一致性，避免出现无效的组合状态。

### 5.3 为什么 QuestionGenerationConfig 的 QuestionCount 有上限？

限制最多生成 10 个问题，是因为：
1. **成本控制**：LLM 生成问题需要成本，生成更多问题意味着更高的成本
2. **收益递减**：超过一定数量后，新增问题带来的召回率提升会越来越小
3. **索引效率**：更多的问题会导致索引体积增大，检索速度变慢

这是一个典型的"工程权衡"——在效果和成本之间找到平衡点。

## 6. 使用指南与常见模式

### 6.1 FAQ 知识库配置场景

**场景 1：答案会随时间变化的 FAQ**
```go
kb := &KnowledgeBase{
    Type: KnowledgeBaseTypeFAQ,
    FAQConfig: &FAQConfig{
        IndexMode:         FAQIndexModeQuestionOnly,  // 只索引问题
        QuestionIndexMode: FAQQuestionIndexModeCombined,
    },
}
```

**场景 2：答案包含丰富语义的 FAQ**
```go
kb := &KnowledgeBase{
    Type: KnowledgeBaseTypeFAQ,
    FAQConfig: &FAQConfig{
        IndexMode:         FAQIndexModeQuestionAnswer,  // 同时索引问题和答案
        QuestionIndexMode: FAQQuestionIndexModeSeparate,  // 分别索引标准问题和相似问题
    },
}
```

### 6.2 文档知识库问题生成配置

**场景 1：技术文档知识库**
```go
kb := &KnowledgeBase{
    Type: KnowledgeBaseTypeDocument,
    QuestionGenerationConfig: &QuestionGenerationConfig{
        Enabled:        true,
        QuestionCount:  5,  // 技术文档可能需要更多问题来覆盖不同的查询角度
    },
}
```

**场景 2：新闻资讯知识库**
```go
kb := &KnowledgeBase{
    Type: KnowledgeBaseTypeDocument,
    QuestionGenerationConfig: &QuestionGenerationConfig{
        Enabled:        true,
        QuestionCount:  3,  // 新闻内容通常主题明确，3 个问题足够
    },
}
```

## 7. 注意事项与潜在陷阱

### 7.1 配置一致性

**陷阱**：直接修改 `KnowledgeBase` 的配置字段而不调用 `EnsureDefaults`，可能导致配置不完整。

**最佳实践**：在创建或更新知识库后，始终调用 `EnsureDefaults` 方法：
```go
kb := &KnowledgeBase{...}
kb.EnsureDefaults()
```

### 7.2 类型与配置的匹配

**陷阱**：为非 FAQ 类型知识库设置 FAQConfig，或为非文档类型知识库设置 QuestionGenerationConfig，虽然不会导致错误，但可能会造成混淆。

**最佳实践**：根据知识库类型设置相应的配置，`EnsureDefaults` 方法会自动清理不相关的配置。

### 7.3 问题生成的成本考量

**陷阱**：将 QuestionCount 设置得过高，可能导致文档处理时间和成本显著增加。

**最佳实践**：从默认值 3 开始，根据实际召回效果逐步调整，不要超过 10 的上限。

## 8. 总结

这个模块虽然代码量不大，但它体现了知识库系统的核心设计思想——检索优化不仅是算法问题，也是配置问题。通过提供灵活的索引策略和问题生成配置，系统可以适应不同类型的知识库和不同的应用场景，同时保持核心逻辑的简洁性。

这种"配置驱动行为"的设计模式，让系统既有足够的灵活性，又不会陷入过度复杂的境地，是一个值得学习的设计范例。
