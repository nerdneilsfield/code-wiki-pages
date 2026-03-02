# wechat-decrypt 构建与代码组织分析

> 目标读者：希望理解项目构建方式、源码树结构及依赖管理的开发者

---

## 1. 项目目录结构

本项目采用**扁平化脚本结构**，所有核心模块直接置于根目录，便于独立执行和快速开发。

```mermaid
graph TD
    ROOT[wechat-decrypt/] --> CONFIG[配置层]
    ROOT --> CORE[核心解密层]
    ROOT --> MONITOR[监控服务层]
    ROOT --> SERVER[服务接口层]
    ROOT --> TOOL[工具脚本层]
    ROOT --> DOC[文档层]

    CONFIG --> GIT[.gitignore<br/>版本控制排除]
    CONFIG --> CFG_EX[config.example.json<br/>配置模板]
    CONFIG --> CFG_PY[config.py<br/>运行时配置加载]

    CORE --> FIND_KEYS[find_all_keys.py<br/>内存密钥提取]
    CORE --> DECRYPT[decrypt_db.py<br/>数据库解密]

    MONITOR --> MON[monitor.py<br/>文件系统监控]
    MONITOR --> MON_WEB[monitor_web.py<br/>Web监控界面]

    SERVER --> MCP[mcp_server.py<br/>MCP协议服务]

    TOOL --> LATENCY[latency_test.py<br/>性能测试]

    DOC --> README[README.md<br/>项目说明]
    DOC --> USAGE[USAGE.md<br/>使用指南]

    style FIND_KEYS fill:#f9f,stroke:#333,stroke-width:2px
    style DECRYPT fill:#f9f,stroke:#333,stroke-width:2px
```

### 目录职责说明

| 层级 | 文件/目录 | 职责 |
|:---|:---|:---|
| **配置层** | `config.py` + `config.example.json` | 集中管理路径、密钥文件位置等运行时配置 |
| **核心解密层** | `find_all_keys.py`, `decrypt_db.py` | 密钥提取与数据库解密的核心能力 |
| **监控服务层** | `monitor.py`, `monitor_web.py` | 实时监听微信数据库变化并自动解密 |
| **服务接口层** | `mcp_server.py` | 对外提供标准化服务接口（MCP协议） |
| **工具脚本层** | `latency_test.py` | 性能基准测试 |

> **设计特点**：无嵌套包结构，每个 `.py` 文件均为可独立执行的入口点，适合工具型项目。

---

## 2. 构建 / 编译流水线

本项目为**纯 Python 解释型项目**，无需传统编译步骤。其"构建"流程实质是**环境准备 → 依赖安装 → 入口配置**的过程。

```mermaid
flowchart TD
    subgraph ENV["1. 环境准备"]
        A[Python 3.10+] --> B[创建虚拟环境]
        B --> C[激活 venv]
    end

    subgraph DEPS["2. 依赖安装"]
        C --> D{检查构建文件}
        D -->|存在 pyproject.toml| E[pip install -e .]
        D -->|无构建文件| F[手动 pip install 依赖]
        E --> G[安装开发依赖组]
        F --> H[安装 runtime 依赖<br/>pycryptodome, watchdog, flask, ...]
    end

    subgraph CONFIG_STEP["3. 配置初始化"]
        H --> I[复制 config.example.json]
        I --> J[编辑为 config.json]
        J --> K[验证微信进程可访问]
    end

    subgraph RUN["4. 运行入口"]
        K --> L[python find_all_keys.py<br/>提取密钥]
        L --> M[生成 all_keys.json]
        M --> N[下游模块就绪]
        N --> O1[python decrypt_db.py]
        N --> O2[python monitor.py]
        N --> O3[python mcp_server.py]
        N --> O4[python monitor_web.py]
    end

    style L fill:#f9f,stroke:#333,stroke-width:2px
    style M fill:#ff9,stroke:#333,stroke-width:2px
```

### 关键构建产物

| 产物 | 生成方式 | 用途 |
|:---|:---|:---|
| `all_keys.json` | `find_all_keys.py` 运行时生成 | 下游所有模块的必需输入 |
| `config.json` | 开发者手动配置 | 运行时参数（路径、端口等） |
| 解密后的 `.db` 文件 | `decrypt_db.py` / `monitor.py` | 最终可用数据 |

---

## 3. 依赖管理

### 3.1 依赖声明现状

**当前状态**：项目未配置标准 Python 构建文件（无 `pyproject.toml` / `setup.py` / `requirements.txt`），依赖处于**隐式管理**状态。

```mermaid
graph TD
    subgraph CURRENT["当前状态：隐式依赖"]
        A[源码 import 语句] --> B[人工识别依赖]
        B --> C[手动 pip install]
        C --> D[本地环境生效]
    end

    subgraph RECOMMENDED["推荐改进：显式管理"]
        E[创建 pyproject.toml] --> F[声明依赖组]
        F --> G1[prod: pycryptodome,<br/>watchdog, flask, waitress]
        F --> G2[dev: pytest, black,<br/>mypy, pylint]
        F --> G3[test: pytest-cov,<br/>pytest-asyncio]
        G1 --> H[pip install -e ".[dev,test]"]
    end

    style CURRENT fill:#fee,stroke:#933
    style RECOMMENDED fill:#efe,stroke:#393
```

### 3.2 推断的运行时依赖

通过分析源码 `import` 语句，识别出以下依赖：

| 模块 | 依赖包 | 用途 |
|:---|:---|:---|
| `find_all_keys.py` | `ctypes` (内置), `re` (内置) | Windows API 调用、内存扫描 |
| `decrypt_db.py` | `pycryptodome` | SQLCipher 4 解密 (PBKDF2, AES-256-CBC, HMAC-SHA512) |
| `monitor.py` | `watchdog` | 文件系统事件监控 |
| `monitor_web.py` | `flask`, `waitress` | Web 服务与 WSGI 服务器 |
| `mcp_server.py` | `asyncio` (内置), `json` (内置) | MCP 协议实现 |
| `latency_test.py` | `time`, `statistics` (内置) | 性能测量 |

### 3.3 推荐的 pyproject.toml 配置

```toml
[project]
name = "wechat-decrypt"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "pycryptodome>=3.19.0",
    "watchdog>=3.0.0",
    "flask>=2.3.0",
    "waitress>=2.1.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.4.0",
    "black>=23.0.0",
    "mypy>=1.5.0",
    "pylint>=2.17.0",
]
test = [
    "pytest-cov>=4.1.0",
    "pytest-asyncio>=0.21.0",
]

[project.scripts]
wechat-find-keys = "find_all_keys:main"
wechat-decrypt = "decrypt_db:main"
wechat-monitor = "monitor:main"
wechat-mcp-server = "mcp_server:main"

[tool.setuptools]
py-modules = [
    "config",
    "find_all_keys",
    "decrypt_db",
    "monitor",
    "monitor_web",
    "mcp_server",
    "latency_test",
]
```

### 3.4 版本锁定策略

```mermaid
flowchart LR
    subgraph LOCK["版本锁定方案"]
        A[pyproject.toml<br/>宽松约束] --> B[pip-compile<br/>或 poetry lock]
        B --> C[生成 requirements.lock]
        C --> D[CI/CD 使用锁定文件]
        D --> E[可复现构建]
    end

    A --> F[开发环境<br/>允许小版本更新]
    C --> G[生产部署<br/>精确版本匹配]
```

---

## 4. 多语言协作

本项目以 **Python 为主语言**，但涉及关键的**跨语言交互场景**：

```mermaid
graph TD
    subgraph PYTHON["Python 层"]
        A[find_all_keys.py] --> B[ctypes 绑定]
        C[decrypt_db.py] --> D[pycryptodome<br/>C扩展]
    end

    subgraph NATIVE["原生/系统层"]
        B --> E[Windows API<br/>kernel32.dll]
        E --> F[OpenProcess<br/>VirtualQueryEx<br/>ReadProcessMemory]
        D --> G[OpenSSL<br/>底层加密实现]
    end

    subgraph TARGET["目标进程"]
        F --> H[Weixin.exe 内存空间]
        H --> I[WCDB 密钥缓存]
        I --> J[提取 x'...' 格式密钥]
    end

    subgraph DATA["数据流"]
        J --> K[all_keys.json]
        K --> L[Python 解密模块]
        G --> M[SQLCipher 4<br/>数据库解密]
    end

    style E fill:#f9f,stroke:#333,stroke-width:2px
    style F fill:#f9f,stroke:#333,stroke-width:2px
```

### 4.1 Python ↔ Windows API（核心机制）

`find_all_keys` 模块通过 `ctypes` 直接调用 Windows 内核 API，这是项目的核心技术点：

| Python 组件 | 对应 Windows API | 功能 |
|:---|:---|:---|
| `MBI` 结构体 | `MEMORY_BASIC_INFORMATION` | 内存区域元数据 |
| `enum_regions()` | `VirtualQueryEx` | 枚举进程虚拟地址空间 |
| `read_mem()` | `ReadProcessMemory` | 读取目标进程内存内容 |
| `get_pid()` | `tasklist` + `subprocess` | 定位微信进程 |

### 4.2 Python ↔ C 加密库

`pycryptodome` 作为 C 扩展模块，提供高性能密码学操作：

- `Crypto.Protocol.KDF.PBKDF2` — 密钥派生
- `Crypto.Cipher.AES` — AES-256-CBC 解密
- `Crypto.Hash.HMAC` — HMAC-SHA512 验证

---

## 5. 开发工作流

### 5.1 环境初始化命令

```bash
# 1. 克隆仓库
git clone <repo-url>
cd wechat-decrypt

# 2. 创建虚拟环境（推荐）
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS/Linux
source .venv/bin/activate

# 3. 安装依赖（当前：手动模式）
pip install pycryptodome watchdog flask waitress

# 3'. 若已配置 pyproject.toml（推荐未来采用）
pip install -e ".[dev,test]"
```

### 5.2 核心开发命令

```mermaid
flowchart TD
    subgraph DEV["日常开发"]
        A[编辑源码] --> B[python find_all_keys.py]
        B --> C{密钥提取成功?}
        C -->|是| D[生成 all_keys.json]
        C -->|否| E[检查微信运行状态<br/>管理员权限]
        D --> F[python decrypt_db.py --db <path>]
        F --> G[验证解密结果]
    end

    subgraph TEST["测试验证"]
        H[pytest tests/] --> I[单元测试]
        H --> J[集成测试<br/>模拟内存结构]
        I --> K[覆盖率报告]
    end

    subgraph SERVE["服务启动"]
        L[python monitor.py] --> M[后台监控模式]
        N[python monitor_web.py] --> O[Web界面<br/>http://localhost:5000]
        P[python mcp_server.py] --> Q[MCP服务<br/>stdio/sse模式]
    end

    subgraph PERF["性能调优"]
        R[python latency_test.py] --> S[测量解密耗时]
        S --> T[优化热点代码]
    end

    style B fill:#f9f,stroke:#333,stroke-width:2px
    style F fill:#f9f,stroke:#333,stroke-width:2px
```

### 5.3 常用命令速查

| 场景 | 命令 | 说明 |
|:---|:---|:---|
| **首次密钥提取** | `python find_all_keys.py` | 需管理员权限，微信正在运行 |
| **单次解密** | `python decrypt_db.py --db "C:\...\MicroMsg.db"` | 解密指定数据库 |
| **启动监控** | `python monitor.py` | 后台监听文件变化自动解密 |
| **启动 Web 服务** | `python monitor_web.py` | 浏览器访问监控界面 |
| **启动 MCP 服务** | `python mcp_server.py` | 提供标准化 API 接口 |
| **性能测试** | `python latency_test.py` | 测量各环节耗时 |

### 5.4 调试与故障排查

```bash
# 验证 Python 路径和版本
python -c "import sys; print(sys.executable, sys.version)"

# 检查依赖安装
python -c "import Crypto, watchdog, flask; print('OK')"

# 模块直接运行测试（利用 __main__ 块）
python -m find_all_keys  # 若已配置为包

# 详细日志输出（建议添加 logging 配置）
python find_all_keys.py --verbose  # 需实现参数解析
```

### 5.5 推荐的 CI/CD 流水线

```mermaid
flowchart LR
    A[Push/PR] --> B[Lint<br/>black, mypy, pylint]
    B --> C[Test<br/>pytest]
    C --> D[Build<br/>wheel/sdist]
    D --> E[Release<br/>GitHub Release]
    
    subgraph QUALITY["质量门禁"]
        B --> F[代码风格检查]
        C --> G[测试覆盖率 >80%]
    end
    
    style B fill:#ff9,stroke:#333
    style C fill:#ff9,stroke:#333
```

---

## 附录：模块依赖关系图

```mermaid
graph TD
    CONFIG[config.py<br/>配置中心] --> FIND[find_all_keys.py]
    CONFIG --> DECRYPT[decrypt_db.py]
    CONFIG --> MON[monitor.py]
    CONFIG --> MON_WEB[monitor_web.py]
    CONFIG --> MCP[mcp_server.py]
    
    FIND --> KEYS[(all_keys.json)]
    KEYS --> DECRYPT
    KEYS --> MON
    KEYS --> MON_WEB
    KEYS --> MCP
    
    DECRYPT -.->|被调用| MON
    DECRYPT -.->|被调用| MON_WEB
    
    style CONFIG fill:#f9f,stroke:#333,stroke-width:2px
    style KEYS fill:#ff9,stroke:#333,stroke-width:2px
    style FIND fill:#9cf,stroke:#333,stroke-width:2px
```

> **关键洞察**：`find_all_keys.py` 是整个工具链的**前置瓶颈**——所有下游模块均依赖其生成的 `all_keys.json`。该模块的成功执行需要**运行时环境配合**（微信进程+管理员权限），这是构建系统无法预置的，需在部署文档中明确说明。