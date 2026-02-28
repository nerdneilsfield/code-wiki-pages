# StructuredLLM 结构化 LLM 客户端

> **模块职责**：为 LLM 调用提供结构化输出能力——将 LLM 的自由文本响应解析为结构化的 JSON 数据，并支持同步/异步两种调用方式。

## 核心组件

### StructuredLLM

```python
class StructuredLLM:
    """Wrapper for LLM with structured output support.
    
    Provides unified interface for getting JSON responses from LLM
    with automatic parsing and validation.
    """
```

**设计意图**：解决 LLM 输出格式不可控的问题——LLM 输出自由文本，但应用需要结构化数据。

## 工作流程

```
用户输入自然语言
       ↓
构造 prompt（含 JSON schema）
       ↓
调用 LLM 获取响应
       ↓
解析 JSON（多策略）
       ↓
Pydantic 模型验证
       ↓
返回结构化数据
```

## 核心方法

### complete_json

获取 JSON 格式的 LLM 响应。

**参数**：
- `prompt`: str - 用户 prompt
- `schema`: Optional[Dict[str, Any]] - JSON schema（可选）

**返回**：Optional[Dict[str, Any]]

```python
def complete_json(self, prompt: str, schema: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Get JSON completion from LLM."""
    if schema:
        prompt = f"{prompt}\n\n{get_json_schema_prompt(schema)}"
    
    response = self._get_vlm().get_completion(prompt)
    return parse_json_from_response(response)
```

### complete_model

获取结构化模型响应。

**参数**：
- `prompt`: str - 用户 prompt
- `model_class`: Type[T] - Pydantic 模型类

**返回**：Optional[T]

```python
def complete_model(self, prompt: str, model_class: Type[T]) -> Optional[T]:
    schema = model_class.model_json_schema()
    response = self.complete_json(prompt, schema=schema)
    if response is None:
        return None
    
    return model_class.model_validate(response)
```

## JSON 解析策略

`parse_json_from_response` 函数实现了 5 种递进式解析策略：

| 策略 | 方法 | 适用场景 |
|------|------|----------|
| 1 | `json.loads()` | 标准 JSON 字符串 |
| 2 | 从 code block 提取 | LLM 返回 markdown 包裹的 JSON |
| 3 | 正则匹配 | 自由格式 JSON |
| 4 | 修复引号 | JSON 引号转义问题 |
| 5 | json_repair | 复杂格式错误 |

**设计意图**：通过递进式策略，逐个尝试直到成功，确保最大兼容性。

## 依赖

- **VLMConfig**: VLM 配置
- **get_json_schema_prompt**: 生成 JSON schema prompt

```python
def get_json_schema_prompt(schema: Dict[str, Any]) -> str:
    """Generate prompt with JSON schema."""
```

## 错误处理

如果解析失败：
1. 记录 warning 日志
2. 返回 None
3. 调用方需要处理 None 返回值

## 扩展点

**get_json_schema_prompt** - 可自定义 schema 生成逻辑

**parse_json_from_response** - 可扩展解析策略

## 注意事项

1. **同步/异步**：提供 sync 和 async 两套 API，调用方根据场景选择
2. **类型安全**：返回 Pydantic 模型实例，类型安全
3. **错误处理**：返回 None 需要调用方处理

## 依赖调用

```python
# 构造 prompt
schema = model_class.model_json_schema()
prompt = f"{prompt}\n\n{get_json_schema_prompt(schema)}"

# 调用 LLM
response = self._get_vlm().get_completion(prompt)

# 解析 JSON
return parse_json_from_response(response)
```

## 注意事项

1. schema 需要是有效的 Pydantic model_json_schema() 输出
2. prompt 构造时包含 schema 信息
3. 解析失败返回 None

**调用流程**：
1. 构造 prompt（含 JSON schema）
2. 调用 LLM
3. 解析响应
4. 返回结构化数据