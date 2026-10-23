# de-ai-slop：去 AI 垃圾

讓 AI agent 寫或改中文文字時，照同一份規則去掉 AI 味。適用所有給人看的中文文字：部落格文章、介紹文、產品說明、Threads／FB／IG 貼文、社團貼文、信件、回饋單或工單的調整說明、給人審的修改清單。

規則來自實際寫文時被退回的句子，以及台灣網友公開點名的 AI 味寫法。例句已經換成中性內容，只保留句型和「為什麼是 AI 味」。

## 裡面有什麼

```
skills/de-ai-slop/
├── SKILL.md                  規則本體（R1–R56）與交付流程
└── references/
    ├── ai-tells.md           真人怎麼認出 AI 文、網友點名的用字、去 AI 味 prompt、紅旗念頭
    ├── bad-examples.md       被退回的句子：原句、為什麼是 AI 味、改法
    └── longform.md           長文與教學文：交稿前先砍什麼、用詞對照、全覽型文章的例外
```

規則分六類：內容必須是真的、直接講事情、只寫讀者在意的事、標題與結構、格式與語感、用詞。每次交付前，agent 要整篇逐條對照，回報違反了哪幾條、怎麼改的。

## 安裝

每個 agent 選一種裝，plugin 和 `npx skills` 都裝會出現兩份。

### Claude Code

```bash
claude plugin marketplace add aixwangtw/de-ai-slop
claude plugin install de-ai-slop@de-ai-slop
```

更新：`claude plugin marketplace update de-ai-slop`

### Codex

```bash
codex plugin marketplace add aixwangtw/de-ai-slop
codex plugin add de-ai-slop@de-ai-slop
```

更新：`codex plugin marketplace upgrade`

### 其他 agent，或想直接改檔案

```bash
npx skills@latest add aixwangtw/de-ai-slop
```

檔案會放在專案的 `.agents/skills/de-ai-slop/`（Codex 讀這裡），Claude Code 透過 `.claude/skills/de-ai-slop` 連結讀到。在一般終端機執行會跳出選單，要非互動安裝就加 `-y`（裝給全部偵測到的 agent），只裝給特定 agent 用 `-a claude-code -a codex -y`。加 `-g` 裝到使用者層級，所有專案都能用。更新用 `npx skills@latest update`。

## 怎麼用

裝好之後不用特別叫它。寫或改中文文字時 agent 會自己載入；也可以直接說「用 de-ai-slop 檢查這篇」。

## 加新規則

被退回一句 AI 味的寫法，就把原句（換成中性內容）、為什麼是 AI 味、改法加進 `references/bad-examples.md`；是新的通則就加進 `SKILL.md` 對應的節，接著往下編號。每次改規則都在 `CHANGELOG.md` 記一筆：日期、改了什麼、起因（回饋原話，匿名化）。

## English

`de-ai-slop` is an agent skill for writing and editing Traditional Chinese text that people will read: blog posts, social posts, product copy, emails, and change notes. It collects rules for removing "AI slop" (contrast clichés like "not X, but Y", forced triplets, fabricated anecdotes, corporate filler, over-formatting) drawn from real rejected drafts and from Taiwanese readers' public discussions of how they spot AI-written posts. The rules are written in Traditional Chinese.

Install with `claude plugin marketplace add aixwangtw/de-ai-slop`, `codex plugin marketplace add aixwangtw/de-ai-slop`, or `npx skills@latest add aixwangtw/de-ai-slop`.

## 授權

MIT，見 [LICENSE](./LICENSE)。
