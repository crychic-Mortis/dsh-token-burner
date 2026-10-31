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

它一次并发发起 N 个**真实的** LLM 生成请求，每个请求让模型生成大量文本
（`maxTokens` 拉满 + 引导长输出），用于：

- 压测 / 触发限流
- 测计费上限、观察 token 消耗曲线
- 验证并发行为

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
用 token_burn 压测：30 个请求，并发 10，每个 maxTokens 4096
```

工具参数（都可选）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `requests` | 16 | 总请求数（上限 512） |
| `concurrency` | 8 | 并发度（上限 64） |
| `maxTokens` | 8192 | 每个请求最大输出 token，越大单次消耗越多 |
| `prompt` | 内置长文引导词 | 可选，让模型生成你指定主题的长文本 |

返回结果示例：

```
token_burn 完成：30/30 次成功，0 次失败
provider=deepseek-official  model=deepseek-v4-pro
并发=10  耗时=42310ms
input tokens=120030  output tokens=245760  total=365790
```

## 工作原理

1. 从 `agentDefaultModel` 服务读当前默认 provider/model（缺省 `deepseek-official` / `deepseek-v4-pro`）；
2. 用简单 worker 池按 `concurrency` 并发度跑满 `requests` 个 `ctx.llm.stream()` 调用；
3. 每个流消费到 `usage` chunk，累计 `inputTokens` / `outputTokens` / `totalTokens`；
4. 全部走工具自身的 `AbortSignal`，被中止时立即停掉在途请求。

## 安全与上限

- **真实消耗 token**：本工具会真实调用模型，消耗账号额度，请确认后再用。
- 硬上限：`maxConcurrency`（默认 64）、`maxRequests`（默认 512），可在配置里收紧。
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
| `defaultMaxTokens` | 8192 | 默认单请求 maxTokens |
| `maxConcurrency` | 64 | 并发硬上限 |
| `maxRequests` | 512 | 请求数硬上限 |

## 许可

MIT
