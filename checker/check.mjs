#!/usr/bin/env node
// de-ai-slop 機械檢查 CLI。只提醒、不改文字。說明：node check.mjs --help

import { readFileSync, existsSync } from 'node:fs';
import { check, loadPrivateTerms, privateTermPaths, TYPES } from './lib.mjs';

const HELP = `用法：node check.mjs <檔案|-> [選項]

檢查中文文字裡「能機械判定」的 de-ai-slop 規則（對比句、套路開場、串場詞、粗體數量、
網址分段、私有名詞等），只列出命中、不改文字。其餘規則仍要人逐條對照 SKILL.md。

引數：
  <檔案>                  要檢查的檔案（Markdown、純文字或 HTML，自動判斷）
  -                       從標準輸入讀

選項：
  --type <類型>           article（長文，預設）、post（FB 等社群貼文）、threads（Threads 主文）、
                          notice（寫給非技術讀者的說明：回饋單、給客戶的信）
  --format <格式>         auto（預設）、html、md
  --json                  輸出 JSON
  --private-terms <路徑>  私有名詞清單（老師、站名、客戶），可重複。一行一個詞，# 是註解，
                          re: 開頭當正規表示式；也可直接指定 .sh 掃描腳本，會讀它的 grep -e 樣式。
                          另會讀環境變數 DEAI_SLOP_PRIVATE_TERMS（冒號分隔多個路徑）與
                          ~/.config/de-ai-slop/private-terms.txt（存在的話）。清單不要放進 repo。
  --style-card            另外檢查作者個人文風卡的詞（預設不檢查）
  --errors-only           只列「錯誤」，不列「提醒」
  -h, --help              顯示這段說明

退出碼：0 沒有命中、1 有命中、2 用法錯誤（含檔案讀不到）。
HTML 輸入的行號是轉成文字後的行號（段落之間空一行、<br> 換一行）。`;

function usageError(message) {
  process.stderr.write(`錯誤：${message}\n執行 node check.mjs --help 看用法。\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { type: 'article', format: 'auto', json: false, privateTerms: [], styleCard: false, errorsOnly: false, input: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) usageError(`${arg} 後面要接值`);
      return next;
    };
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--style-card') options.styleCard = true;
    else if (arg === '--errors-only') options.errorsOnly = true;
    else if (arg === '--type') options.type = value();
    else if (arg.startsWith('--type=')) options.type = arg.slice(7);
    else if (arg === '--format') options.format = value();
    else if (arg.startsWith('--format=')) options.format = arg.slice(9);
    else if (arg === '--private-terms') options.privateTerms.push(value());
    else if (arg.startsWith('--private-terms=')) options.privateTerms.push(arg.slice(16));
    else if (arg === '-' || !arg.startsWith('-')) {
      if (options.input !== null) usageError('一次只能檢查一個檔案');
      options.input = arg;
    } else usageError(`不認得的選項 ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(HELP + '\n');
  process.exit(0);
}
if (options.input === null) usageError('要給一個檔案，或用 - 從標準輸入讀');
if (!TYPES.includes(options.type)) usageError(`--type 只能是 ${TYPES.join('、')}`);
if (!['auto', 'html', 'md'].includes(options.format)) usageError('--format 只能是 auto、html、md');
for (const path of options.privateTerms) {
  if (!existsSync(path)) usageError(`私有名詞清單不存在：${path}`);
}

let text;
try {
  text = options.input === '-' ? readFileSync(0, 'utf8') : readFileSync(options.input, 'utf8');
} catch (error) {
  usageError(`讀不到 ${options.input}（${error.code ?? error.message}）`);
}

const termPaths = privateTermPaths(options.privateTerms);
const privateTerms = loadPrivateTerms(termPaths);
const result = check(text, { type: options.type, format: options.format, privateTerms, styleCard: options.styleCard });
const hits = options.errorsOnly ? result.hits.filter((hit) => hit.level === 'error') : result.hits;

const byRule = {};
for (const hit of hits) byRule[hit.rule] = (byRule[hit.rule] ?? 0) + 1;
const errors = hits.filter((hit) => hit.level === 'error').length;

if (options.json) {
  process.stdout.write(JSON.stringify({
    file: options.input,
    type: result.type,
    format: result.format,
    privateTermSources: termPaths.length,
    privateTermPatterns: privateTerms.length,
    styleCard: options.styleCard,
    summary: { total: hits.length, errors, warnings: hits.length - errors, byRule },
    hits,
  }, null, 2) + '\n');
} else {
  const lines = [`檔案：${options.input}（類型 ${result.type}，格式 ${result.format}）`];
  for (const hit of hits) {
    lines.push(`${hit.rule} [${hit.level === 'error' ? '錯誤' : '提醒'}] 第 ${hit.line} 行${hit.match ? `「${hit.match}」` : ''}：${hit.excerpt}`);
    lines.push(`  建議：${hit.suggestion}`);
  }
  if (hits.length) {
    const ruleList = Object.entries(byRule).map(([rule, count]) => `${rule}×${count}`).join('、');
    lines.push(`共 ${hits.length} 個命中（錯誤 ${errors}、提醒 ${hits.length - errors}）：${ruleList}`);
  } else {
    lines.push('沒有命中。只代表能機械判定的規則沒問題，其餘規則仍要逐條對照 SKILL.md。');
  }
  if (!privateTerms.length) lines.push('（沒有設定私有名詞清單，未檢查老師、站名、客戶名稱；見 --help 的 --private-terms）');
  process.stdout.write(lines.join('\n') + '\n');
}
process.exit(hits.length ? 1 : 0);
