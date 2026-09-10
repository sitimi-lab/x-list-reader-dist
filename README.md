# Xリスト強化 — リポスト振り分け＋既読ライン

PC ChromeのTampermonkeyと、iPhone SafariのUserscripts向けの配布用リポジトリです。
現在のバージョン: **8.14.0**

## 初回インストール

[スクリプト本体を開く](https://raw.githubusercontent.com/sitimi-lab/x-list-reader-dist/main/x-list-reader.user.js)

- PC：Tampermonkeyを有効にしてリンクを開き、インストールします。
  既存のスクリプトがある場合は、その編集画面に新しい本体を全体ごと貼り替えて保存する方法でも構いません。
- iPhone：Safariでリンクを開き、拡張機能メニューのUserscriptsからインストール案内を押します。
  保存先は「このiPhone内」の既存フォルダを使えます。
  初回だけ古いスクリプトを保存先フォルダの外へ退避し、二重登録を避けてください。

インストール後はXを再読み込みし、左下のRPボタンからパネルを開いてバージョンを確認します。
インストール案内が出ない場合は、配布URLでUserscriptsの実行権限を確認してください。

## 上下のバーの表示

RPパネルで上部・下部それぞれを「そのまま／スクロール中は隠す／常に隠す」から選べます。
初期設定では上下どちらへスクロールしても隠れ、読むために止まっても隠れた状態を保ちます。
上部はスマホ幅の画面が対象で、戻るボタンは残します。
上端に戻るか、下端で止まってから改めて下へ進む操作で表示します。
途中でもRPパネルの「上下のバーを表示」で呼び戻せます。「常に隠す」も次のスクロールまで一時解除します。
「そのまま」はX本来の動作に任せます。

## 更新

- PC：Tampermonkeyの更新機能で取得し、Xを再読み込みします。
- iPhone：SafariのUserscriptsに表示される更新を適用し、Xを再読み込みします。

更新確認や配布サーバーのキャッシュにより、公開直後には最新版が見えない場合があります。
同期用トークンや接続文字列をこのリポジトリに投稿しないでください。

[Tampermonkey公式説明](https://www.tampermonkey.net/documentation.php?locale=en&q=update_url)
 / [Userscripts公式説明](https://github.com/quoid/userscripts/tree/release/4.x.x#readme)
