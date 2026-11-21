<p align="right"><a href="README.md">English</a> | <b>简体中文</b> | <a href="README.ja.md">日本語</a></p>

<p align="center">
  <img width="96" height="96" alt="Clear Chat 图标" src="images/icon.png">
</p>

<h1 align="center">Clear Chat</h1>

<p align="center">Clear Chat 是 <a href="https://paseo.sh">Paseo</a> 的插件。这一版只保留回答卡片：回复里有字母选项题时，用卡片选题或自己写答案，预览后发送。Clear Chat 不再绘制对话。对话显示请用另一个插件 <a href="https://paseo.sh/plugins/roundreddot/better-paseo">Better Paseo</a>。</p>

<p align="center">
  <a href="https://github.com/jasonhnd/paseo-clear-chat/releases"><img alt="版本" src="https://img.shields.io/github/v/tag/jasonhnd/paseo-clear-chat?label=version&sort=date"></a>
  <a href="LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://paseo.sh"><img alt="Paseo 0.16.0 或更新，徽章标注 0.16.2" src="https://img.shields.io/badge/Paseo-%3E%3D0.16.0%20%C2%B7%20tested%200.16.2-5b5bd6"></a>
</p>

## 这一版

Clear Chat 0.16.2.2 不再绘制步骤行、工具卡、侧边栏、搜索、引用回复、跳转标签或语法高亮。标题为 **这一轮的改动** 的卡片也没有了。那些属于对话显示。设置页标题是 **回答卡片**，用来设置回答卡片和常用回答。

完整改动见 [变更记录](CHANGELOG.md)。

## 回答卡片

有字母选项题的回复生成完之后，输入框上方会出现一个按钮。按钮上带着进度，例如 **回答卡片 · 已答 0/2**。点它把整张卡片打开成面板；窄屏上是从底部升起的面板。在面板里选好答案，按卡片上的 **发送**：消息像你亲手发的一样进到这个对话，输入框里正在写的内容不受影响。每答一题，按钮上的数字跟着变（**回答卡片 · 已答 1/2**）；关掉面板再打开，答案还在；发送之后按钮消失，等下一段有字母选项题的回复完成后再出现。按钮只属于当前对话：换到别的对话，显示的是那个对话自己的卡片，没有就不显示。

打开 **Settings → Plugins → Clear Chat**。页面标题是 **回答卡片**。设置文件里没有存过开关时，**在包含字母选项问题的回复下显示回答卡片** 是开的。已经存过的开或关仍然有效。开关下面的说明是：重新加载聊天以更新现有回复。

卡片本身的操作如下。

回复要同时满足这些条件才会被认成题：有编号的问题，每题至少两个字母选项（`A`–`H`，也包括全角 `Ａ`–`Ｈ`），并且有推荐标记，或有「reply with」「answer with」这类要求简短作答的提示。代码块和引用里的行不看。同一题里字母必须往前排（`A` 然后 `C` 可以；`B` 然后 `A` 不行）。`（推荐）` 或 `(recommended)` 会认出来；「not recommended」和 `不推荐` 不会。选项下面单独一行点名选项的推荐，例如 `Recommended: A`、`推荐：A`、`おすすめ：A`，会标出这些选项，不算进上面那个选项；标记可以带句号，也可以加粗。日文的标记后面要有冒号或空格。像 `不推荐：A` 这样的一行不会被当成推荐。

1. 点一个选项；焦点在卡片里时也可以按对应字母。还可以用 **↑/↓** 移动，按 **Enter** 选定。在 Paseo 输入框里按的键仍归输入框。
2. 答完一道还没答的题，会到下一道还没答的题。最后一道选定后，焦点到 **发送**。没答齐时，**发送** 会标出还缺哪一题，并且不能按。
3. 题签显示问题的短名。不是当前题、但已经答过的题签显示 `✓` 和答案。改一道已经答过的题时，停在这一题。
4. 要自己写，选 **自己写**。**Enter** 确认并往后走，**Shift+Enter** 换行。输入法选字不会确认。空着会提示先写答案。
5. **发送** 显示字母索引，例如 `1B 2A`。自己写的答案按你确认的文字放进消息。发送成功后按钮消失，卡片不再显示；对话里那条消息（例如 `1B 2A`）就是你的回答。
6. 普通列表被误认成题时，点 **不是选项**。这条回复在重新加载后仍保持收起。发送过程中没有这个按钮。
7. 在设置页编辑的常用回答，会在卡片上变成按钮。点一下把短语插到光标处，不会发送。

句子里单独出现的一个字母不当成答案，例如 “wait a moment”。带编号的记号仍然算，例如 `1A`、`2b`、`Q1A`，旁边有标点也算（`1A.`）。整条消息就是答案时不变，包括只有一道题、整条消息是 `b` 的情况。`Plan 2B` 这样的消息仍可能被当成答案。

## 安装

Clear Chat 0.16.2.2 需要 Paseo 0.16.0 或更新。在 Paseo 0.15.x 上这一版无法正常安装或运行，请留在 Clear Chat 0.15.4.x。

```bash
paseo plugin install git:jasonhnd/paseo-clear-chat --ref v0.16.2.2
```

安装会在 daemon 主机上运行 `npm ci`，所以那台机器要有 Node.js 和 npm，并且能连到 npm 仓库。

把已经安装的 Clear Chat 更新到这一版：

```bash
paseo plugin update clear-chat --ref v0.16.2.2 --yes
```

打开 **Settings → Plugins → Clear Chat**，看标题下面的版本行。从目录安装时会沿用该目录里已有的版本信息，因此可能显示旧版本。构建里没有可用版本时，这一行显示 **未知**。

> [!IMPORTANT]
> 已经在用 Beautiful Chat？安装或卸载任何插件**之前**，请先看[从 Beautiful Chat 升级](#从-beautiful-chat-升级)。在 Paseo 里卸载插件，会连它的设置一起删掉。

<details>
<summary><b>旧版 Paseo（0.13 / 0.12），以及版本号怎么看</b></summary>

还在用 Paseo 0.13？Clear Chat 0.13.2.2 已经发布，并声明支持 Paseo 0.13.0 或更新版本。下面这条安装命令尚未在 Paseo 0.13 上实测：

```bash
paseo plugin install git:jasonhnd/paseo-clear-chat --ref v0.13.2.2
```

如果已经安装 Clear Chat，下方是拟使用的指定旧版命令。**这次切换及其对设置的影响尚未在 Paseo 0.13 上实测；从新版切回旧版也尚未验证。**

```bash
paseo plugin update clear-chat --ref v0.13.2.2 --yes
```

还在用 Paseo 0.12 的，请改装 Clear Chat 0.12.0.1：

```bash
paseo plugin install git:jasonhnd/paseo-clear-chat --ref v0.12.0.1
```

如果已经装着 Clear Chat，`install` 会停下并提示 `Plugin ID clear-chat is already configured`。这时请改用 `update` 换版本，设置会保留：

```bash
paseo plugin update clear-chat --ref v0.12.0.1 --yes
```

Clear Chat 的版本号是它所对应的 Paseo 版本，再加一位，表示在这个 Paseo 版本上是第几次发布。例如 0.13.0.1 是对应 Paseo 0.13.0 的第一个版本，0.13.0.2 是第二个。Paseo 出了新版本，Clear Chat 没有新东西就不跟着发。1.0.0 和 1.0.1 是定这个规则之前发的，0.12.0.1 比它们都新。

</details>

## 升级与回退

```bash
paseo plugin update clear-chat --ref v0.16.2.2 --yes
```

升级会保留设置文件。回答卡片、常用回答、被收起的误认，以及没写完的草稿都会留下。这一版不再显示的功能，它们的键还在文件里，设置页上没有对应控件。退回更早的 ref 一般也保留文件，但某一次回退对设置的影响没有保证，设置重要的话先备份。卸载插件会删掉它的设置。

更新之后，对话不再由 Clear Chat 绘制。对话显示用 [Better Paseo](https://paseo.sh/plugins/roundreddot/better-paseo)。你不会再看到 Clear Chat 的步骤行、工具卡、侧边栏。

回答卡片从输入框上方的按钮打开。更新后，有字母选项题的回复生成完，输入框上方就会出现按钮，例如 **回答卡片 · 已答 0/2**，点它打开卡片。

启动时不会删除插件数据目录里的任何东西。以前的图片和历史目录会留在原地。这一版不用它们。

## 设置

页面标题是 **回答卡片**。

| 设置 | 作用 |
|---|---|
| 在包含字母选项问题的回复下显示回答卡片 | 没有存过值时为开。存过的值仍然有效。开关下的说明是重新加载聊天以更新现有回复。 |
| 常用回答 | 每行一个短语。默认是 `Go with the recommended`、`Leave it for now`、`Continue`。在回答卡片上点一个短语会插入，不会发送。在这里改完，离开输入框就保存。 |

**已安装版本。** 标题下面显示这次安装所用构建的版本。从目录安装时会沿用该目录里已有的版本信息，因此可能显示旧版本。没有可用版本时显示 **未知**。

**报告问题** 会在浏览器里打开 GitHub 的问题表单。你不提交，就什么都不会发出。

设置保存在主机上，连到这台主机的客户端都共用。

## 语言

Clear Chat 自己的文字跟随 Paseo 的应用语言：英文、简体中文、日文。设置页和回答卡片已翻译。Paseo 自己的文字仍用 Paseo 的语言，agent 的输出从不翻译。插件列表显示英文说明。

## 已知限制

- `Plan 2B` 仍可能被当成答案。句子里的单个字母不会。
- 回复还在生成时，输入框上方不会出现这段回复的按钮。如果卡片开着时 agent 又开始回答，面板会说明回复还在生成，结束前不能作答。
- 手机宽度下，在 Paseo 自己的输入框里按 Enter 是换行，请用它的发送按钮。这是宿主的行为。
- 这一版没有在正在运行的 Paseo 应用里检查过，也没有用真实模型、真实的 iOS 或 Android 设备检查过。 <!-- TODO(host-verification) -->
- 卸载插件会删掉它的设置，请先备份。启动不会删除插件数据目录里的旧文件。

## 隐私与主机上的数据

- Clear Chat 不会把对话内容发到主机之外，不发给 agent 供应商，也不发给其他服务。例外是你自己发出的消息：回答卡片上的 **发送** 会以你的身份，经 Paseo 把一条消息发给当前对话的 agent，和你手打的消息一样。
- 这一版不读取本机图片、不做代码高亮，也不再注册 provider 副本。
- Clear Chat 自己唯一的联网是安装时的 `npm ci`。
- **报告问题** 在浏览器里打开 GitHub 表单。你不提交，就什么都不会发出。
- 已有的插件数据目录会留着。这一版不会新建图片库或历史记录。

## 大家常问的问题

**Clear Chat 还绘制对话吗？** 不绘制。步骤行、工具卡、侧边栏、搜索、引用回复、跳转标签和语法高亮都没有了。标题为 **这一轮的改动** 的卡片也没有了。对话显示用 [Better Paseo](https://paseo.sh/plugins/roundreddot/better-paseo)。

**为什么看不到回答卡片？** 打开 **在包含字母选项问题的回复下显示回答卡片**。最新回复要有编号的问题，每题至少两个字母选项，并且有推荐标记，或有 “reply with”“answer with” 这类要求简短作答的提示。这段回复生成完之后，输入框上方才会出现它的按钮，点按钮打开卡片。

**哪些回复会被认成题？** 带编号的问题，每题至少两个字母选项，并且有推荐标记或简短作答的提示。代码块和引用不算。

**要改现在的 agent 设置吗？** 不用。这一版不加 provider 副本。以前的粘贴图片处理没有了。

**支持哪些 Paseo 版本？** 0.16.0 或更新。在 Paseo 0.15.x 上这一版无法正常运行，请留在 Clear Chat 0.15.4.x。Paseo 0.13 和 0.12 的旧安装路径见[安装](#安装)；0.13 的命令仍未实测。

**卸载插件后设置会怎样？** 会跟插件一起删掉。请先备份。见[从 Beautiful Chat 升级](#从-beautiful-chat-升级)。

**Clear Chat 会把对话发到别处吗？** 不会，除了你自己发出的答案，那和手打的消息一样经 Paseo 发出。完整说明见 [OVERVIEW](OVERVIEW.zh-CN.md)。

## 常见问题

| 问题 | 怎么办 |
|---|---|
| 用 Cafe 插件安装失败。 | 用[安装](#安装)里的 Paseo CLI 命令重试，仓库和版本标签保持不变。Clear Chat 用 `npm ci --include=dev` 安装依赖，所以运行 daemon 的主机上要有 Node.js 和 npm，网络也要能连到 npm 仓库。如果代码目录是你自己管理的，请先在那里运行 `npm ci --include=dev` 再重试。 |
| 安装停止，提示插件需要更新的 Paseo 版本。 | Clear Chat 0.16.2.2 需要 daemon 主机和所有连接的应用都用 Paseo 0.16.0 或更新版本。在 Paseo 0.15.x 上请留在 Clear Chat 0.15.4.x。更旧的宿主见[安装](#安装)。 |
| Clear Chat 提示需要插件 RPC、设置页面、设置注册和请求处理。 | 把运行 daemon 的主机和所有连着的应用都更新 Paseo，再重新加载 Clear Chat。需要的版本写在 `paseo-plugin.json` 里。 |
| 插件注册失败，Clear Chat 启动不了。 | 更新 Paseo，再重新加载 Clear Chat。还不行的话，先备份插件设置，再用 CLI 重新安装。 |
| Clear Chat 读不到主机上的设置。 | 重新连接主机，在设置页点 **重试**。还不行的话，检查 daemon 能不能访问插件设置文件夹。 |
| Clear Chat 提示设置无效或格式不支持。 | 先备份设置。用一份正常的备份恢复，或在 daemon 主机上修好设置文件，再点 **重试**。Clear Chat 不会自己删掉这个文件。 |
| Clear Chat 保存不了设置。 | 检查 daemon 主机上的写入权限和剩余磁盘空间，重新连接后再改一次。**重试** 只会重新读取设置，不会重发刚才失败的修改。 |
| 设置被另一个客户端不停改动。 | 等另一边改完，再改一次。 |
| Beautiful Chat 的设置没有复制过来。 | 保留 Beautiful Chat 原来的设置并备份。检查两个插件设置文件夹的读写权限和剩余磁盘空间，再重新加载 Clear Chat 重试。复制失败时，daemon 日志里会有一条恢复提示；已经存在的 Clear Chat 设置文件不会被覆盖。 |

如果 Paseo 运行不了构建命令，或加载不了插件包，Clear Chat 就没办法自己显示提示。请检查 daemon 主机上的 Node.js、npm 和 Paseo 版本，再用 CLI 重试。问题还在的话，用设置页里的 **报告问题**，附上恢复提示和你的 Paseo 版本。分享日志前，请去掉私人路径和对话内容。

## 从 Beautiful Chat 升级

1. **备份** Beautiful Chat 的设置。
2. 在 Beautiful Chat 还装着的时候**安装 Clear Chat**。Clear Chat 第一次启动、自己还没有设置文件时，会把 Beautiful Chat 的文件复制过来。
3. **确认**文件到了，再卸载 Beautiful Chat。设置页只显示回答卡片开关和常用回答。复制过来的其他键留在文件里，没有对应控件。

<details>
<summary><b>具体命令、回退方法、复制是怎么做的</b></summary>

下面的命令使用 `PASEO_HOME`，没有设置时用 `$HOME/.paseo`。如果你的 daemon 只用 `--home` 指定目录，请先把 `PASEO_HOME` 设成那个路径。备份或确认失败时请停下。

**1. 备份**

```bash
legacy_backup="${PASEO_HOME:-$HOME/.paseo}/backups/plugin-settings-beautiful-chat-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${PASEO_HOME:-$HOME/.paseo}/backups"
cp -a "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/beautiful-chat" "$legacy_backup"
```

如果没有 `beautiful-chat` 这个设置文件夹，说明你没改过 Beautiful Chat 的设置，这一步可以跳过。

**2. 安装**

```bash
paseo plugin install git:jasonhnd/paseo-clear-chat --ref v0.16.2.2
```

**3. 确认后卸载旧插件**

确认 `${PASEO_HOME:-$HOME/.paseo}/plugin-settings/clear-chat/presentation.json` 已经生成，并且和 `$legacy_backup/presentation.json` 一致。已经存在的 Clear Chat 设置文件绝不会被覆盖。如果文件不存在或内容不同，请保留 Beautiful Chat 和备份，到日志里查看复制错误。

```bash
paseo plugin remove beautiful-chat
```

备份请留着。

**回退**

先备份 Clear Chat 当前的设置，再卸载。卸载 Clear Chat 会把它的设置全部删掉，`update` 不会。如果没有 `clear-chat` 这个设置文件夹，跳过 `cp` 那一行。

```bash
clear_chat_backup="${PASEO_HOME:-$HOME/.paseo}/backups/plugin-settings-clear-chat-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${PASEO_HOME:-$HOME/.paseo}/backups"
cp -a "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/clear-chat" "$clear_chat_backup"
paseo plugin remove clear-chat
```

如果 Beautiful Chat 的设置文件夹已经没了，从升级时的备份恢复。把 `YYYYMMDD-HHMMSS` 换成你备份的时间。已经存在的文件夹绝不会被覆盖。

```bash
legacy_backup="${PASEO_HOME:-$HOME/.paseo}/backups/plugin-settings-beautiful-chat-YYYYMMDD-HHMMSS"
test ! -e "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/beautiful-chat" &&
  cp -a "$legacy_backup" "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/beautiful-chat"
```

然后安装 Beautiful Chat 的最后一个版本：

```bash
paseo plugin install git:jasonhnd/paseo-clear-chat --ref 2bf25e8
```

在 Clear Chat 里改过的设置不会同步回 Beautiful Chat。两份备份都请留着。

**复制是怎么做的**

- 第一次启动时，如果 Clear Chat 还没有设置文件，服务端会把 Beautiful Chat 的 `presentation.json` 复制到 Clear Chat 的设置文件夹。两边的文件都不会被删除或覆盖。
- 复制失败时，错误会记到日志，Clear Chat 用默认设置启动。下次启动会再试。
- 然后按当前的设置格式读取。文件里的回答卡片相关值会留下。这一版不再显示的功能，它们的键仍会被接受，但不会显示成控件。
- 在浏览器里，以前存在浏览器里的偏好会导入一次。以主机上保存的设置为准。
- 复制只认默认的安装 id。用了自定义 `--id`，或者 daemon 目录只用 `--home` 指定的，需要手动复制设置。

</details>

## 反馈问题

遇到问题或有想法？请[在 GitHub 上提问题](https://github.com/jasonhnd/paseo-clear-chat/issues/new/choose)。也可以点设置页最下面的 **报告问题**。每个版本的变化都记在 [变更记录](CHANGELOG.md) 里。

故障表单要求界面问题提供已去掉隐私的截图或视频；无法提供时请说明原因。非界面问题如无需图片，请填写 `N/A — not a UI issue`。知道已安装的产品版本就请填写。功能建议表单会询问使用场景和期望结果。GitHub 表单的实际显示和提交尚未测试。

## 致谢

Clear Chat 基于 [Beautiful Chat](https://github.com/ABorakati/beautiful-chat)（作者 ABorakati），按 MIT 许可证使用。原作的版权声明保留在 [LICENSE](LICENSE) 里。

开发者请看 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)（英文）：构建步骤和项目结构。

## 许可证

[MIT](LICENSE)
