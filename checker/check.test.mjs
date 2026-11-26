// 執行：node --test checker/check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, loadPrivateTerms, htmlToText, detectFormat } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rulesOf = (text, options) => check(text, options).hits.map((hit) => hit.rule);
const hasRule = (text, rule, options) => rulesOf(text, options).includes(rule);

test('R12 對比句：命中「而是」「不是 X，是 Y」「不只…更」', () => {
  assert.ok(hasRule('最累的不是改程式，而是找問題。', 'R12'));
  assert.ok(hasRule('接案最累的不是改 bug，是找 bug。', 'R12'));
  assert.ok(hasRule('它不只省錢，更省時間。', 'R12'));
});

test('R12 反例：一般的「不是」不算', () => {
  assert.ok(!hasRule('這個檔案不是 PDF，請先轉檔。', 'R12'));
  assert.ok(!hasRule('不是每一題都有詳解。', 'R12'));
  assert.ok(!hasRule('不只數學，物理也能做。', 'R12'));
});

test('R15、R16、R17、R57：套路開場與串場詞', () => {
  assert.ok(hasRule('先說結論，這個做法可行。', 'R15'));
  assert.ok(hasRule('老實說？我也沒想到。', 'R15'));
  assert.ok(hasRule('首先打開設定頁。', 'R16'));
  assert.ok(hasRule('順帶一提，這裡也能改。', 'R17'));
  assert.ok(hasRule('這篇先把整條路列出來，之後再分篇細教。', 'R57'));
  assert.ok(hasRule('本篇預設你已經裝好 VS Code。', 'R66'));
});

test('套路詞反例：正常開頭不命中', () => {
  const text = '打開終端機，貼上這行指令。\n裝好之後輸入 claude 就能用。';
  assert.deepEqual(rulesOf(text), []);
});

test('R14 情境共鳴句', () => {
  assert.ok(hasRule('你以為 AI 聽懂了，做完才發現完全不是你要的。', 'R14'));
  assert.ok(!hasRule('動工前輸入 /grill-me，AI 會一輪一輪問清楚需求。', 'R14'));
});

test('R36 粗體上限：貼文 0 組、長文 8 組', () => {
  assert.ok(hasRule('這步要 **先備份**。', 'R36', { type: 'post' }));
  const nine = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 步 **動作${i}**`).join('\n');
  const eight = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 步 **動作${i}**`).join('\n');
  assert.equal(rulesOf(nine, { type: 'article' }).filter((r) => r === 'R36').length, 1);
  assert.ok(!hasRule(eight, 'R36', { type: 'article' }));
});

test('R36 HTML：<strong> 計數、內文漏出 ** 符號', () => {
  assert.ok(hasRule('<p>這步要<strong>先備份</strong>。</p>', 'R36', { type: 'post' }));
  assert.ok(hasRule('<p>這步要**先備份**。</p>', 'R36', { type: 'article' }));
  assert.ok(!hasRule('<p>這步要<strong>先備份</strong>。</p>', 'R36', { type: 'article' }));
});

test('R36 整句粗體提醒', () => {
  const hits = check('- **這一段整句都被加粗了，讀者不知道重點在哪。** 後面說明。').hits;
  assert.ok(hits.some((hit) => hit.rule === 'R36' && hit.level === 'warn'));
});

test('R38 破折號：貼文每個都提醒；長文 3 個以上才提醒；表格的單一「—」不算', () => {
  assert.ok(hasRule('這步很重要——別跳過。', 'R38', { type: 'post' }));
  assert.ok(!hasRule('這步很重要——別跳過。', 'R38', { type: 'article' }));
  assert.ok(hasRule('甲——乙\n丙——丁\n戊——己', 'R38', { type: 'article' }));
  assert.ok(!hasRule('| 模型 | 費用 |\n| A | — |\n| B | — |\n| C | — |', 'R38', { type: 'post' }));
});

test('FB-URL：網址要自成一段、前面空一行', () => {
  assert.ok(hasRule('教學在這裡：\nhttps://example.com/a', 'FB-URL', { type: 'post' }));
  assert.ok(hasRule('教學在這裡：https://example.com/a', 'FB-URL', { type: 'post' }));
  assert.ok(hasRule('<p>教學在這裡：<br><a href="https://example.com/a">https://example.com/a</a></p>', 'FB-URL', { type: 'post' }));
  assert.ok(!hasRule('教學在這裡：\n\nhttps://example.com/a', 'FB-URL', { type: 'post' }));
  assert.ok(!hasRule('<p>教學在這裡：</p><p><a href="https://example.com/a">https://example.com/a</a></p>', 'FB-URL', { type: 'post' }));
  assert.ok(!hasRule('教學在這裡：https://example.com/a', 'FB-URL', { type: 'article' }));
});

test('FB-MD：HTML 貼文裡手打 Markdown', () => {
  assert.ok(hasRule('<p>看 [教學](https://example.com)</p>', 'FB-MD', { type: 'post' }));
  assert.ok(hasRule('<p>- 第一項</p>', 'FB-MD', { type: 'post' }));
  assert.ok(!hasRule('<ul><li>第一項</li></ul>', 'FB-MD', { type: 'post' }));
});

test('THREADS：超過 500 字元、主文放網址', () => {
  assert.ok(hasRule('字'.repeat(501), 'THREADS', { type: 'threads' }));
  assert.ok(hasRule('看文章 https://example.com', 'THREADS', { type: 'threads' }));
  assert.ok(!hasRule('字'.repeat(500), 'THREADS', { type: 'threads' }));
});

test('R24 寫給非技術讀者的說明：檔名、底線變數名、$', () => {
  assert.ok(hasRule('已修改 config.php 的 max_size 設定。', 'R24', { type: 'notice' }));
  assert.ok(hasRule('公式 $x^2$ 顯示正常了。', 'R24', { type: 'notice' }));
  assert.ok(!hasRule('上傳的檔案太大時，現在會先提醒再壓縮。', 'R24', { type: 'notice' }));
  assert.ok(!hasRule('已修改 config.php。', 'R24', { type: 'article' }));
});

test('R45：cc 簡稱；文中已交代「Claude Code（CC）」就不提醒', () => {
  assert.ok(hasRule('我用 cc 寫程式。', 'R45'));
  assert.ok(!hasRule('我用 Claude Code（CC）寫程式，CC 會先問需求。', 'R45'));
  assert.ok(hasRule('發到脆上。', 'R45'));
  assert.ok(!hasRule('炸得很酥脆。', 'R45'));
});

test('R53 版本號；IP 位址不算版本號', () => {
  assert.ok(hasRule('目前版本 2.4.1。', 'R53'));
  assert.ok(!hasRule('主機在 10.0.0.12。', 'R53'));
  assert.ok(!hasRule('用 Opus 5.5 寫。', 'R53'));
});

test('程式碼、網址、連結目標不檢查詞語', () => {
  const md = '```bash\necho 而是\n```\n行內 `首先` 不算，[連結](https://example.com/而是)，https://example.com/首先';
  assert.deepEqual(rulesOf(md).filter((r) => r !== 'BW-FENCE'), []);
  assert.deepEqual(rulesOf('<pre><code class="language-bash">echo 而是</code></pre><p>正常句子。</p>'), []);
});

test('BW-FENCE：程式區塊不寫語言或寫 text', () => {
  assert.ok(hasRule('```\nls\n```', 'BW-FENCE'));
  assert.ok(hasRule('```text\nls\n```', 'BW-FENCE'));
  assert.ok(!hasRule('```bash\nls\n```', 'BW-FENCE'));
  assert.ok(!hasRule('<pre data-code-kind="output"><code>ok</code></pre>', 'BW-FENCE'));
  assert.ok(hasRule('<pre><code>ls</code></pre>', 'BW-FENCE'));
});

test('BW-IMGLINK：圖片外面包連結又寫圖說', () => {
  assert.ok(hasRule('[![圖](https://example.com/a.png "圖說")](https://example.com)', 'BW-IMGLINK'));
  assert.ok(!hasRule('![圖](https://example.com/a.png "圖說")', 'BW-IMGLINK'));
});

test('R55：同一句 15 字以上出現兩次', () => {
  const sentence = '這一輪的標準答案是老師從結果改出來的分數偏高。';
  assert.ok(hasRule(`${sentence}\n中間一段。\n${sentence}`, 'R55'));
  assert.ok(!hasRule('短句重複。\n短句重複。', 'R55'));
});

test('私有名詞：從外部清單讀，一般詞與 re: 樣式都支援；.sh 讀 grep -e 樣式', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deaislop-'));
  const list = join(dir, 'terms.txt');
  writeFileSync(list, '# 註解\n王小明老師\nre:測試站[0-9]+\n');
  const script = join(dir, 'scan.sh');
  writeFileSync(script, "#!/usr/bin/env bash\ngrep -rnIE \\\n -e '甲補習班|乙補習班' \\\n \"$1\"\n");
  const terms = loadPrivateTerms([list, script, join(dir, 'missing.txt')]);
  assert.equal(terms.length, 3);
  assert.ok(hasRule('感謝王小明老師。', 'R9', { privateTerms: terms }));
  assert.ok(hasRule('部署到測試站2。', 'R9', { privateTerms: terms }));
  assert.ok(hasRule('乙補習班在用。', 'R9', { privateTerms: terms }));
  assert.ok(!hasRule('感謝老師。', 'R9', { privateTerms: terms }));
  assert.ok(!hasRule('感謝王小明老師。', 'R9'));
});

test('文風卡的詞要加 styleCard 才檢查', () => {
  assert.ok(!hasRule('把考卷丟進來就好。', 'SC'));
  assert.ok(hasRule('把考卷丟進來就好。', 'SC', { styleCard: true }));
});

test('HTML 轉文字：段落空一行、<br> 換一行、表格一列一行', () => {
  assert.equal(detectFormat('<p>a</p>'), 'html');
  assert.equal(detectFormat('# 標題\n內文'), 'md');
  const { text } = htmlToText('<p>甲<br>乙</p><p>丙</p><table><tr><td>1</td><td>2</td></tr></table>');
  assert.equal(text, '甲\n乙\n\n丙\n\n1 | 2 |');
});

test('行號與原文片段', () => {
  const [hit] = check('第一行。\n第二行而是這樣。').hits;
  assert.equal(hit.rule, 'R12');
  assert.equal(hit.line, 2);
  assert.equal(hit.match, '而是');
  assert.ok(hit.excerpt.includes('第二行而是這樣'));
});

// ---------- CLI ----------
const cli = (args, input) => spawnSync(process.execPath, [join(here, 'check.mjs'), ...args], { input, encoding: 'utf8', env: { ...process.env, DEAI_SLOP_PRIVATE_TERMS: '' } });

test('CLI：退出碼 0／1／2、--json、--help、stdin', () => {
  assert.equal(cli(['-'], '打開設定頁，按儲存。\n').status, 0);
  const hit = cli(['-'], '最累的不是改程式，而是找問題。\n');
  assert.equal(hit.status, 1);
  assert.match(hit.stdout, /R12 \[錯誤\] 第 1 行/);
  const json = cli(['-', '--json'], '首先打開設定頁。\n');
  assert.equal(json.status, 1);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.hits[0].rule, 'R16');
  assert.equal(parsed.summary.total, 1);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['--type', 'poem', '-'], 'x').status, 2);
  assert.equal(cli(['--bogus', '-'], 'x').status, 2);
  assert.equal(cli(['/no/such/file.md']).status, 2);
  assert.equal(cli(['-', '--private-terms', '/no/such/terms.txt'], 'x').status, 2);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法：node check.mjs/);
});

test('CLI：--errors-only 只列錯誤', () => {
  const result = cli(['-', '--errors-only', '--json'], '其實這樣就好。\n');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).summary.total, 0);
});
