
# 提示词模板与 FebriText 配置模块技术深度解析

## 1. 模块概述

### 1.1 核心问题域

在一个大型 LLM 驱动的对话系统中，提示词管理面临着诸多挑战：不同场景需要不同的提示词策略（系统提示、上下文模板、查询重写等）、提示词可能包含敏感信息需要与代码分离、多租户场景下需要灵活的提示词配置、以及提示词内容可能需要动态调整而无需重新部署。

本模块正是为了解决这些问题而设计的。它提供了一个统一的机制来加载、解析和管理各种提示词模板，同时支持通过配置文件和外部目录两种方式进行灵活配置。

### 1.2 模块定位

该模块位于 `platform_infrastructure_and_runtime/runtime_configuration_and_bootstrap/` 下，是整个应用配置系统的核心组成部分。它负责：
- 定义提示词模板的数据结构
- 提供从配置文件和外部目录加载提示词的能力
- 支持环境变量替换
- 管理 FebriText 相关的配置

## 2. 核心数据模型

### 2.1 PromptTemplate 结构

`PromptTemplate` 是最基本的提示词模板单元，代表一个完整的提示词配置。

```go
type PromptTemplate struct {
    ID               string `yaml:"id"                 json:"id"`
    Name             string `yaml:"name"               json:"name"`
    Description      string `yaml:"description"        json:"description"`
    Content          string `yaml:"content"            json:"content"`
    HasKnowledgeBase bool   `yaml:"has_knowledge_base" json:"has_knowledge_base,omitempty"`
    HasWebSearch     bool   `yaml:"has_web_search"     json:"has_web_search,omitempty"`
}
```

**设计意图**：
- `ID` 和 `Name` 用于模板的唯一标识和友好展示
- `Description` 提供模板用途说明，便于维护
- `Content` 是核心的提示词文本内容
- `HasKnowledgeBase` 和 `HasWebSearch` 是功能标签，用于标记该模板是否依赖知识库或网络搜索功能

### 2.2 PromptTemplatesConfig 结构

`PromptTemplatesConfig` 是提示词模板的容器，按用途分类组织模板：

```go
type PromptTemplatesConfig struct {
    SystemPrompt    []PromptTemplate `yaml:"system_prompt"    json:"system_prompt"`
    ContextTemplate []PromptTemplate `yaml:"context_template" json:"context_template"`
    RewriteSystem   []PromptTemplate `yaml:"rewrite_system"   json:"rewrite_system"`
    RewriteUser     []PromptTemplate `yaml:"rewrite_user"     json:"rewrite_user"`
    Fallback        []PromptTemplate `yaml:"fallback"         json:"fallback"`
}
```

**设计意图**：
- 按提示词的使用场景进行分类组织
- 每个分类支持多个模板，为多场景和 A/B 测试提供支持
- 这种结构化组织使配置文件更清晰，也便于代码中按类型检索模板

### 2.3 FebriText 结构

`FebriText` 是一个专门的配置结构，用于处理带标签和不带标签的文本：

```go
type FebriText struct {
    WithTag   string `yaml:"with_tag"    json:"with_tag"`
    WithNoTag string `yaml:"with_no_tag" json:"with_no_tag"`
}
```

**设计意图**：
- 提供两种不同的文本处理模板
- 通常用于在有标签和无标签的知识库内容之间进行区分处理

## 3. 配置加载机制

### 3.1 双层加载策略

该模块采用了一种巧妙的双层加载策略：

1. **主配置文件加载**：首先从 `config.yaml` 等主配置文件中加载基础配置
2. **外部目录覆盖**：然后尝试从配置文件所在目录下的 `prompt_templates/` 子目录中加载专门的模板文件，如果成功则覆盖主配置中的模板

```go
// 加载提示词模板（从目录或配置文件）
configDir := filepath.Dir(viper.ConfigFileUsed())
promptTemplates, err := loadPromptTemplates(configDir)
if err != nil {
    fmt.Printf("Warning: failed to load prompt templates from directory: %v\n", err)
    // 如果目录加载失败，使用配置文件中的模板（如果有）
} else if promptTemplates != nil {
    cfg.PromptTemplates = promptTemplates
}
```

**设计决策分析**：
- **灵活性与简洁性的平衡**：对于简单场景，可以直接在主配置文件中定义提示词；对于复杂场景，可以使用外部目录管理
- **环境适应性**：不同环境（开发、测试、生产）可以有不同的提示词目录
- **回退机制**：目录加载失败时有警告但不中断，保证系统的鲁棒性

### 3.2 环境变量替换

模块支持在配置文件中使用 `${ENV_VAR}` 格式的环境变量引用，这是通过正则表达式匹配和替换实现的：

```go
re := regexp.MustCompile(`\${([^}]+)}`)
result := re.ReplaceAllStringFunc(string(configFileContent), func(match string) string {
    // 提取环境变量名称（去掉${}部分）
    envVar := match[2 : len(match)-1]
    // 获取环境变量值，如果不存在则保持原样
    if value := os.Getenv(envVar); value != "" {
        return value
    }
    return match
})
```

**设计意图**：
- 敏感信息（如 API 密钥）可以不直接写在配置文件中
- 不同部署环境可以通过环境变量注入不同配置
- 未设置的环境变量保持原样，提供了良好的容错性

### 3.3 目录模板加载

`loadPromptTemplates` 函数负责从 `prompt_templates` 目录加载模板文件，它使用了一个映射表来定义文件名与配置结构字段的对应关系：

```go
templateFiles := map[string]*[]PromptTemplate{
    "system_prompt.yaml":    &config.SystemPrompt,
    "context_template.yaml": &config.ContextTemplate,
    "rewrite_system.yaml":   &config.RewriteSystem,
    "rewrite_user.yaml":     &config.RewriteUser,
    "fallback.yaml":         &config.Fallback,
}
```

**设计意图**：
- 使用映射表而非硬编码的条件语句，使代码更易于扩展
- 每个模板文件独立，便于团队协作和版本控制
- 文件不存在时跳过而非报错，提供了灵活性

## 4. 数据流向与依赖关系

### 4.1 模块依赖关系

该模块是配置系统的一部分，被上层的应用启动流程调用。从代码结构来看，它的主要依赖是：
- `github.com/spf13/viper` - 配置管理
- `gopkg.in/yaml.v3` - YAML 解析
- `github.com/go-viper/mapstructure/v2` - 配置结构映射
- `github.com/Tencent/WeKnora/internal/types` - 内部类型定义

### 4.2 数据流向

1. **初始化阶段**：`LoadConfig()` 被应用入口调用
2. **配置读取**：Viper 从多个可能的位置查找并读取配置文件
3. **环境变量处理**：配置内容中的环境变量引用被替换
4. **结构解析**：配置被解析到 `Config` 结构体
5. **模板加载**：尝试从 `prompt_templates` 目录加载额外的模板文件
6. **配置返回**：完整的配置对象返回给调用者

## 5. 设计决策与权衡

### 5.1 配置文件 vs 代码定义

**选择**：支持配置文件和外部目录两种方式，外部目录优先

**理由**：
- 配置文件方式简单直接，适合快速启动和简单场景
- 外部目录方式更灵活，适合复杂的多模板场景
- 提示词可能包含敏感信息，放在外部目录可以更精细地控制访问权限
- 提示词内容可能需要频繁修改，外部目录方式无需重新编译

**权衡**：
- 增加了代码复杂度
- 需要处理两种方式的合并和覆盖逻辑
- 文档和使用指导需要更加详细

### 5.2 数组 vs 单个模板

**选择**：每个提示词类型使用数组 `[]PromptTemplate` 而非单个模板

**理由**：
- 支持多场景配置（如不同语言、不同领域的提示词）
- 为 A/B 测试提供基础架构
- 给上层应用更多选择和组合的空间

**权衡**：
- 上层应用需要处理选择逻辑
- 配置文件可能变得更复杂
- 需要明确约定默认选择机制

### 5.3 环境变量替换的实现方式

**选择**：手动实现正则表达式替换，而非依赖 Viper 的环境变量功能

**理由**：
- Viper 的环境变量替换主要针对配置键值，对大段文本内容支持有限
- 可以在 YAML 解析前进行替换，确保替换后的内容能被正确解析
- 更灵活的语法支持（`${VAR}` 格式）

**权衡**：
- 自定义实现增加了维护成本
- 需要处理边界情况（如未定义的环境变量）

## 6. 使用指南与最佳实践

### 6.1 基本配置方式

在主配置文件 `config.yaml` 中直接定义：

```yaml
prompt_templates:
  system_prompt:
    - id: default_system
      name: Default System Prompt
      description: Default system prompt for general conversations
      content: "You are a helpful assistant..."
      has_knowledge_base: true
```

### 6.2 外部目录方式

在配置文件所在目录下创建 `prompt_templates` 子目录，并在其中创建分类文件，如 `system_prompt.yaml`：

```yaml
templates:
  - id: default_system
    name: Default System Prompt
    description: Default system prompt for general conversations
    content: "You are a helpful assistant..."
    has_knowledge_base: true
  - id: technical_support
    name: Technical Support Prompt
    description: System prompt for technical support scenarios
    content: "You are a technical support specialist..."
    has_knowledge_base: true
    has_web_search: true
```

### 6.3 环境变量使用

在配置文件中可以使用环境变量：

```yaml
prompt_templates:
  system_prompt:
    - id: default_system
      name: Default System Prompt
      content: "You are a helpful assistant. The API endpoint is ${API_ENDPOINT}"
```

## 7. 注意事项与潜在问题

### 7.1 模板内容安全

- 提示词模板可能包含敏感信息，应确保配置文件和模板目录的访问权限
- 生产环境中，避免将包含敏感信息的模板提交到版本控制系统

### 7.2 错误处理

- 模板目录加载失败不会导致程序崩溃，但会输出警告信息
- 监控这些警告信息很重要，因为可能导致使用过时或不正确的模板

### 7.3 模板选择逻辑

- 当前模块只负责加载模板，不负责选择使用哪个模板
- 上层应用需要实现自己的模板选择逻辑（如根据 ID 选择、默认选择第一个等）
- 建议在应用层建立明确的模板选择约定

### 7.4 大模板性能

- 提示词内容可能很长，大量大模板会增加内存占用
- 考虑在应用层实现模板的懒加载机制

## 8. 扩展与演进方向

### 8.1 可能的改进

1. **模板版本控制**：增加模板版本字段，支持模板的版本管理
2. **模板继承**：支持模板之间的继承关系，减少重复内容
3. **热重载**：支持配置和模板的热重载，无需重启应用
4. **模板验证**：增加模板内容的验证机制，确保占位符等格式正确
5. **模板仓库**：支持从远程模板仓库加载模板

### 8.2 与其他模块的协作

该模块提供的配置主要被以下模块使用：
- [agent_runtime_and_tools](../agent_runtime_and_tools.md) - 用于构建代理的提示词
- [application_services_and_orchestration](../application_services_and_orchestration.md) - 用于对话流程中的提示词生成
- [model_providers_and_ai_backends](../model_providers_and_ai_backends.md) - 用于与模型交互时的提示词构建

## 总结

`prompt_template_and_febri_text_configuration` 模块是一个精心设计的配置管理组件，它通过灵活的双层加载策略、结构化的模板组织和环境变量支持，为 LLM 应用提供了强大而易用的提示词管理能力。其设计权衡了灵活性与简洁性，为不同规模的应用场景提供了合适的解决方案。
