// 危険な操作。全データ削除→初期状態に戻す。
import { useState } from "react";
import { send } from "../../shared/messages";

export function DangerZone() {
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function handleReset() {
    const confirmed = window.confirm(
      "記事・要約・チャット履歴を削除し、各ブログを未取得状態に戻します。APIキーなどの設定は保持されます。この操作は取り消せません。よろしいですか？",
    );
    if (!confirmed) {
      return;
    }
    setRunning(true);
    setMessage(null);
    try {
      const result = await send({ type: "RESET_ALL" });
      setMessage(result.ok ? "初期状態に戻しました。" : "削除に失敗しました。");
    } catch (err) {
      setMessage(`削除に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="danger-zone">
      <h2>危険な操作</h2>
      <p>記事・要約・チャット履歴を削除し、各ブログを未取得状態に戻します。APIキーなどの設定は保持されます。</p>
      <button type="button" className="danger" onClick={handleReset} disabled={running}>
        {running ? "削除中…" : "全データを削除して初期状態に戻す"}
      </button>
      {message && <p className="result">{message}</p>}
    </section>
  );
}
