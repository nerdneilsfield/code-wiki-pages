# RerankClient 文档重排序客户端

> **模块职责**：调用 VikingDB Rerank API 对文档进行批量相关性评分。

## 核心组件

### RerankClient

```python
class RerankClient:
    """VikingDB Rerank API client.
    
    Supports batch rerank for multiple documents against a query.
    """
```

**设计意图**：对初步检索结果进行重排序，提升检索质量。

## 核心方法

### rerank_batch

对文档列表进行批量重排序。

**参数**：
- `query`: str - 查询文本
- `documents`: List[str] - 文档文本列表

**返回**：List[float] - 每个文档的相关性分数

```python
def rerank_batch(self, query: str, documents: List[str]) -> List[float]:
    if not documents:
        return []
    
    # 构建请求体
    req_body = {
        "model_name": self.model_name,
        "model_version": self.model_version,
        "data": [[{"text": doc}] for doc in documents],
        "query": [{"text": query}],
        "instruction": "Whether the Document answers the Query or matches the content retrieval intent",
    }
    
    # 发送请求
    req = self._prepare_request(...)
    response = requests.request(...)
    
    # 解析响应
    scores = [item.get("score", 0.0) for item in data]
    return scores
```

### from_config

从配置创建 RerankClient 实例。

```python
@classmethod
def from_config(cls, config) -> Optional["RerankClient"]:
    """从 RerankConfig 创建 RerankClient。"""
    if not config or not config.is_available():
        return None
    
    return cls(
        ak=config.ak,
        sk=config.sk,
        host=config.host,
        model_name=config.model_name,
        model_version=config.model_version,
    )
```

## 请求签名

使用 Volcengine SignerV4 进行 API 签名：

```python
def _prepare_request(self, method, path, params=None, data=None) -> Request:
    r = Request()
    r.set_shema("https")
    r.set_method(method)
    r.set_connection_timeout(10)
    r.set_socket_timeout(30)
    
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Host": self.host,
    }
    r.set_headers(headers)
    
    credentials = Credentials(self.ak, self.sk, "vikingdb", "cn-beijing")
    SignerV4.sign(r, credentials)
    
    return r
```

## 错误处理

**安全失败设计**：
- 任何异常都返回 0.0 分数列表
- 记录 error 日志
- 不抛出异常

```python
except Exception as e:
    logger.error(f"[RerankClient] Rerank failed: {e}")
    return [0.0] * len(documents)
```

## 配置

通过 RerankConfig 配置：

- `ak`: VikingDB Access Key
- `sk`: VikingDB Secret Key  
- `host`: API 主机地址
- `model_name`: 模型名称（默认 doubao-seed-rerank）
- `model_version`: 模型版本（默认 251028）

## 使用示例

```python
from openviking_cli.utils.config import get_openviking_config

config = get_openviking_config()
client = RerankClient.from_config(config.rerank)

if client:
    query = "如何配置数据库连接"
    documents = [
        "数据库配置方法详解",
        "前端开发指南",
        "数据库连接池配置"
    ]
    
    scores = client.rerank_batch(query, documents)
    # scores = [0.95, 0.12, 0.87]
```

## 依赖

- **requests**: HTTP 客户端
- **volcengine.auth.SignerV4**: 请求签名
- **volcengine.Credentials**: 认证凭证

## 注意事项

1. **API 格式**：每个文档需要包装为 `[[{"text": doc}]]` 格式
2. **分数范围**：返回 0.0-1.0 的相关性分数
3. **降级处理**：失败时返回全 0.0 分数，调用方应处理
4. **配置检查**：使用 `is_available()` 确认配置有效