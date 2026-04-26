# OpenAI vs Azure OpenAI `chat/completions` 差异分析

本文基于以下两个 OpenAPI 规范文件整理：

- `openapi/openai.yml`
- `openapi/azure-openai.yml`

并进一步对照当前代码实现：

- `src/types/openai.ts`
- `src/utils/azureOpenAI.ts`
- `src/server/handlers.ts`

目标有两部分：

1. 说明 OpenAI 与 Azure OpenAI 在 `chat/completions` 接口上的差异。
2. 标出规范中存在、但当前代码里还没有显式覆盖或没有实际消费的字段。

---

## 一、接口级差异

## 1. 路径能力不同

### OpenAI
在 `openapi/openai.yml:3080`，`/chat/completions` 同时包含：

- `GET /chat/completions`
- `POST /chat/completions`

其中 `GET` 用于列出已存储的 chat completions。

### Azure OpenAI
在 `openapi/azure-openai.yml:662`，`/chat/completions` 只有：

- `POST /chat/completions`

### 结论
Azure 规范只保留“创建 chat completion”，没有 OpenAI 的 list/stored completion 查询能力。

---

## 2. Azure 多了 `api-version` query 参数

Azure 在 `POST /chat/completions` 上额外定义了：

- `api-version`

位置：`openapi/azure-openai.yml:667`

说明：

- 非必填
- 默认 `v1`

OpenAI 官方规范没有这个 query 参数。

### 对当前项目的影响
当前 `src/utils/azureOpenAI.ts:32` 只是把 URL 拼成：

- `${baseUrl}/chat/completions`

没有额外附带 `api-version`。

不过当前项目的 Azure 判定只接受 `/openai/v1` 形态的 base URL，见 `src/utils/provider.ts:10`，因此这和当前支持范围是一致的。

---

## 二、请求体差异

## 1. 两边共有的核心字段

OpenAI 与 Azure 两边都覆盖了当前项目最依赖的字段：

- `model`
- `messages`
- `temperature`
- `top_p`
- `stream`
- `stream_options`
- `stop`
- `presence_penalty`
- `frequency_penalty`
- `logit_bias`
- `max_tokens`
- `max_completion_tokens`
- `n`
- `seed`
- `tools`
- `tool_choice`
- `parallel_tool_calls`
- `function_call`
- `functions`
- `response_format`
- `audio`
- `store`
- `metadata`
- `logprobs`
- `top_logprobs`
- `modalities`
- `reasoning_effort`
- `verbosity`

这也是为什么当前 adapter 的主链路在大方向上可以兼容 Azure v1。

---

## 2. OpenAI 规范中更完整的能力

### OpenAI 有 `web_search_options`
位置：`openapi/openai.yml:36948`

这是 OpenAI 官方 chat/completions 中更平台化的扩展之一，Azure 当前这份规范里没有对应字段。

### OpenAI 的 `model` 约束更强
位置：`openapi/openai.yml:36906`

OpenAI 使用 `ModelIdsShared` 引用，而 Azure 这里直接是普通 `string`：

- `openapi/azure-openai.yml:882`

### 结论
OpenAI 官方规范整体更“平台产品化”，而 Azure 更偏“兼容 OpenAI 主要字段 + Azure 自己的扩展能力”。

---

## 3. Azure 专属请求字段

Azure 在请求体里额外定义了以下字段：

- `safety_identifier` — `openapi/azure-openai.yml:858`
- `prompt_cache_key` — `openapi/azure-openai.yml:863`
- `prompt_cache_retention` — `openapi/azure-openai.yml:866`
- `user_security_context` — `openapi/azure-openai.yml:1074`

同时，Azure 这里的 `user` 被标记为 deprecated：

- `openapi/azure-openai.yml:852`

### 含义
这些字段主要是两类能力：

1. **安全/用户识别**
   - `safety_identifier`
   - `user_security_context`

2. **提示缓存**
   - `prompt_cache_key`
   - `prompt_cache_retention`

### 对当前项目的影响
当前 `src/types/openai.ts:3` 的 `OpenAIChatRequest` 中没有这些字段，因此即使未来上层想传，也没有显式类型支持。

---

## 三、响应体差异

## 1. OpenAI 把普通响应和流式 chunk 分开建模

OpenAI 单独定义了：

- `CreateChatCompletionResponse` — `openapi/openai.yml:37273`
- `CreateChatCompletionStreamResponse` — `openapi/openai.yml:37423`

Azure 则是在 `200` 响应中使用 `anyOf`，把普通响应和流式 chunk 放在一个响应定义里：

- `openapi/azure-openai.yml:688`

这是规范组织方式不同，不一定意味着协议不兼容，但会影响生成 SDK 或手工建模时的思路。

---

## 2. Azure 额外返回 `apim-request-id`

Azure 在响应 header 中定义：

- `apim-request-id` — `openapi/azure-openai.yml:680`

这是 Azure 的请求追踪信息。

### 对当前项目的影响
当前 `src/utils/azureOpenAI.ts:125` 和 `src/utils/azureOpenAI.ts:142` 只解析 body，不会提取这个 header，也不会回传给下游。

---

## 3. Azure 非流式响应多了内容过滤结果

Azure 非流式响应多了：

- `prompt_filter_results` — `openapi/azure-openai.yml:726`

OpenAI 官方 `CreateChatCompletionResponse` 中没有这个字段。

### 对当前项目的影响
当前 `src/types/openai.ts:100` 的 `OpenAIChatResponse` 没有定义这个字段；
`src/converters/response.ts:15` 也不会消费它。

---

## 4. Azure 流式响应多了内容过滤结果

Azure 流式 chunk 中多了：

- `content_filter_results` — `openapi/azure-openai.yml:792`

### 对当前项目的影响
当前 `src/types/openai.ts:126` 的 `OpenAIStreamChunk` / `OpenAIStreamChoice` 没有这个字段；
`src/converters/streaming.ts:112` 和 `src/converters/xmlStreaming.ts:83` 也没有处理它。

---

## 5. Azure 流式 delta 多了 `reasoning_content`

Azure 的流式 delta schema：

- `OpenAI.ChatCompletionStreamResponseDelta` — `openapi/azure-openai.yml:12240`

比标准 OpenAI 多了：

- `reasoning_content` — `openapi/azure-openai.yml:12269`

描述很明确：

> Azure-specific extension property containing generated reasoning content from supported models.

### 对当前项目的影响
当前 `src/types/openai.ts:141` 的 `OpenAIStreamDelta` 只有：

- `role`
- `content`
- `tool_calls`

没有 `reasoning_content`。

这意味着：

- Azure 如果真的返回 reasoning 增量，当前代码会忽略它。
- 由于 `streamOpenAIToAnthropic` 和 `streamXmlOpenAIToAnthropic` 都只读取 `delta.content` / `delta.tool_calls`，这部分信息不会被转给 Claude Code。

---

## 四、错误响应差异

Azure 的默认错误响应在路径上被明确展开：

- `code`
- `message`
- `param`
- `type`
- `inner_error`

位置：`openapi/azure-openai.yml:794`

当前 `src/utils/azureOpenAI.ts:6` 定义的 `AzureErrorShape` 只覆盖了：

- `error.message`
- `error.code`
- `error.type`
- 顶层 `message`

也就是说，当前项目只拿了最关键的错误消息字段，没对完整 Azure error payload 建模。

---

## 五、结合代码看：规范有但当前代码没显式覆盖的字段

下面按“请求 / 非流式响应 / 流式响应 / 错误结构”四类列出。

## 1. 请求字段：规范里有，但 `src/types/openai.ts` 没建模

当前 `OpenAIChatRequest` 定义见：`src/types/openai.ts:3`

### Azure 专属未覆盖
- `safety_identifier`
- `prompt_cache_key`
- `prompt_cache_retention`
- `user_security_context`

### OpenAI 规范字段未覆盖
- `modalities`
- `verbosity`
- `reasoning_effort`
- `response_format`
- `audio`
- `store`
- `logprobs`
- `top_logprobs`
- `prediction`
- `parallel_tool_calls`
- `function_call`
- `functions`
- `metadata`
- `web_search_options`

### 说明
这些字段不是说一定“完全不能透传”，而是：

- 当前类型里没声明
- 当前 `convertRequestToOpenAI` 也基本没有从 Anthropic 请求侧构造这些字段
- 因此目前主链路不会主动使用它们

---

## 2. message 类型：规范里更丰富，但当前类型只覆盖子集

当前消息类型定义见：`src/types/openai.ts:24`

### 未覆盖的 role / message 形态
OpenAI 规范示例中已出现 `developer` role：
- `openapi/openai.yml:3326`

Azure 的流式 delta role 枚举中也允许：
- `developer`
- `system`
- `user`
- `assistant`
- `tool`

位置：`openapi/azure-openai.yml:12256`

而当前代码里：
- `OpenAISystemMessage.role = 'system'`
- `OpenAIUserMessage.role = 'user'`
- `OpenAIAssistantMessage.role = 'assistant'`
- `OpenAIToolMessage.role = 'tool'`

没有 `developer` message 类型。

### 结果
如果未来上游或内部调用需要严格支持 developer role，当前类型层不完整。

---

## 3. 非流式响应：规范里有，但 `OpenAIChatResponse` 没覆盖

当前定义：`src/types/openai.ts:100`

### OpenAI 规范中未覆盖
- `service_tier`
- `choices[].logprobs`
- `choices[].message.refusal`
- `choices[].message.annotations`
- `choices[].message.function_call`
- `usage.completion_tokens_details`
- `usage.prompt_tokens_details.audio_tokens`

### Azure 规范中未覆盖
- `prompt_filter_results`

### 说明
当前 adapter 的响应转换只依赖：

- `choices[0].message.content`
- `choices[0].message.tool_calls`
- `choices[0].finish_reason`
- `usage.prompt_tokens`
- `usage.completion_tokens`
- `usage.prompt_tokens_details.cached_tokens`

也就是说，现有实现采用了“够用子集”，不是完整建模。

---

## 4. 流式响应：规范里有，但 `OpenAIStreamChunk` / `OpenAIStreamDelta` 没覆盖

当前定义：

- `OpenAIStreamChunk` — `src/types/openai.ts:126`
- `OpenAIStreamChoice` — `src/types/openai.ts:135`
- `OpenAIStreamDelta` — `src/types/openai.ts:141`

### 未覆盖字段
- `service_tier`
- `choices[].logprobs`
- `delta.function_call`
- `delta.refusal`
- `delta.reasoning_content`（Azure 专属）
- `choices[].content_filter_results`（Azure 专属）

### 结果
这些字段即使上游返回：

- 当前类型不表达，或只靠 `any` 穿过
- 当前流式转换器也不会产出对应的 Anthropic 事件

---

## 5. Azure transport 层未显式处理的内容

### `apim-request-id` response header
规范中有，当前 `src/utils/azureOpenAI.ts` 未提取。

### 完整错误结构
规范中有更完整 error body，当前 `AzureErrorShape` 只提取最小子集。

### `api-version`
规范支持 query 参数，当前项目没有提供单独控制入口。

---

## 六、当前代码已经覆盖得比较好的部分

虽然上面列了不少“未覆盖”，但对 adapter 当前目标来说，真正核心的兼容点其实已经做得不错：

1. **请求发送**
   - `model`
   - `messages`
   - `stream`
   - `temperature`
   - `top_p`
   - `stop`
   - `tools`
   - `tool_choice`
   - `max_tokens` / `max_completion_tokens`

2. **Azure token 字段兼容**
   - 自动根据 400 错误在 `max_tokens` 和 `max_completion_tokens` 之间切换
   - 位置：`src/utils/provider.ts:57`、`src/utils/azureOpenAI.ts:70`

3. **普通响应转换**
   - 文本内容
   - tool calls
   - usage

4. **流式响应转换**
   - 文本增量
   - tool call 增量
   - usage 尾块

所以现状不是“Azure 不兼容”，而是：

**当前实现覆盖了 adapter 运行所需的最小核心子集，但没有覆盖 OpenAI/Azure 规范中的完整高级字段集合。**

---

## 七、建议优先级

如果后续要补齐规范覆盖，建议优先级如下：

### P1：高价值
- `OpenAIStreamDelta.reasoning_content`
- Azure `prompt_filter_results`
- Azure `content_filter_results`
- `apim-request-id` 提取与日志记录

### P2：中价值
- `response_format`
- `parallel_tool_calls`
- `metadata`
- `logprobs` / `top_logprobs`
- `service_tier`
- `usage.completion_tokens_details`

### P3：按需支持
- `safety_identifier`
- `prompt_cache_key`
- `prompt_cache_retention`
- `user_security_context`
- `web_search_options`
- `developer` role
- `prediction`
- `audio` / `modalities`

---

## 八、一句话总结

OpenAI 与 Azure OpenAI 在 `chat/completions` 上总体兼容，但 Azure 增加了 **内容过滤、推理增量、安全标识、提示缓存、请求追踪** 等扩展能力；而当前项目只实现了运行代理所需的核心子集，尚未显式覆盖这些高级字段。
