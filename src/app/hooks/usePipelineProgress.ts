// パイプライン進捗の取得。起動時に GET_PROGRESS を投げ、以後は SW からの PROGRESS 通知で更新する。

import { useEffect, useState } from "react";
import type { Message } from "../../shared/messages";
import { send } from "../../shared/messages";
import { IDLE_PROGRESS } from "../../shared/settings";
import type { PipelineProgress } from "../../shared/types";

export function usePipelineProgress(): PipelineProgress {
  const [progress, setProgress] = useState<PipelineProgress>(IDLE_PROGRESS);

  useEffect(() => {
    let cancelled = false;

    send({ type: "GET_PROGRESS" })
      .then((p) => {
        if (!cancelled) setProgress(p);
      })
      .catch(() => {
        // SW がまだ起動していない等で失敗しても致命的ではない。
        // 以後の PROGRESS 通知、または次回の再マウントで更新される。
      });

    // §13-4: SW からの broadcast は受信者がいなくても例外にならないよう、
    // ページ側は単純な onMessage リスナーで受信するだけでよい（同期で false を返す）。
    const handler = (msg: Message) => {
      if (msg.type === "PROGRESS") {
        setProgress(msg.progress);
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(handler);

    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(handler);
    };
  }, []);

  return progress;
}
