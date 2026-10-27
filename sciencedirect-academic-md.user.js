// ==UserScript==
// @name         ScienceDirect 学术综述 Markdown 导出
// @namespace    https://github.com/myh333777/leapspace-md-export
// @homepageURL  https://github.com/myh333777/leapspace-md-export
// @supportURL   https://github.com/myh333777/leapspace-md-export/issues
// @updateURL    https://raw.githubusercontent.com/myh333777/leapspace-md-export/main/sciencedirect-academic-md.meta.js
// @downloadURL  https://raw.githubusercontent.com/myh333777/leapspace-md-export/main/sciencedirect-academic-md.user.js
// @version      1.6.9
// @description  学术综述 Markdown 导出、完整文献摘要与需预览确认的历史会话批量清理。
// @author       MYH
// @match        https://www.sciencedirect.com/leapspace*
// @match        https://www.sciencedirect.com/researcher-ai*
// @run-at       document-idle
// @noframes
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';

  const APP_ID = 'leapspace-md-exporter';
  const VERSION = '1.6.9';
  const ANSWER_SELECTOR = '[class*="_markdown_"]'; // Verified in JUST sciencedirect-researcher-ai Skill.
  const REF_DOT = 'button[data-component="ReferenceDot"]';
  const SHOW_REFS = '[data-testid="show-all-references-button"], button[aria-label*="Show all"][aria-label*="references"]';
  const UNWANTED = 'nav, aside, [role="dialog"], [role="navigation"], [aria-hidden="true"], [inert]';
  const KEY_MAX_STEPS = 140;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const domOrderBefore = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const text = el => (el?.innerText || el?.textContent || '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
  // LeapSpace link titles include screen-reader instructions such as
  // 'Opens in a new window'. These are not part of a publication's title.
  function cleanUiText(value) {
    return (value || '').replace(/\s*(?:Opens? in a new (?:window|tab)|在新窗口中打开|在新标签页中打开)\s*$/gi, '').trim();
  }
  const cleanAuthors = value => (value || '').replace(/\s*;\s*/g, '; ').replace(/\s+/g, ' ').trim();

  const currentPage = () => location.href.split('#')[0];

  function visible(el) {
    if (!el?.isConnected || el.closest('#' + APP_ID)) return false;
    if (el.closest('[aria-hidden="true"], [inert], [hidden]')) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && !!el.getClientRects().length;
  }

  function usefulText(s) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (t.length < 3 || t.length > 15000) return false;
    return !/^(answer|回答|references?|引用|show all references|hide abstract|show abstract|search|new conversation|new chat|history|share|copy|download|loading|继续提问|复制|下载)$/i.test(t);
  }

  function safeUrl(raw) {
    if (!raw || /^\s*(?:javascript|data|vbscript):/i.test(raw)) return '';
    try {
      const base = /^\/leapspace\/redirect\?/.test(raw) ? 'https://www.sciencedirect.com' : location.href;
      const u = new URL(raw, base);
      // LeapSpace titles are often indirect links: turn them into portable DOI URLs.
      if (u.hostname === 'www.sciencedirect.com' && u.pathname === '/leapspace/redirect') {
        const doi = u.searchParams.get('doi') || '';
        if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return 'https://doi.org/' + encodeURI(doi);
      }
      if (!/^https?:$/.test(u.protocol)) return '';
      // Remove known analytics-only params without stripping query parameters
      // that are needed to resolve the article itself.
      for (const k of [...u.searchParams.keys()]) {
        if (/^(?:adobe_mc|utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid|igshid)$/i.test(k)) {
          u.searchParams.delete(k);
        }
      }
      return u.href;
    } catch { return ''; }
  }

  function escapeInline(s) {
    return s.replace(/\\/g, '\\\\').replace(/([*_[\]`|])/g, '\\$1');
  }
  // Preserve leading indentation (nested lists, footnote continuation and code)
  // and original blank lines inside fenced blocks. Avoid global whitespace trimming.
  function normalizeMd(s) {
    const lines = s.replace(/\u00ad/g, '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let fenced = false;
    let fenceType = '';
    let fenceLength = 0;
    let blank = false;
    for (let line of lines) {
      const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (delimiter && (!fenced ||
          (delimiter[1][0] === fenceType && delimiter[1].length >= fenceLength && !delimiter[2].trim()))) {
        if (!fenced) {
          fenced = true;
          fenceType = delimiter[1][0];
          fenceLength = delimiter[1].length;
        } else {
          fenced = false;
        }
        output.push(line);
        blank = false;
        continue;
      }
      if (fenced) { output.push(line); continue; }
      line = line.replace(/[ \t]+$/g, '');
      if (!line.trim()) {
        if (output.length && !blank) output.push('');
        blank = true;
      } else {
        output.push(line);
        blank = false;
      }
    }
    return output.join('\n').trim();
  }
  function getTex(el) {
    const annotation = el.querySelector?.('annotation[encoding="application/x-tex"]');
    const candidate = annotation?.textContent || el.getAttribute?.('data-tex') || el.getAttribute?.('data-latex') || '';
    return candidate.trim();
  }
  function mathInline(node, display = false) {
    const tex = getTex(node);
    if (tex) return display ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    return (node.getAttribute?.('alttext') || node.getAttribute?.('aria-label') || text(node)).trim();
  }
  function isMath(n) {
    return n.matches?.('.katex, .katex-display, .MathJax, .MathJax_Display, mjx-container, math, [data-latex], [data-tex]');
  }
  function isBlock(n) {
    return /^(ADDRESS|ARTICLE|BLOCKQUOTE|DIV|DL|H[1-6]|HR|LI|OL|P|PRE|SECTION|TABLE|UL)$/.test(n.tagName || '')
      || n.matches?.('.katex-display, .MathJax_Display, mjx-container[display="true"]');
  }
  function refLabel(n) {
    return (n.getAttribute('aria-label')?.match(/\d+/)?.[0] || text(n).match(/\d+/)?.[0] || '').slice(0, 8);
  }

  // Inline serialization retains LaTeX from KaTeX's application/x-tex annotation;
  // KaTeX's accessibility and visual branches are NEVER serialized twice.
  function inlineNode(node, ctx) {
    if (node.nodeType === Node.TEXT_NODE) return escapeInline((node.nodeValue || '').replace(/\u00ad/g, ''));
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node;
    if (el.matches?.('script,style,noscript,svg,button:not([data-component="ReferenceDot"]),[hidden],[aria-hidden="true"],.sr-only,[class*="_srOnly_"]')) return '';
    if (el.matches?.(REF_DOT)) {
      const ref = refLabel(el);
      if (!ref) return '';
      ctx.cites.add(ref);
      return `@@LSE_CITE_${ctx.turn}_${ref}@@`;
    }
    if (el.matches?.('.katex-display, .MathJax_Display, mjx-container[display="true"]')) return mathInline(el, true);
    if (isMath(el)) return mathInline(el, false);
    if (el.matches?.('br')) return '  \n';
    if (el.matches?.('img')) {
      const src = safeUrl(el.getAttribute('src'));
      const alt = (el.getAttribute('alt') || '图片').replace(/[\[\]]/g, '');
      return src ? `![${alt}](${src})` : '';
    }
    if (el.matches?.('code') && !el.closest('pre')) {
      const raw = el.textContent || '';
      const ticks = '`'.repeat(Math.max(1, ...Array.from(raw.matchAll(/`+/g), m => m[0].length + 1)));
      return `${ticks}${raw}${ticks}`;
    }
    const children = Array.from(el.childNodes).map(child => inlineNode(child, ctx)).join('');
    if (el.matches?.('a[href]')) {
      const dest = safeUrl(el.getAttribute('href'));
      if (!dest) return children;
      const label = children.trim() || escapeInline(dest);
      return `[${label}](${dest.replace(/\)/g, '%29')})`;
    }
    if (el.matches?.('strong,b')) return `**${children.trim()}**`;
    if (el.matches?.('em,i')) return `*${children.trim()}*`;
    if (el.matches?.('del,s,strike')) return `~~${children.trim()}~~`;
    if (el.matches?.('sub,sup')) return `<${el.tagName.toLowerCase()}>${children}</${el.tagName.toLowerCase()}>`;
    return children;
  }

  function inline(el, ctx) {
    // The surrounding paragraph can contain a KaTeX display block. Protect
    // $$...$$ before collapsing whitespace, then restore it on separate lines.
    // Otherwise a browser-rendered equation becomes invalid inline "text $$ x $$".
    const formulas = [];
    let raw = Array.from(el.childNodes).map(c => inlineNode(c, ctx)).join('');
    raw = raw.replace(/\n\n\$\$\n[\s\S]*?\n\$\$\n\n/g, match => {
      const key = `\uE000LSMATH${formulas.length}\uE001`;
      formulas.push(match.trim());
      return key;
    });
    raw = raw.replace(/[\t\r\n ]+/g, ' ').replace(/\s+([,.;:!?，。；：！？])/g, '$1').trim();
    return raw.replace(/\uE000LSMATH(\d+)\uE001/g, (_, index) =>
      `\n\n${formulas[Number(index)]}\n\n`).trim();
  }

  function fencedCode(el) {
    const code = el.querySelector('code') || el;
    const raw = (code.textContent || '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const language = ([...code.classList].find(n => /^(language|lang)-/.test(n)) || el.getAttribute('data-language') || '')
      .replace(/^(language|lang)-/, '').replace(/[^a-zA-Z0-9_+.#-]/g, '');
    const maxRun = Math.max(0, ...Array.from(raw.matchAll(/`+/g), m => m[0].length));
    const fence = '`'.repeat(Math.max(3, maxRun + 1));
    return `\n\n${fence}${language}\n${raw}\n${fence}\n\n`;
  }

  function tableMd(el, ctx) {
    const trs = [...el.querySelectorAll('tr')].filter(tr => tr.closest('table') === el);
    if (!trs.length) return '';
    const rows = trs.map(tr => [...tr.children].filter(cell => /^(TD|TH)$/.test(cell.tagName))
      .flatMap(cell => {
        const parts = [inline(cell, ctx).replace(/\|/g, '\\|').replace(/\n/g, ' ')];
        const span = Math.min(Math.max(1, Number(cell.getAttribute('colspan') || 1)), 15);
        for (let i = 1; i < span; i++) parts.push('');
        return parts;
      }));
    const count = Math.max(...rows.map(r => r.length), 1);
    const pad = r => Array.from({length: count}, (_, i) => r[i] || '');
    const first = pad(rows[0]);
    const rest = rows.slice(1).map(r => `| ${pad(r).join(' | ')} |`);
    return `\n\n| ${first.join(' | ')} |\n| ${Array(count).fill('---').join(' | ')} |\n${rest.join('\n')}\n\n`;
  }

  function listMd(el, ctx, level = 0) {
    const ordered = el.tagName === 'OL';
    const start = Number(el.getAttribute('start') || 1);
    const lis = Array.from(el.children).filter(child => child.tagName === 'LI');
    return lis.map((li, i) => {
      const itemChildren = [...li.childNodes].filter(n => !(n.nodeType === 1 && n.matches('ul,ol')));
      const piece = itemChildren.map(n => n.nodeType === 1 && isBlock(n) ? block(n, ctx).trim() : inlineNode(n, ctx)).join('')
        .trim().replace(/\n{3,}/g, '\n\n');
      const marker = ordered ? `${start + i}. ` : '- ';
      const spaces = '    '.repeat(level);
      let line = spaces + marker + piece.replace(/\n/g, '\n' + spaces + ' '.repeat(marker.length));
      const nested = Array.from(li.children).filter(n => n.matches('ul,ol'));
      if (nested.length) line += '\n' + nested.map(n => listMd(n, ctx, level + 1)).join('\n');
      return line;
    }).join('\n');
  }

  function block(el, ctx) {
    if (el.nodeType === Node.TEXT_NODE) return (el.nodeValue || '').trim() ? inlineNode(el, ctx) : '';
    if (el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.matches('script,style,noscript,svg,[hidden],[aria-hidden="true"],.sr-only,[class*="_srOnly_"]') || el.closest('#' + APP_ID)) return '';
    if (el.matches('.katex-display,.MathJax_Display,mjx-container[display="true"]')) return mathInline(el, true);
    if (isMath(el)) return mathInline(el, false);
    if (el.matches('pre')) return fencedCode(el);
    if (el.matches('table')) return tableMd(el, ctx);
    if (el.matches('ul,ol')) return '\n\n' + listMd(el, ctx) + '\n\n';
    if (el.matches('blockquote')) return '\n\n' + blockChildren(el, ctx).trim().split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    if (el.matches('hr')) return '\n\n---\n\n';
    if (/^H[1-6]$/.test(el.tagName)) return '\n\n' + '#'.repeat(Math.min(6, Number(el.tagName[1]) + 2)) + ' ' + inline(el, ctx) + '\n\n';
    if (el.matches('p')) return '\n\n' + inline(el, ctx) + '\n\n';
    return blockChildren(el, ctx);
  }
  function blockChildren(el, ctx) {
    let out = '';
    let buf = '';
    const flush = () => { if (buf.trim()) out += '\n\n' + buf.trim() + '\n\n'; buf = ''; };
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && isBlock(child)) { flush(); out += block(child, ctx); }
      else buf += inlineNode(child, ctx);
    }
    flush();
    return out;
  }

  function getAnswers() {
    // Verified on a real LeapSpace conversation (2026-10-26): this ARTICLE is
    // the actual rendered answer; the surrounding _markdown_ DIV also contains
    // sr-only accessibility text that should not appear in Markdown.
    const precise = [...document.querySelectorAll('article[data-testid="buffered-content-markdown"]')]
      .filter(visible).filter(n => !n.closest(UNWANTED) && usefulText(text(n)));
    if (precise.length) return precise;
    const all = [...document.querySelectorAll(ANSWER_SELECTOR)].filter(visible)
      .filter(n => !n.closest(UNWANTED) && usefulText(text(n)));
    return all.filter(n => !all.some(parent => parent !== n && parent.contains(n)));
  }

  function currentMain(answers) {
    const first = answers[0];
    if (!first) return document.querySelector('main,[role="main"]') || document.body;
    return first.closest('main,[role="main"],article,[class*="conversation"]') || document.querySelector('main,[role="main"]') || document.body;
  }

  function userCandidates(root) {
    const selectors = [
      '[data-message-author-role="user"]', '[data-testid*="user-message" i]', '[data-testid*="question" i]',
      '[data-testid*="prompt" i]', '[class*="userMessage"]', '[class*="_userMessage_"]', '[class*="_userQueryMessage_"]',
      '[class*="_question_"]', '[class*="questionText"]', '[class*="_prompt_"]',
      '[class*="promptText"]', '[class*="promptContent"]', '[class*="userBubble"]',
      '[class*="_userBubble_"]', '[class*="humanMessage"]'
    ];
    const candidates = [...root.querySelectorAll(selectors.join(','))];
    return candidates.filter(n => visible(n) && !n.closest(ANSWER_SELECTOR) && !n.closest(UNWANTED) && usefulText(text(n)))
      .filter(n => !candidates.some(parent => parent !== n && parent.contains(n) && usefulText(text(parent)) && text(parent) === text(n)));
  }

  function guessQuestion(answer, prevAnswer, root, explicit) {
    // The stable exchange wrapper directly pairs each question with its answer.
    // Real DOM: [data-testid^="exchange-"] > ._userQueryMessage_* + ._exchangeWrapper_*
    const exchange = answer.closest('[data-testid^="exchange-"]');
    const directQuestion = exchange?.querySelector('[class*="_userQueryMessage_"], [data-testid="user-query-message"]');
    if (directQuestion && visible(directQuestion) && text(directQuestion).trim()) {
      return {question: text(directQuestion), confidence: 'exchange'};
    }
    const valid = n => n !== answer && visible(n) && !n.contains(answer) && !n.closest(UNWANTED) &&
      !(n.matches?.(ANSWER_SELECTOR) || n.querySelector?.(ANSWER_SELECTOR)) && usefulText(text(n));
    const between = n => domOrderBefore(n, answer) && (!prevAnswer || domOrderBefore(prevAnswer, n));
    const hits = explicit.filter(n => valid(n) && between(n))
      .sort((a, b) => domOrderBefore(a, b) ? 1 : -1);
    if (hits.length) return {question: text(hits[0]), confidence: 'explicit'};

    // Conservative structural fallback: nearest non-answer previous sibling up to 6 ancestors.
    let cur = answer;
    for (let level = 0; level < 6 && cur && cur !== root; level++, cur = cur.parentElement) {
      for (let sibling = cur.previousElementSibling, num = 0; sibling && num < 5; sibling = sibling.previousElementSibling, num++) {
        if (!between(sibling) || !valid(sibling)) continue;
        const s = text(sibling);
        if (s.length > 2500 || /^(Answer|References|Suggested follow-up|Sources)$/i.test(s)) continue;
        if (s.length > 5) return {question: s, confidence: 'adjacent'};
      }
    }
    return {question: '', confidence: 'missing'};
  }

  function enclosingAnswerCard(answer) {
    let parent = answer;
    for (let i = 0; i < 6 && parent; i++, parent = parent.parentElement) {
      const count = parent.querySelectorAll(ANSWER_SELECTOR).length;
      if (count > 1) break;
      if (parent.querySelector(SHOW_REFS)) return parent;
    }
    return answer.parentElement || answer;
  }

  // A reference card initially displays its title/metadata only. LeapSpace
  // creates the abstract text inside a collapsed Animation container only
  // after its native "Show abstract" button has been clicked. Extract from
  // the expanded content, not from the surrounding article metadata.
  function readAbstract(article) {
    const wrap = article.querySelector('[class*="expandCollapse"], [data-testid*="abstract" i]');
    if (!wrap || wrap.getAttribute('data-state') === 'exit') return '';
    const blocks = [...wrap.querySelectorAll('p')].filter(visible).map(p => text(p)).filter(Boolean);
    let body = blocks.join('\n\n');
    if (!body) body = visible(wrap) ? text(wrap) : '';
    return body.replace(/^(?:Hide|Show) abstract\s*/i, '').replace(/\u00ad/g, '').trim();
  }

  async function expandAbstracts(pane, report) {
    const currentRecords = () => [...pane.querySelectorAll('article')]
      .filter(a => a.querySelector('[data-testid="reference-title"]'));
    const total = currentRecords().length;
    const opened = [];
    let available = 0;
    let failed = 0;
    // Small DOM batches: do not trigger 35 simultaneous React updates. This
    // stays in the existing tab; it never fetches hidden API endpoints.
    for (let i = 0; i < Math.min(total, 180); i++) {
      // React may remount the reference list following each expansion.
      const article = currentRecords()[i];
      if (!article) { failed++; continue; }
      let abstract = readAbstract(article);
      if (!abstract) {
        const show = article.querySelector('button[aria-label="Show abstract"]');
        if (show && visible(show)) {
          try { show.click(); opened.push(article); }
          catch { /* Leave this reference unexpanded rather than failing all. */ }
          const deadline = Date.now() + 1200;
          while (Date.now() < deadline) {
            abstract = readAbstract(article);
            if (abstract) break;
            await pause(90);
          }
        }
      }
      if (abstract) available++;
      else failed++;
      if ((i + 1) % 5 === 0 || i === Math.min(total, 180) - 1) {
        report(`正在读取文献摘要：${Math.min(i + 1, total)}/${total}，成功 ${available}，不可用 ${failed}`);
      }
      await pause(110);
    }
    if (total > 180) report(`文献量 ${total} 超出本轮摘要展开保护上限 180；超出部分仅保留题录并明确显示缺失。`);
    return {opened, available, failed, seen: total};
  }

  function readReferences(root) {
    const refs = [];
    const seen = new Set();
    for (const article of root.querySelectorAll('article')) {
      const titleEl = article.querySelector('[data-testid="reference-title"]');
      if (!titleEl || !visible(titleEl)) continue;
      const a = titleEl.querySelector('a[href]');
      const title = cleanUiText(text(a || titleEl));
      const refNumberButton = article.querySelector(REF_DOT + ',button[aria-label^="Reference number"]');
      const number = refLabel(refNumberButton || {getAttribute: () => null, innerText: ''}) || String(refs.length + 1);
      if (!title || seen.has(number + '|' + title)) continue;
      seen.add(number + '|' + title);
      const authorsEl = article.querySelector('[class*="authorsContainer"]');
      const authors = authorsEl ? cleanAuthors(text(authorsEl)) : '';
      const meta = text(article.querySelector('[class*="_mb8_"]') || article);
      const year = meta.match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
      const journal = [...article.querySelectorAll('a[href]')].map(n => cleanUiText(text(n)))
        .find(x => x && x !== title && !/Scopus|publisher|full text|abstract|doi/i.test(x) && x.length < 140) || '';
      const links = [];
      for (const link of article.querySelectorAll('a[href]')) {
        const url = safeUrl(link.getAttribute('href'));
        if (!url || links.some(x => x.url === url)) continue;
        if (url === safeUrl(a?.getAttribute('href')) || /doi\.org|scopus|sciencedirect|publisher/i.test(url + text(link)))
          links.push({label: cleanUiText(text(link)) || '论文链接', url});
      }
      // Prefer the publisher article URL when a verified Elsevier PII is
      // present in the source DOM. Do not synthesize a PII from a Scopus ID.
      const doiLink = links.find(item => /^https:\/\/doi\.org\//i.test(item.url));
      const targetId = article.querySelector('[aria-describedby^="ref-title-"]')
        ?.getAttribute('aria-describedby') || titleEl.querySelector('[id^="ref-title-"]')?.id || '';
      const pii = targetId.match(/^ref-title-(S[A-Z0-9]{14,25})$/i)?.[1] || '';
      if (doiLink && /^https:\/\/doi\.org\/10\.1016\//i.test(doiLink.url) && pii) {
        const publisherUrl = 'https://www.sciencedirect.com/science/article/pii/' + pii.toUpperCase();
        if (!links.some(link => link.url === publisherUrl)) links.push({label:'出版社文章页',url:publisherUrl});
      }
      const abstract = readAbstract(article);
      refs.push({number, title, authors, year, journal, links, abstract});
    }
    return refs;
  }

  function currentRefsFor(answer, card) {
    const direct = readReferences(card);
    return direct.length ? direct : [];
  }

  function snapshotTurn(answer, previous, root, explicit, index) {
    const questionResult = guessQuestion(answer, previous, root, explicit);
    const ctx = {turn: index, cites: new Set()};
    const md = normalizeMd(block(answer, ctx));
    const card = enclosingAnswerCard(answer);
    return {question: questionResult.question, confidence: questionResult.confidence,
      answer: md, cites: [...ctx.cites], refs: currentRefsFor(answer, card),
      id: answer.closest('[data-testid^="exchange-"]')?.getAttribute('data-testid') ||
          answer.closest('[data-message-id],[data-testid*="message" i]')?.getAttribute('data-message-id') || ''};
  }

  function snapshot() {
    const answers = getAnswers();
    if (!answers.length) return [];
    const root = currentMain(answers);
    const explicit = userCandidates(root);
    return answers.map((a, i) => snapshotTurn(a, answers[i - 1] || null, root, explicit, i + 1))
      .filter(t => t.answer.length >= 3);
  }

  function signature(t) {
    // Hash used for virtualized scroll overlap; id takes precedence when present.
    if (t.id) return 'id:' + t.id;
    const raw = t.question.slice(0, 350) + '\u0000' + t.answer.replace(/@@LSE_CITE_\d+_(\d+)@@/g, '@@LSE_CITE_$1@@');
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 16777619);
    return 'hash:' + (h >>> 0).toString(16) + ':' + raw.length;
  }
  function mergeTurn(a, b) {
    const refs = b.refs.length > a.refs.length ? b.refs : a.refs;
    const question = a.question || b.question;
    return {...a, question, confidence: a.question ? a.confidence : b.confidence, refs};
  }

  function activeScroller() {
    const first = getAnswers()[0];
    if (!first) return null;
    let n = first.parentElement;
    while (n && n !== document.body) {
      const style = getComputedStyle(n);
      if (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight + 80) return n;
      n = n.parentElement;
    }
    const doc = document.scrollingElement;
    return doc?.scrollHeight > doc?.clientHeight + 80 ? doc : null;
  }

  async function scanCurrentConversation(autoScroll, report) {
    const scroller = autoScroll ? activeScroller() : null;
    if (!scroller) return snapshot();
    const startTop = scroller.scrollTop;
    const wasBottom = scroller.scrollHeight - scroller.clientHeight - startTop < 100;
    let previousHeight = 0;
    // Explicit user action: inspect older turns that are loaded on upward scrolling.
    for (let i = 0; i < 16; i++) {
      scroller.scrollTop = 0;
      await pause(240);
      const h = scroller.scrollHeight;
      if (scroller.scrollTop === 0 && h === previousHeight) break;
      previousHeight = h;
    }
    const found = new Map();
    function absorb() {
      for (const turn of snapshot()) {
        const id = signature(turn);
        found.set(id, found.has(id) ? mergeTurn(found.get(id), turn) : turn);
      }
    }
    let stagnation = 0;
    try {
      for (let step = 0; step < KEY_MAX_STEPS; step++) {
        absorb();
        if (step % 10 === 0) report(`正在扫描当前对话：已识别 ${found.size} 条回答…`);
        const before = scroller.scrollTop;
        scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(280, Math.floor(scroller.clientHeight * .75)), scroller.scrollHeight);
        await pause(115);
        const bottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 6;
        if (scroller.scrollTop === before && bottom) stagnation++;
        else stagnation = 0;
        if (stagnation >= 3) break;
      }
      absorb();
    } finally {
      scroller.scrollTop = wasBottom ? scroller.scrollHeight : Math.min(startTop, scroller.scrollHeight);
    }
    return [...found.values()];
  }

  // Expand the reference pane only after a user asks to export references.
  // The pane is in a sibling ASIDE, not inside MAIN (verified on live page).
  // Restore it afterwards if this exporter opened it; never read other chats.
  async function enrichVisibleReferenceLists(turns, report, withAbstracts = true) {
    const answers = getAnswers();
    if (!answers.length) return turns;
    const bySignature = new Map(turns.map((t, i) => [signature(t), i]));
    const refPaneSelector = 'aside#canvas-container, aside[aria-label="All references"], aside[aria-label="Reference details"], aside[data-testid="canvas-panel"]';
    const refPane = () => document.querySelector(refPaneSelector);
    let clicks = 0;
    for (let i = 0; i < answers.length && clicks < 30; i++) {
      const answer = answers[i];
      const card = enclosingAnswerCard(answer);
      const show = card.querySelector(SHOW_REFS);
      const local = snapshot();
      const turn = local[i];
      if (!turn) continue;
      const target = bySignature.get(signature(turn));
      if (target === undefined || turns[target].refs.length) continue;
      const previousPaneRefs = readReferences(refPane() || document.body);
      const initialPane = refPane();
      const initialListOpen = initialPane?.getAttribute('aria-label') === 'All references' && visible(initialPane);
      let openedByUs = false;
      let selectedExchange = false;
      let abstractsOpened = [];
      try {
        if (initialListOpen && turns.length === 1) {
          // A single turn with the exact list already open: do not toggle it.
          selectedExchange = true;
        } else if (show && visible(show)) {
          show.click();
          clicks++;
          openedByUs = !initialListOpen;
          selectedExchange = true;
        }
        let pane = refPane();
        let items = [];
        for (let attempt = 0; attempt < 10; attempt++) {
          await pause(150);
          pane = refPane();
          items = readReferences(pane || card);
          if (!items.length) items = readReferences(card);
          if (items.length) break;
        }
        if (!items.length && !selectedExchange && turns.length === 1) items = previousPaneRefs;
        if (withAbstracts && items.length && pane && pane.getAttribute('aria-label') === 'All references') {
          const expansion = await expandAbstracts(pane, report);
          abstractsOpened = expansion.opened;
          // Reread after expansion; DOM may have re-rendered due to React state.
          items = readReferences(pane);
        }
        if (items.length && (selectedExchange || turns.length === 1)) turns[target].refs = items;
        report(`已提取参考文献 ${items.length} 条，其中含摘要 ${items.filter(r=>r.abstract).length} 条`);
      } catch (err) {
        report(`参考文献面板局部异常：${String(err?.message || err).slice(0,100)}；继续保存正文。`);
      } finally {
        if (!openedByUs) {
          // If the user had the reference panel open, preserve its original
          // expansion state as closely as possible.
          for (const article of abstractsOpened) {
            const hide = article.querySelector('button[aria-label="Hide abstract"]');
            try { hide?.click(); } catch { /* Do not block export. */ }
            await pause(18);
          }
        } else {
          const pane = refPane();
          const close = [...(pane?.querySelectorAll('button') || [])]
            .find(n => /^(close|关闭)$/i.test(text(n)) || /^(close|关闭)$/i.test(n.getAttribute('aria-label') || ''));
          try { close?.click(); } catch { /* UI close is optional. */ }
          await pause(120);
        }
      }
    }
    return turns;
  }

  function yaml(s) { return JSON.stringify(String(s || '').replace(/\r?\n/g, ' ').slice(0, 700)); }

  // Clean only display titles and filenames. Do not alter the source question or AI text.
  function displayTitle(value) {
    let result = (value || '').replace(/\s*[-–—]\s*LeapSpace(?:\s*-\s*ScienceDirect\.com)?\s*$/i, '')
      .replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    const mates = {'】':'【', ']':'[', '）':'（', ')':'(', '》':'《', '」':'「', '』':'『'};
    while (result && mates[result.slice(-1)] && !result.includes(mates[result.slice(-1)])) {
      result = result.slice(0, -1).trimEnd();
    }
    return result || '研究综述';
  }

  function formattedAuthors(value) {
    const names = (value || '').split(/\s*;\s*/).map(s => s.trim()).filter(Boolean);
    if (!names.length) return '作者信息缺失';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  }

  function academicReference(r, ordinal, compactRefs, includeAbstracts) {
    const doi = r.links?.find(x => /^https:\/\/doi\.org\//i.test(x.url));
    const publisher = r.links?.find(x => /^https:\/\/www\.sciencedirect\.com\/science\/article\/pii\/S[A-Z0-9]{14,25}$/i.test(x.url));
    const paper = publisher || doi || r.links?.find(x => /^https?:\/\//i.test(x.url) && !/scopus|\/(?:journal|sourceid)\//i.test(x.url));
    const scopus = r.links?.find(x => /scopus\.com\/pages\/publications\//i.test(x.url));
    const name = cleanUiText(r.title || '题名未提供').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
    const titlePart = paper ? `[${name}](${paper.url.replace(/\)/g, '%29')})` : name;
    const author = formattedAuthors(r.authors);
    const year = r.year ? ` (${r.year})` : '（发表年份缺失）';
    const journal = r.journal ? ` *${cleanUiText(r.journal).replace(/\*/g, '\\*')}*.` : '';
    const extraLinks = [];
    if (doi && paper?.url !== doi.url) extraLinks.push('[DOI](' + doi.url.replace(/\)/g, '%29') + ')');
    if (scopus) extraLinks.push(`[Scopus（可能需要机构登录）](${scopus.url.replace(/\)/g, '%29')})`);
    if (!compactRefs) {
      const seen = new Set([doi?.url, paper?.url, publisher?.url, scopus?.url]);
      for (const item of r.links || []) {
        if (seen.has(item.url)) continue;
        if (/\/(?:journal|sourceid)\//i.test(item.url)) continue;
        seen.add(item.url);
        extraLinks.push(`[${cleanUiText(item.label || '更多信息').replace(/[\[\]]/g, '')}](${item.url.replace(/\)/g, '%29')})`);
      }
    }
    const titleTerm = /[.!?。！？]$/.test(name) ? '' : '.';
    const out = [`${ordinal}. <a id="ref-${ordinal}" name="ref-${ordinal}"></a> ${author}${year}. ${titlePart}${titleTerm}${journal}${extraLinks.length ? ' (' + extraLinks.join('；') + ')' : ''}`];
    const continuation = ' '.repeat(String(ordinal).length + 2);
    if (includeAbstracts) {
      out.push('', continuation + '> **摘要注释 · 英文原文**', continuation + '>');
      if (r.abstract?.trim()) {
        const paras = r.abstract.trim().split(/\n{2,}/).map(x => x.replace(/[ \t]+/g, ' ').trim())
          .filter(x => x && !/^(?:\*\*)?\s*(?:摘要注释\s*[·:：]\s*英文原文|Abstract)\s*(?:\*\*)?\s*[:：]?$/i.test(x));
        for (let i = 0; i < paras.length; i++) {
          if (i) out.push(continuation + '>');
          out.push(continuation + '> ' + paras[i].replace(/\n/g, ' '));
        }
      } else out.push(continuation + '> *当前页面未读取到摘要；不代表论文没有摘要。*');
    }
    return out.join('\n');
  }

  // Number heading levels as an academic summary, without touching the text
  // inside code fences. Original AI headings may have been shifted two levels
  // deeper by the HTML serializer; normalize them back to an ordinary outline.
  function formatOutline(md, baseLevel, prefix) {
    const rows = md.split('\n');
    const candidates = [];
    let searchingFence = null;
    for (const row of rows) {
      const fence = row.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (!searchingFence) searchingFence = {c:fence[1][0],len:fence[1].length};
        else if (fence[1][0]===searchingFence.c && fence[1].length>=searchingFence.len) searchingFence=null;
        continue;
      }
      if (!searchingFence && /^#{2,6} +\S/.test(row)) candidates.push(row);
    }
    const minLevel = candidates.length ? Math.min(...candidates.map(s => s.match(/^#+/)[0].length)) : 6;
    const counters = [];
    let codeFence = null;
    let topSections = 0;
    const transformed = rows.map(row => {
      const fence = row.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (!codeFence) codeFence = {c:fence[1][0],len:fence[1].length};
        else if (fence[1][0] === codeFence.c && fence[1].length >= codeFence.len) codeFence = null;
        return row;
      }
      if (codeFence) return row;
      const m = row.match(/^(#{2,6}) +(.*)$/);
      if (!m) return row;
      const depth = Math.max(0, Math.min(3, m[1].length - minLevel));
      while (counters.length <= depth) counters.push(0);
      counters[depth]++;
      counters.length = depth + 1;
      for (let k = 0; k < depth; k++) if (!counters[k]) counters[k] = 1;
      if (depth === 0) topSections++;
      const marker = prefix ? `${prefix}.${counters.join('.')}` : counters.join('.');
      const headingSize = Math.min(6, baseLevel + depth);
      return `${'#'.repeat(headingSize)} ${marker}. ${m[2].replace(/^\d+(?:\.\d+)*\.\s*/, '')}`;
    });
    return {text: transformed.join('\n'), topSections};
  }

  // Build one bibliography for the whole document. The same DOI used in
  // several turns gets one global number; local [1] from another turn never
  // erroneously points to the first turn's [1].
  function globalBibliography(turns) {
    const records = [];
    const byKey = new Map();
    const perTurnNumbers = [];
    for (const [turnIndex, turn] of turns.entries()) {
      const own = new Map();
      for (const r of turn.refs || []) {
        const doi = r.links?.find(l => /^https:\/\/doi\.org\//i.test(l.url))?.url;
        const scopus = r.links?.find(l => /scopus\.com\/pages\/publications\//i.test(l.url))?.url;
        const key = doi ? 'doi:' + doi.toLowerCase() : scopus ? 'scopus:' + scopus.toLowerCase()
          : 'title:' + (r.title || '').toLowerCase().replace(/\s+/g, ' ').trim() + '|' + (r.year || '');
        let n = byKey.get(key);
        if (!n) {
          n = records.length + 1;
          byKey.set(key, n);
          records.push({...r, number: n, sourceTurn: turnIndex + 1});
        } else {
          const cur = records[n - 1];
          if ((!cur.abstract || cur.abstract.length < (r.abstract || '').length) && r.abstract) cur.abstract = r.abstract;
          if (!cur.authors && r.authors) cur.authors = r.authors;
          if (!cur.year && r.year) cur.year = r.year;
          if (!cur.journal && r.journal) cur.journal = r.journal;
          const seen = new Set((cur.links || []).map(l => l.url));
          for (const l of r.links || []) if (!seen.has(l.url)) { cur.links.push(l); seen.add(l.url); }
        }
        own.set(String(r.number), n);
      }
      perTurnNumbers.push(own);
    }
    return {records, perTurnNumbers};
  }

  function buildMarkdown(turns, includeRefs = true, compactRefs = true, includeAbstracts = true, withYaml = false) {
    if (!turns.length) throw new Error('没有识别到已加载的回答。请先打开当前对话。');
    const rawQuestion = turns.find(t => t.question)?.question || '';
    const title = displayTitle(rawQuestion || document.title || '研究综述').slice(0, 110);
    const date = new Date();
    const source = currentPage();
    const missing = turns.filter(t => !t.question).length;
    const {records, perTurnNumbers} = includeRefs ? globalBibliography(turns)
      : {records: [], perTurnNumbers: turns.map(() => new Map())};
    const refCount = records.length;
    const citationOccurrences = turns.reduce((n,t) => n + (t.answer.match(/@@LSE_CITE_\d+_\d+@@/g)||[]).length, 0);
    const unresolved = includeRefs ? turns.reduce((n,t,i) => n + t.cites.filter(id => !perTurnNumbers[i].has(String(id))).length, 0) : 0;
    const doiLinks = records.filter(r => (r.links || []).some(l => /^https:\/\/doi\.org\//i.test(l.url))).length;
    const abstractCount = includeRefs && includeAbstracts ? records.filter(r => !!r.abstract).length : 0;
    const abstractsNotExtracted = includeRefs && includeAbstracts ? Math.max(0,refCount-abstractCount) : 0;
    const frontmatter = [
      '---', `title: ${yaml(title)}`, `source: ${yaml(source)}`, `exported_at: ${yaml(date.toISOString())}`,
      `document_type: ${yaml('研究综述')}`, `original_question: ${yaml(rawQuestion)}`,
      `exporter_version: ${yaml(VERSION)}`, `answers: ${turns.length}`, `question_missing: ${missing}`,
      `references_extracted: ${refCount}`, `citation_occurrences: ${citationOccurrences}`,
      `citation_unresolved: ${unresolved}`, `doi_links: ${doiLinks}`,
      `abstracts_extracted: ${abstractCount}`, `abstracts_not_extracted: ${abstractsNotExtracted}`,
      `abstracts_requested: ${includeRefs && includeAbstracts}`, '---', ''
    ];
    const lines = [...(withYaml ? frontmatter : []), '# ' + title, ''];
    let mainSections = 0;
    const sourceAssessments = [];
    turns.forEach((turn, i) => {
      const map = perTurnNumbers[i];
      let answer = turn.answer.replace(/@@LSE_CITE_\d+_(\d+)@@/g, (_, local) => {
        const ordinal = map.get(String(local));
        // Text remains traceable when the page did not supply a record.
        return ordinal ? `[\\[${ordinal}\\]](#ref-${ordinal})` : `[${local}]`;
      });
      answer = answer.replace(/ {2,}(?=\[\\\[\d+\\\]\]\(#ref-\d+\))/g, ' ');
      // An AI model's confidence assertion is not a scholarly finding.
      // Preserve its exact wording in the source notes, outside the narrative.
      const foundAssessments = [];
      answer = answer.split('\n').filter(line => {
        if (/^Confidence level:\s*/i.test(line.trim())) {foundAssessments.push(line.trim());return false;}
        return true;
      }).join('\n');
      for (const assessment of foundAssessments) sourceAssessments.push({turn:i+1,text:assessment});
      if (turns.length > 1) {
        const heading = displayTitle(turn.question || `研究问题 ${i + 1}`);
        lines.push(`## ${i + 1}. ${heading}`, '');
        const outlined = formatOutline(answer, 3, String(i + 1));
        lines.push(outlined.text, '');
      } else {
        const outlined = formatOutline(answer, 2, '');
        mainSections = outlined.topSections;
        lines.push(outlined.text, '');
      }
    });
    const nextSection = (turns.length > 1 ? turns.length : mainSections) + 1;
    if (includeRefs && records.length) {
      lines.push(`## ${nextSection}. 参考文献`, '');
      for (const r of records) lines.push(academicReference(r, r.number, compactRefs, includeAbstracts), '');
    }
    const lastSection = includeRefs && records.length ? nextSection + 1 : nextSection;
    lines.push(`## ${lastSection}. 资料来源与说明`, '',
      `- **原始会话**：${source}`,
      `- **导出时间**：${date.toLocaleString()}`,
      `- **内容范围**：本次从网页成功读取 ${turns.length} 条回答。`);
    if (rawQuestion && rawQuestion !== displayTitle(rawQuestion)) lines.push(`- **原始提问**：${rawQuestion}`);
    if (missing) lines.push(`- **问题缺失**：${missing} 条回答未可靠匹配到提问，未补写。`);
    if (unresolved) lines.push(`- **引文缺失**：有 ${unresolved} 个原始引用编号无法匹配文献，不做推测。`);
    if (includeRefs && includeAbstracts) lines.push(`- **摘要读取**：${abstractCount}/${refCount} 篇；未读到的条目已标示。摘要来自页面展开内容，尚未与出版商官网逐句核验。`);
    for (const item of sourceAssessments) {
      lines.push(`- **原回答的置信度自评${turns.length>1?'（问题 '+item.turn+'）':''}（未经核验）**：${item.text}`);
    }
    lines.push('- **链接说明**：DOI 是持久标识符；出版社直达页只在原页面提供文章 PII 时生成；Scopus 可能要求机构登录，不代表链接错误。', '- **使用说明**：正文与参考文献为页面内容记录，不代表全部研究结论已由论文原文独立核实。', '');
    return {markdown: normalizeMd(lines.join('\n')) + '\n', title, missing, refs:refCount, unresolved,citationOccurrences,abstractCount};
  }

  function safeFilename(value) {
    const name = displayTitle(value || '研究综述').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 56);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    return `${name || '研究综述'}_文献综述_${stamp}.md`;
  }

  function download(contents, filename) {
    const blob = new Blob([contents], {type: 'text/markdown;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }


  // Conversation history cleanup operates through LeapSpace's own visible UI only.
  // It NEVER calls undocumented network endpoints or deletes without a user preview.
  const HISTORY_COUNT_KEY = 'ls-academic-md-exporter.history-count.v1';
  const HISTORY_ITEM_RE = /^\/leapspace\/conversation\/([0-9a-z-]{16,})\/?$/i;
  const HISTORY_LIMIT = 500;

  function historyIdentity(link) {
    const href = link?.getAttribute?.('href');
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(HISTORY_ITEM_RE);
      return match ? {id:match[1], href:url.pathname, title:(link.getAttribute('aria-label') || link.getAttribute('title') || link.textContent || '').replace(/\s+/g,' ').trim().slice(0,160)} : null;
    } catch { return null; }
  }

  function historyScope(allowModal = false) {
    // LeapSpace 2026 has two <nav aria-label="Left Panel"> elements:
    // 1. [data-testid="nav-bar"]: narrow icon bar (marked aria-hidden="true" when side sheet opens)
    // 2. [data-testid="left-panel-nav"]: slide-out drawer containing conversations
    // We must prioritize left-panel-nav or exclude nav-bar, otherwise querySelector
    // matches the preceding nav-bar first and wrongly reports sidebar as hidden.
    const nav=document.querySelector('[data-testid="left-panel-nav"]')
      || document.querySelector('nav[aria-label="Left Panel"]:not([data-testid="nav-bar"])')
      || document.querySelector('nav[aria-label="Left Panel"]');
    if(!nav)
      throw new Error('左侧聊天栏未展开；请展开 Conversations 后再预览。');
    // When a modal dialog is open (e.g. Delete confirmation), LeapSpace sets
    // aria-hidden="true" on background elements including left-panel-nav.
    // If allowModal is true or any site modal is active, do not treat that as a collapsed sidebar.
    const hasModal = allowModal || Boolean(document.querySelector('[role="dialog"]:not(#'+APP_ID+'),[role="alertdialog"],div[class*="_modal-overlay_"]'));
    const isActuallyHidden = !hasModal && (nav.getAttribute('aria-hidden')==='true' || (nav.getBoundingClientRect?.().width === 0));
    if(isActuallyHidden)
      throw new Error('左侧聊天栏未展开；请展开 Conversations 后再预览。');
    const allToggles=[...nav.querySelectorAll('button[aria-label]')]
      .filter(b=>/^(Conversations|会话|聊天记录)$/i.test((b.getAttribute('aria-label')||'').trim()));
    const toggle=allToggles.length===1 ? allToggles[0] : null;
    // LeapSpace 2026 marks actual chat rows with this exact test id. Use the
    // shared owning list, not a guessed Nth parent or a single list item.
    // This avoids repeatedly traversing every sidebar control in long lists.
    const identifiedRows=[...nav.querySelectorAll('[data-testid="conversation-list-item"]')]
      .filter(row=>[...row.querySelectorAll('a[href]')].some(a=>historyIdentity(a)));
    if(identifiedRows.length){
      const lists=[...new Set(identifiedRows.map(row=>row.closest('ul,ol,[role="list"]')))].filter(Boolean);
      if(lists.length!==1 || identifiedRows.some(row=>!lists[0].contains(row)))
        throw new Error('发现多组会话列表，无法确认删除范围；未执行删除。');
      const list=lists[0];
      // A valid Conversations heading must be present before the identified
      // list. Never accept a Project/Writing list as the conversation scope.
      const exactHeading=toggle||[...nav.querySelectorAll('h2,h3,h4,[role="heading"]')]
        .find(e=>/^(Conversations|会话|聊天记录)$/i.test((e.getAttribute('aria-label')||e.textContent||'').trim()));
      if(!exactHeading || !(exactHeading.compareDocumentPosition(list)&Node.DOCUMENT_POSITION_FOLLOWING))
        throw new Error('会话条目存在，但无法核对其 Conversations 标题；未执行删除。');
      const afterHeading=[...nav.querySelectorAll('button[aria-label]')]
        .filter(e=>e!==exactHeading && /^(Projects|Writings|项目|写作)$/i.test((e.getAttribute('aria-label')||'').trim()))
        .some(e=>(exactHeading.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)
          && (e.compareDocumentPosition(list)&Node.DOCUMENT_POSITION_FOLLOWING));
      if(afterHeading) throw new Error('会话列表与其他栏目交错，无法确认范围；未执行删除。');
      return {nav,scope:list,toggle};
    }
    // Older builds may omit the row test id. In that case accept only a
    // *uniquely named* region, never all of the sidebar and never one row.
    const named=[...nav.querySelectorAll('[role="region"][aria-label],section[aria-label]')]
      .filter(e=>/^(Conversations|会话|聊天记录)$/i.test((e.getAttribute('aria-label')||'').trim()));
    if(named.length===1){
      const scope=named[0];
      if(/error loading conversations|unable to load conversations|加载会话.*失败|会话.*加载失败/i.test(scope.textContent||''))
        throw new Error('网站会话列表加载失败，未执行任何删除。');
      return {nav,scope,toggle};
    }
    if(toggle){
      const parent=toggle.closest('[class*="accordion"],[class*="component_3kb6b"]');
      if(parent && parent.querySelector('[class*="expandCollapse"]')
          && ![...parent.querySelectorAll('button[aria-label]')]
            .some(b=>b!==toggle && /^(Projects|Writings|项目|写作)$/i.test(b.getAttribute('aria-label')||''))) {
        if(/error loading conversations|unable to load conversations/i.test(parent.textContent||''))
          throw new Error('网站会话列表加载失败，未执行任何删除。');
        return {nav,scope:parent,toggle};
      }
    }
    throw new Error('没有找到可核验的 Conversations 列表；请展开侧栏并刷新。未执行删除。');
  }

  function visibleHistoryAnchors(scope) {
    const found = new Map();
    for (const a of scope.querySelectorAll('a[href]')) {
      const item = historyIdentity(a);
      if (item && !found.has(item.id)) found.set(item.id,{...item,anchor:a});
    }
    return [...found.values()];
  }

  function historyListMore(scope) {
    const pattern = /^(?:load more(?: conversations)?|show more(?: conversations)?|view (?:more|all)(?: conversations)?|see (?:more|all)(?: conversations)?|load older(?: conversations)?|show older(?: conversations)?|older conversations|加载更多(?:会话)?|查看更多(?:会话)?|更多会话|显示更多(?:会话)?|查看全部(?:会话)?)$/i;
    const nav=document.querySelector('[data-testid="left-panel-nav"]');
    const scopes=[scope];
    // Real and simulated lazy lists place Load More just after the <ul>,
    // not inside it. Include only an immediate, section-local parent.
    const parent=scope?.parentElement;
    if(parent && parent!==nav && ![...parent.querySelectorAll('button[aria-label]')]
      .some(b=>/^(Projects|Writings|项目|写作)$/i.test((b.getAttribute('aria-label')||'').trim()))) {
      scopes.push(parent);
    }
    for (const root of scopes) {
      const matches=[...root.querySelectorAll('button,[role="button"],a')]
        .filter(el=>historyVisible(el)&&pattern.test((el.getAttribute('aria-label')||el.textContent||'').replace(/\s+/g,' ').trim()));
      if(matches.length===1) return matches[0];
      if(matches.length>1) return null; // Ambiguous; never click unrelated controls.
    }
    return null;
  }

  function historyScroller(scope,nav) {
    const ancestors=[];
    for(let p=scope?.parentElement;p&&p!==nav;p=p.parentElement) ancestors.push(p);
    // Current LeapSpace uses a sidebar scroll container above the accordion;
    // older versions have a list-local scroller within Conversations.
    for (const node of [scope,...Array.from(scope.querySelectorAll('*')).slice(0,80),...ancestors,nav]) {
      if (!node || node.scrollHeight <= node.clientHeight + 20) continue;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
      if (!style || /auto|scroll|overlay/i.test(style.overflowY)) return node;
    }
    return null;
  }

  const historyDelay = (ms,signal) => new Promise((resolve,reject) => {
    if (signal?.aborted) return reject(new Error('操作已停止。'));
    const waitMs=window.__LS_MD_EXPORT_TEST__===true ? Math.min(ms,12) : ms;
    const timer=setTimeout(() => {signal?.removeEventListener('abort',onAbort);resolve();},waitMs);
    function onAbort(){clearTimeout(timer);reject(new Error('操作已停止。'));}
    signal?.addEventListener('abort',onAbort,{once:true});
  });

  // Safe diagnostic breadcrumbs: no conversation titles, IDs, URL tokens or cookies.
  function historyTrace(stage, step, total, detail='') {
    console.info('[LeapSpace cleanup]', {version:VERSION, stage, step, total, detail});
  }

  async function historySnapshot(mode,count,progress,signal) {
    if (!/^\/(?:leapspace|researcher-ai)(?:\/|$)/.test(location.pathname)) throw new Error('请先打开 LeapSpace。');
    if (mode !== 'recent' && mode !== 'all') throw new Error('未知清理范围。');
    const target = mode === 'recent' ? Math.min(500,Math.max(1,Math.floor(Number(count)||50))) : HISTORY_LIMIT;
    let initialNav = document.querySelector('[data-testid="left-panel-nav"]')
      || document.querySelector('nav[aria-label="Left Panel"]:not([data-testid="nav-bar"])');
    if (!initialNav || initialNav.getAttribute('aria-hidden') === 'true') {
      const openBtn = document.querySelector('#open-navigation-panel-button')
        || [...document.querySelectorAll('button')].find(b => /^(?:Toggle sidebar|Open sidebar)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
      if (openBtn) {
        progress?.('正在展开左侧栏…');
        openBtn.click();
        await historyDelay(300, signal);
      }
    }
    let {nav,scope,toggle} = historyScope();
    // Expand only the Conversations accordion, not the global sidebar.
    if (toggle?.getAttribute('aria-expanded')==='false') {
      progress?.('正在展开 Conversations 列表…');
      toggle.click();
      await historyDelay(220,signal);
      ({nav,scope,toggle}=historyScope());
    }
    const originalScroll = historyScroller(scope,nav);
    const scrollStart = originalScroll?.scrollTop || 0;
    const seen = new Map();
    let idle = 0, complete = false, capped = false;
    for(let step=0;step<140;step++) {
      if (signal?.aborted) throw new Error('已取消扫描。');
      const {nav:liveNav,scope:liveScope}=historyScope();
      for (const item of visibleHistoryAnchors(liveScope)) if (!seen.has(item.id)) seen.set(item.id,{id:item.id,href:item.href,title:item.title});
      progress?.('找到 '+seen.size+' 条会话，正在核对列表…');
      if (mode==='recent' && seen.size>=target) {complete=true;break;}
      if(seen.size>=HISTORY_LIMIT) {capped=true;break;}
      const more=historyListMore(liveScope);
      const scroller=historyScroller(liveScope,liveNav);
      let moved=false;
      if (more) {more.click();moved=true;}
      else if (scroller) {
        const before=scroller.scrollTop;
        scroller.scrollTop=Math.min(scroller.scrollHeight,scroller.scrollTop+Math.max(350,scroller.clientHeight*.8));
        moved=scroller.scrollTop>before+2;
      }
      if (!moved) idle++; else idle=0;
      if (idle>=3) {complete=true;break;}
      await historyDelay(more ? 270 : 160,signal);
    }
    if (originalScroll?.isConnected) originalScroll.scrollTop=scrollStart;
    const rows=[...seen.values()];
    if (!rows.length) throw new Error('未找到可识别的会话链接，未执行删除。');
    const selected=mode==='recent' ? rows.slice(0,target) : rows;
    const incomplete=mode==='all' && (!complete || capped || !!historyListMore(historyScope().scope));
    if (incomplete) throw new Error('“全部”范围尚未完整加载（已识别至少 '+seen.size+' 条），为避免漏删已停止。');
    if (mode==='recent' && selected.length<target && !complete) throw new Error('未完整读取最近 '+target+' 条会话，未删除。');
    return {mode,requested:target,items:selected,available:rows.length,complete:complete && !capped};
  }

  function historyRow(anchor,nav) {
    for (let parent=anchor?.parentElement,depth=0;parent && parent!==nav && depth<9;parent=parent.parentElement,depth++) {
      const count=visibleHistoryAnchors(parent).length;
      if (count!==1) continue;
      if (parent.matches('li,[role="listitem"],[data-testid*="conversation-item"],[class*="conversationItem"]')) return parent;
      if (parent.querySelector('button,[role="button"]')) return parent;
    }
    return null;
  }

  function historyRowById(id) {
    try {
      const {nav,scope}=historyScope(true);
      const item=visibleHistoryAnchors(scope).find(it=>it.id===id);
      return item ? historyRow(item.anchor,nav) : null;
    } catch {
      return null;
    }
  }

  async function historyFindRow(id,signal) {
    let row=historyRowById(id);
    if (row) return row;
    const {nav,scope}=historyScope();
    const scroller=historyScroller(scope,nav);
    if (scroller) scroller.scrollTop=0;
    for(let i=0;i<75;i++) {
      await historyDelay(150,signal);
      row=historyRowById(id);
      if(row) return row;
      const {nav:liveNav,scope:liveScope}=historyScope();
      const more=historyListMore(liveScope);
      const s=historyScroller(liveScope,liveNav);
      if(more) more.click();
      else if(s && s.scrollTop+s.clientHeight<s.scrollHeight-5) s.scrollTop=Math.min(s.scrollHeight,s.scrollTop+Math.max(350,s.clientHeight*.8));
      else break;
    }
    return null;
  }

  function historyAccessibleName(node) {
    return (node?.getAttribute?.('aria-label')||node?.getAttribute?.('title')||node?.textContent||'').replace(/\s+/g,' ').trim();
  }

  function historyVisible(node) {
    if (!node?.isConnected) return false;
    const style=getComputedStyle(node);
    return style.display!=='none' && style.visibility!=='hidden' && !!node.getClientRects().length;
  }

  function historyMenuControl(row) {
    const buttons=[...row.querySelectorAll('button,[role="button"]')];
    const identified=buttons.filter(b=>/more(?: options| actions)?|options|actions|ellipsis|更多|操作|菜单/i.test(historyAccessibleName(b))
      || b.getAttribute('aria-haspopup')==='menu' || /more|menu|options/i.test(b.getAttribute('data-testid')||''));
    // Destructive actions must be attached to an explicitly identified menu control.
    // Never guess that an unlabeled icon represents an action menu.
    return identified.length===1 ? identified[0] : null;
  }

  function historyDeleteAction(previouslyVisibleMenus) {
    // Never choose an unrelated, already-open context menu elsewhere on the page.
    const roots=[...document.querySelectorAll('[role="menu"],[data-radix-menu-content]')]
      .filter(root=>historyVisible(root) && !previouslyVisibleMenus.has(root));
    const nodes=roots.flatMap(root=>[...root.querySelectorAll('[role="menuitem"],button')]);
    const found=nodes.filter(el=>historyVisible(el) && /^(?:delete|delete conversation|remove conversation|删除|删除对话|删除会话)$/i.test(historyAccessibleName(el)));
    return found.length===1 ? found[0] : null;
  }

  function historyConfirmation() {
    const dialogs=[...document.querySelectorAll('[role="alertdialog"],[role="dialog"]')].filter(d=>!d.closest('#'+APP_ID) && historyVisible(d)
      && /delete|remove|删除/i.test(d.textContent||''));
    if(!dialogs.length) return null;
    const d=dialogs[dialogs.length - 1];
    const acts=[...d.querySelectorAll('button,[role="button"]')].filter(b=>historyVisible(b)
      && /^(?:delete|delete conversation|yes, delete|confirm delete|删除|确认删除)$/i.test(historyAccessibleName(b)));
    return acts.length===1 ? acts[0] : null;
  }

  async function historyDeleteRowNode(row,item,signal) {
    row.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
    await historyDelay(window.__LS_MD_EXPORT_TEST__ ? 10 : 80,signal);
    const control=historyMenuControl(row);
    if (!control) throw new Error('当前页面未识别会话操作菜单；没有删除任何新的条目。');
    const existingMenus=new Set([...document.querySelectorAll('[role="menu"],[data-radix-menu-content]')].filter(historyVisible));
    const originalStyle=control.getAttribute('style');
    let action=null;
    try {
      if (!historyVisible(control)) {
        control.style.setProperty('display','inline-flex','important');
        control.style.setProperty('opacity','1','important');
        control.style.setProperty('pointer-events','auto','important');
      }
      control.click();
      for (let attempt = 0; attempt < 10; attempt++) {
        action = historyDeleteAction(existingMenus);
        if (action) break;
        if (attempt === 1 && control.getAttribute('aria-expanded') !== 'true') {
          control.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1}));
          control.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,composed:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:0}));
        }
        await historyDelay(window.__LS_MD_EXPORT_TEST__ ? 10 : 90, signal);
      }
      if(!action) throw new Error('未找到唯一的“删除会话”操作，已中止，不会猜测按钮。');
      action.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1}));
      action.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,composed:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:0}));
      action.click();
      // Genuine DOM click already dispatches through React delegated listeners.
      // Do not invoke React internals again (double mutation risk).

      // Explicitly wait for the confirmation modal to mount and stabilize before proceeding
      let conf = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        conf = historyConfirmation();
        if (conf) break;
        await historyDelay(window.__LS_MD_EXPORT_TEST__ ? 10 : 100, signal);
      }
      if (!conf) throw new Error('未弹出删除确认窗口，已停止。');
      // Brief pause to allow the modal's entry CSS transition and focus trap to settle
      await historyDelay(window.__LS_MD_EXPORT_TEST__ ? 10 : 180, signal);
    } finally {
      if (originalStyle===null) control.removeAttribute('style');
      else control.setAttribute('style',originalStyle);
    }

    const activeId = location.pathname.match(HISTORY_ITEM_RE)?.[1] || '';
    let deleted = false;
    let confirmationSent = false;
    for (let tick = 0; tick < 60; tick++) {
      if (confirmationSent && (!historyRowById(item.id) || (item.id === activeId && !location.pathname.includes(item.id)))) {
        deleted = true;
        break;
      }
      if (signal?.aborted) throw new Error('操作已停止。');

      const liveConf = historyConfirmation();
      if (liveConf && !confirmationSent) {
          liveConf.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1}));
          liveConf.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,composed:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:0}));
          liveConf.click();
          confirmationSent = true;
          // At-most-once: do not re-click while site mutation is in flight.
          if (!historyRowById(item.id)) {deleted=true;break;}
      }

      await historyDelay(window.__LS_MD_EXPORT_TEST__ ? 12 : 160, signal);
    }

    if (!deleted && confirmationSent && (!historyRowById(item.id) || (item.id === activeId && !location.pathname.includes(item.id)))) {
      deleted = true;
    }
    if (!deleted) throw new Error('删除确认已至多提交一次，但 10 秒内未确认列表变化，结果未知；勿自动重试该项。');
  }

  async function historyDeleteOne(item,signal) {
    const row=await historyFindRow(item.id,signal);
    if (!row) throw new Error('未找到原定会话“'+(item.title||item.id)+'”；停止，避免误删其他会话。');
    const current=visibleHistoryAnchors(row).find(a=>a.id===item.id);
    if(!current) throw new Error('会话身份变化，停止删除。');
    return historyDeleteRowNode(row,item,signal);
  }

  async function historyWaitIdle(signal) {
    for (let tick=0;tick<75;tick++) {
      if (signal?.aborted) throw new Error('操作已停止。');
      const blockingOverlay=[...document.querySelectorAll('div[class*="_modal-overlay_"],div[class*="_overlay-background_"]')]
        .some(el=>historyVisible(el) && Number(getComputedStyle(el).opacity || 1)>0.05);
      const openMenu=[...document.querySelectorAll('[role="menu"],[data-radix-menu-content]')].some(historyVisible);
      if (!historyConfirmation() && !blockingOverlay && !openMenu) return;
      await historyDelay(window.__LS_MD_EXPORT_TEST__ ? 10 : 160,signal);
    }
    throw new Error('网站上一条操作的弹窗或遮罩仍未退出，暂停以免点击到错误会话。');
  }

  async function historyExecute(plan,progress,signal) {
    if (!plan?.items?.length || !['recent','all'].includes(plan.mode)) throw new Error('没有有效的预览清单。');
    const targetCount = plan.items.length;
    // Immutable target identity, not live list index. New chats, sort changes,
    // or React re-rendering must never change which conversations are deleted.
    const frozen=plan.items.map(item=>({id:item.id,href:item.href,title:item.title}));
    if (frozen.some(item=>!item.id || !HISTORY_ITEM_RE.test(item.href||'')) || new Set(frozen.map(item=>item.id)).size!==targetCount)
      throw new Error('预览清单的会话身份不完整或重复，拒绝删除。');

    // If currently inside a specific conversation, navigate to blank /leapspace
    // to prevent conversation removal from triggering SPA unmount/redirection.
    if (/^\/(?:leapspace|researcher-ai)\/conversation\//i.test(location.pathname)) {
      const newChatBtn = document.querySelector('a[href="/leapspace"]')
        || [...document.querySelectorAll('a,button')].find(b => /^(?:New conversation|新对话|新建会话)$/i.test((b.textContent || b.getAttribute('aria-label') || '').trim()));
      if (newChatBtn) {
        newChatBtn.click();
        await historyDelay(window.__LS_MD_EXPORT_TEST__ ? 20 : 350, signal);
      }
    }

    let completed = 0;
    for (let step = 0; step < targetCount; step++) {
      if (signal?.aborted) return {completed, total: targetCount, stopped: true};
      const target=frozen[step];
      historyTrace('locating',step+1,targetCount);
      try {
        await historyWaitIdle(signal);
        await historyDeleteOne(target,signal);
      } catch (err) {
        if (signal?.aborted) return {completed, total: targetCount, stopped: true};
        historyTrace('halted',step+1,targetCount,'open the cleaner panel for the error');
        return {completed, total: targetCount, stopped: true,
          error:'第 '+(step+1)+' 条未能完成核验：'+String(err?.message || err)};
      }
      completed++;
      historyTrace('verified',completed,targetCount);
      progress?.(completed, targetCount, target);
      if (signal?.aborted) return {completed, total: targetCount, stopped: true};
      try {
        // Count a verified deletion before checking whether its popup faded.
        await historyWaitIdle(signal);
        await historyDelay(window.__LS_MD_EXPORT_TEST__ ? 15 : 1500, signal);
      } catch (err) {
        return {completed, total: targetCount, stopped: true,
          error: signal?.aborted ? '' : String(err?.message||err)};
      }
    }
    return {completed, total: targetCount, stopped: false};
  }

  // Minimal panel: one primary action and an optional preferences popover.
  // Preferences contain only non-sensitive booleans; no conversation data is stored.
  const SETTINGS_KEY = 'ls-academic-md-exporter.preferences.v1';
  const DEFAULT_PREFS = Object.freeze({scroll:true, refs:true, abstracts:true, compact:true, yaml:false});

  function readPreferences() {
    let raw = null;
    try {
      if (typeof GM_getValue === 'function') raw = GM_getValue(SETTINGS_KEY, null);
    } catch { /* Userscript storage may be unavailable. */ }
    if (raw == null) {
      try { raw = localStorage.getItem(SETTINGS_KEY); } catch { /* Ignore blocked storage. */ }
    }
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const result = {...DEFAULT_PREFS};
      if (obj && typeof obj === 'object') {
        for (const key of Object.keys(DEFAULT_PREFS)) {
          if (typeof obj[key] === 'boolean') result[key] = obj[key];
        }
      }
      return result;
    } catch { return {...DEFAULT_PREFS}; }
  }

  function savePreferences(value) {
    const safe = {};
    for (const key of Object.keys(DEFAULT_PREFS)) safe[key] = Boolean(value[key]);
    const payload = JSON.stringify(safe);
    try { if (typeof GM_setValue === 'function') GM_setValue(SETTINGS_KEY, payload); } catch { /* Fallback follows. */ }
    try { localStorage.setItem(SETTINGS_KEY, payload); } catch { /* Browsers may block localStorage. */ }
  }

  function createPanel() {
    if (document.getElementById(APP_ID)) return;
    const el = document.createElement('section');
    el.id = APP_ID;
    el.setAttribute('aria-label', 'Markdown 导出工具');
    el.innerHTML = `
<style>
#${APP_ID}{position:fixed;right:17px;bottom:18px;z-index:2147483638;width:max-content;max-width:calc(100vw - 22px);box-sizing:border-box;color:#263345;font:12px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
#${APP_ID} *{box-sizing:border-box}#${APP_ID} button,#${APP_ID} input{font:inherit}
#${APP_ID} .ls-bar{display:flex;align-items:center;gap:2px;border:1px solid #d7dee6;border-radius:12px;padding:3px;background:#fff;box-shadow:0 3px 15px rgba(20,37,57,.11)}
#${APP_ID} button{border:0;outline:0;background:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}
#${APP_ID} .ls-download{border-radius:8px;height:33px;gap:6px;padding:0 13px;background:#244b66;color:#fff;font-size:12px;font-weight:600;letter-spacing:.1px}
#${APP_ID} .ls-download:hover{background:#183e57}#${APP_ID} .ls-download:disabled{opacity:.58;cursor:wait}
#${APP_ID} .ls-settings-btn{border-radius:8px;width:32px;height:33px;color:#64748b}
#${APP_ID} .ls-settings-btn:hover,#${APP_ID} .ls-settings-btn[aria-expanded=true]{background:#eef3f7;color:#264861}
#${APP_ID} button:focus-visible,#${APP_ID} input:focus-visible{outline:2px solid #4384ab;outline-offset:2px}
#${APP_ID} .ls-icon{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
#${APP_ID} .ls-settings{position:absolute;bottom:calc(100% + 9px);right:0;width:226px;max-width:calc(100vw - 22px);padding:12px;background:#fff;border:1px solid #d7dee6;border-radius:12px;box-shadow:0 10px 35px rgba(26,46,66,.16)}
#${APP_ID} .ls-settings[hidden],#${APP_ID} .ls-toast[hidden]{display:none!important}
#${APP_ID} .ls-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;font-size:12px;font-weight:700;color:#263345}
#${APP_ID} .ls-reset{color:#8a97a7!important;font-weight:400;font-size:11px!important;padding:3px 0!important}
#${APP_ID} .ls-reset:hover{color:#245273!important}
#${APP_ID} .ls-option{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 2px;cursor:pointer;color:#37475b;font-size:12px}
#${APP_ID} .ls-option:has(input:disabled){opacity:.45;cursor:default}
#${APP_ID} .ls-option input{margin:0;flex:none;appearance:none;-webkit-appearance:none;width:29px;height:17px;background:#c7d0db;border-radius:10px;position:relative;cursor:pointer;transition:background .12s}
#${APP_ID} .ls-option input:before{content:'';display:block;position:absolute;top:2px;left:2px;width:13px;height:13px;background:#fff;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.17);transition:transform .12s}
#${APP_ID} .ls-option input:checked{background:#265e80}#${APP_ID} .ls-option input:checked:before{transform:translateX(12px)}
#${APP_ID} .ls-option input:disabled{cursor:default}
#${APP_ID} .ls-settings-foot{border-top:1px solid #edf0f4;margin-top:7px;padding-top:10px;display:flex;align-items:center;justify-content:space-between}
#${APP_ID} .ls-history-entry{border-top:1px solid #edf0f4;margin-top:7px;padding-top:9px}
#${APP_ID} .ls-history-entry button{width:100%;justify-content:flex-start;padding:5px 2px;color:#a43435;font-weight:500;font-size:12px}
#${APP_ID} .ls-history-dialog{position:fixed;bottom:69px;right:17px;width:348px;max-width:calc(100vw - 22px);max-height:min(76vh,590px);overflow:auto;padding:13px;background:#fff;border:1px solid #d7dee6;border-radius:12px;box-shadow:0 10px 35px rgba(26,46,66,.17);color:#304155}
#${APP_ID} .ls-history-dialog[hidden]{display:none!important}
#${APP_ID} .ls-history-head{display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:13px;margin-bottom:9px}
#${APP_ID} .ls-history-close{font-size:19px!important;width:22px;height:22px;color:#768395}
#${APP_ID} .ls-history-choice{display:flex;align-items:center;gap:6px;padding:6px 0;font-size:12px}
#${APP_ID} .ls-history-choice input[type=number]{width:68px;padding:4px 5px;border:1px solid #cbd5e1;border-radius:6px;background:transparent;color:inherit}
#${APP_ID} .ls-history-info{color:#718096;font-size:11px;line-height:1.5;margin:6px 0}
#${APP_ID} .ls-history-status{font-size:11px;line-height:1.5;padding:6px 0;white-space:normal;overflow-wrap:anywhere}
#${APP_ID} .ls-history-status.error{color:#b42318}
#${APP_ID} .ls-history-preview-list{max-height:135px;overflow:auto;margin:6px 0;padding-left:19px;font-size:11px;color:#66758a}
#${APP_ID} .ls-history-preview-list li{padding:1px 0;overflow-wrap:anywhere}
#${APP_ID} .ls-history-ack,#${APP_ID} .ls-history-phrase{font-size:11px;display:flex;gap:6px;align-items:center;margin:8px 0}
#${APP_ID} .ls-history-phrase input{width:115px;min-width:0;padding:4px 6px;border:1px solid #d5dbe4;border-radius:6px;background:transparent;color:inherit}
#${APP_ID} .ls-history-actions{display:flex;align-items:center;gap:7px;margin-top:10px}
#${APP_ID} .ls-history-actions button{padding:7px 10px;border-radius:7px;border:1px solid #ccd4df;color:#34465c}
#${APP_ID} .ls-history-actions .ls-history-confirm{background:#a22b2b;color:#fff;border-color:#a22b2b}
#${APP_ID} .ls-history-actions button:disabled{opacity:.4;cursor:default}
#${APP_ID} .ls-history-actions [hidden],#${APP_ID} .ls-history-ack[hidden],#${APP_ID} .ls-history-phrase[hidden]{display:none!important}

#${APP_ID} .ls-copy{padding:4px 0!important;color:#255f80;font-weight:600}
#${APP_ID} .ls-copy:hover{text-decoration:underline}
#${APP_ID} .ls-note{font-size:10px;color:#9aa4b2}
#${APP_ID} .ls-toast{position:absolute;right:0;bottom:calc(100% + 9px);max-width:min(295px,calc(100vw - 22px));min-width:155px;background:#fff;border:1px solid #d7dee6;border-radius:9px;padding:8px 10px;box-shadow:0 4px 16px rgba(20,38,58,.12);font:11px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#496175;white-space:normal;overflow-wrap:anywhere}
#${APP_ID} .ls-toast.error{color:#b42318;border-color:#efb2ae}
#${APP_ID} .ls-toast.ok{color:#23513f}
@media(max-width:650px){#${APP_ID}{right:9px;bottom:10px}#${APP_ID} .ls-history-dialog{right:9px;bottom:61px}}
@media(prefers-color-scheme:dark){#${APP_ID} .ls-bar,#${APP_ID} .ls-settings,#${APP_ID} .ls-toast{background:#1e2631;border-color:#435163;box-shadow:0 5px 20px rgba(0,0,0,.3)}#${APP_ID} .ls-option,#${APP_ID} .ls-heading{color:#e4ebf3}#${APP_ID} .ls-download{background:#316581}#${APP_ID} .ls-download:hover{background:#427b9a}#${APP_ID} .ls-settings-btn{color:#bdc8d3}#${APP_ID} .ls-settings-btn:hover,#${APP_ID} .ls-settings-btn[aria-expanded=true]{background:#324558}#${APP_ID} .ls-settings-foot,#${APP_ID} .ls-history-entry{border-color:#46505f}#${APP_ID} .ls-history-dialog{background:#1e2631;border-color:#435163;color:#dce5ef}#${APP_ID} .ls-history-preview-list,#${APP_ID} .ls-history-info{color:#a5b4c5}#${APP_ID} .ls-copy{color:#9dccea}#${APP_ID} .ls-toast{color:#d3dce6}#${APP_ID} .ls-toast.ok{color:#9dd5b5}#${APP_ID} .ls-toast.error{color:#ffb3a8}}
</style>
<div class="ls-bar">
 <button type="button" class="ls-download" title="导出当前会话为 Markdown" aria-label="导出 Markdown">
 <svg class="ls-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/></svg>导出 MD</button>
 <button type="button" class="ls-settings-btn" aria-label="导出设置" aria-controls="${APP_ID}-settings" aria-expanded="false" title="设置">
 <svg class="ls-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M9 4v6M15 14v6"/></svg></button>
</div>
<div class="ls-settings" id="${APP_ID}-settings" role="group" aria-label="导出设置" hidden>
 <div class="ls-heading"><span>导出设置</span><button type="button" class="ls-reset">重置</button></div>
 <label class="ls-option"><span>完整对话</span><input type="checkbox" class="ls-scroll" data-pref="scroll" aria-label="加载完整对话"></label>
 <label class="ls-option"><span>参考文献</span><input type="checkbox" class="ls-refs" data-pref="refs" aria-label="导出参考文献"></label>
 <label class="ls-option"><span>论文摘要</span><input type="checkbox" class="ls-abstracts" data-pref="abstracts" aria-label="导出论文摘要"></label>
 <label class="ls-option"><span>精简链接</span><input type="checkbox" class="ls-compact" data-pref="compact" aria-label="精简参考文献链接"></label>
 <label class="ls-option"><span>YAML 元数据</span><input type="checkbox" class="ls-yaml" data-pref="yaml" aria-label="包含 YAML 元数据"></label>
 <div class="ls-settings-foot"><button type="button" class="ls-copy" title="复制当前对话为 Markdown">复制 MD</button><span class="ls-note">自动记住设置</span></div>
 <div class="ls-history-entry"><button type="button" class="ls-manage-history">清理聊天记录…</button></div>
</div>
<div class="ls-history-dialog" role="dialog" aria-label="管理 LeapSpace 聊天记录" hidden>
 <div class="ls-history-head"><span>清理聊天记录</span><button type="button" class="ls-history-close" aria-label="关闭清理">×</button></div>
 <label class="ls-history-choice"><input type="radio" name="ls-history-mode" value="recent" checked> 最近 <input class="ls-history-count" type="number" min="1" max="500" step="1" value="50" aria-label="删除最近几条"> 条</label>
 <label class="ls-history-choice"><input type="radio" name="ls-history-mode" value="all"> 全部可加载的会话</label>
 <div class="ls-history-info">按左侧会话列表由新到旧；先预览再删除。删除可能无法恢复，不使用隐藏接口。</div>
 <div class="ls-history-status" role="status" aria-live="polite">先检查待删范围。</div>
 <ol class="ls-history-preview-list"></ol>
 <label class="ls-history-ack" hidden><input type="checkbox" class="ls-history-ack-input"> 我理解记录删除后可能无法恢复</label>
 <label class="ls-history-phrase" hidden>输入“删除全部”<input type="text" class="ls-history-phrase-input" autocomplete="off"></label>
 <div class="ls-history-actions"><button type="button" class="ls-history-scan">预览</button><button type="button" class="ls-history-confirm" disabled>确认删除</button><button type="button" class="ls-history-stop" hidden>停止</button></div>
</div>
<div class="ls-toast" role="status" aria-live="polite" hidden></div>`;
    document.body.append(el);

    const settingsEl = el.querySelector('.ls-settings');
    const settingsBtn = el.querySelector('.ls-settings-btn');
    const toast = el.querySelector('.ls-toast');
    const buttons = el.querySelectorAll('.ls-download,.ls-copy');
    const prefs = readPreferences();
    const controls = Object.fromEntries(Object.keys(DEFAULT_PREFS).map(key => [key, el.querySelector(`[data-pref="${key}"]`)]));
    let busy = false;
    let toastTimer = null;

    const refreshSwitches = () => {
      for (const key of Object.keys(controls)) controls[key].checked = prefs[key];
      controls.abstracts.disabled = !prefs.refs;
    };
    const closeSettings = () => {
      settingsEl.hidden = true;
      settingsBtn.setAttribute('aria-expanded','false');
    };
    const openSettings = () => {
      if (historyRunning) return;
      if (!historyEl.hidden) closeHistory();
      if (!settingsEl.hidden) { closeSettings(); return; }
      toast.hidden = true;
      clearTimeout(toastTimer);
      settingsEl.hidden = false;
      settingsBtn.setAttribute('aria-expanded','true');
    };
    const notice = (msg, kind = '', duration = 0) => {
      clearTimeout(toastTimer);
      toast.className = 'ls-toast' + (kind ? ' ' + kind : '');
      toast.textContent = msg;
      toast.hidden = false;
      toast.title = msg;
      if (duration > 0) toastTimer = setTimeout(() => {toast.hidden = true;}, duration);
    };
    const report = msg => {
      const m = String(msg || '').match(/正在读取文献摘要：\s*(\d+)\/(\d+)，成功\s*(\d+)/);
      if (m) return notice(`摘要 ${m[1]}/${m[2]} · 已读取 ${m[3]}`);
      if (/正在扫描当前对话/.test(msg)) return notice('扫描完整对话…');
      if (/正在解析当前会话/.test(msg)) return notice('正在导出…');
      if (/已提取参考文献/.test(msg)) return notice(String(msg).replace('已提取参考文献','文献').replace('其中含摘要','摘要').replace(/\s*条/g, ''));
      const txt = String(msg || '处理中…');
      notice(txt.length > 85 ? txt.slice(0, 82) + '…' : txt);
    };


    // Destructive history controls are intentionally nested under Settings and
    // remain inert until the user previews, accepts the loss, and confirms.
    const historyEl=el.querySelector('.ls-history-dialog');
    const historyStatus=el.querySelector('.ls-history-status');
    const historyList=el.querySelector('.ls-history-preview-list');
    const historyCount=el.querySelector('.ls-history-count');
    const historyAck=el.querySelector('.ls-history-ack-input');
    const historyPhrase=el.querySelector('.ls-history-phrase-input');
    const historyConfirm=el.querySelector('.ls-history-confirm');
    const historyScanButton=el.querySelector('.ls-history-scan');
    const historyStopButton=el.querySelector('.ls-history-stop');
    let historyPlan=null, historyController=null, historyRunning=false;
    try {
      const value=typeof GM_getValue==='function' ? GM_getValue(HISTORY_COUNT_KEY,50) : localStorage.getItem(HISTORY_COUNT_KEY);
      const n=Number(value);
      if(Number.isInteger(n) && n>=1 && n<=500) historyCount.value=String(n);
    } catch {/* Count only; no private conversations are persisted. */}
    const historyMode=()=>el.querySelector('input[name="ls-history-mode"]:checked')?.value||'recent';
    const historyMessage=(msg,error=false)=>{
      historyStatus.textContent=msg;
      historyStatus.classList.toggle('error',Boolean(error));
    };
    const historyReady=()=> {
      historyConfirm.disabled=!historyPlan || historyRunning || !historyAck.checked ||
        (historyPlan.mode==='all' && historyPhrase.value.trim()!=='删除全部');
    };
    const invalidateHistory=()=>{
      if(historyRunning) return;
      historyPlan=null;
      historyList.replaceChildren();
      historyAck.checked=false;
      historyPhrase.value='';
      el.querySelector('.ls-history-ack').hidden=true;
      el.querySelector('.ls-history-phrase').hidden=true;
      historyMessage('先检查待删范围。');
      historyReady();
    };
    function closeHistory(){
      if(historyRunning) {
        historyController?.abort();
        historyMessage('正在停止。当前条目可能已提交删除，请等待核验…');
        return;
      }
      historyController?.abort();
      historyEl.hidden=true;
    }
    el.querySelector('.ls-manage-history').addEventListener('click',()=>{
      closeSettings();
      historyEl.hidden=false;
      invalidateHistory();
    });
    el.querySelector('.ls-history-close').addEventListener('click',closeHistory);
    for (const radio of el.querySelectorAll('input[name="ls-history-mode"]')) radio.addEventListener('change',invalidateHistory);
    historyCount.addEventListener('change',()=>{
      historyCount.value=String(Math.min(500,Math.max(1,Math.floor(Number(historyCount.value)||50))));
      try {if(typeof GM_setValue==='function') GM_setValue(HISTORY_COUNT_KEY,Number(historyCount.value));}
      catch {/* no-op */ }
      try {localStorage.setItem(HISTORY_COUNT_KEY,historyCount.value);}catch {/* no-op */}
      invalidateHistory();
    });
    historyAck.addEventListener('change',historyReady);
    historyPhrase.addEventListener('input',historyReady);
    historyStopButton.addEventListener('click',()=>{
      historyController?.abort();
      historyMessage('停止指令已发送；不会继续删除下一条。');
    });
    historyScanButton.addEventListener('click',async()=>{
      if (busy || historyRunning) return;
      busy=true;
      buttons.forEach(b=>b.disabled=true);
      historyScanButton.disabled=true;
      historyController=new AbortController();
      invalidateHistory();
      try{
        const mode=historyMode();
        const count=historyCount.value;
        historyPlan=await historySnapshot(mode,count,msg=>historyMessage(msg),historyController.signal);
        historyList.replaceChildren();
        historyPlan.items.slice(0,8).forEach((item,i)=>{
          const li=document.createElement('li');
          li.textContent=(i+1)+'. '+(item.title||'未命名会话');
          historyList.append(li);
        });
        if(historyPlan.items.length>8){
          const li=document.createElement('li');
          li.textContent='…另外 '+(historyPlan.items.length-8)+' 条';
          historyList.append(li);
        }
        historyMessage('待删除 '+historyPlan.items.length+' 条'+(mode==='all'?'（当前账户可完整读取的列表）':'（由新到旧）')+'。删除无法撤销。');
        el.querySelector('.ls-history-ack').hidden=false;
        el.querySelector('.ls-history-phrase').hidden=mode!=='all';
      }catch(err){
        historyMessage('扫描失败：'+String(err?.message||err),true);
        historyPlan=null;
      }finally{
        busy=false;
        buttons.forEach(b=>b.disabled=false);
        historyScanButton.disabled=false;
        historyReady();
      }
    });
    historyConfirm.addEventListener('click',async()=>{
      if (busy || !historyPlan || historyConfirm.disabled || !historyAck.checked) return;
      if(historyPlan.mode==='all' && historyPhrase.value.trim()!=='删除全部') return;
      const plan=historyPlan;
      const confirmation='将删除当前 LeapSpace 账号中预览的 '+plan.items.length+' 条聊天记录。删除可能不可恢复。确定继续？';
      if(!window.confirm(confirmation)) return;
      historyRunning=true;
      busy=true;
      historyController=new AbortController();
      buttons.forEach(b=>b.disabled=true);
      historyScanButton.disabled=true;
      historyConfirm.disabled=true;
      historyStopButton.hidden=false;
      let outcome;
      try{
        outcome=await historyExecute(plan,(done,total)=>{
          historyMessage('已确认删除 '+done+'/'+total+' 条。停止按钮只阻止后续条目。');
        },historyController.signal);
      }catch(err){
        outcome={completed:0,total:plan.items.length,stopped:true,error:String(err?.message||err)};
      }finally{
        historyRunning=false;
        busy=false;
        buttons.forEach(b=>b.disabled=false);
        historyStopButton.hidden=true;
        historyScanButton.disabled=false;
        // The preview is consumed. A new deletion always requires a fresh scan.
        historyPlan=null;
        historyAck.checked=false;
        historyConfirm.disabled=true;
      }
      const incomplete=outcome.stopped || outcome.completed!==outcome.total;
      historyMessage((incomplete?'已停止':'已完成')+'：已确认删除 '+outcome.completed+'/'+outcome.total+' 条。'+
        (outcome.error?' '+outcome.error:'')+' 如需继续请重新预览。',incomplete);
    });

    for (const key of Object.keys(controls)) {
      controls[key].addEventListener('change', () => {
        prefs[key] = controls[key].checked;
        controls.abstracts.disabled = !prefs.refs;
        savePreferences(prefs);
      });
    }
    el.querySelector('.ls-reset').addEventListener('click', () => {
      Object.assign(prefs, DEFAULT_PREFS);
      refreshSwitches();
      savePreferences(prefs);
    });
    settingsBtn.addEventListener('click', openSettings);
    const abort = new AbortController();
    // When a SPA unmounts/remounts the toolbar, discard previous global listeners.
    if (typeof window.__LS_MD_EXPORT_UI_DISPOSE__ === 'function') window.__LS_MD_EXPORT_UI_DISPOSE__();
    window.__LS_MD_EXPORT_UI_DISPOSE__ = () => {abort.abort();historyController?.abort();};
    document.addEventListener('pointerdown', e => {
      if (!el.contains(e.target) && !settingsEl.hidden) closeSettings();
      // Site-owned menu and confirmation portals live outside this toolbar.
      // Never abort a running cleanup because a pointer event occurs there.
      if (!el.contains(e.target) && !historyEl.hidden && !historyRunning && !busy) closeHistory();
    }, {signal:abort.signal});
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !historyEl.hidden) {closeHistory();settingsBtn.focus();return;}
      if (e.key === 'Escape' && !settingsEl.hidden) {closeSettings();settingsBtn.focus();}
    }, {signal:abort.signal});

    async function act(copy) {
      if (busy) return;
      busy = true;
      closeSettings();
      buttons.forEach(b => b.disabled = true);
      try {
        report('正在解析当前会话…');
        let turns = await scanCurrentConversation(prefs.scroll, report);
        if (!turns.length) throw new Error('未发现回答，请进入具体会话后重试。');
        const withRefs = prefs.refs;
        const withAbstracts = withRefs && prefs.abstracts;
        if (withRefs) turns = await enrichVisibleReferenceLists(turns, report, withAbstracts);
        const {markdown,title,refs,unresolved,abstractCount} = buildMarkdown(turns,withRefs,prefs.compact,withAbstracts,prefs.yaml);
        if (copy) {
          if (typeof GM_setClipboard === 'function') GM_setClipboard(markdown,'text');
          else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(markdown);
          else throw new Error('剪贴板不可用，请直接下载 MD。');
        } else download(markdown, safeFilename(title));
        const warning = unresolved ? ` · 未匹配引用 ${unresolved}` : '';
        notice(`${copy ? '已复制' : '已触发下载'} · ${turns.length} 段 · ${refs} 篇文献${withAbstracts ? ' · ' + abstractCount + ' 篇摘要' : ''}${warning}`, 'ok', 6500);
      } catch (err) {
        const error = String(err?.message || err);
        notice('导出失败：' + error, 'error', 12000);
      } finally {
        busy = false;
        buttons.forEach(b => b.disabled = false);
      }
    }
    el.querySelector('.ls-download').addEventListener('click', () => act(false));
    el.querySelector('.ls-copy').addEventListener('click', () => act(true));
    refreshSwitches();
  }

  function mountWhenReady() {
    if (!/\/(leapspace|researcher-ai)(\/|$|\?)/.test(location.pathname) && window.__LS_MD_EXPORT_TEST__ !== true) return;
    if (document.body) createPanel();
    else document.addEventListener('DOMContentLoaded', createPanel, {once: true});
  }
  mountWhenReady();
  // SPA route changes may retain the same document and unmount the toolbar.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; mountWhenReady(); }
  }, 2000);

  // Test-only exposure: inert on real pages; no access to secrets or network.
  if (typeof window !== 'undefined' && window.__LS_MD_EXPORT_TEST__ === true) {
    window.__LS_MD_EXPORT_API__ = {snapshot, buildMarkdown, safeFilename, tableMd, inline, getAnswers, readReferences, readAbstract, expandAbstracts, safeUrl, cleanUiText, scanCurrentConversation, academicReference, globalBibliography, formatOutline, displayTitle, readPreferences, savePreferences, historyIdentity, visibleHistoryAnchors, historyScope, historySnapshot, historyRow, historyMenuControl, historyDeleteAction, historyConfirmation, historyDeleteOne, historyExecute};
  }
})();
