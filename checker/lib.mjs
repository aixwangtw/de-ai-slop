// de-ai-slop 機械檢查：只檢查「用字串或簡單句型就能判定」的規則，只提醒、不改文字。
// 規則依據見同資料夾 README.md 的兩張表。

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TYPES = ['article', 'post', 'threads', 'notice'];

const BOLD_OPEN = '⁣'; // HTML 的 <strong> 轉文字後用看不見的分隔字元標起來，只給粗體規則用
const BOLD_CLOSE = '⁤';
const URL_RE = /https?:\/\/[^\s<>"'）)\]」]+/g;

// ---------- 前處理 ----------

/** 判斷輸入是不是 HTML（CMS 存的文章內文與社群貼文都是 HTML）。 */
export function detectFormat(text) {
  return /<(p|h[1-6]|ul|ol|li|br|div|strong|table|pre|blockquote)\b[^>]*>/i.test(text) ? 'html' : 'md';
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * HTML 轉成逐行文字：段落、標題之間空一行，<br> 換一行，表格一列一行。
 * 程式區塊整段換成空行（行數照留），行內程式碼改成反引號，粗體用看不見的字元標記。
 * @returns {{ text: string, meta: { fences: { line: number, lang: string }[], imageLinks: number[] } }}
 */
export function htmlToText(html) {
  const meta = { fences: [], imageLinks: [] };
  let source = html.replace(/\r\n?/g, '\n');
  // 先把換行壓掉，行數由區塊標籤決定
  source = source.replace(/\n/g, ' ');
  source = source.replace(/<!--[\s\S]*?-->/g, ' ');
  source = source.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  // 程式區塊：記下語言，內容不檢查
  source = source.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (_, preAttrs, inner) => {
    const kind = /data-code-kind="([^"]*)"/i.exec(preAttrs)?.[1] ?? '';
    const lang = /class="[^"]*language-([\w-]+)/i.exec(inner)?.[1] ?? '';
    return `\n\n⁠FENCE:${kind || lang || ''}⁠\n\n`;
  });
  // 圖片外面包連結（部落格規則：這樣圖說不會出現）
  source = source.replace(/<a\b[^>]*>\s*(<img\b[^>]*title="[^"]+"[^>]*>)\s*<\/a>/gi, (_, img) => `⁠IMGLINK⁠${img}`);
  source = source.replace(/<img\b[^>]*>/gi, ' ');
  source = source.replace(/<(strong|b)\b[^>]*>/gi, BOLD_OPEN).replace(/<\/(strong|b)>/gi, BOLD_CLOSE);
  source = source.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => '`' + inner.replace(/<[^>]+>/g, '') + '`');
  source = source.replace(/<br\s*\/?>/gi, '\n');
  source = source.replace(/<\/(td|th)>/gi, ' | ');
  source = source.replace(/<\/(tr|li|summary|figcaption|dt|dd)>/gi, '\n');
  source = source.replace(/<(li)\b[^>]*>/gi, '\n');
  source = source.replace(/<\/?(p|h[1-6]|ul|ol|div|blockquote|table|thead|tbody|details|figure|section|article|video|dl)\b[^>]*>/gi, '\n\n');
  source = source.replace(/<[^>]+>/g, '');
  source = decodeEntities(source);
  // 每行去頭尾空白，連續空行壓成一行
  const lines = source.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim());
  const out = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const finalLines = out.map((line, index) => {
    const fence = /^⁠FENCE:([\w-]*)⁠$/.exec(line);
    if (fence) {
      meta.fences.push({ line: index + 1, lang: fence[1] });
      return '';
    }
    if (line.includes('⁠IMGLINK⁠')) {
      meta.imageLinks.push(index + 1);
      return line.replace(/⁠IMGLINK⁠/g, '');
    }
    return line;
  });
  return { text: finalLines.join('\n'), meta };
}

/** 把一段字換成等長空白（遮掉不檢查的部分，行內欄位位置不變）。 */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/**
 * 產生每一行的「遮罩版」：程式碼、網址、連結目標、HTML 標籤、短碼換成空白，詞語規則只看遮罩版。
 * @returns {{ lines: string[], masked: string[], codeFree: string[], fences: { line: number, lang: string }[], imageLinks: number[] }}
 */
export function prepare(text, format) {
  let meta = { fences: [], imageLinks: [] };
  let body = text.replace(/\r\n?/g, '\n');
  if (format === 'html') {
    const converted = htmlToText(body);
    body = converted.text;
    meta = converted.meta;
  }
  const lines = body.split('\n');
  const masked = [];
  const codeFree = []; // 只遮程式區塊（給 R24、私有名詞用，網址與行內程式碼保留）
  let inFence = false;
  let fenceMarker = '';
  let inFrontmatter = format !== 'html' && lines[0]?.trim() === '---';
  lines.forEach((line, index) => {
    if (inFrontmatter) {
      if (index > 0 && line.trim() === '---') inFrontmatter = false;
      masked.push(blank(line));
      codeFree.push(blank(line));
      return;
    }
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (format !== 'html' && fence && (!inFence || fence[1][0] === fenceMarker)) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
        meta.fences.push({ line: index + 1, lang: fence[2] || '' });
      } else {
        inFence = false;
      }
      masked.push(blank(line));
      codeFree.push(blank(line));
      return;
    }
    if (inFence) {
      masked.push(blank(line));
      codeFree.push(blank(line));
      return;
    }
    if (format !== 'html' && /\[!\[[^\]]*\]\([^)\s]+\s+"[^"]+"\)\]\([^)]+\)/.test(line)) meta.imageLinks.push(index + 1);
    codeFree.push(line);
    let m = line;
    m = m.replace(/`[^`]*`/g, blank);
    m = m.replace(/\]\([^)]*\)/g, (s) => ']' + blank(s.slice(1)));
    m = m.replace(URL_RE, blank);
    m = m.replace(/<[^>]+>/g, blank);
    m = m.replace(/\[\[[^\]]*\]\]/g, blank);
    masked.push(m);
  });
  return { lines, masked, codeFree, fences: meta.fences, imageLinks: meta.imageLinks };
}

// ---------- 私有名詞清單（不放進 repo，從外部檔讀） ----------

/**
 * 讀私有名詞清單。支援兩種檔：
 * - 一般文字檔：一行一個詞，# 開頭是註解，`re:` 開頭當正規表示式。
 * - .sh 檔（例如自己的敏感字掃描腳本）：抓出 grep 的 `-e '...'` 樣式，每個當一條正規表示式。
 * @returns {{ label: string, source: string, re: RegExp }[]}
 */
export function loadPrivateTerms(paths) {
  const terms = [];
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    if (/\.sh$/.test(path) || content.startsWith('#!')) {
      for (const match of content.matchAll(/-e\s+'([^']+)'/g)) {
        const pattern = match[1].replace(/\\b/g, '\\b');
        try {
          terms.push({ label: `${path} 的樣式`, source: path, re: new RegExp(pattern, 'g') });
        } catch {
          // grep 才吃得下的樣式就跳過
        }
      }
      continue;
    }
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('re:')) {
        try {
          terms.push({ label: '自訂樣式', source: path, re: new RegExp(line.slice(3), 'g') });
        } catch {
          // 寫錯的樣式跳過
        }
      } else {
        terms.push({ label: line, source: path, re: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') });
      }
    }
  }
  return terms;
}

/** 私有名詞清單的路徑：--private-terms 指定的，加上環境變數 DEAI_SLOP_PRIVATE_TERMS（冒號分隔），再加上預設位置。 */
export function privateTermPaths(cliPaths = [], env = process.env) {
  const fromEnv = (env.DEAI_SLOP_PRIVATE_TERMS ?? '').split(':').filter(Boolean);
  const fallback = join(homedir(), '.config', 'de-ai-slop', 'private-terms.txt');
  const all = [...cliPaths, ...fromEnv];
  if (existsSync(fallback)) all.push(fallback);
  return [...new Set(all)];
}

// ---------- 規則 ----------

const ERROR = 'error';
const WARN = 'warn';

/**
 * 詞語／句型規則。patterns 是字串或正規表示式（不用加 g）。
 * types：只套用在這些類型；沒寫就全部類型。styleCard：作者個人文風卡的詞，要加 --style-card 才檢查。
 */
export const PHRASE_RULES = [
  // R12 對比句
  { id: 'R12', level: ERROR, patterns: ['而是'], suggestion: '「而是」是對比句的記號。拿掉對比框架，直接講重點；改法先給使用者確認。' },
  { id: 'R12', level: ERROR, patterns: [/不是[^。！？!?\n]{1,40}?[，,；;]\s*是/], suggestion: '「不是 X，是 Y」對比句。直接講 Y，不用先否定 X。' },
  { id: 'R12', level: WARN, patterns: [/不(?:只|僅|單)[^。！？!?\n]{1,30}?更/], suggestion: '「不只…更…」是對比句的變體，直接講重點。' },
  // R13「從 X 到 Y」試過，近期文章 13 個命中幾乎都是實際的範圍或數字變化（從 0.111 美元降到 0.094 美元），誤報太多，不做。
  // R14 情境共鳴句
  { id: 'R14', level: ERROR, patterns: [/你以為[^。！？\n]*?(?:才|結果)發現/], suggestion: '「你以為 X，才發現 Z」句型，改寫成操作或結果。引用原文本身是這個結構時可忽略。' },
  { id: 'R14', level: WARN, patterns: [/做完才發現/], suggestion: '情境共鳴句，讀者看完不會多做一件事；改寫成操作或結果。' },
  // R15 套路開場與收尾
  { id: 'R15', level: ERROR, patterns: ['先說結論', '一句話總結', '事實是', '老實說', '更有意思的是', /哈囉[，,~～！!\s]*我是/, '你是否也曾'], suggestion: '套路開場或收尾，第一句直接進正題。' },
  // R16 串段落
  { id: 'R16', level: ERROR, patterns: ['首先', '其次', '總的來說', '總而言之'], suggestion: '「首先→其次→最後→總的來說」串段落，拿掉串場詞。' },
  { id: 'R16', level: WARN, patterns: ['此外'], suggestion: '「此外」是 ai-tells 點名的銜接詞，多半可以直接拿掉。' },
  // R17 過場句
  { id: 'R17', level: ERROR, patterns: ['有趣的是', '順帶一提', '先講清楚一件', '回到我們那件事', '順手澄清'], suggestion: '過場句，交代自己要講什麼；刪掉，直接講。' },
  // R57 介紹文章本身、打包
  { id: 'R57', level: ERROR, patterns: [/這篇(?:要講|先把|先帶|一次列|是系列)/, /本(?:篇|文)將/, /帶你(?:看完|走完)/, '整條路'], suggestion: '在介紹文章本身或用比喻打包內容；第一句直接寫第一件要做的事或最具體的事實。' },
  { id: 'R57', level: WARN, patterns: ['其實'], suggestion: '「其實」常用來把事情講小或替內容打包，多半可以刪。' },
  { id: 'R57', level: WARN, patterns: ['最常被問到'], suggestion: '開頭的「最常被問到」要有紀錄才能寫，沒有就刪。' },
  // R66 系列文開頭
  { id: 'R66', level: ERROR, patterns: ['本篇預設', /預設你已(?:經)?/], suggestion: '不寫「本篇預設你已…」，直接寫前置步驟，或「還沒裝先…」。' },
  // R71 導覽式預告句（文風卡把它推廣到所有文字）
  { id: 'R71', level: WARN, patterns: ['一項一項看', '以下這些是', '接下來讓我們', '讓我們逐一', '逐一來看'], suggestion: '只預告「等一下要逐項講」的句子沒有內容，拿掉，直接講第一項。' },
  // R18 助理腔、諮商腔、假戲劇停頓
  { id: 'R18', level: ERROR, patterns: ['我能幫你', '還有什麼需要我', '你並不孤單', '你沒有壞', '我愣了一下', '我沉默了', '我安靜了'], suggestion: '助理腔、諮商腔或假戲劇停頓，刪掉。' },
  // R19 商業黑話、正確的廢話
  { id: 'R19', level: ERROR, patterns: ['護城河', '賦能', '圓滿成功', '反響熱烈', '受益匪淺', /能帶走什麼[？?]/], suggestion: '商業黑話或正確的廢話，換成具體事實或刪掉。' },
  { id: 'R19', level: WARN, patterns: ['很穩'], suggestion: '「很穩」是 R19 點名的黑話，換成具體事實（幾次測試、多久沒出錯）。' },
  // R11 推銷語、評論、寫稿提醒漏進內文（bad-examples 第 8、9、47 條）
  { id: 'R11', level: ERROR, patterns: ['最在意的賣點', '我們也真的做到了', '可以寫一句誠實的話', '可以當作具體例子', '更有說服力', '誠實標明', /[（(](?:需說明|需註明|另註明|待補|TODO)/], suggestion: '推銷語、評論，或寫稿時給自己的提醒漏進內文；只留事實。' },
  // R10 不寫「還不知道的事」
  { id: 'R10', level: ERROR, patterns: ['還不知道的事', '沒有結論的部分'], suggestion: '查不到、沒有結論的事直接不寫，不特地列一段。' },
  // R6
  { id: 'R6', level: WARN, patterns: ['目前僅支援'], suggestion: 'R6 的反例句型：沒有官方出處時不要改寫成「目前僅支援某平台」。有出處可忽略。' },
  // R20 名詞化
  { id: 'R20', level: WARN, patterns: [/進行(?!中)(?:評估|分析|討論|處理|測試|修改|調整|優化|確認|檢查|說明|比較|研究|整理|驗證|審核)/], suggestion: '名詞化：「進行評估」寫「評估」。' },
  // R22 講產品能力用「正確性」
  { id: 'R22', level: WARN, patterns: [/(?<![標精水基校對批核])(?:很|蠻|超|夠|不夠)準(?![備時確則點度])/, '準不準'], suggestion: '講產品能力用「正確性」「正確率」，不用「準」。' },
  // R44 扁平形容
  { id: 'R44', level: WARN, patterns: ['充滿挑戰'], suggestion: '扁平形容，換成素材裡真的發生的事。' },
  // R3 編出來的錨點
  { id: 'R3', level: WARN, patterns: ['某位朋友', '某個午後', '某天下午'], suggestion: '素材沒有的錨點不要湊；有真人真事就寫具體，沒有就刪。' },
  // R56 強調詞背書
  { id: 'R56', level: WARN, patterns: ['真的', '真正', '實際上'], suggestion: '強調詞替主張背書；換成具體事實，查不到就拿掉。第一人稱情緒（R44「當時真的有點崩潰」）不在此限。' },
  // R45 口語簡稱
  { id: 'R45', level: WARN, patterns: [/(?<![酥清乾爽香鬆])脆(?![弱皮餅口片])/], suggestion: '「脆」正文寫 Threads。' },
  { id: 'R45', level: WARN, skipWhenCcDefined: true, patterns: [/(?<![A-Za-z0-9_.@-])(?:cc|CC)(?![A-Za-z0-9_])/], suggestion: '「cc」指 Claude Code 時正文寫全名（指令本身是 claude）。信件副本的 cc 可忽略。' },
  // R53 版本號
  { id: 'R53', level: WARN, patterns: [/(?<![\d.])v?\d+\.\d+\.\d+(?![\d.])/], suggestion: '不寫套件版本號與版本差異備註（文章主題就是版本更新時除外）。' },
  // bad-examples 第 41、49、51、52 條（文風卡也列為不用的詞）
  { id: 'R46', level: ERROR, patterns: ['選得起來', '選不起來'], suggestion: '自創標籤當名稱（bad-examples 第 41 條）；PDF 寫「文字版 PDF」「掃描版 PDF」，第一次用讀者做得到的動作說明怎麼分。' },
  { id: 'R65', level: WARN, patterns: [/有遇過[^。？?\n]{0,20}?[嗎吗]/], suggestion: '結尾問有沒有遇過錯（bad-examples 第 49 條）；改問讀者平常怎麼用，再邀請敲碗。' },
  { id: 'R48', level: WARN, patterns: ['最在意的是', /要看兩件事/], suggestion: '替讀者宣告他在意什麼，沒有事實（bad-examples 第 51 條）；直接寫事實。' },
  { id: 'R59', level: WARN, patterns: [/各錯\s*\d+\s*題/, '最容易出錯'], suggestion: '教學內容寫成報告工具錯在哪（bad-examples 第 52 條）；改寫成怎麼做才會正確。' },

  // 作者個人文風卡（要加 --style-card 才檢查）
  { id: 'SC', level: ERROR, styleCard: true, patterns: ['最意外', '沒想到', '我的心得是', '所以我的做法是', '我自己的做法是', '我現在的習慣是', '我很想知道別人', '一看就知道', '差很多', /(?:完整|實)測了一輪/, '這陣子', '一路調整', '等於要它'], suggestion: '文風卡「不用的詞與句型」。' },
  { id: 'SC', level: WARN, styleCard: true, patterns: ['重點是', /丟(?:進來|進去|給)/, /認(?:出來|錯)/, /送(?:法|\s?PDF|給\s?AI)/], suggestion: '文風卡：替讀者宣告「重點是…」、口語動詞（丟進來→上傳、交給）、「認出來」照全站用語寫「AI 辨識」、工程師用詞「送法」。' },
];

function toGlobal(pattern) {
  if (typeof pattern === 'string') return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
}

function snippet(line, index, length) {
  const start = Math.max(0, index - 12);
  const end = Math.min(line.length, index + length + 12);
  const text = line.slice(start, end).replace(/[⁣⁤]/g, '');
  return (start > 0 ? '…' : '') + text + (end < line.length ? '…' : '');
}

/**
 * 檢查一段文字。
 * @param {string} text
 * @param {{ type?: string, format?: 'html'|'md'|'auto', privateTerms?: { label: string, re: RegExp }[], styleCard?: boolean }} options
 * @returns {{ type: string, format: string, hits: { rule: string, level: string, line: number, column: number, match: string, excerpt: string, suggestion: string }[] }}
 */
export function check(text, options = {}) {
  const type = options.type ?? 'article';
  const format = !options.format || options.format === 'auto' ? detectFormat(text) : options.format;
  const { lines, masked, codeFree, fences, imageLinks } = prepare(text, format);
  const hits = [];
  const add = (rule, level, lineIndex, column, match, suggestion, source = lines) => {
    hits.push({ rule, level, line: lineIndex + 1, column: column + 1, match: match.replace(/[⁣⁤]/g, ''), excerpt: snippet(source[lineIndex] ?? '', column, match.length), suggestion });
  };

  // 文中已用「Claude Code（CC）」交代過簡稱時，後面的 CC 不再提醒（作者本人的貼文就這樣寫）
  const ccDefined = /Claude Code\s*[（(]\s*CC\s*[）)]/.test(lines.join('\n'));

  // 詞語與句型
  for (const rule of PHRASE_RULES) {
    if (rule.skipWhenCcDefined && ccDefined) continue;
    if (rule.styleCard && !options.styleCard) continue;
    if (rule.types && !rule.types.includes(type)) continue;
    for (const pattern of rule.patterns) {
      const re = toGlobal(pattern);
      masked.forEach((line, index) => {
        for (const m of line.matchAll(re)) add(rule.id, rule.level, index, m.index, m[0], rule.suggestion);
      });
    }
  }

  // R36 粗體上限：貼文 0 組、長文 8 組；整句粗體也提醒
  const boldSpans = [];
  masked.forEach((line, index) => {
    for (const m of line.matchAll(/\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g)) boldSpans.push({ index, column: m.index, match: m[0], inner: m[1] ?? m[2], literal: true });
    for (const m of line.matchAll(new RegExp(`${BOLD_OPEN}([^${BOLD_CLOSE}]*)${BOLD_CLOSE}`, 'g'))) boldSpans.push({ index, column: m.index, match: m[0], inner: m[1], literal: false });
  });
  const isPost = type === 'post' || type === 'threads';
  const boldLimit = isPost ? 0 : 8;
  if (boldSpans.length > boldLimit) {
    const extra = isPost ? boldSpans : boldSpans.slice(boldLimit);
    for (const span of extra) add('R36', ERROR, span.index, span.column, span.match, isPost ? '貼文不用粗體（0 組）。' : `長文粗體最多 8 組，這篇有 ${boldSpans.length} 組；只留不可逆的警告、每步一個關鍵動作、條列開頭的名詞標籤。`);
  }
  for (const span of boldSpans) {
    const inner = span.inner.trim();
    if (inner.length >= 25 || /[。！？!?]$/.test(inner)) add('R36', WARN, span.index, span.column, span.match, '整句粗體，粗體只標關鍵詞。');
  }
  // 粗體符號漏出來：HTML 內容裡出現 **，或貼文裡出現 **（FB 不吃 Markdown）
  if (format === 'html') {
    masked.forEach((line, index) => {
      for (const m of line.matchAll(/\*\*/g)) add('R36', ERROR, index, m.index, m[0], '`**` 符號直接漏出來，是最明顯的破綻。');
    });
  }

  // R37 ⚠️＋粗體＋破折號連用
  masked.forEach((line, index) => {
    if (/⚠/.test(line) && /\*\*|⁣/.test(line) && /——/.test(line)) add('R37', ERROR, index, line.indexOf('⚠'), '⚠', '「⚠️＋粗體＋破折號＋後果」連用，換一種句構。');
  });

  // R38 破折號「——」：貼文每個都提醒；長文只在用到 3 個以上時提醒（門檻是本腳本自訂）。
  // 單一個「—」不算：表格常拿它當「沒有數值」。
  const dashes = [];
  masked.forEach((line, index) => {
    for (const m of line.matchAll(/——/g)) dashes.push({ index, column: m.index, match: m[0] });
  });
  if (isPost) {
    for (const d of dashes) add('R38', ERROR, d.index, d.column, d.match, '貼文避開破折號（台灣讀者看到常直接判 AI）。');
  } else if (dashes.length >= 3) {
    for (const d of dashes) add('R38', WARN, d.index, d.column, d.match, `這篇用了 ${dashes.length} 個破折號，長文不強制全刪，但不要拿它當萬用連接。`);
  }

  // R39 貼文少用 emoji
  if (isPost) {
    masked.forEach((line, index) => {
      for (const m of line.matchAll(/\p{Extended_Pictographic}/gu)) {
        if (/[©®™]/.test(m[0])) continue;
        add('R39', WARN, index, m.index, m[0], '貼文少用 emoji，格式撐不起空洞的內容。');
      }
    });
  }

  // R41 中文旁邊的半形逗號
  masked.forEach((line, index) => {
    for (const m of line.matchAll(/(?<=[一-鿿]),|,(?=[一-鿿])/g)) add('R41', WARN, index, m.index, m[0], '中文旁邊的半形逗號改全形（有本人舊文時以舊文為準）。');
  });

  // R24 給非技術讀者的說明：反斜線、$、{}、底線變數名、副檔名、反引號
  if (type === 'notice') {
    codeFree.forEach((line, index) => {
      const scan = line.replace(URL_RE, blank);
      const checks = [
        [/\\/g, '反斜線'],
        [/\$/g, '$ 符號'],
        [/[{}]/g, '大括號'],
        [/`/g, '反引號（程式碼）'],
        [/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g, '底線變數名'],
        [/\b[\w-]+\.(?:php|js|mjs|ts|vue|py|md|json|ya?ml|sh|css|html|sql|env|txt|csv)\b/g, '檔名'],
      ];
      for (const [re, label] of checks) {
        for (const m of scan.matchAll(re)) add('R24', ERROR, index, m.index, m[0], `寫給非技術讀者的說明出現${label}；只寫原因、調整、結果。`, codeFree);
      }
    });
  }

  // R55 同一句話出現兩次（只比 15 字以上、完全相同的句子）
  const seen = new Map();
  masked.forEach((line, index) => {
    for (const m of line.matchAll(/[^。！？!?\n|]+[。！？!?]?/g)) {
      const sentence = m[0].replace(/[\s⁣⁤]/g, '');
      const cjk = (sentence.match(/[一-鿿]/g) ?? []).length;
      if (cjk < 15) continue;
      const key = sentence.replace(/[。！？!?，,]/g, '');
      if (seen.has(key)) add('R55', WARN, index, m.index + (m[0].length - m[0].trimStart().length), m[0].trim(), `同一句在第 ${seen.get(key)} 行出現過；同一件事只講一次。`);
      else seen.set(key, index + 1);
    }
  });

  // FB 貼文：網址自成一段、前面空一行；不得出現 Markdown 符號
  if (type === 'post') {
    lines.forEach((line, index) => {
      const urls = [...line.matchAll(URL_RE)];
      if (!urls.length) return;
      const alone = line.trim() === urls[0][0] && urls.length === 1;
      const prevBlank = index === 0 || lines[index - 1].trim() === '';
      if (!alone) add('FB-URL', ERROR, index, urls[0].index, urls[0][0], '網址要單獨一行、前後不接其他字，FB 才會變成超連結。');
      else if (!prevBlank) add('FB-URL', ERROR, index, urls[0].index, urls[0][0], '網址要自成一段、前面空一行（介紹句下一行直接接網址，FB 不會轉成超連結）。');
    });
    lines.forEach((line, index) => {
      const checks = [
        [/^\s*#{1,6}\s/, '行首 #'],
        [/\[[^\]\n]+\]\([^)\n]+\)/, '[文字](網址)'],
        [/`/, '反引號'],
        [/__[^_\n]+__/, '__'],
      ];
      if (format === 'html') checks.push([/^\s*[-*+]\s/, '行首 - * +'], [/^\s*\d+\.\s/, '段落開頭手打 1. ']);
      for (const [re, label] of checks) {
        const m = re.exec(line);
        if (m) add('FB-MD', ERROR, index, m.index, m[0], `FB 貼文不吃 Markdown：${label}。`);
      }
    });
  }

  // Threads：主文 500 字元以內、主文不放網址
  if (type === 'threads') {
    const plain = lines.join('\n').replace(/[⁣⁤]/g, '');
    const length = [...plain].length;
    if (length > 500) add('THREADS', ERROR, lines.length - 1, 0, '', `Threads 主文 ${length} 字元，超過 500。`);
    lines.forEach((line, index) => {
      for (const m of line.matchAll(URL_RE)) add('THREADS', ERROR, index, m.index, m[0], 'Threads 主文不放網址，網址放第一則留言。');
    });
  }

  // 部落格：程式區塊不用 text 或不寫語言；圖片外面不包連結
  if (type === 'article') {
    for (const fence of fences) {
      if (!fence.lang || fence.lang === 'text') add('BW-FENCE', WARN, fence.line - 1, 0, fence.lang || '（沒寫語言）', '程式區塊要標 bash／prompt／agent／output，不用 text 或不寫語言。');
    }
    for (const line of imageLinks) add('BW-IMGLINK', WARN, line - 1, 0, '', '圖片外面包連結時圖說不會出現；要圖說就不要包連結，連結寫在圖下一行。');
  }

  // 私有名詞（老師、站名、客戶、金鑰樣式）
  for (const term of options.privateTerms ?? []) {
    const re = new RegExp(term.re.source, term.re.flags.includes('g') ? term.re.flags : term.re.flags + 'g');
    codeFree.forEach((line, index) => {
      for (const m of line.matchAll(re)) {
        if (!m[0]) continue;
        add('R9', ERROR, index, m.index, m[0], '私有名詞（老師、站名、客戶、聯絡方式、金鑰）不寫進對外文字。', codeFree);
      }
    });
  }

  hits.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  // 同一處被同一條規則的兩個樣式命中時只留一筆
  const unique = [];
  const keys = new Set();
  for (const hit of hits) {
    const key = `${hit.rule}:${hit.line}:${hit.column}`;
    if (keys.has(key)) continue;
    keys.add(key);
    unique.push(hit);
  }
  return { type, format, hits: unique };
}
