/* pi board — canvas client. Cards arrive from the extension over server-sent events. */
(function () {
  "use strict";

  const world = document.getElementById("world");
  const viewport = document.getElementById("viewport");
  // `overflow: clip` keeps the viewport out of the scroll containers, but an engine that ignores
  // it (and falls back to `hidden`) would still scroll when the composer or an editor takes
  // focus, leaving the pan state behind. Zeroing the offset holds the invariant on every engine.
  viewport.addEventListener("scroll", () => {
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
  });
  const emptyHint = document.getElementById("empty");
  const live = document.getElementById("live");
  const liveText = document.getElementById("liveText");
  const liveClock = document.getElementById("liveClock");
  const resetBtn = document.getElementById("reset");
  const token = new URLSearchParams(location.search).get("token") || "";

  // Kept in step with the code font size in index.html: 13px text, 20px rows.
  const LINE_HEIGHT = 20;
  const GUTTER = 56;
  const view = { x: 0, y: 0, k: 1 };
  const cards = [];
  const byId = new Map();
  let z = 1;
  const occupied = [];
  let sawFirstCard = false;
  /** The card the composer is currently replying into, or null for a fresh message. */
  let replyTarget = null;
  // A snapshot is what is already on the board, so nothing in it is new to the reader.
  let replaying = false;
  // Only the first snapshot of a session frames the board: a reconnect restores cards the human
  // already arranged, so it must leave the view exactly where they left it.
  let framedView = false;
  let freshCount = 0;

  const GAP = 18;
  const STEP = 24;

  // Cards are sized in columns rather than pixels: code reads best at 120 monospace
  // columns, prose at 80. Both are measured from the fonts actually in use.
  const SOURCE_COLS = 120;
  const NOTE_COLS = 90;
  let charWidths;

  function measureCharWidths() {
    if (charWidths) return charWidths;
    const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const probe = (font, text) => {
      const span = document.createElement("span");
      span.style.cssText = `position:absolute;left:-9999px;top:0;white-space:pre;font:${font}`;
      span.textContent = text;
      document.body.appendChild(span);
      const perChar = span.getBoundingClientRect().width / text.length;
      span.remove();
      return perChar;
    };
    const prose = "the quick brown fox jumps over a lazy dog, then writes another long line of ordinary prose";
    charWidths = {
      mono: probe(`13px ${cssVar("--mono")}`, "M".repeat(100)),
      prose: probe(getComputedStyle(document.body).font || "13px system-ui, sans-serif", prose),
    };
    return charWidths;
  }

  /** Default width: gutter, text padding and borders included, so the columns really fit. */
  function defaultWidth(kind) {
    const widths = measureCharWidths();
    if (kind === "source") return Math.round(52 + 24 + 2 + widths.mono * SOURCE_COLS);
    if (kind === "question") return 460;
    return Math.round(24 + 2 + widths.prose * NOTE_COLS);
  }

  const overlaps = (a, b) =>
    a.x < b.x + b.w + GAP && a.x + a.w + GAP > b.x && a.y < b.y + b.h + GAP && a.y + a.h + GAP > b.y;

  /** Closest free spot to an anchor, searched outward in rings. The board owns placement, never the agent. */
  function findFreeSpot(w, h, anchor) {
    const ax = anchor ? anchor.x : 60;
    const ay = anchor ? anchor.y : 60;
    let best = null;
    let bestScore = Infinity;
    for (let ring = 0; ring < 60; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const x = Math.round((ax + dx * STEP) / STEP) * STEP;
          const y = Math.round((ay + dy * STEP) / STEP) * STEP;
          if (x < 0 || y < 0) continue;
          const rect = { x, y, w, h };
          if (occupied.some((other) => overlaps(rect, other))) continue;
          const score = Math.hypot(x - ax, y - ay);
          if (score < bestScore) {
            bestScore = score;
            best = rect;
          }
        }
      }
      if (best) return best;
    }
    // Every ring was searched and none was free: put the card clear of the whole board, right of
    // the rightmost card and level with the highest one, instead of stacking it on the card that
    // already sits at the anchor.
    const right = occupied.reduce((far, spot) => Math.max(far, spot.x + spot.w), -Infinity);
    const top = occupied.reduce((high, spot) => Math.min(high, spot.y), Infinity);
    // Nothing placed yet (or nothing with a positive edge): the anchor is the whole board.
    if (right === -Infinity || top === Infinity) return { x: ax, y: ay, w, h };
    return { x: right + GAP, y: top, w, h };
  }

  const viewportCenter = () => ({
    x: (viewport.clientWidth / 2 - view.x) / view.k,
    y: (viewport.clientHeight / 2 - view.y) / view.k,
  });

  // ---------- helpers ------------------------------------------------------
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  /** The card dot's colour, in one place so the card and its rail row cannot drift apart. */
  const dotKind = (kind) => (kind === "source" ? "code" : kind === "question" ? "question" : "note");
  /**
   * The world is zoomed with the CSS `zoom` property, so text is laid out at the size it is
   * shown at and never softens the way a scaled bitmap does. `zoom` scales the element's own
   * offsets too, hence dividing the pan by the scale.
   */
  const ZOOM_SUPPORTED = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("zoom", "2");
  const applyView = () => {
    if (ZOOM_SUPPORTED) {
      world.style.zoom = view.k;
      world.style.left = `${view.x / view.k}px`;
      world.style.top = `${view.y / view.k}px`;
    } else {
      // Older browsers only have the bitmap scale, which softens text while it catches up.
      world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    }
    if (typeof recomputePill === "function") recomputePill();
    // The button says the zoom it is showing, not a fixed promise of 100%.
    resetBtn.textContent = `${Math.round(view.k * 100)}%`;
    // The board's zoom scales the focus ring drawn inside it too, so the rule in index.html
    // divides the ring by this to keep it the same thickness at every zoom.
    document.documentElement.style.setProperty("--zoom", String(view.k));
  };

  // ---------- syntax highlighting -----------------------------------------
  const TOKENS =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:[^`\\]|\\.)*`)|(#.*$|\/\/.*$)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*(?=\())|(\b(?:def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|with|lambda|yield|await|async|const|let|var|function|export|default|new|throw|catch|switch|case|break|continue|type|interface|struct|fn|pub|use|mod|match|impl|self|this|True|False|None|null|true|false|nil|end|do|then)\b)/g;

  function highlight(raw) {
    let out = "";
    let last = 0;
    for (const match of raw.matchAll(TOKENS)) {
      const [text] = match;
      out += escapeHtml(raw.slice(last, match.index));
      const cls = match[1] ? "s" : match[2] ? "c" : match[3] ? "n2" : match[4] ? "f" : "k";
      out += `<span class="${cls}">${escapeHtml(text)}</span>`;
      last = match.index + text.length;
    }
    out += escapeHtml(raw.slice(last));
    return out || "&nbsp;";
  }

  // ---------- markdown -----------------------------------------------------
  function inlineMd(text) {
    let out = escapeHtml(text);
    // Cross-references jump to another card, but a key inside inline code stays literal.
    out = out
      .split(/(`[^`]+`)/)
      .map((piece) =>
        piece.startsWith("`")
          ? piece
          : piece.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, key, label) => {
              const name = key.trim();
              return `<a class="xref" href="#" data-key="${name}" title="jump to ${name}">${(label || name).trim()}</a>`;
            }),
      )
      .join("");
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return out;
  }

  function sanitizeSvg(svg) {
    return svg
      .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "")
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript:/gi, "");
  }

  /** `|---|:--:|` under a header row is what makes the block above it a table. */
  function isTableRule(line) {
    return typeof line === "string" && line.includes("-") && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);
  }

  function tableCells(line) {
    return line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function renderTable(headerLine, ruleLine, bodyLines) {
    const wrap = el("div", "table-wrap");
    const table = el("table");
    const align = tableCells(ruleLine).map((spec) =>
      spec.startsWith(":") && spec.endsWith(":") ? "center" : spec.endsWith(":") ? "right" : spec.startsWith(":") ? "left" : "",
    );
    const head = el("thead");
    const headRow = el("tr");
    tableCells(headerLine).forEach((cell, column) => {
      const th = el("th");
      th.innerHTML = inlineMd(cell);
      if (align[column]) th.style.textAlign = align[column];
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    const body = el("tbody");
    for (const line of bodyLines) {
      const row = el("tr");
      const cells = tableCells(line);
      // Rows shorter than the header still line up, and extra cells are kept rather than lost.
      const width = Math.max(cells.length, headRow.childElementCount);
      for (let column = 0; column < width; column += 1) {
        const td = el("td");
        td.innerHTML = inlineMd(cells[column] ?? "");
        if (align[column]) td.style.textAlign = align[column];
        row.appendChild(td);
      }
      body.appendChild(row);
    }
    table.append(head, body);
    wrap.appendChild(table);
    return wrap;
  }

  function renderMarkdown(markdown) {
    const holder = el("div");
    const fences = [];
    let tickIndex = 0;
    const stripped = markdown.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, body) => {
      const index = fences.push({ lang: lang.toLowerCase(), body }) - 1;
      return `\u0000FENCE${index}\u0000`;
    });

    // A fence may follow text on the next single newline, so give every marker its own block.
    const spaced = stripped.replace(/(\u0000FENCE\d+\u0000)/g, "\n\n$1\n\n");
    for (const block of spaced.split(/\n{2,}/)) {
      const fenceTag = block.match(/^\u0000FENCE(\d+)\u0000$/);
      if (fenceTag) {
        const { lang, body } = fences[Number(fenceTag[1])];
        if (lang === "svg") {
          const wrap = el("div", "svg-wrap");
          wrap.innerHTML = sanitizeSvg(body);
          holder.appendChild(wrap);
        } else {
          const pre = el("pre");
          const code = el("code");
          code.textContent = body.replace(/\n$/, "");
          pre.appendChild(code);
          holder.appendChild(pre);
        }
        continue;
      }
      // Lines are walked one by one, so a list can be followed by a paragraph with no blank
      // line between them, which is what typing under a list produces.
      const lines = block.split("\n");
      let ul = null;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // A table is a header row, a separator row, then body rows until something else.
        // The separator needs a pipe of its own and must line up with the header, otherwise a
        // paragraph that ends in a pipe and is followed by `---` would become a table.
        if (
          /\|/.test(line) &&
          isTableRule(lines[index + 1]) &&
          lines[index + 1].includes("|") &&
          tableCells(line).length === tableCells(lines[index + 1]).length
        ) {
          const rows = [];
          let cursor = index + 2;
          while (cursor < lines.length && /\|/.test(lines[cursor])) rows.push(lines[cursor++]);
          holder.appendChild(renderTable(line, lines[index + 1], rows));
          ul = null;
          index = cursor - 1;
          continue;
        }
        const item = line.match(/^\s*[-*+]\s+(.*)$/);
        if (item) {
          if (!ul) {
            ul = el("ul");
            holder.appendChild(ul);
          }
          const li = el("li");
          const box = item[1].match(/^\[([ xX])\]\s*(.*)$/);
          li.innerHTML = box
            ? `<span class="tick" title="tick it">${box[1].trim() ? "☑" : "☐"}</span> ${inlineMd(box[2])}`
            : inlineMd(item[1]);
          if (box) li.dataset.tick = String(tickIndex++);
          ul.appendChild(li);
          continue;
        }
        ul = null;
        if (!line.trim()) continue;
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          // The level is kept up to h3: a deeper heading is as small as a card can show it.
          const h = el(`h${Math.min(heading[1].length, 3)}`);
          h.innerHTML = inlineMd(heading[2]);
          holder.appendChild(h);
          continue;
        }
        if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
          holder.appendChild(el("hr"));
          continue;
        }
        // `>` lines group into one quote; a bare `>` splits it into paragraphs.
        const quoted = line.match(/^\s*>\s?(.*)$/);
        if (quoted) {
          const pieces = [];
          let cursor = index;
          while (cursor < lines.length) {
            const next = lines[cursor].match(/^\s*>\s?(.*)$/);
            if (!next) break;
            pieces.push(next[1]);
            cursor += 1;
          }
          const quote = el("blockquote");
          const para = [];
          const flush = () => {
            if (!para.length) return;
            const p = el("p");
            p.innerHTML = inlineMd(para.join(" "));
            quote.appendChild(p);
            para.length = 0;
          };
          for (const piece of pieces) {
            if (piece.trim()) para.push(piece.trim());
            else flush();
          }
          flush();
          holder.appendChild(quote);
          ul = null;
          index = cursor - 1;
          continue;
        }
        const p = el("p");
        p.innerHTML = inlineMd(line);
        holder.appendChild(p);
      }
    }
    return holder;
  }

  // ---------- bodies -------------------------------------------------------
  /** Virtualized code view: only visible lines exist in the DOM. */
  function sourceBody(data) {
    const lines = data.content.split("\n");
    const scroll = el("div", "code-scroll");
    const inner = el("div", "code-inner");
    const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
    inner.style.height = `${lines.length * LINE_HEIGHT}px`;
    inner.style.width = `${GUTTER + Math.min(width, 260) * measureCharWidths().mono + 30}px`;
    scroll.appendChild(inner);

    let first = -1;
    let last = -1;
    const hit = data.line;

    const renderWindow = () => {
      const height = scroll.clientHeight || 320;
      const start = Math.max(0, Math.floor(scroll.scrollTop / LINE_HEIGHT) - 6);
      const end = Math.min(lines.length - 1, Math.ceil((scroll.scrollTop + height) / LINE_HEIGHT) + 6);
      if (start === first && end === last) return;
      first = start;
      last = end;
      const fragment = document.createDocumentFragment();
      for (let i = start; i <= end; i++) {
        const row = el("div", "row" + (hit === i + 1 ? " hit" : ""));
        row.style.top = `${i * LINE_HEIGHT}px`;
        row.innerHTML = `<span class="n">${i + 1}</span><span class="t">${highlight(lines[i])}</span>`;
        fragment.appendChild(row);
      }
      inner.replaceChildren(fragment);
    };

    let scheduled = false;
    scroll.addEventListener("scroll", () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        renderWindow();
      });
    });
    new ResizeObserver(() => renderWindow()).observe(scroll);
    renderWindow();
    requestAnimationFrame(() => {
      if (hit && hit > 0) {
        scroll.scrollTop = Math.max(0, (hit - 1) * LINE_HEIGHT - (scroll.clientHeight / 2 - LINE_HEIGHT / 2));
      }
      renderWindow();
    });
    return scroll;
  }

  function questionBody(data, entry) {
    // A question that ran out of time is as settled as an answered one: its buttons are dead and
    // the header says which of the two happened.
    const settled = data.status === "answered" || data.status === "expired";
    const holder = el("div", "q-body");
    const text = el("div", "q-text");
    text.innerHTML = inlineMd(data.question || "");
    holder.appendChild(text);

    // The arrival lands the keyboard here, so a focused option cannot answer on Space or Enter.
    const buttons = el("div", "q-options");
    buttons.tabIndex = -1;
    // Built before the options are wired: every answer path hands the row to submitAnswer, which
    // takes it out of the card while the send is in flight and puts it back if the send fails.
    let freeRow = null;
    if (data.allowFreeText && !settled) {
      freeRow = el("div", "q-free");
      const input = el("input");
      input.placeholder = "or type an answer…";
      const send = el("button", "q-opt");
      send.textContent = "send";
      const fire = () => {
        const value = input.value.trim();
        if (value) submitAnswer(entry, value, buttons, freeRow);
      };
      send.addEventListener("click", fire);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") fire();
      });
      freeRow.append(input, send);
    }

    for (const option of data.options || []) {
      const button = el("button", "q-opt");
      button.textContent = option;
      if (settled) {
        button.disabled = true;
        if (data.answer === option) button.classList.add("picked");
      } else {
        button.addEventListener("click", () => submitAnswer(entry, option, buttons, freeRow));
      }
      buttons.appendChild(button);
    }
    holder.appendChild(buttons);
    if (freeRow) holder.appendChild(freeRow);

    if (data.status === "answered") {
      const done = el("div", "q-done");
      done.textContent = `answered: ${data.answer || "—"}`;
      holder.appendChild(done);
    }
    return holder;
  }

  async function submitAnswer(entry, answer, buttons, freeRow) {
    buttons.querySelectorAll("button").forEach((button) => (button.disabled = true));
    if (freeRow) freeRow.remove();
    for (const button of buttons.querySelectorAll("button")) {
      if (button.textContent === answer) button.classList.add("picked");
    }
    let problem = "";
    try {
      const response = await fetch(`/answer?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: entry.id, answer }),
      });
      // A 409 means the question expired or another tab answered it, so nothing was delivered.
      if (!response.ok) problem = (await response.text()).trim() || "could not send — the question may have expired";
    } catch {
      problem = "could not reach the board server";
    }
    if (!problem) return;
    // The agent got nothing, so the card goes back to looking unanswered: a picked option and
    // dead buttons would read as sent.
    for (const button of buttons.querySelectorAll("button")) {
      button.disabled = false;
      button.classList.remove("picked");
    }
    if (freeRow) buttons.after(freeRow);
    const holder = buttons.parentElement;
    let warn = holder.querySelector(".q-done");
    if (!warn) {
      warn = el("div", "q-done");
      warn.setAttribute("role", "alert");
      holder.appendChild(warn);
    }
    // Styled as a failure, so it does not read as a muted "answered: …" line.
    warn.classList.add("q-problem");
    warn.textContent = problem;
  }

  /** One follow-up exchange: your question, what happened to it, then the answer. */
  function turnNode(turn) {
    const wrap = el("div", `turn ${turn.status || "queued"}`);
    const question = el("div", "turn-q");
    question.textContent = turn.text || "";
    wrap.appendChild(question);
    const status = el("div", `turn-status ${turn.status || "queued"}`);
    status.textContent =
      turn.status === "answered"
        ? "answered"
        : turn.status === "stopped"
          ? "stopped"
          : turn.status === "sent"
            ? "running"
            : `queued · ${turn.mode === "steer" ? "steer" : "queue"}`;
    wrap.appendChild(status);
    if (turn.images) {
      const shot = el("div", "turn-status");
      shot.textContent = `${turn.images} image${turn.images > 1 ? "s" : ""} attached`;
      wrap.appendChild(shot);
    }
    if (turn.reply) {
      const answer = el("div", "turn-a note-body");
      answer.appendChild(renderMarkdown(turn.reply));
      wrap.appendChild(answer);
    }
    return wrap;
  }

  /**
   * Follow-ups live in the card they are about, below its body, so asking again never pushes a
   * new card onto the canvas.
   */
  function paintThread(entry, data) {
    const turns = Array.isArray(data.turns) ? data.turns : [];
    const last = turns[turns.length - 1];
    // News is a turn that was not there before, or the last turn's answer landing; a thread the
    // card is created with is history. Either way it fires once per real answer.
    const seen = entry.threadSeen ?? { count: turns.length, answered: Boolean(last?.reply) };
    const fresh = turns.length > seen.count || (Boolean(last?.reply) && !seen.answered);
    entry.threadSeen = { count: turns.length, answered: Boolean(last?.reply) };
    entry.thread.hidden = turns.length === 0;
    entry.thread.replaceChildren(...turns.map(turnNode));
    if (!fresh) return;
    // The note above the thread can be taller than the card, so the answer would land below the
    // fold with nothing moving: the card's own column scrolls down to it.
    requestAnimationFrame(() => {
      entry.scroll.scrollTop = entry.scroll.scrollHeight;
    });
  }

  /** A message from the user, with the agent's answer attached once it arrives. */
  function stickyBody(data) {
    const holder = el("div", "sticky-body");
    const text = el("div", "sticky-text");
    text.textContent = data.text || "";
    holder.appendChild(text);
    if (data.images) {
      const shot = el("div", "sticky-status");
      shot.textContent = `${data.images} image${data.images > 1 ? "s" : ""} attached`;
      holder.appendChild(shot);
    }
    const status = el("div", `sticky-status ${data.status || "queued"}`);
    status.textContent =
      data.status === "answered"
        ? "answered"
        : data.status === "stopped"
          ? "stopped"
          : data.status === "sent"
            ? "delivered"
            : `queued · ${data.mode === "steer" ? "steer" : "queue"}`;
    holder.appendChild(status);
    if (data.reply) {
      const reply = el("div", "sticky-reply note-body");
      reply.appendChild(renderMarkdown(data.reply));
      holder.appendChild(reply);
    }
    return holder;
  }

  function bodyFor(data, entry) {
    if (data.type === "source") return { node: sourceBody(data), cls: "source-body" };
    if (data.type === "sticky") return { node: stickyBody(data), cls: "" };
    if (data.type === "question") return { node: questionBody(data, entry), cls: "" };
    return { node: renderMarkdown(data.markdown || ""), cls: "note-body" };
  }

  // ---------- cards --------------------------------------------------------
  /** Half a card on screen for this long is a card the human has had a chance to read. */
  const SEEN_MS = 1500;
  const seenTimers = new Map();
  /** Only the cards the observer last called on screen may start a countdown. */
  const inView = new Set();
  /** A ratio reported as an int can sit a hair under the threshold the card just crossed. */
  const RATIO_EPS = 0.01;

  function forgetSeen(card) {
    const timer = seenTimers.get(card);
    if (timer) clearTimeout(timer);
    seenTimers.delete(card);
  }

  function armSeen(card) {
    // A hidden tab is nobody looking, so it schedules nothing: visibilitychange starts over.
    if (document.hidden || seenTimers.has(card)) return;
    seenTimers.set(
      card,
      setTimeout(() => {
        seenTimers.delete(card);
        if (!document.hidden) clearFresh(card);
      }, SEEN_MS),
    );
  }

  /**
   * "New" has to expire on its own, or every card ends up wearing the same border and badge and
   * the mark stops meaning anything. The countdown belongs to the time the card is on screen: a
   * card scrolled away before it fires is still new when it comes back.
   */
  const seenObserver = new IntersectionObserver(
    (hits) => {
      for (const hit of hits) {
        // The root is the canvas, not the window: a card the rail or the bars clip is not in
        // front of the human even when it sits inside the window. Half of whichever is smaller,
        // so a card taller than the canvas still counts once half the canvas shows it.
        const half = Math.min(hit.boundingClientRect.height, viewport.clientHeight) * 0.5;
        const onScreen = hit.isIntersecting && (hit.intersectionRatio >= 0.5 - RATIO_EPS || hit.intersectionRect.height >= half);
        if (onScreen) {
          inView.add(hit.target);
          armSeen(hit.target);
        } else {
          inView.delete(hit.target);
          forgetSeen(hit.target);
        }
      }
      // The pill counts what the same rule does not call on screen, so the two cannot disagree.
      recomputePill();
    },
    { root: viewport, threshold: [0, 0.5] },
  );

  /**
   * The one place a card stops being new: the border, the badge, the rail row and the pill all
   * read .fresh, so they have to change together or the board contradicts itself.
   */
  function clearFresh(card) {
    if (!card || !card.classList.contains("fresh")) return;
    card.classList.remove("fresh");
    forgetSeen(card);
    inView.delete(card);
    seenObserver.unobserve(card);
    // Hidden, not removed: dropping the badge would shift the buttons under the pointer.
    const badge = card.querySelector(".new-badge");
    if (badge) badge.style.visibility = "hidden";
    syncRailCard(byId.get(card.dataset.id));
    recomputePill();
  }

  /** A delegate card reports its own progress, so it redraws far more often than a note. */
  function isDelegate(data) {
    return typeof data.key === "string" && data.key.startsWith("delegate-");
  }

  function makeCard(data, quiet = false) {
    const isSource = data.type === "source";
    const isQuestion = data.type === "question";
    const kind = data.type;
    const isNote = data.type === "note";
    const width = data.rect ? data.rect.w : defaultWidth(kind);
    // A delegate card opens small and grows as the run reports; a normal note wants the room.
    const delegate = isDelegate(data);
    const defaultHeight = isSource ? 430 : isQuestion ? 300 : isNote ? (delegate ? 220 : 420) : 300;
    const height = data.rect ? data.rect.h : defaultHeight;

    // The server remembers where a card was put, so a refresh and other tabs agree. A card
    // without a place goes in the nearest free area to the middle of what you are looking at.
    const spot = data.rect
      ? { x: data.rect.x, y: data.rect.y, w: width, h: height }
      : findFreeSpot(width, height, viewportCenter());
    occupied.push(spot);
    if (!data.rect) void saveLayout(data.id, spot);

    const card = el("div", kind === "sticky" ? "card sticky" : "card");
    card.style.cssText = `left:${spot.x}px; top:${spot.y}px; width:${width}px; height:${height}px; z-index:${z++}`;
    card.dataset.rect = JSON.stringify(spot);
    card.dataset.kind = kind;
    card.dataset.id = data.id;

    const head = el("div", "head");
    head.innerHTML = `
      <span class="dot ${dotKind(kind)}"></span>
      <span class="title"></span>
      <span class="sub"></span>
      <span class="spacer"></span>
      <button type="button" class="ask-pill" aria-label="centre this question">answer needed</button>
      <span class="chip"></span>
      <button class="min" title="minimize this card" aria-label="minimize this card">▾</button>
      <button class="reply" title="ask a follow-up about this card" aria-label="ask a follow-up about this card">↩</button>
      <button class="edit" title="edit this note" aria-label="edit this note">✎</button>
      <button class="close" title="close" aria-label="close">×</button>`;
    // One scroll column holds the note and its follow-ups, so a long card has one scrollbar.
    const scroll = el("div", "card-scroll");
    const body = el("div", "body");
    const thread = el("div", "thread");
    thread.hidden = true;
    scroll.append(body, thread);
    const grip = el("div", "resize");
    card.append(head, scroll, grip);
    world.appendChild(card);
    cards.push(card);

    const badge = el("span", "new-badge");
    // A restored card is one you already had, so it does not carry a "new" tag.
    if (replaying || quiet) badge.style.visibility = "hidden";
    badge.textContent = "new";
    head.insertBefore(badge, head.querySelector(".close"));
    if (!replaying) {
      card.classList.add("fresh");
      // Watched only while it can still stop being new.
      seenObserver.observe(card);
    }
    // A card the human clicks is seen at once, without waiting for the observer's countdown.
    card.addEventListener("pointerdown", () => clearFresh(card), true);

    const entry = {
      id: data.id,
      card,
      head,
      scroll,
      body,
      thread,
      titleEl: head.querySelector(".title"),
      subEl: head.querySelector(".sub"),
      chipEl: head.querySelector(".chip"),
      askPill: head.querySelector(".ask-pill"),
      data,
    };
    byId.set(data.id, entry);
    entry.askPill.addEventListener("click", (event) => {
      event.stopPropagation();
      centreQuestion(entry);
    });
    if (data.mini) setMini(card, true);
    paintCard(entry, data);

    card.addEventListener("pointerdown", () => {
      card.style.zIndex = z++;
      cards.forEach((c) => c.classList.toggle("active", c === card));
    }, true);

    // The keyboard and the mouse agree on which card is current: focus landing inside a card marks
    // it, so the outline, `r` and the digit keys follow the keyboard rather than the last click.
    card.addEventListener("focusin", (event) => {
      cards.forEach((c) => c.classList.toggle("active", c === card));
      reveal(event.target);
    });

    head.querySelector(".min").addEventListener("click", (event) => {
      event.stopPropagation();
      const mini = !card.classList.contains("mini");
      setMini(card, mini);
      const rect = JSON.parse(card.dataset.rect || "{}");
      void saveLayout(entry.id, rect, mini);
    });

    head.querySelector(".reply").addEventListener("click", (event) => {
      event.stopPropagation();
      setReplyTarget(entry);
    });

    head.querySelector(".edit").addEventListener("click", (event) => {
      event.stopPropagation();
      startEditing(entry);
    });

    head.querySelector(".close").addEventListener("click", (event) => {
      event.stopPropagation();
      dropCard(entry);
      // Closing has to reach the server, otherwise a refresh brings the card back.
      void fetch(`/close?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: entry.id }),
      }).catch(() => {});
    });

    head.addEventListener("pointerdown", (event) => {
      // Buttons in the header are for clicking, not for dragging the card.
      if (event.target.closest(".close, .edit, .reply, .min, .ask-pill")) return;
      event.preventDefault();
      card.classList.add("dragging");
      const sx = event.clientX;
      const sy = event.clientY;
      const ox = parseFloat(card.style.left);
      const oy = parseFloat(card.style.top);
      const move = (ev) => {
        card.style.left = `${ox + (ev.clientX - sx) / view.k}px`;
        card.style.top = `${oy + (ev.clientY - sy) / view.k}px`;
      };
      const up = () => {
        card.classList.remove("dragging");
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        const rect = {
          x: Math.round(parseFloat(card.style.left)),
          y: Math.round(parseFloat(card.style.top)),
          w: card.offsetWidth,
          h: card.offsetHeight,
        };
        placeCard(entry, rect);
        void saveLayout(entry.id, rect);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });

    grip.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      const sx = event.clientX;
      const sy = event.clientY;
      const ow = card.offsetWidth;
      const oh = card.offsetHeight;
      const move = (ev) => {
        card.style.width = `${Math.max(240, ow + (ev.clientX - sx) / view.k)}px`;
        card.style.height = `${Math.max(120, oh + (ev.clientY - sy) / view.k)}px`;
        // A size the user chose wins over growing to fit later answers.
        card.dataset.sized = "user";
        card.classList.remove("auto-height");
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        const rect = {
          x: Math.round(parseFloat(card.style.left)),
          y: Math.round(parseFloat(card.style.top)),
          w: card.offsetWidth,
          h: card.offsetHeight,
        };
        placeCard(entry, rect);
        void saveLayout(entry.id, rect);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });

    updateEmpty();
    return entry;
  }

  /** The agent is blocked on this card until the question on it is answered. */
  function questionWants(data) {
    return Boolean(data) && data.type === "question" && data.status === "open";
  }

  /** A note says when it arrived, or when it last changed once it has changed. */
  function noteSub(data, entry) {
    if (!entry.updatedAt) return new Date(data.at || Date.now()).toLocaleTimeString();
    // Hours and minutes only: a card repainted on every run step must not flicker as seconds tick.
    return `updated ${new Date(entry.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  /**
   * An open question says when it gives up, so the wait has a visible end. A settled one says
   * what actually happened: an answer, or a question the board abandoned.
   */
  function questionSub(data) {
    if (data.status === "answered") return "answered";
    if (data.status === "expired") return "expired — no answer sent";
    if (!data.expiresAt) return "waiting for you";
    return `expires ${new Date(data.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  function paintCard(entry, data) {
    const isSource = data.type === "source";
    const isOpenQuestion = questionWants(data);
    entry.data = data;
    if (entry.editing) return;
    entry.titleEl.textContent =
      data.title || (isSource ? data.path : data.type === "question" ? "question" : data.type === "sticky" ? "you" : "note");
    entry.titleEl.title = entry.titleEl.textContent;
    entry.subEl.textContent = isSource
      ? `${data.content.split("\n").length} lines`
      : data.type === "question"
        ? questionSub(data)
        : data.type === "sticky"
          ? data.status || "queued"
          : noteSub(data, entry);
    entry.subEl.classList.toggle("expired", data.type === "question" && data.status === "expired");
    // The pink ring and the pill belong to the question the agent is blocked on, so both go
    // away the moment it is settled.
    entry.card.classList.toggle("waiting", isOpenQuestion);
    entry.askPill.style.display = isOpenQuestion ? "" : "none";
    const editBtn = entry.head.querySelector(".edit");
    if (editBtn) editBtn.style.display = data.type === "note" ? "" : "none";
    const closeBtn = entry.head.querySelector(".close");
    // Closing an open question would leave the agent waiting for an answer with nothing on
    // screen to click, so the button appears only once it has been answered or has expired.
    if (closeBtn) closeBtn.style.display = isOpenQuestion ? "none" : "";
    entry.chipEl.textContent = isSource && data.line ? `line ${data.line}` : "";
    entry.chipEl.style.display = entry.chipEl.textContent ? "" : "none";

    const { node, cls } = bodyFor(data, entry);
    entry.body.className = cls ? `body ${cls}` : "body";
    entry.body.replaceChildren(node);
    paintThread(entry, data);
    fitContent(entry, data);
    renumberQueue();
    syncRailCard(entry);
  }

  /**
   * A note that holds more than its default height grows to fit, up to the CSS limit, so
   * nothing hides behind an inner scrollbar. It never shrinks on its own, and a card the user
   * resized keeps that size. An answered sticky does the same for its reply.
   */
  function fitContent(entry, data) {
    if (entry.card.dataset.sized === "user" || entry.card.classList.contains("mini")) return;
    const answeredSticky = data.type === "sticky" && Boolean(data.reply);
    const threaded = Array.isArray(data.turns) && data.turns.length > 0;
    // A question grows too: long options and the free-text row would otherwise hide behind the
    // column's scrollbar while the card sits at its default height.
    if (data.type !== "note" && data.type !== "question" && !answeredSticky && !threaded) return;
    requestAnimationFrame(() => {
      if (entry.card.dataset.sized === "user") return;
      // The note and its follow-ups share one column, so one measurement covers both.
      const tight = entry.scroll.scrollHeight > entry.scroll.clientHeight + 2;
      if (!tight) return;
      entry.card.classList.add("auto-height");
      requestAnimationFrame(() => {
        // The card can be closed between the two frames, and a snapshot replay clears and
        // re-creates the same id, so only this same entry may still claim a place.
        if (byId.get(entry.id) !== entry) return;
        const rect = {
          x: Math.round(parseFloat(entry.card.style.left)),
          y: Math.round(parseFloat(entry.card.style.top)),
          w: entry.card.offsetWidth,
          h: entry.card.offsetHeight,
        };
        // Through placeCard, so the space the card grew into is the space later cards avoid.
        placeCard(entry, rect);
        void saveLayout(entry.id, rect);
      });
    });
  }

  /**
   * Pending messages read as next, 2nd, 3rd in the order they will be answered, and the
   * labels shift up as each one is dealt with.
   */
  function ordinalPosition(position) {
    if (position === 1) return "next";
    const suffix = ["th", "st", "nd", "rd"];
    const rest = position % 100;
    return `${position}${suffix[(rest - 20) % 10] || suffix[rest] || suffix[0]}`;
  }

  function renumberQueue() {
    let position = 0;
    for (const card of cards) {
      const record = byId.get(card.dataset.id);
      if (!record || record.data.type !== "sticky") continue;
      if (record.data.status === "answered" || record.data.status === "stopped") continue;
      position += 1;
      record.chipEl.textContent = ordinalPosition(position);
      record.chipEl.classList.add("queue-pos");
      record.chipEl.style.display = "";
    }
  }

  /**
   * The fields a repaint actually draws. A refresh that rewrites the same text is not news, and
   * a delegate card is re-broadcast every few seconds whether or not anything moved.
   */
  function cardChanged(before, after) {
    const fields = ["title", "markdown", "text", "question", "reply", "status"];
    if (fields.some((field) => before[field] !== after[field])) return true;
    // A follow-up's answer settles into the turn it was asked with, so the thread changes without
    // gaining a turn: compare what each turn draws, not only how many there are.
    const was = before.turns || [];
    const now = after.turns || [];
    if (was.length !== now.length) return true;
    return now.some((turn, at) => {
      const old = was[at] || {};
      return old.text !== turn.text || old.status !== turn.status || old.reply !== turn.reply || old.images !== turn.images;
    });
  }

  /**
   * A card that changed says so. The ring is rate-limited because a progress card is re-broadcast
   * every few seconds; the header stamp is not, because it is cheap and has to be true.
   */
  function markUpdated(entry) {
    const now = Date.now();
    // A delegate card rebuilds its markdown with the elapsed time, so every progress tick would
    // move this stamp and pin the rail age near zero. Its body already shows that time.
    if (!isDelegate(entry.data)) entry.updatedAt = now;
    const card = entry.card;
    // A card that is still new already wears the mark, so a ring on top of it says nothing.
    if (card.classList.contains("fresh")) return;
    if (entry.flashedAt && now - entry.flashedAt < 10000) return;
    entry.flashedAt = now;
    flashCard(card);
  }

  function applyMessage(data, quiet = false) {
    const existing = byId.get(data.id);
    if (existing) {
      if (!replaying && !quiet) {
        // An identical re-broadcast would only wipe a selection and reset a scrolled body.
        if (!cardChanged(existing.data, data)) return;
        markUpdated(existing);
      }
      paintCard(existing, data);
      return;
    }
    const entry = makeCard(data, quiet);
    recomputePill();
    if (!sawFirstCard) {
      sawFirstCard = true;
      if (!replaying) fitAll();
    }
    // An off-screen arrival is announced by the new-card pill, and a question has its own
    // centring below, so no scroll into view is needed (and the viewport cannot scroll).
    // A question blocks the agent, so it lands under the eye and the keyboard. A replay brings
    // back cards the user already has, so it never pulls the view or steals the focus.
    // A question already on screen keeps the view: a second one must not pull it away.
    const onScreen = [...byId.values()].some(
      (record) => record !== entry && record.data.type === "question" && record.data.status === "open" && isVisible(record.card),
    );
    if (!replaying && !quiet && data.type === "question" && data.status === "open" && !onScreen && !typingSomewhere()) {
      // One frame later: fitContent grows the card in its own rAF, so centring now would measure
      // the default height and leave the lower options under the fold.
      requestAnimationFrame(() => centreQuestion(entry));
    }
  }

  function clearBoard() {
    // The composer may be docked inside a card, so it comes home first: removing the cards
    // would take the field with them and leave nothing to type into.
    setReplyTarget(null);
    for (const card of cards) card.remove();
    cards.length = 0;
    byId.clear();
    // A replay rebuilds every card, so the observer must let go of the dead ones.
    seenObserver.disconnect();
    inView.clear();
    for (const timer of seenTimers.values()) clearTimeout(timer);
    seenTimers.clear();
    occupied.length = 0;
    freshCount = 0;
    clearRailCards();
    paintPill();
    sawFirstCard = false;
    updateEmpty();
  }

  /** Remove a card from the board and let later cards fill the space it held. */
  function dropCard(entry) {
    const record = byId.get(entry.id);
    if (!record) return;
    // Compared by id: a remote remove arrives as a bare { id } and would never match the entry.
    if (replyTarget && replyTarget.id === record.id) setReplyTarget(null);
    record.card.remove();
    forgetSeen(record.card);
    inView.delete(record.card);
    seenObserver.unobserve(record.card);
    const at = cards.indexOf(record.card);
    if (at >= 0) cards.splice(at, 1);
    byId.delete(record.id);
    dropRailCard(record.id);
    releaseSpot(record.card);
    renumberQueue();
    recomputePill();
    updateEmpty();
  }

  /** Free the rectangle a closed card was holding so later cards can fill the gap. */
  function releaseSpot(card) {
    const rect = card.dataset.rect ? JSON.parse(card.dataset.rect) : null;
    if (!rect) return;
    const index = occupied.findIndex((candidate) => candidate.x === rect.x && candidate.y === rect.y);
    if (index >= 0) occupied.splice(index, 1);
  }

  /** Deliberate re-pack of everything, only ever triggered by the user. */
  function tidy() {
    occupied.length = 0;
    const ordered = [...cards].sort((a, b) => (a.dataset.kind === "source" ? -1 : 0) - (b.dataset.kind === "source" ? -1 : 0));
    let cursor = { x: 60, y: 60 };
    for (const card of ordered) {
      const rect = findFreeSpot(card.offsetWidth, card.offsetHeight, cursor);
      occupied.push(rect);
      card.style.left = `${rect.x}px`;
      card.style.top = `${rect.y}px`;
      card.dataset.rect = JSON.stringify(rect);
      const record = byId.get(card.dataset.id);
      if (record) void saveLayout(record.id, { ...rect, w: card.offsetWidth, h: card.offsetHeight });
    }
    fitAll();
  }

  function paintPill() {
    const pill = document.getElementById("newPill");
    if (!pill) return;
    pill.textContent = freshCount > 0 ? `${freshCount} new` : "";
    pill.style.display = freshCount > 0 ? "" : "none";
  }

  /** The count follows the observer, so a card the pill counts is a card whose mark still counts. */
  function recomputePill() {
    freshCount = cards.filter((card) => card.classList.contains("fresh") && !inView.has(card)).length;
    paintPill();
  }

  function jumpToFresh() {
    const record = attentionCard();
    if (!record) return;
    view.k = Math.min(1.1, Math.max(view.k, 0.6));
    // A question takes the keyboard with it, the way it does when it arrives.
    if (questionWants(record.data)) centreQuestion(record);
    else centerOn(record);
    // One click clears one mark, so a second click moves on to the next card.
    clearFresh(record.card);
  }

  /**
   * What the pill leads to: an arrival the human has not looked at outranks a question that has
   * already waited out its mark, a question wins inside its group because it blocks the agent, and
   * the latest event beats the latest arrival.
   */
  function attentionCard() {
    const entries = (list) => list.map((card) => byId.get(card.dataset.id)).filter(Boolean);
    // A fresh card is one the pill counts, so the same rule picks it here.
    const fresh = entries(cards.filter((card) => card.classList.contains("fresh") && !inView.has(card)));
    const pool = fresh.length
      ? fresh
      : entries(cards.filter((card) => !isVisible(card))).filter((entry) => questionWants(entry.data));
    // The change stamp is later than the arrival the card opened with, so it is the newer event.
    const stamp = (entry) => entry.updatedAt || new Date(entry.data.at || 0).getTime() || 0;
    const ranked = pool.sort(
      (a, b) => Number(questionWants(b.data)) - Number(questionWants(a.data)) || stamp(b) - stamp(a),
    );
    return ranked[0] || null;
  }

  function isVisible(card) {
    const x = parseFloat(card.style.left) * view.k + view.x;
    const y = parseFloat(card.style.top) * view.k + view.y;
    return x < viewport.clientWidth && x + card.offsetWidth * view.k > 0 && y < viewport.clientHeight && y + card.offsetHeight * view.k > 0;
  }

  /**
   * Bring the focused control into view, moving the view as little as it can. A control already
   * fully on screen is left alone, so tabbing through a card never drags the canvas out from under
   * the reader, and a card taller than the screen shows the field the focus is on, not its top.
   */
  function reveal(node) {
    // A control touched to the header or the composer edge reads as cramped, so it keeps a margin.
    const margin = 12;
    const box = node.getBoundingClientRect();
    const area = viewport.getBoundingClientRect();
    const right = box.right - area.right;
    const bottom = box.bottom - area.bottom;
    if (box.left >= area.left + margin && box.top >= area.top + margin && right <= -margin && bottom <= -margin) return;
    if (box.left < area.left + margin) view.x += area.left + margin - box.left;
    else if (right > -margin) view.x -= right + margin;
    if (box.top < area.top + margin) view.y += area.top + margin - box.top;
    else if (bottom > -margin) view.y -= bottom + margin;
    applyView();
  }

  function updateEmpty() {
    if (emptyHint) emptyHint.style.display = cards.length ? "none" : "grid";
  }

  // ---------- view ---------------------------------------------------------
  /**
   * Ctrl (or Cmd) plus wheel zooms around the pointer. A plain wheel over the empty canvas pans
   * the view: panning moves nothing on the board, so a stray scroll still cannot rearrange it,
   * while a wheel over a card keeps scrolling that card.
   */
  /** Tell the server where a card sits, so placement survives a refresh. */
  function saveLayout(cardId, rect, mini) {
    const body = { cardId, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } };
    // Only sent when it is asked for, so an ordinary move never clears a folded card.
    if (typeof mini === "boolean") body.mini = mini;
    return fetch(`/layout?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  /**
   * Folding keeps the card's real height on the server, so restoring it puts the card back
   * exactly as it was. Only the header stays on the canvas.
   */
  function setMini(card, mini) {
    card.classList.toggle("mini", mini);
    card.dataset.mini = mini ? "1" : "0";
    const button = card.querySelector(".min");
    if (button) {
      button.textContent = mini ? "▸" : "▾";
      button.title = mini ? "restore this card" : "minimize this card";
      // The glyph says nothing out loud, so the spoken name follows the tooltip.
      button.setAttribute("aria-label", button.title);
    }
  }

  /** Move a card locally and take the space it now holds into account. */
  function placeCard(record, rect) {
    const card = record.card;
    card.style.left = `${rect.x}px`;
    card.style.top = `${rect.y}px`;
    if (rect.w) card.style.width = `${rect.w}px`;
    if (rect.h) card.style.height = `${rect.h}px`;
    const old = card.dataset.rect ? JSON.parse(card.dataset.rect) : null;
    if (old) {
      const at = occupied.findIndex((spot) => spot.x === old.x && spot.y === old.y);
      if (at >= 0) occupied.splice(at, 1);
    }
    card.dataset.rect = JSON.stringify(rect);
    occupied.push(rect);
  }

  /** Save a note the user changed: a ticked box, or text typed in the editor. */
  async function saveNote(entry, markdown) {
    entry.data = { ...entry.data, markdown };
    paintCard(entry, entry.data);
    try {
      await fetch(`/edit?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: entry.id, markdown }),
      });
    } catch {
      // A failed save leaves the text on screen; the next reload shows the server's copy.
    }
  }

  /** Flip the Nth task marker, so the tick lands on the line the user clicked. */
  function flipTask(markdown, index) {
    let seen = -1;
    return markdown.replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (whole, lead, state) => {
      seen += 1;
      if (seen !== index) return whole;
      return `${lead}[${state.trim() ? " " : "x"}]`;
    });
  }

  /** The note body becomes a textarea holding its own markdown: no rich text, no surprises. */
  function startEditing(entry) {
    if (entry.data.type !== "note") return;
    entry.editing = true;
    const area = el("textarea", "note-edit");
    area.value = entry.data.markdown || "";
    area.spellcheck = false;
    entry.body.replaceChildren(area);
    area.focus();
    const finish = (commit) => {
      if (!entry.editing) return;
      entry.editing = false;
      const value = area.value;
      if (commit && value !== entry.data.markdown) void saveNote(entry, value);
      else paintCard(entry, entry.data);
    };
    area.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(true);
      }
    });
    area.addEventListener("blur", () => finish(true));
  }

  /** Ring a card once, through the same class a reference jump uses. */
  function flashCard(card) {
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 1400);
  }

  /** Centre the view on a card and ring it, so a reference lands where it points. */
  function centerOn(record) {
    const card = record.card;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const x = parseFloat(card.style.left) + card.offsetWidth / 2;
    const y = parseFloat(card.style.top) + card.offsetHeight / 2;
    const fits = Math.min(width / (card.offsetWidth + 80), height / (card.offsetHeight + 80));
    view.k = Math.min(view.k, Math.max(0.3, fits));
    view.x = width / 2 - x * view.k;
    view.y = height / 2 - y * view.k;
    applyView();
    flashCard(card);
    cards.forEach((c) => c.classList.toggle("active", c === card));
  }

  /** Centre a question and put the keyboard on its options, so the number keys are one press away. */
  function centreQuestion(record) {
    // The rule jumpToFresh uses: never arrive so far out that the ring and the text stop reading.
    view.k = Math.min(1.1, Math.max(view.k, 0.6));
    centerOn(record);
    // preventScroll: centring already moved the canvas, and a second jump would fight it.
    record.body.querySelector(".q-options")?.focus({ preventScroll: true });
  }

  /** True while the keystroke belongs to a field the user is typing in. */
  function typingSomewhere() {
    const active = document.activeElement;
    return Boolean(active && active.closest("input, textarea"));
  }

  /**
   * The question a number key answers: the active one, and only while it is on screen and open. A
   * folded or scrolled-away question is one the user cannot see, so a digit must not answer it.
   */
  function openQuestion() {
    const marked = document.querySelector(".card.active");
    const record = marked ? byId.get(marked.dataset.id) : null;
    if (!record || !questionWants(record.data)) return null;
    if (record.card.classList.contains("mini") || !isVisible(record.card)) return null;
    return record;
  }

  /** Follow a [[key]] reference: by key first, then by card title. */
  function jumpToKey(key) {
    const wanted = key.toLowerCase();
    for (const record of byId.values()) {
      if (record.data.key && record.data.key.toLowerCase() === wanted) return centerOn(record);
    }
    for (const record of byId.values()) {
      const title = record.titleEl.textContent.trim().toLowerCase();
      if (title && title === wanted) return centerOn(record);
    }
  }

  viewport.addEventListener("click", (event) => {
    const tick = event.target.closest(".tick");
    if (tick) {
      const card = tick.closest(".card");
      const record = card ? byId.get(card.dataset.id) : null;
      const item = tick.closest("li");
      if (record && record.data.type === "note" && item && item.dataset.tick != null) {
        void saveNote(record, flipTask(record.data.markdown || "", Number(item.dataset.tick)));
      }
      return;
    }
    const link = event.target.closest(".xref");
    if (!link) return;
    event.preventDefault();
    jumpToKey(link.dataset.key);
  });

  /** A wheel reports pixels, lines or pages, so one factor turns any of them into pixels. */
  const wheelPixels = (event, delta) =>
    delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);

  viewport.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) {
      // Only the empty canvas pans. The rail, composer and picker sit outside the viewport, and a
      // wheel over a card scrolls that card.
      if (event.target.closest(".card")) return;
      event.preventDefault();
      view.x -= wheelPixels(event, event.deltaX);
      view.y -= wheelPixels(event, event.deltaY);
      applyView();
      return;
    }
    event.preventDefault();
    const k = Math.min(3, Math.max(0.25, view.k * Math.exp(-wheelPixels(event, event.deltaY) * 0.0015)));
    const rect = viewport.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    view.x = px - (px - view.x) * (k / view.k);
    view.y = py - (py - view.y) * (k / view.k);
    view.k = k;
    applyView();
  }, { passive: false });

  viewport.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".card")) return;
    viewport.classList.add("dragging");
    cards.forEach((c) => c.classList.remove("active"));
    const sx = event.clientX;
    const sy = event.clientY;
    const ox = view.x;
    const oy = view.y;
    const move = (ev) => {
      view.x = ox + (ev.clientX - sx);
      view.y = oy + (ev.clientY - sy);
      applyView();
    };
    const up = () => {
      viewport.classList.remove("dragging");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });

  function fitAll() {
    if (!cards.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const card of cards) {
      const x = parseFloat(card.style.left);
      const y = parseFloat(card.style.top);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + card.offsetWidth);
      maxY = Math.max(maxY, y + card.offsetHeight);
    }
    const pad = 40;
    const k = Math.min(
      (viewport.clientWidth - pad * 2) / (maxX - minX),
      (viewport.clientHeight - pad * 2) / (maxY - minY),
      1.15,
    );
    view.k = Math.max(0.3, k);
    view.x = (viewport.clientWidth - (maxX - minX) * view.k) / 2 - minX * view.k;
    view.y = (viewport.clientHeight - (maxY - minY) * view.k) / 2 - minY * view.k;
    applyView();
  }

  /**
   * `100%` is real size without losing your place, so the zoom pivots on a card that is really on
   * the board: the active one, or else the one nearest the middle of the screen. Its position on
   * screen stays put, which is what keeps 100% from landing on empty canvas. An empty board only
   * changes the zoom, because there is nothing to hold still.
   */
  function resetZoom() {
    if (!cards.length) {
      view.k = 1;
      applyView();
      return;
    }
    // A board that is entirely off screen is framed first: 100% of empty canvas is still empty.
    if (!cards.some(isVisible)) fitAll();
    const mid = viewportCenter();
    const away = (card) => {
      const x = parseFloat(card.style.left) + card.offsetWidth / 2 - mid.x;
      const y = parseFloat(card.style.top) + card.offsetHeight / 2 - mid.y;
      return x * x + y * y;
    };
    const pivot =
      document.querySelector(".card.active") || cards.reduce((best, card) => (away(best) <= away(card) ? best : card));
    const px = parseFloat(pivot.style.left) + pivot.offsetWidth / 2;
    const py = parseFloat(pivot.style.top) + pivot.offsetHeight / 2;
    // Where the pivot sits on screen right now, which is where 100% has to leave it.
    const sx = px * view.k + view.x;
    const sy = py * view.k + view.y;
    view.k = 1;
    view.x = sx - px;
    view.y = sy - py;
    applyView();
  }

  document.getElementById("fit").addEventListener("click", fitAll);
  document.getElementById("tidy").addEventListener("click", tidy);
  document.getElementById("newPill").addEventListener("click", jumpToFresh);
  resetBtn.addEventListener("click", resetZoom);

  // ---------- activity rail ------------------------------------------------
  const stopBtn = document.getElementById("stop");
  const railNow = document.getElementById("railNow");
  const railLog = document.getElementById("railLog");
  const railRunning = document.getElementById("railRunning");
  const railOpenCount = document.getElementById("railOpenCount");
  const actEls = new Map();

  // The rail is the user's furniture: its width and whether it is showing survive a reload.
  const RAIL_MIN = 160;
  const RAIL_MAX = 720;
  const root = document.documentElement;

  function railWidth(px) {
    const width = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(px)));
    root.style.setProperty("--rail", `${width}px`);
    try {
      localStorage.setItem("board.railWidth", String(width));
    } catch {}
    return width;
  }

  function railShown(shown) {
    document.body.classList.toggle("rail-off", !shown);
    try {
      localStorage.setItem("board.railOff", shown ? "0" : "1");
    } catch {}
  }

  function restoreRail() {
    let saved = 0;
    let off = "0";
    try {
      saved = Number(localStorage.getItem("board.railWidth")) || 0;
      off = localStorage.getItem("board.railOff") || "0";
    } catch {}
    if (saved) railWidth(saved);
    if (off === "1") railShown(false);
  }
  restoreRail();
  document.getElementById("railToggle").onclick = () => railShown(false);
  document.getElementById("railOpen").onclick = () => railShown(true);

  (() => {
    const grip = document.getElementById("railGrip");
    let dragging = false;
    grip.addEventListener("pointerdown", (event) => {
      dragging = true;
      grip.setPointerCapture(event.pointerId);
      document.body.classList.add("rail-resizing");
      event.preventDefault();
    });
    grip.addEventListener("pointermove", (event) => {
      if (dragging) railWidth(event.clientX);
    });
    const stop = (event) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("rail-resizing");
      if (grip.hasPointerCapture?.(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    };
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  })();

  // The rail is the overview of the board: every card, newest first, with the one state worth
  // knowing. A row is the way back to its card.
  const railCards = document.getElementById("railCards");
  const railCardCount = document.getElementById("railCardCount");
  const railRows = new Map();

  /** An age short enough to share a row with a title. */
  function agoText(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  /** The one state word a row has room for, in the words the card itself already uses. */
  function railState(entry) {
    const data = entry.data || {};
    // "updated" rides on the arrival badge's own .fresh class, so there is one notion of new.
    const updated = entry.card.classList.contains("fresh");
    const wants = questionWants(data);
    if (data.type === "question" && data.status === "expired") return { text: "expired", wants: false, updated };
    if (wants) return { text: "answer needed", wants, updated };
    if (updated) return { text: "updated", wants, updated };
    if (data.type === "sticky") return { text: data.status || "queued", wants, updated };
    // A changed card is as old as its change, so the row does not keep counting from arrival.
    return { text: agoText(Date.now() - (entry.updatedAt || data.at || Date.now())), wants, updated };
  }

  function paintRailCount() {
    railCardCount.textContent = railRows.size ? String(railRows.size) : "";
    syncTicker();
  }

  /** Just the state word and its tone, so the clock and a repaint share one writer. */
  function paintRailState(entry) {
    const row = railRows.get(entry.id);
    if (!row) return;
    const { text, wants, updated } = railState(entry);
    // The clock calls this every second, so a word that has not changed must not touch the DOM.
    if (row.children[2].textContent !== text) {
      row.children[2].textContent = text;
      row.classList.toggle("wants", wants);
      row.classList.toggle("updated", updated);
      row.title = `${row.children[1].textContent} · ${text}`;
    }
  }

  /**
   * One row per card, built once and patched in place: this runs on every card repaint, so it
   * must not rebuild the list or touch any other card's DOM. Arrival order is the order the
   * cards array keeps, so a new card is only ever prepended.
   */
  function syncRailCard(entry) {
    if (!entry) return;
    let row = railRows.get(entry.id);
    if (!row) {
      row = el("button", "rail-card");
      row.type = "button";
      row.dataset.id = entry.id;
      row.append(el("span", "dot"), el("span", "rail-title"), el("span", "rail-state"));
      row.addEventListener("click", () => {
        const record = byId.get(row.dataset.id);
        if (record) centerOn(record);
      });
      railRows.set(entry.id, row);
      railCards.prepend(row);
    }
    row.children[0].className = `dot ${dotKind(entry.data.type)}`;
    row.children[1].textContent = entry.titleEl.textContent;
    paintRailState(entry);
    paintRailCount();
  }

  function dropRailCard(id) {
    const row = railRows.get(id);
    if (!row) return;
    row.remove();
    railRows.delete(id);
    paintRailCount();
  }

  function clearRailCards() {
    railCards.replaceChildren();
    railRows.clear();
    paintRailCount();
  }

  function actRow(row) {
    const node = el("div", `act ${row.kind === "reply" ? "reply" : ""} ${row.status}`);
    const top = el("div", "top");
    top.appendChild(el("span", "dot"));
    const name = el("span", "name");
    // The phrase says what the call does; the tool name stays available on hover.
    name.textContent = row.kind === "reply" ? "answer" : row.label || row.tool || "tool";
    if (row.tool) name.title = row.tool;
    top.appendChild(name);
    const timing = el("span", "ms");
    timing.textContent = row.durationMs
      ? `${(row.durationMs / 1000).toFixed(row.durationMs < 1000 ? 2 : 1)}s`
      : row.status === "running"
        ? Number.isFinite(row.startedAt)
          ? rowClock(Date.now() - row.startedAt)
          : "…"
        : "";
    top.appendChild(timing);
    // A running row is re-rendered by the ticker in place, so it carries its own start time.
    node.dataset.startedAt = String(row.startedAt ?? "");
    node.appendChild(top);
    const detail = row.kind === "reply" ? row.text || "" : row.summary || row.target || "";
    if (detail) {
      const note = el("div", row.kind === "reply" ? "note" : "target");
      note.textContent = detail;
      note.title = detail;
      node.appendChild(note);
    }
    return node;
  }

  function applyActivity(row) {
    const node = actRow(row);
    const previous = actEls.get(row.id);
    if (previous) previous.remove();
    actEls.set(row.id, node);
    if (row.status === "running") {
      railNow.prepend(node);
    } else {
      railLog.prepend(node);
      while (railLog.childElementCount > 200) {
        const last = railLog.lastElementChild;
        if (!last) break;
        for (const [id, elem] of actEls) if (elem === last) actEls.delete(id);
        last.remove();
      }
    }
    const running = railNow.childElementCount ? String(railNow.childElementCount) : "";
    railRunning.textContent = running;
    railOpenCount.textContent = running;
    syncTicker();
  }

  // ---------- composer -----------------------------------------------------
  const msgBox = document.getElementById("msg");
  const sendBtn = document.getElementById("send");
  const composerHint = document.getElementById("composerHint");
  const replyChip = document.getElementById("replyChip");
  const replyChipText = document.getElementById("replyChipText");
  let sendMode = "queue";
  composerHint.textContent = "waits for this run to finish";

  /**
   * A reply is aimed at one card, so the composer shows which until it is sent or cleared.
   * Without this the follow-up would arrive as a new sticky and the thread would be lost.
   */
  function setReplyTarget(entry) {
    replyTarget = entry && byId.has(entry.id) ? entry : null;
    for (const record of byId.values()) record.card.classList.toggle("replying", record === replyTarget);
    dockComposer(replyTarget);
    replyChip.hidden = !replyTarget;
    if (replyTarget) {
      // A sticky is titled "you", so it is named by its own words instead.
      const name =
        replyTarget.data.type === "sticky"
          ? (replyTarget.data.text || "message").replace(/\s+/g, " ").trim().slice(0, 40)
          : replyTarget.titleEl.textContent;
      replyChipText.textContent = `in “${name}”`;
      msgBox.placeholder = "ask a follow-up about this card…  (esc to send to the board instead)";
      msgBox.focus();
    } else {
      msgBox.placeholder = "message the agent…  (enter sends, shift+enter for a new line, paste an image or pick files)";
    }
    composerHint.textContent = sendMode === "steer" ? "interrupts the run" : "waits for this run to finish";
  }

  document.getElementById("replyChipClear").addEventListener("click", () => setReplyTarget(null));

  for (const button of document.querySelectorAll("#composer .modes button[data-mode]")) {
    button.addEventListener("click", () => {
      sendMode = button.dataset.mode === "steer" ? "steer" : "queue";
      for (const other of document.querySelectorAll("#composer .modes button[data-mode]")) {
        other.classList.toggle("on", other === button);
      }
      composerHint.textContent = sendMode === "steer" ? "interrupts the run" : "waits for this run to finish";
    });
  }

  // Images pasted into the composer travel with the message, so a screenshot reaches the
  // agent without leaving the board for the terminal.
  const attachments = document.getElementById("attachments");
  const pendingImages = [];

  function drawAttachments() {
    attachments.replaceChildren();
    for (const [index, image] of pendingImages.entries()) {
      const holder = el("div", "shot");
      const thumb = document.createElement("img");
      thumb.src = image.dataUrl;
      thumb.title = image.mimeType;
      const remove = el("button", "");
      remove.textContent = "×";
      remove.title = "remove";
      remove.addEventListener("click", () => {
        pendingImages.splice(index, 1);
        drawAttachments();
      });
      holder.append(thumb, remove);
      attachments.appendChild(holder);
    }
  }

  // A screenshot is several megabytes once base64 encoded, which is slow to push and slow to
  // replay. Shrinking it to a size that still reads well keeps the message small.
  const MAX_IMAGE_EDGE = 1568;
  function shrinkImage(dataUrl, mimeType) {
    const original = { dataUrl, mimeType, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
    return new Promise((resolve) => {
      const image = new Image();
      image.addEventListener("load", () => {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (Math.max(width, height) <= MAX_IMAGE_EDGE && dataUrl.length < 400_000) {
          resolve(original);
          return;
        }
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        const shrunk = canvas.toDataURL("image/jpeg", 0.85);
        resolve({ dataUrl: shrunk, mimeType: "image/jpeg", data: shrunk.slice(shrunk.indexOf(",") + 1) });
      });
      // Anything the browser cannot decode travels untouched rather than disappearing.
      image.addEventListener("error", () => resolve(original));
      image.src = dataUrl;
    });
  }

  msgBox.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files.slice(0, 4)) {
      const reader = new FileReader();
      reader.addEventListener("load", async () => {
        pendingImages.push(await shrinkImage(String(reader.result), file.type));
        drawAttachments();
      });
      reader.readAsDataURL(file);
    }
  });

  // ---------- file picker --------------------------------------------------
  // The agent works on paths, so the picker attaches paths: it lists a folder's names and never
  // pulls file contents through the browser. Picking starts at the session folder and walks
  // anywhere the server can read, which is what the user asked for when attaching a file.
  const picker = document.getElementById("picker");
  const pickList = document.getElementById("pickList");
  const pickPathInput = document.getElementById("pickPath");
  const pickFilter = document.getElementById("pickFilter");
  const pickHidden = document.getElementById("pickHidden");
  const pickUp = document.getElementById("pickUp");
  const pickCount = document.getElementById("pickCount");
  const pickError = document.getElementById("pickError");
  const pathChips = document.getElementById("pathChips");
  /** Picked paths survive navigation, so one message can name files from several folders. */
  const picked = new Map();
  let pickerAt = "";
  let listed = [];
  let listedTotal = 0;
  /**
   * The row the arrow keys are on, which the filter keeps the focus away from so typing works.
   * `-1` is no row: a fresh list starts unhighlighted, so Enter never attaches what the list
   * happened to open on.
   */
  let pickAt = -1;
  /** Every listing bumps this, so a slow reply cannot land on top of a newer one. */
  let browseSeq = 0;
  let filterTimer = 0;

  /** `~` in place of the home folder keeps a chip short enough to read in a row. */
  function shortenPath(path) {
    const home = picker.dataset.home || "";
    return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  }

  function drawChips() {
    pathChips.replaceChildren();
    for (const [path, meta] of picked) {
      const chip = el("div", meta.dir ? "chip folder" : "chip");
      chip.title = path;
      const label = el("span", "");
      label.textContent = shortenPath(path);
      const remove = el("button", "");
      remove.textContent = "×";
      remove.title = "remove";
      remove.addEventListener("click", () => {
        picked.delete(path);
        drawChips();
        drawList();
      });
      chip.append(label, remove);
      pathChips.appendChild(chip);
    }
    const count = picked.size;
    pickCount.textContent = count === 0 ? "nothing picked" : count === 1 ? "1 path" : `${count} paths`;
  }

  function drawList() {
    pickList.replaceChildren();
    if (listed.length === 0) {
      const hint = el("div", "p-empty");
      hint.textContent = pickFilter.value.trim() ? "nothing matches" : "empty folder";
      pickList.appendChild(hint);
      return;
    }
    for (const entry of listed) {
      const isPicked = picked.has(entry.path);
      // A real button, so the list can be walked with the keyboard: Enter or Space is a pick.
      const row = el("button", `p-item${entry.dir ? " dir" : ""}${isPicked ? " on" : ""}`);
      row.type = "button";
      row.title = entry.path;
      const tick = el("span", "p-tick");
      tick.textContent = isPicked ? "●" : "○";
      // The row's name is the file, so the glyph says nothing out loud and `aria-pressed` says it.
      tick.setAttribute("aria-hidden", "true");
      row.setAttribute("aria-pressed", String(isPicked));
      const name = el("span", "p-name");
      name.textContent = entry.name;
      row.append(tick, name);
      // A click picks; the chevron opens, because walking a tree and choosing in it are two acts.
      // A button cannot hold another button, so the chevron is decoration the row listens for.
      row.addEventListener("click", (event) => {
        if (event.target.classList.contains("p-open")) return void browse(entry.path);
        if (isPicked) picked.delete(entry.path);
        else picked.set(entry.path, { dir: entry.dir });
        drawList();
        drawChips();
      });
      if (entry.dir) {
        const open = el("span", "p-open");
        open.textContent = "›";
        open.title = "open this folder";
        // ArrowRight opens from the keyboard, so the glyph is not a second control to stop at.
        open.setAttribute("aria-hidden", "true");
        row.appendChild(open);
      }
      pickList.appendChild(row);
    }
    markHighlight();
    if (listedTotal > listed.length) {
      const note = el("div", "p-empty");
      note.textContent = `${listedTotal - listed.length} more — type in the filter to narrow it`;
      pickList.appendChild(note);
    }
  }

  /** Paint the row the arrows are on; the filter keeps the focus so typing keeps filtering. */
  function markHighlight() {
    const rows = [...pickList.querySelectorAll(".p-item")];
    rows.forEach((row, at) => row.classList.toggle("hl", at === pickAt));
  }

  /** The list hangs off the composer's top edge, which is where the field is however the page moves. */
  function placePicker() {
    const box = document.getElementById("composer").getBoundingClientRect();
    const width = Math.min(430, window.innerWidth - 28);
    picker.style.width = `${width}px`;
    const left = Math.min(Math.max(14, box.left + 14), window.innerWidth - width - 14);
    picker.style.left = `${left}px`;
    // Anchored by its bottom, so the list grows upward and never drifts across the field.
    picker.style.bottom = `${Math.max(14, window.innerHeight - box.top + 8)}px`;
  }

  async function browse(path, { focus = true } = {}) {
    const seq = (browseSeq += 1);
    pickError.hidden = true;
    try {
      const query = new URLSearchParams({ token, path: path ?? "" });
      if (pickHidden.checked) query.set("hidden", "1");
      const needle = pickFilter.value.trim();
      // Filtering happens on the server because the server is what caps how many names travel.
      if (needle) query.set("q", needle);
      const response = await fetch(`/browse?${query}`);
      if (seq !== browseSeq) return;
      if (!response.ok) throw new Error((await response.text()).slice(0, 120) || response.statusText);
      const data = await response.json();
      if (seq !== browseSeq) return;
      pickerAt = data.path;
      picker.dataset.home = data.home || "";
      pickPathInput.value = shortenPath(data.path);
      pickUp.disabled = data.parent === data.path;
      pickUp.dataset.parent = data.parent;
      listed = data.entries;
      listedTotal = data.total ?? data.entries.length;
      // A new folder starts the walk nowhere, so no row is armed until an arrow key moves.
      pickAt = -1;
      drawList();
      drawChips();
      picker.hidden = false;
      placePicker();
      // Typing a filter must not have its text selected out from under it, so only an
      // open or a deliberate move takes focus.
      if (focus) {
        pickFilter.focus();
        pickFilter.select();
      }
    } catch (error) {
      if (seq !== browseSeq) return;
      // The folder already open stays open: a typo in a path should not wipe the list.
      pickError.textContent = error.message || String(error);
      pickError.hidden = false;
      picker.hidden = false;
      placePicker();
    }
  }

  const closePicker = () => {
    // A keyboard user inside the list gets the keyboard back on the control that opened it; a
    // click elsewhere has already chosen its own target.
    const inside = !picker.hidden && picker.contains(document.activeElement);
    picker.hidden = true;
    // Whatever is still in flight belongs to a picker that is gone.
    browseSeq += 1;
    clearTimeout(filterTimer);
    // Picking files is rarely the end of the message, so a draft in hand takes the keyboard back.
    if (inside && msgBox.value.trim()) msgBox.focus();
    else if (inside) document.getElementById("pickFiles").focus();
  };

  document.getElementById("pickFiles").addEventListener("click", () => {
    if (!picker.hidden) closePicker();
    else void browse(pickerAt);
  });
  document.getElementById("pickDone").addEventListener("click", closePicker);
  document.getElementById("pickClose").addEventListener("click", closePicker);
  document.getElementById("pickHere").addEventListener("click", () => {
    if (!pickerAt) return;
    if (picked.has(pickerAt)) picked.delete(pickerAt);
    else picked.set(pickerAt, { dir: true });
    drawList();
    drawChips();
  });
  pickUp.addEventListener("click", () => {
    if (pickUp.dataset.parent) void browse(pickUp.dataset.parent);
  });
  document.getElementById("pickHome").addEventListener("click", () => void browse("~"));
  document.getElementById("pickCwd").addEventListener("click", () => void browse(""));
  pickHidden.addEventListener("change", () => void browse(pickerAt, { focus: false }));
  pickFilter.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      if (!picker.hidden) void browse(pickerAt, { focus: false });
    }, 160);
  });
  // The whole overlay answers the keyboard, so Escape leaves from a row or the hidden box, not
  // only from the two fields, and the arrows walk the list while the filter keeps the focus.
  picker.addEventListener("keydown", (event) => {
    // The path field already took this keystroke (it browses what was typed).
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePicker();
      return;
    }
    const rows = [...pickList.querySelectorAll(".p-item")];
    const onRow = event.target.closest(".p-item");
    // Walking continues from the row the focus is on, which Tab can reach without the arrows.
    const from = onRow ? rows.indexOf(onRow) : pickAt;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!listed.length) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      pickAt = (from + step + listed.length) % listed.length;
      markHighlight();
      if (onRow) rows[pickAt]?.focus();
      rows[pickAt]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" && !event.target.closest("button")) {
      // A row is a button, so Enter on one clicks it natively, and every other button in the
      // dialog keeps its own Enter; only a field hands the keystroke to the highlight.
      if (!rows[pickAt]) return;
      event.preventDefault();
      rows[pickAt].click();
      return;
    }
    // Right only opens a folder from a row, so it stays a caret move inside the fields.
    if (event.key === "ArrowRight" && onRow && listed[from] && listed[from].dir) {
      event.preventDefault();
      void browse(listed[from].path);
    }
  });
  pickPathInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void browse(pickPathInput.value.trim() || "/");
  });
  window.addEventListener("resize", () => {
    if (!picker.hidden) placePicker();
  });
  // A click anywhere else puts the picker away, the same as closing it. The chip row is part of
  // the composer's own furniture, so removing a pick is not a click on the board.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (picker.hidden || event.target.closest("#picker, #pickFiles, #pathChips")) return;
      closePicker();
    },
    true,
  );

  /** Paths travel as text, which the agent's own file tools read directly. */
  function pickedPathsText() {
    const lines = [...picked].map(([path, meta]) => `${path}${meta.dir ? "/" : ""}`);
    return `Files and folders:\n${lines.join("\n")}`;
  }

  async function sendMessage() {
    // Enter fires again while the first send is in flight; a second body would carry a new id,
    // slip past the server's duplicate guard and deliver the message twice.
    if (sendBtn.disabled) return;
    const draft = msgBox.value;
    const typed = draft.trim();
    if (!typed && pendingImages.length === 0 && picked.size === 0) return;
    const text = picked.size === 0 ? typed : `${typed}${typed ? "\n\n" : ""}${pickedPathsText()}`;
    // What this message carries, so a pick or a keystroke made while it travels is still there.
    const sentPaths = [...picked.keys()];
    const sentImages = [...pendingImages];
    const sentTarget = replyTarget;
    sendBtn.disabled = true;
    // Both attempts carry the same id, so a retry after a reset cannot deliver twice.
    const body = JSON.stringify({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      cardId: replyTarget ? replyTarget.id : undefined,
      text,
      mode: sendMode,
      images: sentImages.map((image) => ({ data: image.data, mimeType: image.mimeType })),
    });
    try {
      let response;
      // A socket the browser thought was alive can be closed under it, which loses the
      // request silently. One retry turns that into a delivered message.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(`/message?token=${encodeURIComponent(token)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          break;
        } catch (error) {
          if (attempt === 1 || !(error instanceof TypeError)) throw error;
        }
      }
      if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
      if (msgBox.value === draft) msgBox.value = "";
      for (const image of sentImages) {
        const at = pendingImages.indexOf(image);
        if (at >= 0) pendingImages.splice(at, 1);
      }
      drawAttachments();
      for (const path of sentPaths) picked.delete(path);
      drawChips();
      closePicker();
      if (replyTarget === sentTarget) setReplyTarget(null);
      composerHint.textContent = sendMode === "steer" ? "steered" : "queued";
    } catch (error) {
      const gone = error instanceof TypeError; // fetch rejects like this when nothing answers
      composerHint.textContent = gone
        ? "board connection lost — reload the page"
        : `failed: ${error.message || error}`;
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener("click", () => void sendMessage());

  // Stop asks the server to abort the run, then waits for meta to confirm it settled.
  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    stopBtn.textContent = "stopping…";
    try {
      await fetch(`/stop?token=${encodeURIComponent(token)}`, { method: "POST" });
    } catch {
      stopBtn.disabled = false;
      stopBtn.textContent = "stop";
    }
  });
  const composer = document.getElementById("composer");
  const composerHome = composer.parentElement;
  let composerAt = composer.nextElementSibling;

  /**
   * The composer is a view of one piece of state, so it moves rather than being copied: while a
   * card is the reply target the field sits at the bottom of that card, and `esc` puts it back.
   */
  function dockComposer(entry) {
    // The field is about to move, so a list hanging off it is closed rather than left behind.
    closePicker();
    if (entry) {
      // A folded card has no room for a field, so replying unfolds it.
      if (entry.card.classList.contains("mini")) setMini(entry.card, false);
      entry.card.insertBefore(composer, entry.card.querySelector(".resize"));
      composer.classList.add("docked");
      return;
    }
    if (composer.parentElement !== composerHome) {
      composer.classList.remove("docked");
      composerHome.insertBefore(composer, composerAt);
    }
  }

  // `r` opens a thread on the card you last clicked, whichever kind it is. The composer keeps
  // its own keys, so a message being typed is never cut short.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "r" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (typingSomewhere()) return;
    const active = document.querySelector(".card.active");
    const record = active ? byId.get(active.dataset.id) : null;
    if (!record) return;
    event.preventDefault();
    setReplyTarget(record);
  });

  // `1`–`6` answer the question the agent is waiting on, so a decision needs no mouse.
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-6]$/.test(event.key)) return;
    if (typingSomewhere()) return;
    const record = openQuestion();
    if (!record) return;
    // The option buttons carry their own click handler, so this reuses the whole answer path.
    const button = record.body.querySelectorAll(".q-options .q-opt")[Number(event.key) - 1];
    if (!button || button.disabled) return;
    event.preventDefault();
    button.click();
  });

  // The board is drivable without a mouse: `f` frames it, `0` is real size, `n` is what is next.
  // The composer keeps its plain letters, because a field the user is typing in is never read.
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (typingSomewhere()) return;
    // The picker is its own surface: a board shortcut behind it would move what is out of reach.
    if (!picker.hidden) return;
    if (event.key === "f") {
      event.preventDefault();
      fitAll();
    } else if (event.key === "0") {
      event.preventDefault();
      resetZoom();
    } else if (event.key === "n") {
      event.preventDefault();
      jumpToFresh();
    }
  });

  msgBox.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && replyTarget) {
      event.preventDefault();
      setReplyTarget(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });

  // ---------- transport ----------------------------------------------------
  // ---------- session header -----------------------------------------------
  const shortNum = (value) => {
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
    return String(value);
  };

  function applyMeta(meta) {
    if (!meta) return;
    metaRunning = meta.running === true;
    // A board served by an older pi has no runStartedAt, so the header says waiting instead
    // of inventing an elapsed time from the moment this tab happened to hear about the run.
    runStartedAt = typeof meta.runStartedAt === "number" ? meta.runStartedAt : null;
    // A run that settled without closing its row would keep it counting for ever, so the rail
    // settles it here and the header and the ticker cannot disagree.
    if (!metaRunning) {
      for (const node of railNow.querySelectorAll(".act.running")) node.classList.replace("running", "error");
    }
    renderLive();
    syncTicker();
    // The stop button exists only while there is something to stop.
    stopBtn.style.display = meta.running ? "" : "none";
    if (!meta.running) {
      stopBtn.disabled = false;
      stopBtn.textContent = "stop";
    }
    const folder = meta.folder || "session";
    const sess = document.getElementById("sess");
    sess.innerHTML = "";
    sess.append("board of ");
    const name = document.createElement("b");
    name.textContent = folder;
    sess.append(name);
    sess.title = `${meta.cwd || folder} · port ${meta.port}`;
    setBaseTitle(`pi - ${folder}`);
    const model = document.getElementById("statModel");
    if (meta.model) {
      model.innerHTML = `<em>${meta.model.split("/").pop()}</em>`;
      model.title = meta.model;
    } else {
      model.innerHTML = "";
    }
    document.getElementById("statTokens").innerHTML =
      meta.tokensIn || meta.tokensOut ? `↑${shortNum(meta.tokensIn)} ↓${shortNum(meta.tokensOut)}` : "";
    document.getElementById("statCost").innerHTML =
      meta.cost > 0 ? `$${meta.cost < 0.01 ? meta.cost.toFixed(4) : meta.cost.toFixed(3)}` : "";
    document.getElementById("statCtx").innerHTML =
      typeof meta.contextPercent === "number" ? `ctx ${Math.round(meta.contextPercent)}%` : "";
  }

  // A background tab announces new material the way a chat app does: the title blinks
  // until the tab is looked at again.
  let baseTitle = document.title || "pi - board";
  let flashTimer = null;

  function setBaseTitle(text) {
    baseTitle = text;
    if (!flashTimer) document.title = text;
  }

  function startFlash() {
    if (flashTimer || !document.hidden) return;
    let on = false;
    flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? `● new · ${baseTitle}` : baseTitle;
    }, 800);
  }

  function stopFlash() {
    if (flashTimer) {
      clearInterval(flashTimer);
      flashTimer = null;
    }
    document.title = baseTitle;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    stopFlash();
    // A hidden tab schedules nothing, so what is on screen now starts its countdown from here.
    for (const card of inView) armSeen(card);
  });
  addEventListener("focus", stopFlash);

  // What the header line is built from: the stream, the run, and the note a broken link leaves.
  let linkUp = false;
  let linkNote = "connecting";
  /** Pending timer that puts the dimmed down state on screen. */
  let dimTimer = null;
  /** null until the first meta says whether a run is in flight. */
  let metaRunning = null;
  let runStartedAt = null;
  let ticker = null;

  // The header line is one decision: a broken link wins, because without the stream the agent's
  // state is unknown and an elapsed time would be a guess.
  function renderLive() {
    const working = linkUp && metaRunning === true;
    live.classList.toggle("down", !linkUp);
    live.classList.toggle("working", working);
    // The clock ticks every second, so it is kept out of the spoken text and hidden: a screen
    // reader hears "working" once instead of a count read out every second.
    liveClock.textContent = "";
    if (!linkUp) {
      liveText.textContent = linkNote || "reconnecting";
      return;
    }
    // Nothing is known about the run until the first meta arrives, so claim nothing.
    if (metaRunning === null) {
      liveText.textContent = "connecting";
      return;
    }
    if (!working) {
      liveText.textContent = "idle";
      return;
    }
    if (runStartedAt === null) {
      liveText.textContent = "waiting";
      return;
    }
    liveText.textContent = "working";
    liveClock.textContent = `· ${clockText(Date.now() - runStartedAt)}`;
  }

  // Elapsed time the header can read at a glance: minutes, then hours once the minutes run out.
  function clockText(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
  }

  // A rail row shows seconds, then whole minutes and seconds, so the width stays steady.
  function rowClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    if (total < 60) return `${total}s`;
    if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
    return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
  }

  // One clock drives the header and every running row. It runs only while something is worth
  // ticking, so an idle board does not wake its tab every second.
  function tick() {
    if (metaRunning === true) renderLive();
    for (const node of railNow.querySelectorAll(".act.running")) {
      const started = Number(node.dataset.startedAt);
      const timing = node.querySelector(".ms");
      if (started && timing) timing.textContent = rowClock(Date.now() - started);
    }
    // Rail ages are derived from stored data, so re-reading them here is the only thing that
    // keeps the word current while nothing repaints the card.
    for (const id of railRows.keys()) {
      const entry = byId.get(id);
      if (entry) paintRailState(entry);
    }
  }

  function syncTicker() {
    const wanted = metaRunning === true || railNow.querySelector(".act.running") !== null || railRows.size > 0;
    if (wanted && !ticker) {
      ticker = setInterval(tick, 1000);
    } else if (!wanted && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function setLive(up, note = "") {
    linkUp = up;
    if (!up) linkNote = note;
    // The last painted board stays on screen, so the content has to say it is stale too. A wake or
    // a roam can break the stream for one retry cycle, so the down state waits a second and a link
    // that returns first cancels it.
    if (up) {
      clearTimeout(dimTimer);
      dimTimer = null;
      document.body.classList.remove("link-down");
    } else if (!dimTimer && !document.body.classList.contains("link-down")) {
      dimTimer = setTimeout(() => {
        dimTimer = null;
        document.body.classList.add("link-down");
      }, 1000);
    }
    renderLive();
  }

  function connect() {
    const source = new EventSource(`/events?token=${encodeURIComponent(token)}`);
    source.onopen = () => setLive(true);
    source.onerror = () => {
      // The browser tells the two failures apart: an HTTP error, such as a token the board no
      // longer knows, closes the stream for good, while a network error leaves it retrying.
      if (source.readyState === EventSource.CLOSED) {
        setLive(false, "token refused — reopen the link pi printed");
      } else {
        setLive(false, "pi not reachable — retrying");
      }
    };
    source.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type === "meta") {
        applyMeta(payload.meta);
      } else if (payload.type === "snapshot") {
        applyMeta(payload.meta);
        // A reconnect replays what is already on the board, and the draft survives it. The thread
        // the draft is aimed at has to survive too, or a reply loses its card mid-conversation.
        const keptTarget = replyTarget ? replyTarget.id : null;
        clearBoard();
        replaying = true;
        // A card that throws mid-replay must not leave the flag set: the tab would then never
        // badge, centre or restore a target again.
        try {
          for (const row of payload.activity || []) applyActivity(row);
          for (const card of payload.cards || []) applyMessage(card);
        } finally {
          replaying = false;
        }
        if (keptTarget && byId.has(keptTarget)) setReplyTarget(byId.get(keptTarget));
        sawFirstCard = (payload.cards || []).length > 0;
        // Armed on the first snapshot even when it is empty: the usual start is an empty snapshot
        // and the first card frames through the new-card path, and the first reconnect must not
        // throw that framing away.
        if (!framedView) {
          framedView = true;
          if (cards.length) fitAll();
        }
      } else if (payload.type === "move") {
        const record = byId.get(payload.id);
        if (record && payload.rect) placeCard(record, payload.rect);
        if (record && typeof payload.mini === "boolean") setMini(record.card, payload.mini);
      } else if (payload.type === "remove") {
        dropCard({ id: payload.id });
      } else if (payload.type === "activity") {
        applyActivity(payload.row);
      } else if (payload.type === "card" || payload.type === "update") {
        applyMessage(payload.card, payload.quiet === true);
        startFlash();
      } else if (payload.type === "clear") {
        clearBoard();
      }
    };
  }

  window.BOARD_START = () => {
    applyView();
    updateEmpty();
    if (!token) {
      // No stream exists here, so nothing on the page is stale: only the header says why the board
      // is blank.
      linkNote = "missing token";
      renderLive();
      return;
    }
    connect();
  };
})();
