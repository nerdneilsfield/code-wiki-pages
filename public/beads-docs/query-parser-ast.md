# query_parser_ast 模块技术文档

## 概述

`query_parser_ast` 模块是整个查询引擎的核心组成部分，负责将用户友好的查询字符串（如 `status=open AND priority>1`）转换为抽象语法树（AST）。这个模块处于查询管道的中间位置：上游是词法分析器（`query_lexer`），下游是求值器（`query_evaluator`）。

为什么要设计一个专门的解析器来转换查询字符串？想象一下，当你需要从成千上万条 issues 中筛选出特定条件的记录时，直接在代码中用字符串匹配来判断是极其低效且容易出错的。这个模块的存在就是为了解决这个问题——它提供了一种结构化的方式来理解和处理用户的查询意图，然后将这些意图转化为高效的可执行操作。

## 架构设计

整个查询引擎采用经典的三阶段管道架构：词法分析 → 语法解析 → 求值。`query_parser_ast` 处于第二阶段，负责构建查询的抽象表示。

```
用户查询字符串
      │
      ▼
┌─────────────────┐
│  query_lexer    │  (词法分析：将字符流转换为 Token 流)
└────────┬────────┘
         │ Token 流
         ▼
┌─────────────────┐
│ query_parser    │  ★ 当前模块：语法解析，将 Token 流转换为 AST
└────────┬────────┘
         │ Node (AST)
         ▼
┌─────────────────┐
│ query_evaluator │  (求值：将 AST 转换为数据库 Filter 或内存 Predicate)
└─────────────────┘
         │
         ▼
   IssueFilter / Predicate
```

### 核心组件

#### Node 接口 — 抽象语法树的根基

```go
type Node interface {
    node() // 标记方法，用于类型断言
    String() string
}
```

这个接口是整个 AST 的基础。所有具体的节点类型（`ComparisonNode`、`AndNode`、`OrNode`、`NotNode`）都实现了这个接口。设计者使用了一个技巧：标记方法 `node()` 没有实际功能，只是为了能够在运行时进行类型断言来判断具体是哪种节点。这种模式在 Go 语言的 AST 处理中非常常见。

#### ComparisonNode — 原子条件

`ComparisonNode` 是查询语言中最基础的单位，代表一个字段比较操作，例如 `status=open` 或 `priority>1`。

```go
type ComparisonNode struct {
    Field     string      // 字段名（已被小写规范化）
    Op        ComparisonOp // 比较运算符
    Value     string      // 比较值
    ValueType TokenType   // 值类型：TokenIdent, TokenString, TokenNumber, TokenDuration
}
```

这里的设计决策值得注意：`ValueType` 字段记录了值的原始类型信息。这是因为在后续的求值阶段，需要知道 `priority>1` 中的 `1` 是数字 `1` 还是字符串 `"1"`——虽然看起来相似，但在数据库查询和类型验证时会带来实质性的差异。

#### 逻辑节点 — AndNode、OrNode、NotNode

这三个节点负责组合原子条件，形成更复杂的布尔表达式：

- **AndNode**: 左右子树必须同时满足
- **OrNode**: 左右子树任一满足即可
- **NotNode**: 对子树结果取反

设计者选择了一个简洁的二叉树结构，每个逻辑节点恰好有两个子节点（`NotNode` 只有一个 `Operand`）。这种设计使得递归遍历 AST 变得非常自然。

#### Parser 结构体 — 递归下降解析器

```go
type Parser struct {
    lexer   *Lexer
    current Token
    peeked  *Token
}
```

`Parser` 使用经典的递归下降算法来实现语法解析。字段 `peeked` 是一个有趣的优化：它实现了"偷看"机制，允许解析器在不消费 Token 的情况下查看下一个 Token，这对于运算符优先级处理和错误报告至关重要。

### 运算符优先级处理

解析器巧妙地处理了运算符优先级。解析顺序是：

```
parseOr      → 最低优先级，处理 OR
parseAnd     → 处理 AND
parseNot     → 处理 NOT
parsePrimary → 处理括号和比较
```

这意味着 `status=open OR priority>1 AND type=bug` 会被解析为 `status=open OR (priority>1 AND type=bug)`，符合直觉。

### KnownFields — 可查询字段白名单

```go
var KnownFields = map[string]bool{
    "id": true, "title": true, "description": true,
    "status": true, "priority": true, "type": true,
    "assignee": true, "owner": true,
    "created": true, "updated": true, "closed": true,
    "label": true, "labels": true,
    "pinned": true, "ephemeral": true, "template": true,
    // ... 更多字段
}
```

这个白名单有两个作用：一是提供给命令行补全建议，二是作为一种文档化的契约，告诉使用者哪些字段可以用于查询。

## 数据流分析

### 解析流程

当你调用 `query.Parse("status=open AND priority>1")` 时，流程如下：

1. **创建 Parser**：初始化 Lexer，准备好输入字符串
2. **Parse() 方法**：
   - 首先调用 `advance()` 获取第一个 Token
   - 检查是否为空查询
   - 调用 `parseOr()` 开始递归下降解析
3. **递归下降**：
   - `parseOr()` 调用 `parseAnd()`
   - `parseAnd()` 调用 `parseNot()`
   - `parseNot()` 调用 `parsePrimary()`
   - `parsePrimary()` 调用 `parseComparison()`
4. **构建 AST**：每个解析方法在返回时创建对应的 Node 结构
5. **验证**：确保所有 Token 都被消费，检查是否有多余的 Token

### 与上下游的协作

这个模块被 `query_evaluator` 依赖。Evaluator 调用 `Parse()` 获取 AST，然后决定如何最好地执行查询：

- **简单查询**（如 `status=open`）：可以直接转换为 `IssueFilter` 推送到数据库
- **复杂查询**（如包含 OR 或复杂 NOT）：需要在内存中用 Predicate 函数过滤

## 设计决策与权衡

### 1. 纯递归下降 vs 生成式解析器

选择纯手写的递归下降解析器而非使用 Lex/Yacc 这样的生成式工具，是一个有意识的决定。优点是：
- 代码可读性强，调试方便
- 错误信息更友好，可以精确指出位置
- 依赖轻，不需要引入额外的代码生成工具

缺点是：
- 对于更复杂的语法，维护成本会上升
- 扩展性有限

考虑到这个查询语言的语法相对简单，这种权衡是合理的。

### 2. 即时求值 vs 延迟求值

解析器在构建 AST 后不会立即执行任何操作。这意味着同一个 AST 可以被多次求值（每次可能使用不同的时间基准，如 `updated>7d` 可以用"今天"或"上周"来计算）。这种设计增加了灵活性，但也意味着语法错误只会在求值时才会被发现——不过对于这种场景，这完全是可以接受的。

### 3. 字段名规范化

在 `parseComparison()` 中可以看到：

```go
field := strings.ToLower(p.current.Value)
```

所有字段名都会被转换为小写。这是一种实用的设计决策，降低了用户的学习成本（不需要记住大小写），但也意味着无法查询区分大小写的字段名。

### 4. TokenType 携带在 AST 中

`ComparisonNode` 保存了 `ValueType`，而不是在求值时才推断类型。这是一种"前端宽松，后端严格"的设计：解析器接受多种类型，求值器根据类型执行不同逻辑。这种分离使得系统更容易理解和测试。

## 依赖分析

### 上游依赖

| 模块 | 依赖方式 | 说明 |
|------|----------|------|
| `query_lexer` | 直接使用 | 提供 Token 流，是 Parser 的输入 |

### 下游依赖

| 模块 | 依赖方式 | 说明 |
|------|----------|------|
| `query_evaluator` | 核心依赖 | 将 AST 转换为 Filter 或 Predicate |

### 外部依赖

- `fmt`: 错误消息格式化
- `strings`: 字符串处理（ToLower 等）

## 使用示例与扩展

### 基本用法

```go
// 解析简单查询
node, err := query.Parse("status=open")
if err != nil {
    log.Fatal(err)
}
fmt.Println(node.String())  // 输出: status=open

// 解析复合查询
node, err := query.Parse("(status=open OR status=blocked) AND priority<2")
if err != nil {
    log.Fatal(err)
}
fmt.Println(node.String())  // 输出: ((status=open OR status=blocked) AND priority<2)
```

### 与求值器结合

```go
// 完整流程：解析 + 求值
now := time.Now()
evaluator := query.NewEvaluator(now)

parsed, err := query.Parse("status=open AND priority>1")
if err != nil {
    log.Fatal(err)
}

result, err := evaluator.Evaluate(parsed)
if err != nil {
    log.Fatal(err)
}

// result.Filter 可用于数据库查询
// result.Predicate 可用于内存过滤
```

## 边界情况与注意事项

### 1. 空查询处理

```go
if p.current.Type == TokenEOF {
    return nil, fmt.Errorf("empty query")
}
```

空查询会被明确拒绝。这符合"快速失败"原则，避免后续处理空 AST 时产生更隐蔽的错误。

### 2. 括号匹配验证

解析器在遇到 `)` 时会验证是否有对应的 `(`：

```go
if p.current.Type != TokenRParen {
    return nil, fmt.Errorf("expected ')' at position %d, got %s", p.current.Pos, p.current.Type.String())
}
```

错误消息包含位置信息，便于用户定位问题。

### 3. 值类型强制

解析器要求比较运算符右侧必须是有效值类型之一：

```go
switch p.current.Type {
case TokenIdent, TokenString, TokenNumber, TokenDuration:
    // 合法
default:
    return nil, fmt.Errorf("expected value...")
}
```

这意味着 `status=`（没有值）是语法错误，会在解析阶段被捕获。

### 4. 字段名小写陷阱

由于字段名被自动转换为小写，以下查询是等价的：
- `Status=Open` → `status=open`
- `PRIORITY>1` → `priority>1`

但这也可能导致意外的匹配，因为某些后端系统可能区分大小写。

### 5. 运算符优先级与直觉

虽然 `AND` 优先级高于 `OR`（通过递归下降的调用顺序实现），但对于不熟悉这个规则的用户来说，可能产生困惑。建议在用户界面上对复杂查询自动添加括号，或提供清晰的帮助文档。

## 测试覆盖

模块包含三类测试：

1. **词法测试**（TestLexer）：验证 Token 化是否正确
2. **解析测试**（TestParser）：验证 AST 构建是否正确
3. **求值测试**（TestEvaluatorSimpleQueries, TestEvaluatorComplexQueries, TestPredicateEvaluation）：验证查询的实际执行结果

测试文件 `query_test.go` 提供了丰富的用例，展示了查询语言的各种特性，建议新加入的开发者仔细阅读。

## 相关文档

- [query_lexer](query-lexer.md) — 词法分析器
- [query_evaluator](query-evaluator.md) — 查询求值器
- [query_and_projection_types](../core-domain-types/query-and-projection-types.md) — IssueFilter 类型定义