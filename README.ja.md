<p align="right"><a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <b>日本語</b></p>

<h1 align="center">Clear Chat</h1>

<p align="center"><b>エージェントとのチャットをひと目で読みやすくする Paseo プラグインです。</b></p>

<p align="center">
  <a href="https://github.com/jasonhnd/paseo-clear-chat/releases"><img alt="Version" src="https://img.shields.io/github/v/tag/jasonhnd/paseo-clear-chat?label=version&sort=date"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://paseo.sh"><img alt="Paseo 0.13.0+" src="https://img.shields.io/badge/Paseo-%3E%3D0.13.0-5b5bd6"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/compare-dark.png">
    <img alt="同じ会話：左はプラグインなし、右は Clear Chat あり" src="images/compare-light.png">
  </picture>
</p>

<p align="center"><sub>左：プラグインなしの同じ会話。右：Clear Chat あり。スクリーンショットはすべてサンプルデータです。</sub></p>

## Clear Chat を選ぶ理由

- **まず結論が見えます。** 終わったステップは 1 行ずつにまとまります（アイコン、要点、状態。エージェントが時間を伝えた場合は時間も）。ターンの最後の返信はいつも全文表示です。
- **どのエージェントも正しく表示します。** Claude、Codex、Hermes の呼び出しをすべてきちんとしたカードで表示します。Paseo が伝える 12 種類のツールにはそれぞれ専用カードがあり、`skill_view` や `memory` などの Hermes ツールにも専用の表示があります。実際の会話を再生したテストでは、空のカードは 1 枚もありません。
- **何もなくなりません。** Beautiful Chat の設定はそのまま引き継がれます。失敗した呼び出しには失敗の理由が表示されます。
- **メンテナンスしています。** 1.0.0 では、元のプラグインで未対応だった Issue と PR を 7 件対応しました。問題は GitHub Issues で受け付け、リリースごとの変更は [CHANGELOG](CHANGELOG.md) にまとめています。
- **速いです。** 私たちのテストでは、221 ステップの会話で最初の画面が約 1.3 秒で表示されました。プラグインなしの場合（同じく約 1.3 秒）とほぼ同じです。長い会話でもスクロールが引っかかりません。<sup>1</sup>

<sub>1. 1 台のマシンでヘッドレスの Google Chrome を 5 回動かした中央値です。環境によって結果は変わります。測り方は [scripts/perf/README.md](scripts/perf/README.md)（英語）にあります。</sub>

## インストール

```bash
paseo plugin install git:https://github.com/jasonhnd/paseo-clear-chat.git --ref v0.13.0.1
```

Clear Chat には Paseo 0.13.0 以降が必要です。Paseo 0.12 を使っている場合は、`--ref v0.12.0.1` で Clear Chat 0.12.0.1 をインストールしてください。

インストール後、**Settings → Plugins → Clear Chat** で色、フォント、折りたたみを選べます。

**バージョン番号について。** Clear Chat のバージョンは、対応してテストした Paseo のバージョンに、その Paseo のバージョンで何回目のリリースかを表す番号を 1 つ足したものです。たとえば 0.12.0.1 は Paseo 0.12.0 向けの最初のリリースで、次は 0.12.0.2 です。Paseo の新しいバージョンが出たら、Clear Chat の次のリリースから数え直します。Paseo 0.12.1 向けなら 0.12.1.1、0.13.0 向けなら 0.13.0.1 です。Paseo が新しくなっても、Clear Chat に新しい変更がなければリリースはしません。1.0.0 と 1.0.1 はこのルールの前に出したもので、0.12.0.1 のほうが新しい版です。

> [!IMPORTANT]
> すでに Beautiful Chat を使っていますか？プラグインのインストールや削除を**する前に**、[Beautiful Chat からのアップグレード](#beautiful-chat-からのアップグレード)をお読みください。Paseo ではプラグインを削除すると、その設定も一緒に消えます。

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
paseo plugin install git:https://github.com/jasonhnd/paseo-clear-chat.git --ref v0.13.0.1
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
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-bash-dark.png"><img alt="Shell と Git" src="docs/images/tool-bash-light.png"></picture><br>**Shell と Git。** ターミナル風の枠、色分けしたコマンド、終了コードを表示します。エージェントが時間を伝えた場合は時間も表示します。 | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-read-dark.png"><img alt="ファイルの読み込み" src="docs/images/tool-read-light.png"></picture><br>**ファイルの読み込み。** 言語アイコン、行番号、コピーボタン。ファイル名を押すとファイルマネージャーでそのファイルを表示します。 |
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
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/approval-dark.png"><img alt="承認" src="docs/images/approval-light.png"></picture><br>**承認。** リスク、実行するコマンド、対象を表示します。済んだ承認は短い状態の行として残ります。 | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/user-dark.png"><img alt="プロンプトの吹き出し" src="docs/images/user-light.png"></picture><br>**プロンプトの吹き出し。** コピーボタンとトークン使用量を表示します。 |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/syntax-dark.png"><img alt="コード" src="docs/images/syntax-light.png"></picture><br>**コード。** 言語の判定、行番号、差分の色分けがあり、コピーではコード全体をコピーします。 | |

### そのほか

- **ステップの詳細。** 折りたたまれたステップを押すと、そのすべてを表示します。入力と出力の全文、コマンドの終了コード、エージェントが伝えた場合はかかった時間が見られます。入力と出力は別々にコピーでき、失敗したステップではエラーの内容も表示されてコピーできます。1 万行あるような長い出力もなめらかにスクロールします。ウィンドウの幅が 744px 未満なら下から出るシート、744〜1023px ならポップオーバー、1024px 以上ならサイドパネルで表示します。ウィンドウの大きさを変えたり、iPad を回転したり Split View にしたりしても、表示の形だけが切り替わり、同じステップ、読んでいる位置、開いている内容はそのままです。別のステップに切り替えると、詳細は先頭から表示します。読んでいるステップに新しい出力が届いても、読んでいる位置はそのままです。会話の中でその場で開きたいときは、**When a collapsed step is pressed** を **Expand inline** にしてください。
- **キーボード操作。** ブラウザーやデスクトップアプリでは、Tab でステップに移り、↑↓ でステップ間を移動、Enter で詳細を開き、Esc で閉じて元の場所に戻ります。入力欄での入力はいつもどおりです。iPad のブラウザーにハードウェアキーボードをつないだときも使えます。iPhone、iPad、Android のネイティブアプリはタッチ操作のみです。プラグインの API では、これらのアプリでハードウェアキーを受け取れないためです。
- **ホバーでプレビュー。** マウスでは、折りたたまれたステップにポインターを少し置くと、要点と結果のプレビューが出ます。ファイルの読み込みは最大 6 行まで表示します。タッチ画面ではプレビューは出ません。
- **ステップのメニュー。** ステップを右クリックするか、タッチ画面で長押しすると、**Copy command**、**Copy path**、**Copy result**、**Open in file manager** のメニューが出ます。使える項目だけが表示され、Write や Edit で書き込んだ内容が結果としてコピーされることはありません。メニューはポインターや指のそばに出て、画面の端では反対側に開きます。
- **スマートフォンではコンパクトに。** スマートフォンの幅では、タイトル、状態の文字、アイコン、余白を小さくして、1 画面に多くのステップが入るようにします。ボタンは押しやすい大きさのままです。
- **折りたたみは自由に。** 開いている行を押すと閉じます。閉じている行を押すと詳細を表示し、**Expand inline** のときはその場で開きます。実行中・失敗・対応待ちの呼び出しは最初から開いています。一度開いたり閉じたりした行は、その状態を再読み込みしても覚えています。長いツールの出力、返信の中の長いコードブロック、長いプロンプトは最初の 15 行だけ表示し、**Show all N lines** で全部見られます。**Copy** はいつも全文をコピーします。
- **まとめの返信。** `wrap_up` ツールで送られた返信は、まとめ・質問・記号付きの選択肢・**Blocked** の警告を含む返信カードとして表示します。
- **リンクを押せます。** 返信の中のリンク（そのまま書かれた URL や画像のアドレスも含む）は、デスクトップ、Web、iOS で開けます。`mailto:` リンクはメールアプリで開きます。
- **会話内の検索。** Ctrl/Cmd+F で検索バーを開くと、ツールのカードの中も検索できます。検索するのは読み込み済みのメッセージだけなので、古いものは先に上にスクロールしてください。
- **ファイルを開く。** カードのファイル名や返信の中のパスを押すと、ホストのコンピューターの Finder やエクスプローラーなどのファイルマネージャーでそのファイルを表示します。スマートフォン、タブレット、幅の狭い Web ウィンドウでは、返信の中のパスはクリップボードにコピーされ、ホストで開くよう案内が出ます。空白を含むファイル名やパスは、インラインコードにするか Markdown のリンクにしてください。
- **文字のハイライト。** 返信の中で `==強調したい文字==` と書くとハイライトされます。コードの中の等号はそのまま表示します。

## 設定

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png"><img alt="設定画面" src="docs/images/settings-light.png"></picture>

| 設定 | 内容 |
|---|---|
| Accent colour | Paseo のテーマに合わせるか、Jade・Violet・Amber・Rose から選ぶか、**Custom** で色見本と HEX 入力欄から好きな色を選びます。カスタムの色は、文字のコントラストが 4.5:1 以上になるよう自動で調整されます。 |
| Interface font | 内蔵の Inter フォントか、システムのフォントを使います。 |
| Text size | Small (90%)、Default (100%)、Large (115%)、XL (130%)。アイコンの大きさは変わりません。 |
| Code glyphs | 合字ありの Iosevka か、普通の字形を使います。 |
| Code font | Default (Iosevka)（初期値）、Iosevka、Menlo、Consolas、Fira Code、Cascadia Code から選びます。コードブロック、インラインコード、ターミナルの出力、差分に効きます。 |
| Fold finished steps | 最初はオンです。オフにすると、個別に選んだ呼び出しを除いてすべてのステップを開きます。 |
| When a collapsed step is pressed | Open details（初期値）は、シート・ポップオーバー・サイドパネルでステップの詳細を表示します。Expand inline は会話の中でその場で開きます。 |
| Fold long output after | 10・15（初期値）・30 行、または Never。ツールの出力、返信の中のコードブロック、プロンプトに効きます。行数は元のテキストで数えるので、折り返しの分は数えません。 |
| Frosted glass | カードの背景をすりガラス風にするか、単色にします。 |
| Enhanced prompt bubble | プロンプトに装飾を付けます。オフにすると Paseo の標準の吹き出しを使います。 |
| Assistant markdown | オフにすると、返信の表示を Paseo に戻します。 |

**カスタムのアクセントカラー。** 色見本を押すか、`#RGB` または `#RRGGBB` を入力して **Apply** を押します。HEX の値が正しくないときは入力欄に残ったままエラーが表示され、保存済みの色は変わりません。プリセットに切り替えても、カスタムの色は覚えています。保存した HEX の値は変わりません。文字が読みにくくなるときだけ、表示する色をライトテーマでは暗く、ダークテーマでは明るく調整します。塗りつぶしのボタンの文字は、黒と白のうちコントラストが高いほうを使います。

**コードのフォント。** プラグイン SDK からは Paseo 自体のコードフォント設定を読めません。**Default (Iosevka)** は Iosevka を使い、**Code glyphs** の選択もそのまま使います。Web とデスクトップでは、ほかのフォントはコンピューターにインストールされている必要があり、ない場合は内蔵の Iosevka で表示します。iOS と iPadOS ではコードは常に Menlo、Android ではシステムの等幅フォントになります。プラグイン SDK では、ネイティブアプリにフォントを追加できないためです。

Clear Chat 自身の表示文字は Paseo アプリの言語（英語、簡体字中国語、日本語）に合わせます。設定はホストに保存されるので、同じホストにつないだ端末どうしで共有されます。アクセントカラー、折りたたみ、ステップを押したときの設定はすぐに反映され、表示済みの行にも効きます。そのほかの変更は新しいメッセージから反映され、前のメッセージを更新するには会話を再読み込みしてください。

> [!NOTE]
> **iOS と iPadOS では**、**Assistant markdown** または **Enhanced prompt bubble** がオンのとき、ドラッグで文字を選べません。返信、プロンプト、コードブロックの **Copy** ボタンを使ってください。コピーに失敗したときは全文を表示する画面が出るので、そこから手で選んでコピーできます。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| Cafe プラグインからのインストールに失敗する、または Paseo が `@shikijs/core` などの Shiki の依存パッケージが足りないと表示する。 | [インストール](#インストール)にある Paseo CLI のコマンドで、同じリポジトリとリリースの ref を指定してやり直してください。Clear Chat は `npm ci --include=dev` で依存パッケージを入れるので、daemon を動かすホストに Node.js と npm が必要で、ネットワークから npm レジストリにつながる必要があります。チェックアウトを自分で管理している場合は、先にそこで `npm ci --include=dev` を実行してからやり直してください。 |
| インストールが止まり、`Plugin "clear-chat" requires Paseo >=0.13.0. Your daemon is 0.12.x.`（または `Your app is …`）と表示される。 | daemon のホストと、つないでいるすべてのアプリの Paseo を 0.13.0 以降に更新してください。Paseo 0.12 のまま使う場合は、`--ref v0.12.0.1` で Clear Chat 0.12.0.1 をインストールしてください。 |
| プロンプトに貼り付けた画像が、プロンプトの吹き出しに表示されない。 | 画像はエージェントにはそのまま送られています。Paseo 0.13 は画像をプラグインに渡さないため、Clear Chat の **Enhanced prompt bubble** では表示できません。会話の中で画像を見たい場合は、**Settings → Plugins → Clear Chat** で **Enhanced prompt bubble** をオフにすると、Paseo の標準の吹き出しで表示されます。 |
| Paseo がプラグインのバージョンを受け付けない、または Clear Chat がプラグインの設定やタイムラインの対応がないと表示する。 | daemon のホストと、つないでいるすべてのアプリの Paseo を更新してから、Clear Chat を再読み込みしてください。Clear Chat に必要な Paseo のバージョンは `paseo-plugin.json` に書いてあります。 |
| プラグインの登録に失敗し、Clear Chat が起動しない。 | Paseo を更新して Clear Chat を再読み込みしてください。それでも直らない場合は、プラグインの設定をバックアップしてから CLI で入れ直してください。 |
| Clear Chat がホストの設定を読み込めない。 | ホストにつなぎ直し、**Settings → Plugins → Clear Chat** で **Retry** を選んでください。それでも直らない場合は、daemon がプラグインの設定フォルダーにアクセスできるか確認してください。 |
| Clear Chat が、設定が正しくない、または対応していない形式だと表示する。 | まず設定をバックアップしてください。正しいバックアップから戻すか、daemon のホストで設定ファイルを直してから **Retry** を選んでください。Clear Chat がこのファイルを勝手に消すことはありません。 |
| Clear Chat が設定を保存できない。 | daemon のホストの書き込み権限と空き容量を確認し、つなぎ直してから、もう一度設定を変えてください。**Retry** は設定を読み込み直すだけで、失敗した変更を送り直すことはありません。 |
| ほかのクライアントからの変更で、設定が変わり続ける。 | ほかの変更が終わるのを待ってから、もう一度設定を変えてください。 |
| Beautiful Chat の設定が引き継がれない。 | Beautiful Chat の元の設定は残したまま、バックアップしてください。両方のプラグインの設定フォルダーの読み書き権限と空き容量を確認し、Clear Chat を再読み込みしてやり直してください。引き継ぎに失敗すると daemon のログに復旧用のメッセージが残ります。すでにある設定が上書きされることはありません。 |

Paseo がビルドのコマンドを実行できない、またはプラグインのバンドルを読み込めない場合、Clear Chat は自分でメッセージを表示できません。daemon のホストの Node.js、npm、Paseo のバージョンを確認し、CLI からやり直してください。それでも直らない場合は、プラグイン設定の **Report a problem** から、復旧用のメッセージと Paseo のバージョンを添えてお知らせください。ログを共有する前に、個人的なパスや会話の内容は消してください。

## 問題の報告

不具合やご要望は [GitHub の Issue](https://github.com/jasonhnd/paseo-clear-chat/issues/new/choose) でお知らせください。設定画面のいちばん下にある **Report a problem** からも開けます。日本語や中国語でも大丈夫です。

## クレジット

Clear Chat は ABorakati さんの [Beautiful Chat](https://github.com/ABorakati/beautiful-chat) をもとに、MIT ライセンスで作っています。元の著作権表示は [LICENSE](LICENSE) に残しています。

文字サイズの機能を[提供してくださった](https://github.com/ABorakati/beautiful-chat/pull/9) Moyf さんに感謝します。ここではホストの設定に保存する形に合わせています。

開発者向けの情報（ビルド手順、プロジェクトの構成、開発中に見つかった Paseo プラグイン SDK の制限）は [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)（英語）にあります。

## ライセンス

[MIT](LICENSE)
