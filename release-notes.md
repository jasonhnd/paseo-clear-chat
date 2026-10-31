# Clear Chat 0.14.0.4 — Release notes / 发布说明 / リリースノート

## English

Release date: **2026-11-01**

### What’s new

- The version shown on Paseo’s plugins page and the package version now match the release they belong to. The previous release carried the code of 0.14.0.3 while both version fields still said 0.14.0.2, so an installed build could not be identified at a glance ([issue #121](https://github.com/jasonhnd/paseo-clear-chat/issues/121)).

### How to upgrade

- Update an existing installation with `paseo plugin update clear-chat --ref v0.14.0.4`; review the README before changing versions. Removing a plugin also removes its settings.

### Known limitations

- **A storage location Clear Chat cannot write to.** Your conversation is not damaged and nothing has been deleted. When Clear Chat cannot read or update its saved copy of a conversation, it shows that conversation with Hermes’s own text instead; a location that is read-only and cannot be written to gives the same result. This is a fallback, not a sign that the record was damaged or that data was lost.
- **“Saved” means the storage confirmed the whole write.** When Clear Chat cannot record a message, the window stays open, the message is reported as not sent, and sending it again works once storage is available. The exact wording shown in that moment has not been verified on a real host yet.
- **Read-only storage was measured on macOS and on a full volume.** The Linux equivalent has not been tested.

### Full changes

https://github.com/jasonhnd/paseo-clear-chat/compare/v0.14.0.3...v0.14.0.4 and the full entry in [CHANGELOG.md](https://github.com/jasonhnd/paseo-clear-chat/blob/v0.14.0.4/CHANGELOG.md).

## 中文

发布日期：**2026-11-01**

### 这一版有什么

- Paseo 插件页显示的版本号与包版本号现在和它们所属的发布一致。上一版带的是 0.14.0.3 的代码，但两个版本字段仍写着 0.14.0.2，装上之后没法一眼分清是哪个版本（[issue #121](https://github.com/jasonhnd/paseo-clear-chat/issues/121)）。

### 怎么升级

- 用 `paseo plugin update clear-chat --ref v0.14.0.4` 更新已有安装；换版本前先看 README。卸载插件会连它的设置一起删掉。

### 已知限制

- **存储位置写不进去的情况。** 你的对话不会因此损坏，也没有东西被删除。Clear Chat 读不到或写不进它保存的对话副本时，会改用 Hermes 自己的原文显示那段对话；只读、写不进去的位置结果相同。这是回退显示，不代表记录损坏或数据丢失。
- **「已保存」以存储确认整条写入为准。** 写不进记录时窗口不会关闭，这条会报成没发出去，等存储恢复后再发一次就能成功。那一刻界面上的具体文字还没有在真机上验证过。
- **只读存储只在 macOS 与磁盘写满的情况下实测过。** Linux 上对应的情况没有测。

### 完整改动清单

https://github.com/jasonhnd/paseo-clear-chat/compare/v0.14.0.3...v0.14.0.4 ，完整条目见 [CHANGELOG.md](https://github.com/jasonhnd/paseo-clear-chat/blob/v0.14.0.4/CHANGELOG.md)。

## 日本語

公開日：**2026-11-01**

### この版の変更

- Paseo のプラグイン画面に表示されるバージョンとパッケージのバージョンが、そのリリースと一致するようになりました。前の版は 0.14.0.3 のコードを含みながら、どちらのバージョン表記も 0.14.0.2 のままだったため、インストール済みのビルドをひと目で判別できませんでした（[issue #121](https://github.com/jasonhnd/paseo-clear-chat/issues/121)）。

### 更新方法

- 既存のインストールは `paseo plugin update clear-chat --ref v0.14.0.4` で更新できます。バージョンを変える前に README を確認してください。プラグインを削除すると設定も一緒に削除されます。

### 既知の制限

- **保存先に書き込めない場合。** 会話が壊れることも、何かが削除されることもありません。Clear Chat が保存した会話の控えを読めない、または書き込めないときは、その会話を Hermes 本来のテキストで表示します。読み取り専用で書き込めない場所でも同じ結果です。これは代替表示であり、記録が壊れた、データが失われたという意味ではありません。
- **「保存済み」は、保存先が書き込み全体を確認できたときだけ成立します。** 記録に書き込めないときはウィンドウを閉じず、そのメッセージを送信していないものとして表示し、保存先が使えるようになってから送り直せば成功します。その瞬間の画面の文言は、まだ実機で確認していません。
- **読み取り専用の保存先は macOS と容量不足の状況でのみ確認しています。** Linux の同等の状況は未検証です。

### 変更の一覧

https://github.com/jasonhnd/paseo-clear-chat/compare/v0.14.0.3...v0.14.0.4 。完全な変更一覧は [CHANGELOG.md](https://github.com/jasonhnd/paseo-clear-chat/blob/v0.14.0.4/CHANGELOG.md) を参照してください。
