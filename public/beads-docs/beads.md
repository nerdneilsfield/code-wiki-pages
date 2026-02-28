# beads 模块技术深度剖析

## 1. 模块概述

`beads` 模块是整个项目的基础入口和定位服务，负责发现和定位项目中的 `.beads` 目录及数据库文件。它是系统的"指南针"，为其他所有模块提供正确的工作路径。

### 问题背景

在大型软件开发项目中，特别是使用 Git 工作树、多仓库或分布式团队协作时，如何准确且一致地定位项目的状态存储位置是一个复杂的问题。用户可能：
- 在任意子目录中运行命令
- 使用 Git 工作树（worktree）功能
- 需要在多个仓库间共享 beads 数据
- 希望将 beads 数据存储在非标准位置

一个简单的"在当前目录查找 `.beads`"的方案无法满足这些复杂需求。

### 设计洞察

`beads` 模块采用了分层搜索策略，结合环境变量、Git 仓库边界、重定向机制和工作树支持，提供了一个健壮的定位系统。它就像一个智能的路径导航系统，能够在各种复杂环境中找到正确的目的地。

## 2. 核心概念与心智模型

### 2.1 主要抽象

#### RedirectInfo
```go
type RedirectInfo struct {
    IsRedirected bool   // 是否存在重定向
    LocalDir     string // 包含重定向文件的本地 .beads 目录
    TargetDir    string // 实际使用的目标 .beads 目录
}
```

这个结构体封装了重定向信息，允许项目将 `.beads` 目录指向另一个位置。

#### DatabaseInfo
```go
type DatabaseInfo struct {
    Path       string // 数据库完整路径
    BeadsDir   string // 父级 .beads 目录
    IssueCount int    // 问题数量（未知时为 -1）
}
```

描述找到的数据库信息，包括位置和基本元数据。

### 2.2 心智模型

想象 `beads` 模块是一个**智能仓库定位器**，它的工作方式类似于：

1. **环境优先**：先检查用户是否通过环境变量明确指定了位置
2. **智能搜索**：从当前目录向上搜索，直到找到 Git 仓库根目录
3. **重定向支持**：如果找到 `.beads/redirect` 文件，就跟随到目标位置
4. **工作树感知**：理解 Git 工作树，优先使用主仓库的 beads 数据
5. **边界限制**：不会越过 Git 仓库边界去搜索，避免找到不相关的数据

这种设计使得 beads 可以适应各种开发场景，同时保持行为的可预测性。

## 3. 架构与数据流

### 3.1 搜索优先级链

`beads` 模块的核心是一套精心设计的搜索优先级：

```
BEADS_DIR → BEADS_DB (已弃用) → 本地目录树搜索
     ↓
   重定向跟随
     ↓
   工作树处理
     ↓
   有效性验证
```

### 3.2 关键组件交互

下面是主要函数之间的调用关系：

```
FindDatabasePath()
  ├─ FollowRedirect()
  ├─ findDatabaseInBeadsDir()
  │   └─ configfile.Load()
  └─ findDatabaseInTree()
      ├─ findGitRoot()
      └─ worktreeRedirectTarget()

FindBeadsDir()
  ├─ FollowRedirect()
  ├─ hasBeadsProjectFiles()
  └─ worktreeRedirectTarget()

GetRedirectInfo()
  ├─ findLocalBdsDirInRepo()
  └─ checkRedirectInDir()
```

## 4. 核心组件深度解析

### 4.1 FollowRedirect - 重定向跟随

```go
func FollowRedirect(beadsDir string) string
```

**设计意图**：允许项目通过简单的文本文件将 `.beads` 目录重定向到其他位置，这对于多仓库协作或特殊存储需求非常有用。

**工作原理**：
1. 读取 `.beads/redirect` 文件
2. 解析文件内容，忽略注释和空行
3. 解析相对路径时，从项目根目录（而不是 `.beads` 目录）开始解析
4. 验证目标目录存在且是有效目录
5. **防止重定向链**：不允许目标目录也包含重定向文件

**关键决策**：
- 不支持重定向链：这是为了避免无限循环和不可预测的行为
- 相对路径从项目根解析：这样重定向文件可以使用相对于项目的路径，更具可移植性

### 4.2 FindDatabasePath - 数据库定位

```go
func FindDatabasePath() string
```

**设计意图**：提供统一的数据库发现入口，支持多种配置方式和复杂场景。

**搜索策略**：
1. **BEADS_DIR**：优先检查环境变量，这是最明确的指定方式
2. **BEADS_DB**：支持已弃用的直接数据库路径指定（保持向后兼容）
3. **目录树搜索**：从当前目录向上搜索，直到 Git 仓库根目录

**与 Git 的集成**：
- 使用 Git 仓库根目录作为搜索边界，避免找到不相关的数据库
- 特别处理 Git 工作树场景，优先使用主仓库的 beads 数据

### 4.3 FindBeadsDir - 目录定位

```go
func FindBeadsDir() string
```

**设计意图**：定位 `.beads` 目录本身，即使没有数据库文件也能工作。

**特殊功能**：
- **项目文件验证**：使用 `hasBeadsProjectFiles()` 确保找到的目录确实是 beads 项目目录，而不是只包含守护进程注册表文件的 `~/.beads`
- **工作树支持**：优先检查工作树本地重定向，然后回退到主仓库

**与 FindDatabasePath 的区别**：
- `FindBeadsDir` 只需要找到有效的 `.beads` 目录
- `FindDatabasePath` 需要找到实际的数据库文件

### 4.4 GetRedirectInfo - 重定向信息获取

```go
func GetRedirectInfo() RedirectInfo
```

**设计意图**：检测当前是否使用了重定向，即使 `BEADS_DIR` 已经被设置为重定向目标。

**关键特性**：
- **双重检查**：即使 `BEADS_DIR` 已设置，仍然会检查 Git 仓库的本地 `.beads` 目录是否有重定向文件
- **场景支持**：处理工具链或 shell 环境预先设置 `BEADS_DIR` 为重定向目标的情况

## 5. 设计决策与权衡

### 5.1 重定向链的限制

**决策**：不支持重定向链（目标目录不能也有重定向文件）

**权衡**：
- ✅ 优点：避免无限循环，行为可预测
- ❌ 缺点：某些复杂场景无法支持

**理由**：在实际使用中，单级重定向已经足够满足绝大多数需求，而防止无限循环和调试复杂性的收益更大。

### 5.2 Git 边界限制

**决策**：搜索在 Git 仓库根目录停止

**权衡**：
- ✅ 优点：不会找到不相关的 beads 项目，行为更可预测
- ❌ 缺点：在非 Git 项目中，搜索会一直到文件系统根目录

**理由**：绝大多数 beads 使用场景都是在 Git 仓库中，这个限制提供了良好的默认行为。

### 5.3 工作树的特殊处理

**决策**：Git 工作树优先使用主仓库的 beads 数据，除非工作树有自己的重定向

**权衡**：
- ✅ 优点：工作树共享同一组 beads 数据，符合直觉
- ❌ 缺点：需要额外的逻辑来处理工作树场景

**理由**：Git 工作树通常用于同一项目的不同分支，共享 beads 数据是合理的默认行为。

### 5.4 环境变量优先级

**决策**：环境变量优先于自动发现

**权衡**：
- ✅ 优点：用户可以明确控制使用哪个 beads 目录
- ❌ 缺点：可能导致混淆，特别是当环境变量被意外设置时

**理由**：显式配置应该优先于隐式发现，这是 Unix 工具的常见行为模式。

## 6. 使用指南与常见模式

### 6.1 基本使用

**定位数据库**：
```go
dbPath := beads.FindDatabasePath()
if dbPath == "" {
    // 处理未找到数据库的情况
}
```

**定位 beads 目录**：
```go
beadsDir := beads.FindBeadsDir()
if beadsDir == "" {
    // 处理未找到 beads 目录的情况
}
```

### 6.2 重定向配置

在项目根目录创建 `.beads/redirect` 文件：
```
# 将 beads 数据重定向到另一个位置
../shared-beads-data
```

或者使用绝对路径：
```
/opt/shared-beads/project-x
```

### 6.3 环境变量使用

临时指定 beads 目录：
```bash
BEADS_DIR=/path/to/my/beads bd status
```

## 7. 边缘情况与注意事项

### 7.1 重定向验证

重定向文件中的路径会被验证，但如果目标路径在重定向设置后被删除或移动，`FollowRedirect` 会优雅地回退到原始路径，并向 stderr 输出警告。

### 7.2 工作树边界

在 Git 工作树中，搜索边界会扩展到包含主仓库，但同时也会保留工作树的边界，以防止搜索到不相关的目录。

### 7.3 符号链接处理

路径会被规范化，符号链接会被解析，以避免通过不同路径访问同一数据库时出现重复。

### 7.4 项目文件验证

`hasBeadsProjectFiles` 确保找到的目录确实是 beads 项目目录，它会检查：
- `metadata.json` 或 `config.yaml`
- `dolt/` 目录
- 非备份、非 `vc.db` 的 `.db` 文件

这防止了返回只包含守护进程注册表的 `~/.beads` 目录。

## 8. 与其他模块的关系

`beads` 模块是整个系统的基础，被许多其他模块依赖：

- **[Beads Repository Context](Beads Repository Context.md)**：本模块是其核心组成部分之一
- **[Storage Interfaces](Storage Interfaces.md)**：使用 `beads` 定位数据库文件
- **[Configuration](Configuration.md)**：使用 `beads` 定位配置文件
- **CLI 命令**：几乎所有命令都需要首先找到 beads 目录

`beads` 模块本身依赖：
- **configfile**：加载 `metadata.json` 配置
- **git**：Git 仓库相关操作
- **utils**：路径规范化等工具函数

## 9. 总结

`beads` 模块是一个看似简单但设计精良的定位系统，它解决了在复杂开发环境中一致定位项目状态存储的问题。通过分层搜索策略、重定向机制、Git 集成和工作树支持，它提供了一个既灵活又可预测的解决方案。

这个模块的设计体现了几个重要的原则：
1. **显式优先于隐式**：环境变量优先于自动发现
2. **防御性设计**：防止重定向链，验证路径有效性
3. **实用主义**：不追求理论上的完美，而是解决实际问题
4. **向后兼容**：保留对已弃用功能的支持

对于新贡献者，理解这个模块的关键是认识到它是整个系统的"导航系统"，所有其他组件都依赖它来找到正确的工作位置。
