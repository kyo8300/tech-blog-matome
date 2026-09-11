// Playwright を使い、`dist/` をビルド済み拡張として起動してアプリページ・設定ページがエラーなく
// 描画されることを確認する煙テスト。`npm run build` を先に実行してから `npm run smoke` で動かす。
//
// 依存は playwright のみ。実行手順:
//   1. dist/ の存在を確認
//   2. chromium.launchPersistentContext(userDataDir, { headless, args: [...], executablePath }) で起動
//   3. Service Worker（拡張の背景スクリプト）の登録を待って拡張IDを取得
//   4. src/app/index.html と src/options/index.html を開き、h1 の描画とエラー無しを確認
//   5. 成功なら「OK」を出力して exit 0、失敗なら理由を出力して exit 1

import { chromium } from "playwright";
import { existsSync, rmSync, globSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const distDir = join(projectRoot, "dist");

function fail(message) {
  console.error(`NG: ${message}`);
  process.exitCode = 1;
}

/** CHROMIUM_PATH → /opt/pw-browsers 配下の glob → Playwright 既定、の順で実行ファイルを決める */
function resolveExecutablePath() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  const candidates = globSync("/opt/pw-browsers/chromium*/chrome-linux*/chrome");
  if (candidates.length > 0) {
    return candidates[0];
  }
  return undefined; // Playwright 既定の実行ファイルに任せる
}

async function main() {
  if (!existsSync(distDir)) {
    fail("dist/ が見つかりません。先に `npm run build` を実行してください。");
    return;
  }

  const executablePath = resolveExecutablePath();
  console.log(`Chromium 実行ファイル: ${executablePath ?? "(Playwright 既定)"}`);

  const userDataDir = await mkdtemp(join(tmpdir(), "tbm-smoke-"));

  const launchArgs = {
    headless: true,
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      "--no-sandbox",
    ],
    ...(executablePath ? { executablePath } : {}),
  };

  let context;
  try {
    try {
      context = await chromium.launchPersistentContext(userDataDir, launchArgs);
    } catch (e) {
      // headless:true が失敗する環境向けに headless:false へフォールバック
      console.log(`headless:true での起動に失敗、headless:false で再試行します（${e.message}）`);
      context = await chromium.launchPersistentContext(userDataDir, {
        ...launchArgs,
        headless: false,
      });
    }

    // Service Worker（拡張の背景スクリプト）の登録を待つ
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
    }
    const extensionId = new URL(sw.url()).host;
    console.log(`拡張ID: ${extensionId}`);

    await checkPage(context, extensionId, "src/app/index.html", "アプリページ");
    await checkPage(context, extensionId, "src/options/index.html", "設定ページ");

    console.log("OK");
  } catch (e) {
    fail(e instanceof Error ? e.stack ?? e.message : String(e));
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function checkPage(context, extensionId, path, label) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  const url = `chrome-extension://${extensionId}/${path}`;
  await page.goto(url);
  const h1 = await page.waitForSelector("h1", { timeout: 15000 });
  const text = await h1.textContent();
  console.log(`${label} (${path}) の h1: "${text?.trim()}"`);

  if (errors.length > 0) {
    throw new Error(`${label} (${path}) で致命的なエラーを検出しました:\n${errors.join("\n")}`);
  }

  await page.close();
}

main();
