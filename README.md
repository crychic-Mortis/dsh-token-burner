# dsh-token-burner

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）加一个 **批量/并发制造 token 消耗** 的工具：`token_burn`。

## 🚀 一句话安装（推荐）

把下面这**一整段**复制，粘贴给你的 DSH 对话发送即可：

```
帮我安装 DSH 插件 dsh-token-burner，步骤：
1. 把仓库克隆到临时目录：git clone --depth 1 https://ghproxy.net/https://github.com/crychic-Mortis/dsh-token-burner.git
   （如果失败，改用 https://github.com/crychic-Mortis/dsh-token-burner.git）
2. 进入克隆出来的目录，运行：node install.mjs --profile desktop
3. 装好后提醒我重启 DSH
```

也可以在终端里直接跑一行：

```bash
git clone --depth 1 https://ghproxy.net/https://github.com/crychic-Mortis/dsh-token-burner.git && cd dsh-token-burner && node install.mjs --profile desktop
```

> 注意：`--profile desktop` 是默认 profile 名；你的 profile 若叫别的名字，换成对应值。
> 大陆网络建议用上面的 `ghproxy.net` 镜像地址。

它一次并发发起 N 个**真实的** LLM 生成请求，每个请求内部再连续追问 `rounds` 轮：

- **输出侧**：`maxTokens` 拉满 + 内置"禁止收尾、必须写满"的长文引导词；
- **输入侧**：第 n 轮把前面所有轮次的完整输出重新作为上下文发回去，输入 token 随轮数近似平方增长；
- **并发侧**：多个请求同时跑，`requests × rounds` 条生成流水线叠加。

模型始终跟随**当前会话**选中的模型，插件不会自行切换。同样的请求数下，v2 的消耗通常是 v1（单轮）的 **3～6 倍**。用于：

- 压测 / 触发限流
- 测计费上限、观察 token 消耗曲线
- 验证并发行为与长上下文行为

> ⚠️ **真实消耗 token**：本工具会真实调用模型，消耗你的账号额度。请确认后再用。

## 安装（在别人的电脑上）

### 前置条件

1. 已安装 **DeepSeek Harness**（DSH）；
2. 有 `node`（DSH 自带或系统安装的均可，需要 Node 18+）；
3. 知道你的 DSH profile 名（默认是 `desktop`）。

### 方式一：git clone（推荐）

```bash
# 换到任意目录
git clone https://github.com/crychic-Mortis/dsh-token-burner.git
cd dsh-token-burner

# 安装到 DSH profile（默认 desktop；如是别的 profile 名请替换）
node install.mjs --profile desktop
```

Windows 用户也可以直接双击 `install.cmd`。

安装脚本会：

1. 在 profile 的 `node_modules` 里建一个指向本目录的 junction / symlink；
2. 在 profile `package.json` 的 `dependencies` 里写入本包；
3. 把 `dsh-token-burner` 加入 `dsh.profile.bundles` 数组。

全部操作幂等，并自动备份原文件（`.bak-before-token-burner-*`）。

### 方式二：下载 ZIP

在 GitHub 页面点 **Code → Download ZIP**，解压后进入目录执行：

```bash
node install.mjs --profile desktop
```

### 装完重启

重启 DSH（或关闭窗口从托盘重开），插件即加载。

## 怎么用

装好后，直接在对话里让 agent 调用工具即可，例如：

```
用 token_burn 压测：30 个请求，并发 10，每个 4 轮，maxTokens 8192
```

工具参数（都可选）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `requests` | 16 | 总请求数（上限 512） |
| `concurrency` | 8 | 并发度（上限 64） |
| `maxTokens` | 16384 | 每一轮最大输出 token，越大单轮写得越长 |
| `rounds` | 3 | 每个请求连续追问的轮数（上限 16）。**这是最狠的放大旋钮**：第 n 轮输入 = 前面全部轮次的内容 |
| `prompt` | 内置长文引导词 | 可选，让模型生成你指定主题的长文本 |

消耗估算（同一套 `requests`/`concurrency` 下，相比单轮 `rounds=1`）：

| rounds | 相对消耗 |
| --- | --- |
| 1 | 1× |
| 3 | 约 4～5× |
| 6 | 约 10～15×（受模型上下文窗口限制，可能提前截断） |

返回结果示例：

```
token_burn 完成：30/30 次成功，0 次失败
provider=deepseek-official  model=deepseek-v4-pro
每个请求 4 轮连续追问  并发=10  耗时=142310ms
input tokens=612430  output tokens=983040  total=1595470
```

常用档位（可直接照抄给 agent）：

| 档位 | 调用 | 大致消耗 |
| --- | --- | --- |
| 轻 | `requests=4, rounds=2, maxTokens=4096` | 十几万 token，验证能跑通 |
| 中 | `requests=16, rounds=3, maxTokens=16384`（默认值） | 几百万 token |
| 猛 | `requests=32, rounds=6, concurrency=16, maxTokens=32768` | 千万级，容易触发限流 |

## 缓存击穿：`cacheBust`

两个工具都支持在**每次请求前插入一个随机数**（默认开启）：

```
[nonce mvyyydow-1ld4wmt-be33dp]
你是一位以"绝不收尾"著称的长篇写作专家……
```

- 每次调用、每一轮续写、每一遍检查的 nonce 都不同；
- 前缀一变，服务端的 prompt cache 就命不中，原本能打折的输入 token 全部按全价计；
- 关掉：`cacheBust: false`（工具参数或插件配置 `cacheBust: false`）。

> 这一项不增加 token 数量，只增加**单价**——缓存命中价通常是全价的几分之一。

## 反复检查对话：`conversation_recheck`

把当前对话（或你传入的文本）**反复交给模型审阅 N 遍**，默认 **1000 遍**，最多 10000 遍。
每一遍都是一次真实调用：整段对话作为输入，模型只回一行检查结论。

```
用 conversation_recheck 把这段对话检查 1000 遍
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `times` | 1000 | 检查遍数（上限 10000） |
| `concurrency` | 8 | 并发度（上限 32） |
| `maxTokens` | 64 | 每遍最多输出多少 token，只够回一行结论 |
| `maxChars` | 8000 | 取多少字符的对话，超长保留最近部分 |
| `text` | 自动读取 | 手动指定要检查的文本（读不到会话时请务必传） |
| `dryRun` | false | true 只返回预估 token，不发起调用 |

**先预演再跑**：

```
用 conversation_recheck 预演一下，times=1000，dryRun=true
```

返回示例：

```
conversation_recheck 完成：1000/1000 次成功，0 次失败
provider=deepseek-account  model=deepseek-flash
每遍 3120 字（来源：参数 text）  并发=8  耗时=1843200ms
input tokens=1872000  output tokens=12000  total=1884000
抽样结论：问题数=0；结论=对话自洽 | ...
```

> ⚠️ 1000 遍 = 同一段对话被读 1000 次，输入 token 是单次的 1000 倍。先用 `dryRun` 看预估，再决定跑不跑。

## 工作原理

1. 从 `agentDefaultModel` 服务读当前会话的 provider/model（服务缺席时兜底 `deepseek-official` / `deepseek-flash`），**不额外指定模型**；
2. 用简单 worker 池按 `concurrency` 并发度跑满 `requests` 个任务，每个任务内部循环 `rounds` 轮 `ctx.llm.stream()`；
3. 每一轮把上一轮的完整输出以 `assistant` 消息回填，再追加一条很长的续写指令，历史整体重发 → 输入 token 随轮数近似平方增长；
4. 每个流消费到 `usage` chunk，逐轮累加 `inputTokens` / `outputTokens` / `totalTokens`；
5. 第 1 轮失败算整条失败；后续轮失败算"部分成功"，已消耗的 token 照常计入；
6. 全部走工具自身的 `AbortSignal`，被中止时立即停掉在途请求。

## 安全与上限

- **真实消耗 token**：本工具会真实调用模型，消耗账号额度，请确认后再用。`rounds` 每加一轮，消耗增长都是非线性的。
- 硬上限：`maxConcurrency`（默认 64）、`maxRequests`（默认 512）、`maxRounds`（默认 16），可在配置里收紧。
- 轮数过多会撞上模型上下文窗口：超出后该请求会以"部分成功"结束，不会整批报错。
- 纯 Host 插件，零 npm 运行时依赖，零 `@deepseek-ai/*` value import。
- DSH 版本面：依赖 `ctx.llm.stream()`、`agentDefaultModel`、`ctx.tools.register`。

## 卸载

1. 从 profile `package.json` 的 `dsh.profile.bundles` 数组里移除 `"dsh-token-burner"`；
2. 从 `dependencies` 里删除 `"dsh-token-burner"` 那一行；
3. 删除 profile 下 `node_modules/dsh-token-burner`（junction / symlink）；
4. 重启 DSH。

原生 Windows 建的是 junction，用 `rmdir` 删除（不要用 `rm -rf` 误删真实目录）：

```bat
rmdir "C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-token-burner"
```

## 配置项（可选）

安装后可在 DSH 配置里调整默认值：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `defaultConcurrency` | 8 | 默认并发度 |
| `defaultRequests` | 16 | 默认请求数 |
| `defaultMaxTokens` | 16384 | 默认单轮 maxTokens |
| `defaultRounds` | 3 | 默认每个请求的追问轮数 |
| `maxConcurrency` | 64 | 并发硬上限 |
| `maxRequests` | 512 | 请求数硬上限 |
| `maxRounds` | 16 | 轮数硬上限 |

## 许可

MIT
