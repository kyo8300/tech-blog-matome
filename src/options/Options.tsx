// 設定ページ本体。
import { useEffect, useState } from "react";
import type { Settings } from "../shared/types";
import { isLockActive, loadSettings, saveSettings } from "../shared/settings";
import { broadcast, send } from "../shared/messages";
import type { Message } from "../shared/messages";
import { DEFAULT_SOURCES } from "../shared/sources";
import { ApiKeyField } from "./components/ApiKeyField";
import { ModelSelect } from "./components/ModelSelect";
import { IntervalSelect } from "./components/IntervalSelect";
import { SourceRow } from "./components/SourceRow";
import { DangerZone } from "./components/DangerZone";

/** ロック判定に使う最小限の進捗情報 */
type LockInfo = { running: boolean; startedAt?: number };

const IDLE_LOCK_INFO: LockInfo = { running: false };

export function Options() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // ModelSelect のカスタム入力が空でモデルIDが未確定の間は保存できない
  const [modelValid, setModelValid] = useState(true);
  // 更新パイプラインの進捗（running / startedAt）。SW 死亡で running:true が古いまま残る
  // ケースがあるため、これ単体ではなく isLockActive(lockInfo, now) で「削除ボタンの無効化」を判定する。
  const [lockInfo, setLockInfo] = useState<LockInfo>(IDLE_LOCK_INFO);
  // isLockActive の判定は現在時刻に依存するため、setInterval のたびにこれを更新して再評価を促す
  // （lockInfo 自体は SW からの通知が無い限り変化しなくても、LOCK_STALE_MS 経過で自動的に
  //  「実行中でない」表示へ戻すため）。
  const [, forceRecheck] = useState(0);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  useEffect(() => {
    let cancelled = false;
    send({ type: "GET_PROGRESS" })
      .then((p) => {
        if (!cancelled) setLockInfo({ running: p.running, startedAt: p.startedAt });
      })
      .catch(() => {
        // SW がまだ起動していない等で失敗しても致命的ではない（以後の PROGRESS 通知で更新される）
      });

    // §13-4: SW からの broadcast は受信者がいなくても例外にならないよう、単純な onMessage で受信する
    const handler = (msg: Message) => {
      if (msg.type === "PROGRESS") {
        setLockInfo({ running: msg.progress.running, startedAt: msg.progress.startedAt });
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(handler);

    // LOCK_STALE_MS 経過による失効を、新しい PROGRESS 通知が来なくても反映できるよう
    // 1分ごとに再評価（再レンダー）する
    const interval = setInterval(() => forceRecheck((n) => n + 1), 60_000);

    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(handler);
      clearInterval(interval);
    };
  }, []);

  // 表示時点の現在時刻で判定する（レンダーのたびに再計算される。isLockActive は純粋関数）
  const resetLocked = isLockActive(lockInfo);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSavedMessage(null);
  }

  function toggleSource(id: string, enabled: boolean) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = enabled
        ? [...new Set([...prev.enabledSources, id])]
        : prev.enabledSources.filter((s) => s !== id);
      return { ...prev, enabledSources: next };
    });
    setSavedMessage(null);
  }

  function setSourceUrl(id: string, url: string | undefined) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev.feedUrlOverrides };
      if (url) {
        next[id] = url;
      } else {
        delete next[id];
      }
      return { ...prev, feedUrlOverrides: next };
    });
    setSavedMessage(null);
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    setSavedMessage(null);

    // ユーザーが編集する項目だけを patch にする。lastRunAt など SW が書くフィールドは送らない
    // （マウント時に読んだ Settings をそのまま渡すと、パイプライン実行後の保存で巻き戻ってしまう）。
    const patch: Partial<Settings> = {
      apiKey: settings.apiKey,
      model: settings.model,
      effort: settings.effort,
      intervalMinutes: settings.intervalMinutes,
      notificationsEnabled: settings.notificationsEnabled,
      enabledSources: settings.enabledSources,
      feedUrlOverrides: settings.feedUrlOverrides,
      summaryConcurrency: Math.min(4, Math.max(1, settings.summaryConcurrency || 1)),
      // 空欄・0での保存を防ぐため下限にクランプする（min属性と一致）
      maxContentChars: Math.max(1000, settings.maxContentChars || 1000),
      maxNewPerSourcePerRun: Math.max(1, settings.maxNewPerSourcePerRun || 1),
      maxSummariesPerRun: Math.max(1, settings.maxSummariesPerRun || 1),
    };

    try {
      await saveSettings(patch);
    } catch (err) {
      setSavedMessage({ ok: false, text: `保存に失敗しました: ${err instanceof Error ? err.message : String(err)}` });
      setSaving(false);
      return;
    }

    setSavedMessage({ ok: true, text: "保存しました" });
    setSaving(false);
    // SETTINGS_CHANGED の送信が失敗しても保存自体は成功しているので、結果表示には影響させない
    void broadcast({ type: "SETTINGS_CHANGED" });
  }

  return (
    <main className="options-page">
      <h1>設定</h1>
      {!settings ? (
        <p>読み込み中…</p>
      ) : (
        <>
          <section>
            <h2>APIキー</h2>
            <ApiKeyField
              apiKey={settings.apiKey}
              model={settings.model}
              modelValid={modelValid}
              onChange={(v) => update("apiKey", v)}
            />
          </section>

          <section>
            <h2>モデル</h2>
            <ModelSelect
              value={settings.model}
              onChange={(v) => update("model", v)}
              onValidityChange={setModelValid}
            />
          </section>

          <section>
            <h2>要約の思考量</h2>
            <div className="field">
              <label htmlFor="effort">思考量</label>
              <select
                id="effort"
                value={settings.effort}
                onChange={(e) => update("effort", e.target.value as Settings["effort"])}
              >
                <option value="low">低</option>
                <option value="medium">中（既定）</option>
                <option value="high">高</option>
              </select>
            </div>
          </section>

          <section>
            <h2>自動更新</h2>
            <IntervalSelect value={settings.intervalMinutes} onChange={(v) => update("intervalMinutes", v)} />
            <div className="field">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.notificationsEnabled}
                  onChange={(e) => update("notificationsEnabled", e.target.checked)}
                />
                <span>新着通知を有効にする</span>
              </label>
            </div>
          </section>

          <section>
            <h2>ソース一覧</h2>
            <div className="source-list">
              {DEFAULT_SOURCES.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  enabled={settings.enabledSources.includes(source.id)}
                  feedUrlOverride={settings.feedUrlOverrides[source.id]}
                  resetLocked={resetLocked}
                  onToggle={(enabled) => toggleSource(source.id, enabled)}
                  onUrlChange={(url) => setSourceUrl(source.id, url)}
                />
              ))}
            </div>
          </section>

          <section>
            <h2>詳細</h2>
            <div className="field">
              <label htmlFor="concurrency">同時要約数</label>
              <input
                id="concurrency"
                type="number"
                min={1}
                max={4}
                value={settings.summaryConcurrency}
                onChange={(e) =>
                  update("summaryConcurrency", Math.min(4, Math.max(1, Number(e.target.value) || 1)))
                }
              />
            </div>
            <div className="field">
              <label htmlFor="maxChars">本文の最大文字数</label>
              <input
                id="maxChars"
                type="number"
                min={1000}
                step={1000}
                value={settings.maxContentChars}
                onChange={(e) => update("maxContentChars", Math.max(0, Number(e.target.value) || 0))}
                onBlur={() =>
                  setSettings((prev) =>
                    prev ? { ...prev, maxContentChars: Math.max(1000, prev.maxContentChars || 1000) } : prev,
                  )
                }
              />
            </div>
            <div className="field">
              <label htmlFor="maxNew">1回の更新あたりの最大新着数（ソースごと）</label>
              <input
                id="maxNew"
                type="number"
                min={1}
                value={settings.maxNewPerSourcePerRun}
                onChange={(e) => update("maxNewPerSourcePerRun", Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="field">
              <label htmlFor="maxSummaries">1回の更新あたりの最大要約数（全体）</label>
              <input
                id="maxSummaries"
                type="number"
                min={1}
                value={settings.maxSummariesPerRun}
                onChange={(e) => update("maxSummariesPerRun", Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
          </section>

          <div className="save-bar">
            <button type="button" onClick={handleSave} disabled={saving || !modelValid}>
              {saving ? "保存中…" : "保存"}
            </button>
            {!modelValid && <span className="result error">モデルIDを入力してください</span>}
            {savedMessage && (
              <span className={`result ${savedMessage.ok ? "ok" : "error"}`}>{savedMessage.text}</span>
            )}
          </div>

          <DangerZone />
        </>
      )}
    </main>
  );
}
