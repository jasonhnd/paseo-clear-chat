<p align="right"><a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <b>日本語</b></p>

<h1 align="center">Clear Chat</h1>

<p align="center"><b>エージェントとのチャットをひと目で読みやすくする Paseo プラグインです。</b></p>

<p align="center">
  <a href="https://github.com/jasonhnd/paseo-clear-chat/releases"><img alt="Version" src="https://img.shields.io/github/v/tag/jasonhnd/paseo-clear-chat?label=version&sort=semver"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://paseo.sh"><img alt="Paseo 0.8.0+" src="https://img.shields.io/badge/Paseo-%3E%3D0.8.0-5b5bd6"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/compare-dark.png">
    <img alt="同じ会話：左はプラグインなし、右は Clear Chat あり" src="images/compare-light.png">
  </picture>
</p>

<p align="center"><sub>左：プラグインなしの同じ会話。右：Clear Chat あり。スクリーンショットはすべてサンプルデータです。</sub></p>

## Clear Chat を選ぶ理由

- **まず結論が見えます。** 終わったステップは 1 行ずつにまとまります（アイコン、要点、状態、時間）。ターンの最後の返信はいつも全文表示です。
- **どのエージェントも正しく表示します。** Claude、Codex、Hermes の呼び出しをすべてきちんとしたカードで表示します。Paseo が伝える 12 種類のツールにはそれぞれ専用カードがあり、`skill_view` や `memory` などの Hermes ツールにも専用の表示があります。実際の会話を再生したテストでは、空のカードは 1 枚もありません。
- **何もなくなりません。** Beautiful Chat の設定はそのまま引き継がれます。貼り付けた画像は枚数が表示され、失敗した呼び出しには失敗の理由が表示されます。
- **メンテナンスしています。** 1.0.0 では、元のプラグインで未対応だった Issue と PR を 7 件対応しました。問題は GitHub Issues で受け付け、リリースごとの変更は [CHANGELOG](CHANGELOG.md) にまとめています。
- **速いです。** 私たちのテストでは、221 ステップの会話で最初の画面が約 1.3 秒で表示されました。プラグインなしの場合（同じく約 1.3 秒）とほぼ同じです。長い会話でもスクロールが引っかかりません。<sup>1</sup>

<sub>1. 1 台のマシンでヘッドレスの Google Chrome を 5 回動かした中央値です。環境によって結果は変わります。測り方は [scripts/perf/README.md](scripts/perf/README.md)（英語）にあります。</sub>

## インストール

```bash
paseo plugin install git:https://github.com/jasonhnd/paseo-clear-chat.git --ref v1.0.0
```

インストール後、**Settings → Plugins → Clear Chat** で色、フォント、折りたたみを選べます。

> [!IMPORTANT]
> すでに Beautiful Chat を使っていますか？プラグインのインストールや削除を**する前に**、[Beautiful Chat からのアップグレード](#beautiful-chat-からのアップグレード)をお読みください。Paseo 0.12 ではプラグインを削除すると、その設定も一緒に消えます。

## Beautiful Chat からのアップグレード

1. Beautiful Chat の設定を**バックアップ**します。
2. Beautiful Chat を入れたまま **Clear Chat をインストール**します。Clear Chat は初回の起動時に設定をコピーします。
3. 設定が正しいことを**確認**してから、Beautiful Chat を削除します。

<details>
<summary><b>具体的なコマンド、元に戻す方法、移行のしくみ</b></summary>

以下のコマンドは `PASEO_HOME` を使い、未設定のときは `$HOME/.paseo` を使います。daemon のフォルダーを `--home` だけで指定している場合は、先に `PASEO_HOME` をそのパスに設定してください。バックアップや確認に失敗したら、そこで止めてください。

**1. バックアップ**

```bash
legacy_backup="${PASEO_HOME:-$HOME/.paseo}/backups/plugin-settings-beautiful-chat-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${PASEO_HOME:-$HOME/.paseo}/backups"
cp -a "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/beautiful-chat" "$legacy_backup"
```

**2. インストール**

```bash
paseo plugin install git:https://github.com/jasonhnd/paseo-clear-chat.git --ref v1.0.0
```

**3. 確認してから古いプラグインを削除**

`${PASEO_HOME:-$HOME/.paseo}/plugin-settings/clear-chat/presentation.json` ができていて、`$legacy_backup/presentation.json` と同じ内容であることを確認してください。すでにある Clear Chat の設定ファイルが上書きされることはありません。ファイルがない、または内容が違う場合は、Beautiful Chat とバックアップを残したまま、ログで移行のエラーを確認してください。

```bash
paseo plugin remove beautiful-chat
```

バックアップは残しておいてください。

**元に戻す**

Clear Chat の今の設定をバックアップしてから削除します。

```bash
clear_chat_backup="${PASEO_HOME:-$HOME/.paseo}/backups/plugin-settings-clear-chat-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${PASEO_HOME:-$HOME/.paseo}/backups"
cp -a "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/clear-chat" "$clear_chat_backup"
paseo plugin remove clear-chat
```

Beautiful Chat の設定フォルダーがなくなっている場合は、アップグレード時のバックアップから戻します。`YYYYMMDD-HHMMSS` はバックアップの日時に置き換えてください。すでにあるフォルダーが上書きされることはありません。

```bash
legacy_backup="${PASEO_HOME:-$HOME/.paseo}/backups/plugin-settings-beautiful-chat-YYYYMMDD-HHMMSS"
test ! -e "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/beautiful-chat" &&
  cp -a "$legacy_backup" "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/beautiful-chat"
```

そのあと、Beautiful Chat の最後のバージョンをインストールします。

```bash
paseo plugin install git:https://github.com/jasonhnd/paseo-clear-chat.git --ref 2bf25e8
```

Clear Chat で変えた設定は Beautiful Chat には戻りません。バックアップは両方とも残しておいてください。

**移行のしくみ**

- 初回の起動時、Clear Chat の設定ファイルがまだなければ、サーバーが Beautiful Chat の `presentation.json` を Clear Chat の設定フォルダーにコピーします。どちらのファイルも削除・上書きしません。
- コピーに失敗した場合は、2 つのパスとエラーをログに残し、Clear Chat は初期設定で起動します。次回の起動時にもう一度試します。
- そのあと設定はバージョン 1 から 2 に更新されます。選んだ内容はそのまま残り、新しい 2 つの折りたたみ設定は初期値から始まります。
- ブラウザーでは、以前ブラウザーに保存されていた設定を 1 回だけ取り込みます。ホストに保存された設定が常に優先です。
- 移行は標準のインストール ID を前提にしています。`--id` を変えている場合や、daemon のフォルダーを `--home` だけで指定している場合は、設定を手でコピーしてください。

</details>

## 機能

### ツール呼び出し

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-bash-dark.png"><img alt="Shell と Git" src="docs/images/tool-bash-light.png"></picture><br>**Shell と Git。** ターミナル風の枠、色分けしたコマンド、終了コード、時間を表示します。 | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-read-dark.png"><img alt="ファイルの読み込み" src="docs/images/tool-read-light.png"></picture><br>**ファイルの読み込み。** 言語アイコン、行番号、コピーボタン。ファイル名を押すとファイルマネージャーでそのファイルを表示します。 |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-edit-dark.png"><img alt="編集" src="docs/images/tool-edit-light.png"></picture><br>**編集。** 見やすい差分を表示します。差分がないときは、変更前と変更後の文字から差分を作ります。 | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-image-dark.png"><img alt="画像" src="docs/images/tool-image-light.png"></picture><br>**画像。** 読み込んだ画像や生成した画像をその場で表示し、サイズと押せる参照元を添えます。 |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-thinking-dark.png"><img alt="推論ツール" src="docs/images/tool-thinking-light.png"></picture><br>**推論ツール。** 考えている途中の文章、トークン数、番号付きのステップを表示します。 | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-mcp-dark.png"><img alt="MCP" src="docs/images/tool-mcp-light.png"></picture><br>**MCP。** サーバー、通信方式、入力、応答を色分けして表示します。 |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-eval-dark.png"><img alt="Eval" src="docs/images/tool-eval-light.png"></picture><br>**Eval。** セルごとに、実行したコードとその出力を表示します。 | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-ask-dark.png"><img alt="質問" src="docs/images/tool-ask-light.png"></picture><br>**質問。** 選択肢を並べ、おすすめと選んだ答えに印を付けます。 |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-task-dark.png"><img alt="サブエージェント" src="docs/images/tool-task-light.png"></picture><br>**サブエージェント。** 名前、種類、モデル、渡した作業を表示します。 | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/hub-dark.png"><img alt="Hub" src="docs/images/hub-light.png"></picture><br>**Hub。** hub のすべての操作に、プロセス・メッセージ・ジョブのカードがあります。 |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/paseo-dark.png"><img alt="Paseo のツール" src="docs/images/paseo-light.png"></picture><br>**Paseo のツール。** Paseo のマークを表示し、作成したエージェントには提供元のマークを付けます。 | |

検索、Web の取得と検索、計画とチェックリスト、プレーンテキスト、Skill、そのほかのツールにもそれぞれカードがあります。知らないツールでも、ツール名、`名前: 値` の形の入力、出力のプレビューを表示します。空の枠になることはありません。

### 会話

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/reasoning-dark.png"><img alt="推論の流れ" src="docs/images/reasoning-light.png"></picture><br>**推論の流れ。** たためるステップに、ステップごとの時間とトークンの合計を付けます。 | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tasks-dark.png"><img alt="チェックリスト" src="docs/images/tasks-light.png"></picture><br>**チェックリスト。** フェーズ、タスクごとの状態、止まっているタスクの理由を表示します。 |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/approval-dark.png"><img alt="承認" src="docs/images/approval-light.png"></picture><br>**承認。** リスク、実行するコマンド、対象を表示します。済んだ承認は短い状態の行として残ります。 | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/user-dark.png"><img alt="プロンプトの吹き出し" src="docs/images/user-light.png"></picture><br>**プロンプトの吹き出し。** コピーボタン、トークン使用量、貼り付けた画像（例：「3 images attached」）を表示します。 |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/syntax-dark.png"><img alt="コード" src="docs/images/syntax-light.png"></picture><br>**コード。** 言語の判定、行番号、差分の色分けがあり、コピーではコード全体をコピーします。 | |

### そのほか

- **折りたたみは自由に。** どの行も押すと開いたり閉じたりでき、再読み込みしても覚えています。実行中・失敗・対応待ちの呼び出しは最初から開いています。長い出力は最初の 15 行だけ表示し、**Show all N lines** で全部見られます。
- **まとめの返信。** `wrap_up` ツールで送られた返信は、まとめ・質問・記号付きの選択肢・**Blocked** の警告を含む返信カードとして表示します。
- **リンクを押せます。** 返信の中のリンクはデスクトップ、Web、iOS で開けます。`mailto:` リンクはメールアプリで開きます。
- **会話内の検索。** Ctrl/Cmd+F で検索バーを開くと、ツールのカードの中も検索できます。検索するのは読み込み済みのメッセージだけなので、古いものは先に上にスクロールしてください。
- **ファイルを開く。** カードのファイル名を押すと、Finder やエクスプローラーなどのファイルマネージャーでそのファイルを表示します。

## 設定

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png"><img alt="設定画面" src="docs/images/settings-light.png"></picture>

| 設定 | 内容 |
|---|---|
| Accent colour | Paseo のテーマに合わせるか、Jade・Violet・Amber・Rose から選びます。 |
| Interface font | 内蔵の Inter フォントか、システムのフォントを使います。 |
| Text size | Small (90%)、Default (100%)、Large (115%)、XL (130%)。アイコンの大きさは変わりません。 |
| Code glyphs | 合字ありの Iosevka か、普通の字形を使います。 |
| Fold finished steps | 最初はオンです。オフにすると、個別に選んだ呼び出しを除いてすべてのステップを開きます。 |
| Fold long output after | 10・15（初期値）・30 行、または Never。コードとツールの出力に効きます。 |
| Frosted glass | カードの背景をすりガラス風にするか、単色にします。 |
| Enhanced prompt bubble | プロンプトに装飾を付けます。オフにすると Paseo の標準の吹き出しを使います。 |
| Assistant markdown | オフにすると、返信の表示を Paseo に戻します。 |

設定はホストに保存されるので、同じホストにつないだ端末どうしで共有されます。折りたたみの設定はすぐに反映されます。そのほかの変更は新しいメッセージから反映され、前のメッセージを更新するには会話を再読み込みしてください。

> [!NOTE]
> **iOS と iPadOS では**、**Assistant markdown** または **Enhanced prompt bubble** がオンのとき、ドラッグで文字を選べません。返信、プロンプト、コードブロックの **Copy** ボタンを使ってください。コピーに失敗したときは全文を表示する画面が出るので、そこから手で選んでコピーできます。

## 問題の報告

不具合やご要望は [GitHub の Issue](https://github.com/jasonhnd/paseo-clear-chat/issues/new/choose) でお知らせください。設定画面のいちばん下にある **Report a problem** からも開けます。日本語や中国語でも大丈夫です。

## クレジット

Clear Chat は ABorakati さんの [Beautiful Chat](https://github.com/ABorakati/beautiful-chat) をもとに、MIT ライセンスで作っています。元の著作権表示は [LICENSE](LICENSE) に残しています。

文字サイズの機能を[提供してくださった](https://github.com/ABorakati/beautiful-chat/pull/9) Moyf さんに感謝します。ここではホストの設定に保存する形に合わせています。

開発者向けの情報（ビルド手順、プロジェクトの構成、開発中に見つかった Paseo プラグイン SDK の制限）は [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)（英語）にあります。

## ライセンス

[MIT](LICENSE)
