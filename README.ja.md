<p align="right"><a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <b>日本語</b></p>

<h1 align="center">Clear Chat</h1>

<p align="center"><b>エージェントとの会話をひと目で読みやすく：ステップは 1 行にまとまり、ツールごとにカードがあり、押せば詳細が見られます。</b><br><a href="https://paseo.sh">Paseo</a> のプラグインです。デスクトップ、Web、iPhone、iPad で使えます。</p>

<p align="center">
  <a href="https://github.com/jasonhnd/paseo-clear-chat/releases"><img alt="Version" src="https://img.shields.io/github/v/tag/jasonhnd/paseo-clear-chat?label=version&sort=date"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://paseo.sh"><img alt="Paseo 0.14.0+" src="https://img.shields.io/badge/Paseo-%3E%3D0.14.0-5b5bd6"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/hero-dark.png">
    <img width="1000" alt="デスクトップのウィンドウとスマートフォンの幅で表示した Clear Chat：終わったステップは 1 行ずつにまとまり、ステップの詳細が会話の横に開いている" src="images/hero-light.png">
  </picture>
</p>

<p align="center">
  <img width="800" alt="26 秒のデモ：エージェントが作業を進め、終わったステップが 1 行にまとまり、ステップをサイドパネルで開き、ウィンドウをスマートフォンの幅まで狭める" src="images/demo.gif">
</p>

<p align="center"><sub>スクリーンショットとデモはすべてサンプルデータです。</sub></p>

## Clear Chat を選ぶ理由

- **まず結論が見えます。** 終わったステップは 1 行ずつにまとまり、ターンの最後の返信はいつも全文表示です。
- **どのステップも開けます。** ステップの入力、出力、エラーの全文を、デスクトップではサイドパネル、iPad ではポップオーバー、スマートフォンでは下から出るシートで表示します。[スマートフォンと iPad](#スマートフォンと-ipad) をご覧ください。
- **ツールごとにカードがあります。** Claude、Codex、Hermes の呼び出しをすべてきちんとしたカードで表示します。Paseo が伝える 12 種類のツールにはそれぞれ専用カードがあり、`skill_view` や `memory` などの Hermes ツールにも専用の表示があります。[機能](#機能)をご覧ください。
- **あなたの言語で表示します。** Clear Chat 自身の表示文字は Paseo アプリの言語（英語、簡体字中国語、日本語）に合わせます。
- **好みに合わせて変えられます。** アクセントカラー、フォント、文字サイズ、折りたたみを変えられます。設定はホストに保存され、そのホストにつないだ端末で共有されます。[設定](#設定)をご覧ください。
- **速さはそのまま。** 私たちのテストでは、221 ステップの会話で最初の画面が約 1.3 秒で表示され、プラグインなしの場合とほぼ同じでした。<sup>1</sup>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/compare-dark.png">
    <img alt="同じ会話：左はプラグインなし、右は Clear Chat あり" src="images/compare-light.png">
  </picture>
</p>

<p align="center"><sub>左：プラグインなしの同じ会話。右：Clear Chat あり。</sub></p>

<sub>1. 1 台のマシンでヘッドレスの Google Chrome を 5 回動かした中央値です。環境によって結果は変わります。測り方は [scripts/perf/README.md](scripts/perf/README.md)（英語）にあります。</sub>

## インストール

```bash
paseo plugin install git:jasonhnd/paseo-clear-chat --ref v0.14.0.3
```

Paseo のプラグイン画面を開き、Clear Chat の説明の先頭でバージョンを確認してください。Paseo 0.14.0 は、アプリの言語を切り替えても、ここに既定の英語の説明を表示します。

Clear Chat 0.14.0.3 には Paseo 0.14.0 以降が必要です。**Settings → Plugins → Clear Chat** で色、フォント、折りたたみを選べます。

あとで更新するには：

```bash
paseo plugin update clear-chat
```

最初にインストールしたリリースではなく、`main` ブランチの最新版に切り替わります。変更する前に確認が出ます。スクリプトで実行するときは `--yes` を付けてください。特定のリリースに切り替えたり前のリリースに戻したりするには、`--ref` を付けます（例：`paseo plugin update clear-chat --ref v0.13.0.1`）。更新時は通常設定が残りますが、特定バージョンへの切り戻し結果や設定の互換性は保証されません。以下の未検証の Paseo 0.13 の例をご覧ください。

> [!IMPORTANT]
> すでに Beautiful Chat を使っていますか？プラグインのインストールや削除を**する前に**、[Beautiful Chat からのアップグレード](#beautiful-chat-からのアップグレード)をお読みください。Paseo ではプラグインを削除すると、その設定も一緒に消えます。

<details>
<summary><b>以前の Paseo（0.13 / 0.12）とバージョン番号の見方</b></summary>

Paseo 0.13 を使い続ける場合、公開済みの Clear Chat 0.13.2.2 は Paseo 0.13.0 以降への対応を明記しています。以下のインストールコマンドは Paseo 0.13 でまだ実機確認していません：

```bash
paseo plugin install git:jasonhnd/paseo-clear-chat --ref v0.13.2.2
```

すでに Clear Chat が入っている場合、下は旧リリースを指定するための候補コマンドです。**この切り替えと設定への影響は Paseo 0.13 でまだ実機確認していません。新しい版から古い版への切り替えも未検証です。**

```bash
paseo plugin update clear-chat --ref v0.13.2.2 --yes
```

Paseo 0.12 では、代わりに Clear Chat 0.12.0.1 をインストールしてください：

```bash
paseo plugin install git:jasonhnd/paseo-clear-chat --ref v0.12.0.1
```

すでに Clear Chat が入っていると、`install` は `Plugin ID clear-chat is already configured` と表示して止まります。その場合は `update` でバージョンを切り替えてください。設定はそのまま残ります：

```bash
paseo plugin update clear-chat --ref v0.12.0.1 --yes
```

Clear Chat のバージョンは、対応してテストした Paseo のバージョンに、その Paseo のバージョンで何回目のリリースかを表す番号を 1 つ足したものです。たとえば 0.13.0.1 は Paseo 0.13.0 向けの最初のリリースで、0.13.0.2 は 2 つ目です。Paseo の新しいバージョンが出たら、Clear Chat の次のリリースから数え直します（Paseo 0.13.1 向けなら 0.13.1.1）。Paseo が新しくなっても、Clear Chat に新しい変更がなければリリースはしません。1.0.0 と 1.0.1 はこのルールの前に出したもので、0.12.0.1 のほうが新しい版です。

</details>

## スマートフォンと iPad

Paseo は同じプラグインをデスクトップ、Web、iPhone、iPad で動かします。Clear Chat は端末の名前ではなく使える幅で表示の形を選ぶので、幅の狭いデスクトップのウィンドウはスマートフォンと同じ表示になります。

| | スマートフォン | iPad | デスクトップと Web |
|---|---|---|---|
| ステップの詳細 | 下から出るシート | ポップオーバー（幅 744〜1023px）またはサイドパネル（1024px 以上） | サイドパネル。狭いウィンドウではポップオーバーかシート |
| 行の表示 | タイトル、アイコン、余白を小さくして、1 画面に多くのステップが入ります。ボタンは押しやすい大きさのまま | 標準 | 標準 |
| ステップのメニュー | ステップを長押し | ステップを長押し | ステップを右クリック |
| ホバーでプレビュー | – | – | 折りたたまれたステップにポインターを少し置く |
| キーボード | – | ブラウザーでハードウェアキーボードをつなぐと Tab、矢印キー、Enter、Esc が使えます | Tab、矢印キー、Enter、Esc |
| 返信の中のパス | クリップボードにコピーし、ホストで開くよう案内 | クリップボードにコピーし、ホストで開くよう案内 | Finder やエクスプローラーなどのファイルマネージャーで表示 |

ウィンドウの大きさを変えたり、iPad を回転したり Split View にしたりしても、表示の形だけが切り替わり、同じステップ、読んでいる位置、開いている内容はそのままです。

<sub>これらのスクリーンショットは、ブラウザーでスマートフォンと iPad の幅にして撮ったもので、サンプルデータを使っています。</sub>

| スマートフォンの幅：会話 | スマートフォンの幅：ステップの詳細 | スマートフォンの幅：ステップのメニュー |
|---|---|---|
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/phone-timeline-dark.png"><img alt="スマートフォンの幅：終わったステップが 1 行ずつにまとまり、最後の返信が開いている会話" src="docs/images/phone-timeline-light.png"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/phone-details-dark.png"><img alt="スマートフォンの幅：編集ステップのパッチと結果を下から出るシートで表示" src="docs/images/phone-details-light.png"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/phone-menu-dark.png"><img alt="スマートフォンの幅：コマンドのステップを長押しして出たメニュー（コマンドをコピー、結果をコピー）" src="docs/images/phone-menu-light.png"></picture> |

| iPad の幅・縦向き：ポップオーバー | iPad の幅・横向き：サイドパネル |
|---|---|
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/ipad-popover-dark.png"><img alt="iPad の幅・縦向き：ステップの詳細を会話の上にポップオーバーで表示" src="docs/images/ipad-popover-light.png"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/ipad-side-dark.png"><img alt="iPad の幅・横向き：左に会話、右のサイドパネルにステップの詳細" src="docs/images/ipad-side-light.png"></picture> |

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

- **ステップの詳細。** 折りたたまれたステップを押すと、入力と出力の全文、コマンドの終了コード、エージェントが伝えた場合はかかった時間が見られます。入力と出力は別々にコピーでき、失敗したステップではエラーの内容も表示されてコピーできます。1 万行あるような長い出力もなめらかにスクロールします。会話の中でその場で開きたいときは、**折りたたんだステップを押したとき**（When a collapsed step is pressed）を **その場で開く**（Expand inline）にしてください。
- **折りたたみは自由に。** 開いている行を押すと閉じます。実行中・失敗・対応待ちの呼び出しは最初から開いています。一度開いたり閉じたりした行は、その状態を再読み込みしても覚えています。長いツールの出力、返信の中の長いコードブロック、長いプロンプトは最初の 15 行だけ表示し、**全 N 行を表示**（Show all N lines）で全部見られます。**コピー**（Copy）はいつも全文をコピーします。
- **ステップのメニュー。** **コマンドをコピー**（Copy command）、**パスをコピー**（Copy path）、**結果をコピー**（Copy result）、**ファイルマネージャーで開く**（Open in file manager）。使える項目だけが表示され、Write や Edit で書き込んだ内容が結果としてコピーされることはありません。
- **まとめの返信。** `wrap_up` ツールで送られた返信は、まとめ・質問・記号付きの選択肢・**ブロック中**（Blocked）の警告を含む返信カードとして表示します。
- **リンクを押せます。** 返信の中のリンク（そのまま書かれた URL や画像のアドレスも含む）は、デスクトップ、Web、iOS で開けます。`mailto:` リンクはメールアプリで開きます。
- **会話内の検索。** Ctrl/Cmd+F で検索バーを開くと、ツールのカードの中も検索できます。検索対象は読み込み済みのメッセージだけです。
- **ファイルを開く。** カードのファイル名や返信の中のパスを押すと、ホストのコンピューターの Finder やエクスプローラーなどのファイルマネージャーでそのファイルを表示します。空白を含むファイル名やパスは、インラインコードにするか Markdown のリンクにしてください。
- **文字のハイライト。** 返信の中で `==強調したい文字==` と書くとハイライトされます。コードの中の等号はそのまま表示します。
- **貼り付けた画像。** **プロンプトの吹き出しを強化**（Enhanced prompt bubble）がオンのとき、プロンプトに貼り付けた画像を吹き出しにサムネイルで表示します。Codex と Claude のエージェントに対応しています。押すと大きく表示します。1.5 MB または 2400 万画素を超える画像は表示しません。Hermes のエージェントは、作成するときにプロバイダーの **·CC** 版を選んでください。[Hermes のエージェントで貼り付けた画像](#hermes-のエージェントで貼り付けた画像)をご覧ください。

## 設定

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png"><img alt="設定画面" src="docs/images/settings-light.png"></picture>

| 設定 | 内容 |
|---|---|
| アクセントカラー（Accent colour） | Paseo のテーマに合わせるか、ジェード（Jade）・バイオレット（Violet）・アンバー（Amber）・ローズ（Rose）から選ぶか、**カスタム**（Custom）で色見本と HEX 入力欄から好きな色を選びます。カスタムの色は、文字のコントラストが 4.5:1 以上になるよう自動で調整されます。 |
| インターフェースのフォント（Interface font） | 内蔵の Inter フォントか、システム（System）のフォントを使います。 |
| コードの字形（Code glyphs） | 合字（Ligatures）ありの Iosevka か、そのまま（Literal）の字形を使います。 |
| コードのフォント（Code font） | 「デフォルト（Iosevka）」（Default (Iosevka)、初期値）、Iosevka、Menlo、Consolas、Fira Code、Cascadia Code から選びます。コードブロック、インラインコード、ターミナルの出力、差分に効きます。 |
| 文字サイズ（Text size） | 小（Small、90%）、標準（Default、100%）、大（Large、115%）、特大（XL、130%）。アイコンの大きさは変わりません。 |
| Hermes·CC プロバイダー（Hermes·CC providers） | 最初はオンです。`hermes acp` で起動する Hermes プロバイダーごとに **·CC** 版を追加し、Hermes のエージェントに貼り付けた画像を吹き出しに表示できるようにします。変更はホストを再読み込みすると反映されます。 |
| 完了したステップを折りたたむ（Fold finished steps） | 最初はオンです。オフにすると、個別に選んだ呼び出しを除いてすべてのステップを開きます。 |
| 折りたたんだステップを押したとき（When a collapsed step is pressed） | 詳細を開く（Open details、初期値）は、シート・ポップオーバー・サイドパネルでステップの詳細を表示します。その場で開く（Expand inline）は会話の中で開きます。 |
| 長い出力を折りたたむ行数（Fold long output after） | 10・15（初期値）・30 行、または折りたたまない（Never）。ツールの出力、返信の中のコードブロック、プロンプトに効きます。行数は元のテキストで数えるので、折り返しの分は数えません。 |
| すりガラス（Frosted glass） | カードの背景をすりガラス風にするか、単色にします。 |
| ポインターの光（Pointer glow） | ポインターを追ってカードの上にやわらかい光が出ます。デスクトップと Web のみです。 |
| プロンプトの吹き出しを強化（Enhanced prompt bubble） | プロンプトに装飾を付けます。オフにすると Paseo の標準の吹き出しを使います。 |
| 選択したときの操作（Selection actions） | カードの中で文字を選ぶと、「コピー」と「チャットに追加」がある小さなバーが出ます。デスクトップと Web のみです。 |
| アシスタントの Markdown（Assistant markdown） | プラグイン独自の見出し、リスト、コードブロックで返信を表示します。オフにすると、返信の表示を Paseo に戻します。 |
| Markdown のスタイル（Markdown style） | ドキュメント（Document：ゆったりして長い回答向け）、コンパクト（Compact：間隔を詰めて短い返信向け）、ターミナル（Terminal：本文をコードのフォントで表示）。 |

**カスタムのアクセントカラー。** 色見本を押すか、`#RGB` または `#RRGGBB` を入力して **適用**（Apply）を押します。HEX の値が正しくないときは入力欄に残ったままエラーが表示され、保存済みの色は変わりません。プリセットに切り替えても、カスタムの色は覚えています。保存した HEX の値は変わりません。文字が読みにくくなるときだけ、表示する色をライトテーマでは暗く、ダークテーマでは明るく調整します。塗りつぶしのボタンの文字は、黒と白のうちコントラストが高いほうを使います。

設定はホストに保存されるので、同じホストにつないだ端末どうしで共有されます。アクセントカラー、折りたたみ、ステップを押したときの設定はすぐに反映され、表示済みの行にも効きます。そのほかの変更は新しいメッセージから反映され、前のメッセージを更新するには会話を再読み込みしてください。

## Hermes のエージェントで貼り付けた画像

Paseo 0.13 はプラグインがメッセージを受け取る前に貼り付けた画像を取り除き、Hermes にも Clear Chat があとで画像を探すための手がかりが残りません。そこで Clear Chat は、設定済みの Hermes プロバイダーごとに、名前に **·CC** が付いた自前の版を追加します（例：**Hermes·PP·CC**）。コマンドが `hermes acp` の Hermes プロバイダーであれば、`-p <profile>` の有無にかかわらず対象です。同じコマンド、プロファイル、環境で同じ Hermes を起動し、プロンプトをそのまま Hermes に渡す前に、貼り付けた画像を自分のフォルダーに保存します。吹き出しは、そのメッセージと正確に一致したときだけ画像を表示し、一致しなければ何も表示しません。

使うには、Paseo で新しいエージェントを作るときに **·CC** 版を選んでください。Paseo のバックグラウンドサービスを再起動しても、Mac を再起動しても、Paseo をアップグレードしても、返信の途中でない状態で Paseo が強制終了したりクラッシュしたりしても、画像と元のプロンプトの文章は残ります。元の Hermes エージェントは変わりません。

**·CC** 版の権限モードは、**·CC** のウィンドウを初めて開き、Paseo が選択肢の一覧を更新した（または再読み込みした）あとに一覧へ表示されます。モデルも同じですが、Hermes プロバイダーの設定ですでにモデルが列挙されている場合は、最初から表示されます。

**·CC** の項目には Hermes のアイコンが表示されます。**·CC** エージェントを作成するときは、Hermes がネイティブのインターフェースで提供するモデルも含め、対応するモデルを選べます。Hermes がモデルの選択を拒否した場合、Clear Chat は別のモデルへ黙って切り替えず、エラーを表示します。

**すでに影響を受けた会話。** Clear Chat 0.13.2.2 は、一部のツール呼び出しが失敗してエラーメッセージがないときに、**·CC** の会話履歴を開けなくなる互換性の問題を今後防ぎます。すでにこの問題の影響を受けた会話は、アップグレード後も開けない場合があります。現在、それらの会話を自動で修復する方法はありません。

知っておいてほしいこと：

- このバージョン以降に **·CC** エージェントで送ったプロンプトだけ画像が表示されます。以前に作ったエージェントと、その古いメッセージには表示されません。
- エラーや通知などのシステムメッセージは保存されないので、再起動後は表示されません。
- 新しい形式の識別情報を持つ 2 つの書き手が同じ会話を記録しようとしたときは、記録を混ぜずに Hermes 本来のテキストで表示します。以前の版が書いた記録にはこの識別情報がないため、従来どおり履歴として再生されます。メッセージを保存した記録に書き込めないときはウィンドウは閉じず、このメッセージを送信されていないものとして表示するので、もう一度送信できます。保存した記録そのものが削除されたり書き換えられたりすることはありません。
- 保存したファイル自体が壊れている場合は、その会話は Hermes 自身の文章に戻り、画像を表示しません。壊れた画像が影響するのは、その画像があるプロンプトだけです。
- 保存した記録が一致しない、変更されている、スラッシュコマンドや巻き戻し（例：`/undo`）を使った、といった場合は、その会話では Clear Chat は Hermes 自身の文章に戻り、画像を表示しません。
- 同じ会話は一度に 1 つのウィンドウで使ってください。2 つ目のウィンドウが同じ会話にプロンプトを送ると、記録は破棄され、両方のウィンドウが Hermes 自身の文章に戻ります。
- 画像は Paseo のホームフォルダー（初期値は `~/.paseo`）の `plugin-data/clear-chat/hermes-cc-images` に最大 2 GB まで保存され、いっぱいになると古いものから削除されます。保存した記録はそのとなりの `hermes-cc-history` にあり、1 つの会話の記録が 64 MB を超えると、その会話は Hermes 自身の文章に戻ります。すべての記録の合計が 1 GB を超えたときは、いちばん古い会話の記録が先に削除され、その会話は Hermes 自身の文章に戻り、画像を表示しません。
- 消したいときは、先に Paseo を終了してください。画像のフォルダーを削除しても会話と文章は残り、画像だけがなくなります。記録のフォルダーを削除すると、会話は Hermes 自身の文章に戻り、画像は表示されません。
- **·CC** 版を追加したくないときは、設定で **Hermes·CC プロバイダー**（Hermes·CC providers）をオフにして、ホストを再読み込みしてください。すでに作った **·CC** エージェントは一覧に残りますが、開くと提供元が見つからないため "Failed to load agent" と表示されます。会話は消えていません。設定をオンに戻して再読み込みすると、また開け、文章も画像も残っています。

## プラグインにできないこと

Clear Chat が変えるのは、Paseo での会話の表示のしかただけです。Paseo が決めていて、プラグインには開かれていないこともあります：

- **元の Hermes エージェントで貼り付けた画像。** Paseo 0.13 はプラグインがメッセージを受け取る前に貼り付けた画像を取り除き、Hermes にも Clear Chat があとで画像を探すための手がかりが残りません。そのエージェントの **·CC** 版を使ってください（[Hermes のエージェントで貼り付けた画像](#hermes-のエージェントで貼り付けた画像)をご覧ください）。元の Hermes エージェントでも画像はそのまま送られています。**プロンプトの吹き出しを強化**（Enhanced prompt bubble）をオフにすると、Paseo の標準の吹き出しで表示されます。
- **Paseo 自体の Markdown。** Clear Chat は Paseo の Markdown 処理を使えないため、**アシスタントの Markdown**（Assistant markdown）が対応しているのはその一部です。mermaid の図、画像、ホストのファイルパスのリンクを使うには、これをオフにしてください。
- **ネイティブアプリのハードウェアキー。** キーボード操作はブラウザーとデスクトップアプリで使えます。iPhone、iPad、Android のネイティブアプリはタッチ操作のみです。
- **ネイティブアプリのフォント。** プラグインは Paseo のコードフォント設定を読めず、ネイティブアプリにフォントを追加することもできません。iOS と iPadOS ではコードは常に Menlo、Android ではシステムの等幅フォントになります。
- **iOS と iPadOS でのドラッグ選択。** **アシスタントの Markdown**（Assistant markdown）または **プロンプトの吹き出しを強化**（Enhanced prompt bubble）がオンのとき、ドラッグで文字を選べません。返信、プロンプト、コードブロックの **コピー**（Copy）ボタンを使ってください。コピーに失敗したときは全文を表示する画面が出るので、そこから手で選んでコピーできます。
- **ステップの時間。** ステップにかかった時間は、エージェントが伝えた場合だけ表示します。
- **Paseo 0.14 のターン全体の折りたたみ。** Paseo のターン全体の折りたたみは、Clear Chat が描画する内容には適用されません。
- **文字サイズ。** Clear Chat が描画する内容は Paseo の文字サイズ設定に連動しません。Clear Chat 自身の **文字サイズ**（Text size）設定を使ってください。
- **会話内の検索。** 検索バーが検索するのは読み込み済みのメッセージだけです。古いものは先に上にスクロールしてください。
- **削除したあとの設定。** Paseo ではプラグインを削除すると、その設定も一緒に消えます。先にバックアップしてください。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| Cafe プラグインからのインストールに失敗する、または Paseo が `@shikijs/core` などの Shiki の依存パッケージが足りないと表示する。 | [インストール](#インストール)にある Paseo CLI のコマンドで、同じリポジトリとリリースの ref を指定してやり直してください。Clear Chat は `npm ci --include=dev` で依存パッケージを入れるので、daemon を動かすホストに Node.js と npm が必要で、ネットワークから npm レジストリにつながる必要があります。チェックアウトを自分で管理している場合は、先にそこで `npm ci --include=dev` を実行してからやり直してください。 |
| プラグインに新しい Paseo が必要なため、インストールが止まる。 | Clear Chat 0.14.0.3 を使うには、daemon のホストと接続するすべてのアプリを Paseo 0.14.0 以降に更新してください。古いホストについては、[インストール](#インストール)の Paseo 0.13 のコマンドと未検証の注意、および別記の Paseo 0.12 の説明をご覧ください。 |
| Paseo がプラグインのバージョンを受け付けない、または Clear Chat がプラグインの設定やタイムラインの対応がないと表示する。 | daemon のホストと、つないでいるすべてのアプリの Paseo を更新してから、Clear Chat を再読み込みしてください。Clear Chat に必要な Paseo のバージョンは `paseo-plugin.json` に書いてあります。 |
| プラグインの登録に失敗し、Clear Chat が起動しない。 | Paseo を更新して Clear Chat を再読み込みしてください。それでも直らない場合は、プラグインの設定をバックアップしてから CLI で入れ直してください。 |
| Clear Chat がホストの設定を読み込めない。 | ホストにつなぎ直し、**Settings → Plugins → Clear Chat** で **再試行**（Retry）を選んでください。それでも直らない場合は、daemon がプラグインの設定フォルダーにアクセスできるか確認してください。 |
| Clear Chat が、設定が正しくない、または対応していない形式だと表示する。 | まず設定をバックアップしてください。正しいバックアップから戻すか、daemon のホストで設定ファイルを直してから **再試行**（Retry）を選んでください。Clear Chat がこのファイルを勝手に消すことはありません。 |
| Clear Chat が設定を保存できない。 | daemon のホストの書き込み権限と空き容量を確認し、つなぎ直してから、もう一度設定を変えてください。**再試行**（Retry）は設定を読み込み直すだけで、失敗した変更を送り直すことはありません。 |
| ほかのクライアントからの変更で、設定が変わり続ける。 | ほかの変更が終わるのを待ってから、もう一度設定を変えてください。 |
| Beautiful Chat の設定が引き継がれない。 | Beautiful Chat の元の設定は残したまま、バックアップしてください。両方のプラグインの設定フォルダーの読み書き権限と空き容量を確認し、Clear Chat を再読み込みしてやり直してください。引き継ぎに失敗すると daemon のログに復旧用のメッセージが残ります。すでにある設定が上書きされることはありません。 |

Paseo がビルドのコマンドを実行できない、またはプラグインのバンドルを読み込めない場合、Clear Chat は自分でメッセージを表示できません。daemon のホストの Node.js、npm、Paseo のバージョンを確認し、CLI からやり直してください。それでも直らない場合は、プラグイン設定の **問題を報告**（Report a problem）から、復旧用のメッセージと Paseo のバージョンを添えてお知らせください。ログを共有する前に、個人的なパスや会話の内容は消してください。

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

`beautiful-chat` の設定フォルダーがない場合は、Beautiful Chat の設定を変えたことがないので、この手順は飛ばしてかまいません。

**2. インストール**

```bash
paseo plugin install git:jasonhnd/paseo-clear-chat --ref v0.14.0.3
```

**3. 確認してから古いプラグインを削除**

`${PASEO_HOME:-$HOME/.paseo}/plugin-settings/clear-chat/presentation.json` ができていて、`$legacy_backup/presentation.json` と同じ内容であることを確認してください。すでにある Clear Chat の設定ファイルが上書きされることはありません。ファイルがない、または内容が違う場合は、Beautiful Chat とバックアップを残したまま、ログで移行のエラーを確認してください。

```bash
paseo plugin remove beautiful-chat
```

バックアップは残しておいてください。

**元に戻す**

Clear Chat の今の設定をバックアップしてから削除します。Clear Chat を削除すると設定もすべて消えます（`update` では消えません）。`clear-chat` の設定フォルダーがない場合は、`cp` の行は飛ばしてください。

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
paseo plugin install git:jasonhnd/paseo-clear-chat --ref 2bf25e8
```

Clear Chat で変えた設定は Beautiful Chat には戻りません。バックアップは両方とも残しておいてください。

**移行のしくみ**

- 初回の起動時、Clear Chat の設定ファイルがまだなければ、サーバーが Beautiful Chat の `presentation.json` を Clear Chat の設定フォルダーにコピーします。どちらのファイルも削除・上書きしません。
- コピーに失敗した場合は、2 つのパスとエラーをログに残し、Clear Chat は初期設定で起動します。次回の起動時にもう一度試します。
- そのあと設定はバージョン 1 から 2 に更新されます。選んだ内容はそのまま残り、新しい 2 つの折りたたみ設定は初期値から始まります。
- ブラウザーでは、以前ブラウザーに保存されていた設定を 1 回だけ取り込みます。ホストに保存された設定が常に優先です。
- 移行は標準のインストール ID を前提にしています。`--id` を変えている場合や、daemon のフォルダーを `--home` だけで指定している場合は、設定を手でコピーしてください。

</details>

## 問題の報告

不具合やご要望は [GitHub の Issue](https://github.com/jasonhnd/paseo-clear-chat/issues/new/choose) でお知らせください。設定画面のいちばん下にある **問題を報告**（Report a problem）からも開けます。日本語や中国語でも大丈夫です。リリースごとの変更は [CHANGELOG](CHANGELOG.md) にまとめています。

不具合フォームでは、画面の問題について、個人情報を除いたスクリーンショットか動画の提出をお願いしています。提出できない場合は理由を記入してください。画面以外の問題で画像が不要な場合は `N/A — not a UI issue` と記入してください。インストール済みの製品バージョンが分かる場合は記入してください。Git revision はコミットであり、製品バージョンではありません。機能の要望フォームでは、使う場面と期待する結果を尋ねます。GitHub フォームの実際の表示と送信は未検証です。

## クレジット

Clear Chat は ABorakati さんの [Beautiful Chat](https://github.com/ABorakati/beautiful-chat) をもとに、MIT ライセンスで作っています。元の著作権表示は [LICENSE](LICENSE) に残しています。

文字サイズの機能を[提供してくださった](https://github.com/ABorakati/beautiful-chat/pull/9) Moyf さんに感謝します。ここではホストの設定に保存する形に合わせています。

開発者向けの情報（ビルド手順、プロジェクトの構成、開発中に見つかった Paseo プラグイン SDK の制限）は [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)（英語）にあります。

## ライセンス

[MIT](LICENSE)