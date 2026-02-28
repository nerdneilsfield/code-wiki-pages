# GitLab 映射模块快速参考

## 核心概念速查

### 映射配置 (MappingConfig)

| 字段 | 用途 | 示例 |
|------|------|------|
| PriorityMap | GitLab 优先级标签 → Beads 优先级(0-4) | "critical" → 0 |
| StateMap | GitLab 状态 → Beads 状态 | "opened" → "open" |
| LabelTypeMap | 类型标签 → Beads 问题类型 | "bug" → "bug" |
| RelationMap | 链接类型 → 依赖类型 | "blocks" → "blocks" |

### 转换函数速查

| 函数 | 输入 | 输出 | 用途 |
|------|------|------|------|
| GitLabIssueToBeads | GitLab Issue, MappingConfig | IssueConversion | GitLab → Beads 完整转换 |
| BeadsIssueToGitLabFields | Beads Issue, MappingConfig | map[string]interface{} | Beads → GitLab API 字段 |
| priorityFromLabels | []string, MappingConfig | int | 从标签提取优先级 |
| statusFromLabelsAndState | []string, string, MappingConfig | string | 确定问题状态 |
| typeFromLabels | []string, MappingConfig | string | 提取问题类型 |
| issueLinksToDependencies | int, []IssueLink, MappingConfig | []DependencyInfo | 转换依赖关系 |

### 标签格式

GitLab 标签支持两种格式：
1. **作用域标签**：`priority::critical`, `type::bug`, `status::in_progress`
2. **普通标签**：`critical`, `bug`, `in_progress`

### 优先级映射

| Beads 优先级 | GitLab 标签 | 含义 |
|-------------|------------|------|
| 0 | critical | 最紧急 |
| 1 | high | 高优先级 |
| 2 | medium | 中优先级（默认） |
| 3 | low | 低优先级 |
| 4 | none | 无优先级 |

### 状态转换

| GitLab 状态 | Beads 状态 | 说明 |
|------------|-----------|------|
| opened | open | 问题开放 |
| closed | closed | 问题关闭（优先级最高） |
| reopened | open | 重新开放 |

额外状态标签：
- `status::in_progress` → "in_progress"
- `status::blocked` → "blocked"
- `status::deferred` → "deferred"

## 常见用例

### 1. 基本转换流程

```go
// 1. 创建配置
config := gitlab.DefaultMappingConfig()

// 2. GitLab → Beads
conversion := gitlab.GitLabIssueToBeads(glIssue, config)
beadsIssue := conversion.Issue

// 3. 处理 Beads 问题...

// 4. Beads → GitLab 字段
updateFields := gitlab.BeadsIssueToGitLabFields(beadsIssue, config)
```

### 2. 自定义映射

```go
config := gitlab.DefaultMappingConfig()

// 自定义优先级
config.PriorityMap["urgent"] = 0
config.PriorityMap["later"] = 4

// 自定义类型
config.LabelTypeMap["improvement"] = "enhancement"
```

## 注意事项

⚠️ **重要**：GitLab 的 "closed" 状态会覆盖任何状态标签  
⚠️ **默认值**：优先级=2(medium)，类型="task"，状态="open"  
⚠️ **标签过滤**：作用域标签不会保留在 Beads 的 Labels 字段中  
⚠️ **时间估算**：GitLab weight × 60 = Beads EstimatedMinutes