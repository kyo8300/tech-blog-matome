// 設定の取得。chrome.storage.local の変更に追従する。

import { useEffect, useState } from "react";
import type { Settings } from "../../shared/types";
import { loadSettings } from "../../shared/settings";
import { SETTINGS_KEY } from "../../shared/constants";

/** 設定を返す。読み込み中は undefined */
export function useSettings(): Settings | undefined {
  const [settings, setSettings] = useState<Settings | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    loadSettings().then((s) => {
      if (!cancelled) setSettings(s);
    });

    const handleChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: chrome.storage.AreaName,
    ) => {
      if (areaName !== "local" || !(SETTINGS_KEY in changes)) return;
      loadSettings().then((s) => {
        if (!cancelled) setSettings(s);
      });
    };
    chrome.storage.onChanged.addListener(handleChange);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(handleChange);
    };
  }, []);

  return settings;
}
