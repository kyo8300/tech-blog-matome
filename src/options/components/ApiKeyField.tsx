// APIキー入力欄。伏字表示 + 表示切替 + 「接続テスト」ボタン。
import { useEffect, useRef, useState } from "react";
import { describeApiError, testApiKey } from "../../lib/claudeClient";

type TestState = { status: "idle" } | { status: "ok"; modelName?: string } | { status: "error"; message: string };

export function ApiKeyField(props: {
  apiKey: string;
  model: string;
  /** モデルID未確定（ModelSelect のカスタム入力が空）の間は false。接続テストを抑止する */
  modelValid: boolean;
  onChange: (apiKey: string) => void;
}) {
  const { apiKey, model, modelValid, onChange } = props;
  const [visible, setVisible] = useState(false);
  const [testState, setTestState] = useState<TestState>({ status: "idle" });
  // 接続テストの実行中フラグ。testState とは別に持つ（testState はテスト中に model/apiKey が
  // 変わったときに idle へリセットされるが、進行中のリクエストはそれでは止まらないため）。
  const [testing, setTesting] = useState(false);
  // 直近の apiKey・model を常に追跡する ref。テスト完了時に「開始時の値」と比較し、
  // 実行中に値が変わっていたら（古いモデルの結果を今のモデルの結果として出さないよう）結果を破棄する。
  const apiKeyRef = useRef(apiKey);
  const modelRef = useRef(model);
  apiKeyRef.current = apiKey;
  modelRef.current = model;

  // モデルIDが変わった（プリセット切替・カスタム入力の確定/未確定含む）ら
  // 別モデルの結果を表示し続けないよう、結果表示をリセットする（実行中フラグには触れない）。
  useEffect(() => {
    setTestState({ status: "idle" });
  }, [model, modelValid]);

  async function handleTest() {
    if (testing) {
      // ボタンは disabled のはずだが、念のため二重起動を防ぐ
      return;
    }
    if (!apiKey) {
      setTestState({ status: "error", message: "APIキーを入力してください" });
      return;
    }
    if (!modelValid || !model.trim()) {
      setTestState({ status: "error", message: "モデルIDを入力してください（モデル欄を確認してください）" });
      return;
    }

    const startedApiKey = apiKey;
    const startedModel = model;
    setTesting(true);
    setTestState({ status: "idle" });
    try {
      const result = await testApiKey(startedApiKey, startedModel);
      // 実行中に APIキー・モデルが変わっていたら、この結果は現在の入力に対応しないため破棄する
      if (apiKeyRef.current !== startedApiKey || modelRef.current !== startedModel) {
        return;
      }
      if (result.ok) {
        setTestState({ status: "ok", modelName: result.modelName });
      } else {
        setTestState({ status: "error", message: result.message });
      }
    } catch (err) {
      if (apiKeyRef.current !== startedApiKey || modelRef.current !== startedModel) {
        return;
      }
      setTestState({ status: "error", message: describeApiError(err) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor="apiKey">APIキー</label>
      <div className="row">
        <input
          id="apiKey"
          type={visible ? "text" : "password"}
          value={apiKey}
          onChange={(e) => {
            onChange(e.target.value);
            setTestState({ status: "idle" });
          }}
          placeholder="sk-ant-..."
          autoComplete="off"
        />
        <button type="button" className="secondary" onClick={() => setVisible((v) => !v)}>
          {visible ? "隠す" : "表示"}
        </button>
        <button type="button" onClick={handleTest} disabled={testing || !modelValid || !model.trim()}>
          {testing ? "テスト中…" : "接続テスト"}
        </button>
      </div>
      {!modelValid && (
        <p className="result error">モデルが未確定のため接続テストできません（モデル欄でモデルIDを入力してください）</p>
      )}
      {modelValid && testState.status === "ok" && (
        <p className="result ok">接続OK（{testState.modelName ?? model}）</p>
      )}
      {modelValid && testState.status === "error" && <p className="result error">{testState.message}</p>}
      <p className="hint">Anthropic Console で発行したAPIキーを入力してください。この拡張以外には送信されません。</p>
    </div>
  );
}
