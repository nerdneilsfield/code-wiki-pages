# models 模块文档

## 模块概述

`models` 模块是前端应用中负责定义和管理 AI 模型信息的核心类型模块。它提供了标准化的模型数据结构，用于在整个前端应用中统一表示和处理 AI 模型的基本信息。该模块是前端核心类型系统的重要组成部分，为模型选择、配置和使用提供了基础数据结构支持。

## 核心组件

### Model 接口

`Model` 接口是该模块的核心组件，定义了 AI 模型的标准数据结构。

```typescript
export interface Model {
  id: string;
  name: string;
  display_name: string;
  description?: string | null;
  supports_thinking?: boolean;
}
```

#### 属性说明

- **id**: `string` - 模型的唯一标识符，用于在系统内部唯一标识一个模型
- **name**: `string` - 模型的内部名称，通常用于程序逻辑中的引用
- **display_name**: `string` - 模型的显示名称，用于在用户界面中展示
- **description**: `string | null | undefined` - 可选属性，模型的描述信息，用于向用户说明模型的特点和用途
- **supports_thinking**: `boolean | undefined` - 可选属性，标识模型是否支持思考模式（如深度思考、推理过程展示等）

#### 使用场景

`Model` 接口在以下场景中广泛使用：

1. **模型列表展示**：在用户界面中展示可用的 AI 模型列表
2. **模型选择**：允许用户在会话或设置中选择特定的 AI 模型
3. **模型配置**：存储和管理用户对模型的偏好设置
4. **API 数据交换**：与后端 API 进行模型信息的数据传输

## 模块关系

`models` 模块与其他模块存在以下关系：

1. **与 gateway_api_contracts 模块**：后端通过 gateway_api_contracts 模块的 `ModelResponse` 和 `ModelsListResponse` 类型向前端传输模型数据，这些数据最终会被转换为 `Model` 类型在前端使用。

2. **与 threads 模块**：线程配置中可能包含所选模型的信息，`AgentThread` 类型可能会引用 `Model` 类型来存储当前使用的模型。

3. **与 settings 模块**：用户设置中可能包含默认模型的选择，`LocalSettings` 类型可能会使用 `Model` 类型或其标识符。

## 使用示例

### 基本使用

```typescript
import { Model } from '@/core/models/types';

// 创建一个模型对象
const gpt4Model: Model = {
  id: 'gpt-4',
  name: 'gpt-4',
  display_name: 'GPT-4',
  description: '强大的多模态模型，适用于复杂任务',
  supports_thinking: false
};

// 使用模型对象
console.log(`使用模型: ${gpt4Model.display_name}`);
```

### 在组件中使用模型列表

```typescript
import { Model } from '@/core/models/types';

interface ModelSelectorProps {
  models: Model[];
  selectedModelId: string;
  onModelSelect: (modelId: string) => void;
}

function ModelSelector({ models, selectedModelId, onModelSelect }: ModelSelectorProps) {
  return (
    <div>
      <h3>选择模型</h3>
      {models.map(model => (
        <div key={model.id}>
          <input
            type="radio"
            id={model.id}
            name="model"
            value={model.id}
            checked={model.id === selectedModelId}
            onChange={() => onModelSelect(model.id)}
          />
          <label htmlFor={model.id}>
            {model.display_name}
            {model.supports_thinking && <span> (支持思考)</span>}
          </label>
          {model.description && <p>{model.description}</p>}
        </div>
      ))}
    </div>
  );
}
```

## 注意事项

1. **可选属性处理**：在使用 `Model` 接口时，注意 `description` 和 `supports_thinking` 是可选属性，需要进行适当的空值检查。

2. **模型标识符**：`id` 属性是模型的唯一标识，在进行模型比较或选择时，应该使用 `id` 而不是 `name` 或 `display_name`。

3. **国际化考虑**：`display_name` 和 `description` 可能需要根据用户的语言环境进行本地化处理。

4. **扩展性**：未来可能会添加更多模型特性属性，使用时应考虑接口的向后兼容性。

## 相关模块

- [gateway_api_contracts 模块](./gateway_api_contracts.md) - 包含后端 API 响应的模型类型定义
- [threads 模块](./frontend_core_domain_types_and_state.md#threads) - 包含线程相关类型，可能使用模型信息
- [settings 模块](./frontend_core_domain_types_and_state.md#settings) - 包含用户设置类型，可能涉及模型偏好
