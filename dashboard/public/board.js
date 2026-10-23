/* pi board — canvas client. Cards arrive from the extension over server-sent events. */
(function () {
  "use strict";

  const world = document.getElementById("world");
  const viewport = document.getElementById("viewport");
  const emptyHint = document.getElementById("empty");
  const live = document.getElementById("live");
  const liveText = document.getElementById("liveText");
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
    return best || { x: ax, y: ay, w, h };
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
      let ul = null;
      for (const line of block.split("\n")) {
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
          const h = el("h3");
          h.innerHTML = inlineMd(heading[2]);
          holder.appendChild(h);
          continue;
        }
        if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
          holder.appendChild(el("hr"));
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
    const holder = el("div", "q-body");
    const text = el("div", "q-text");
    text.innerHTML = inlineMd(data.question || "");
    holder.appendChild(text);

    const buttons = el("div", "q-options");
    for (const option of data.options || []) {
      const button = el("button", "q-opt");
      button.textContent = option;
      if (data.status === "answered") {
        button.disabled = true;
        if (data.answer === option) button.classList.add("picked");
      } else {
        button.addEventListener("click", () => submitAnswer(entry, option, buttons));
      }
      buttons.appendChild(button);
    }
    holder.appendChild(buttons);

    if (data.allowFreeText && data.status !== "answered") {
      const row = el("div", "q-free");
      const input = el("input");
      input.placeholder = "or type an answer…";
      const send = el("button", "q-opt");
      send.textContent = "send";
      const fire = () => {
        const value = input.value.trim();
        if (value) submitAnswer(entry, value, buttons, row);
      };
      send.addEventListener("click", fire);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") fire();
      });
      row.append(input, send);
      holder.appendChild(row);
    }

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
    try {
      await fetch(`/answer?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: entry.id, answer }),
      });
    } catch {
      const warn = el("div", "q-done");
      warn.textContent = "could not reach the board server";
      buttons.parentElement.appendChild(warn);
    }
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
    if (data.type === "source") return { node: sourceBody(data), cls: "" };
    if (data.type === "sticky") return { node: stickyBody(data), cls: "sticky-body-wrap" };
    if (data.type === "question") return { node: questionBody(data, entry), cls: "q-body-wrap" };
    return { node: renderMarkdown(data.markdown || ""), cls: "note-body" };
  }

  // ---------- cards --------------------------------------------------------
  function makeCard(data) {
    const isSource = data.type === "source";
    const isQuestion = data.type === "question";
    const kind = data.type;
    const width = data.rect ? data.rect.w : defaultWidth(kind);
    const height = data.rect ? data.rect.h : isSource ? 430 : isQuestion ? 300 : 300;

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
      <span class="dot ${isSource ? "code" : isQuestion ? "question" : kind === "sticky" ? "sticky" : "note"}"></span>
      <span class="title"></span>
      <span class="sub"></span>
      <span class="spacer"></span>
      <span class="chip"></span>
      <button class="edit" title="edit this note">✎</button>
      <button class="close" title="close">×</button>`;
    const body = el("div", "body");
    const grip = el("div", "resize");
    card.append(head, body, grip);
    world.appendChild(card);
    cards.push(card);

    const badge = el("span", "new-badge");
    badge.textContent = "new";
    head.insertBefore(badge, head.querySelector(".close"));
    card.classList.add("fresh");
    const clearFresh = () => {
      if (!card.classList.contains("fresh")) return;
      card.classList.remove("fresh");
      // Hidden, not removed: dropping it would shift the buttons under the pointer.
      badge.style.visibility = "hidden";
      recomputePill();
    };
    card.addEventListener("pointerdown", clearFresh, true);

    const entry = {
      id: data.id,
      card,
      head,
      body,
      titleEl: head.querySelector(".title"),
      subEl: head.querySelector(".sub"),
      chipEl: head.querySelector(".chip"),
      data,
    };
    byId.set(data.id, entry);
    paintCard(entry, data);

    card.addEventListener("pointerdown", () => {
      card.style.zIndex = z++;
      cards.forEach((c) => c.classList.toggle("active", c === card));
    }, true);

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
      if (event.target.closest(".close, .edit")) return;
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

  function paintCard(entry, data) {
    const isSource = data.type === "source";
    entry.data = data;
    if (entry.editing) return;
    entry.titleEl.textContent =
      data.title || (isSource ? data.path : data.type === "question" ? "question" : data.type === "sticky" ? "you" : "note");
    entry.titleEl.title = entry.titleEl.textContent;
    entry.subEl.textContent = isSource
      ? `${data.content.split("\n").length} lines`
      : data.type === "question"
        ? data.status === "answered" ? "answered" : "waiting for you"
        : data.type === "sticky"
          ? data.status || "queued"
          : new Date(data.at || Date.now()).toLocaleTimeString();
    const editBtn = entry.head.querySelector(".edit");
    if (editBtn) editBtn.style.display = data.type === "note" ? "" : "none";
    entry.chipEl.textContent = isSource && data.line ? `line ${data.line}` : "";
    entry.chipEl.style.display = entry.chipEl.textContent ? "" : "none";

    const { node, cls } = bodyFor(data, entry);
    entry.body.className = cls ? `body ${cls}` : "body";
    entry.body.replaceChildren(node);
    growSticky(entry, data);
    renumberQueue();
  }

  /**
   * An answered sticky holds the question and the reply, so it grows to fit them instead of
   * hiding the answer behind an inner scrollbar. Height stays put once the user resizes it.
   */
  function growSticky(entry, data) {
    if (data.type !== "sticky" || !data.reply || entry.card.dataset.sized === "user") return;
    // Letting the card size itself beats guessing pixels: no inner scrollbar, no clipping.
    entry.card.classList.add("auto-height");
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

  function applyMessage(data) {
    const existing = byId.get(data.id);
    if (existing) {
      paintCard(existing, data);
      return;
    }
    const entry = makeCard(data);
    recomputePill();
    if (!sawFirstCard) {
      sawFirstCard = true;
      fitAll();
    }
    entry.card.scrollIntoView && entry.card.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function clearBoard() {
    for (const card of cards) card.remove();
    cards.length = 0;
    byId.clear();
    occupied.length = 0;
    freshCount = 0;
    paintPill();
    sawFirstCard = false;
    updateEmpty();
  }

  /** Remove a card from the board and let later cards fill the space it held. */
  function dropCard(entry) {
    const record = byId.get(entry.id);
    if (!record) return;
    record.card.remove();
    const at = cards.indexOf(record.card);
    if (at >= 0) cards.splice(at, 1);
    byId.delete(record.id);
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

  /** The count must follow the viewport, so it is recomputed rather than incremented. */
  function recomputePill() {
    freshCount = cards.filter((card) => card.classList.contains("fresh") && !isVisible(card)).length;
    paintPill();
  }

  function jumpToFresh() {
    const card = cards.find((candidate) => candidate.classList.contains("fresh"));
    if (!card) return;
    const x = parseFloat(card.style.left);
    const y = parseFloat(card.style.top);
    view.k = Math.min(1.1, Math.max(view.k, 0.6));
    view.x = viewport.clientWidth / 2 - (x + card.offsetWidth / 2) * view.k;
    view.y = viewport.clientHeight / 2 - (y + card.offsetHeight / 2) * view.k;
    applyView();
  }

  function isVisible(card) {
    const x = parseFloat(card.style.left) * view.k + view.x;
    const y = parseFloat(card.style.top) * view.k + view.y;
    return x < viewport.clientWidth && x + card.offsetWidth * view.k > 0 && y < viewport.clientHeight && y + card.offsetHeight * view.k > 0;
  }

  function updateEmpty() {
    if (emptyHint) emptyHint.style.display = cards.length ? "none" : "grid";
  }

  // ---------- view ---------------------------------------------------------
  /**
   * Ctrl (or Cmd) plus wheel zooms around the pointer. A plain wheel is left alone so the
   * browser scrolls whatever sits under the cursor: a card's body, a code view, the rail.
   * Panning the board is drag-only, because a stray scroll should never move the layout.
   */
  /** Tell the server where a card sits, so placement survives a refresh. */
  function saveLayout(cardId, rect) {
    return fetch(`/layout?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } }),
    }).catch(() => {});
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
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 1400);
    cards.forEach((c) => c.classList.toggle("active", c === card));
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

  viewport.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const k = Math.min(3, Math.max(0.25, view.k * Math.exp(-event.deltaY * 0.0015)));
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

  document.getElementById("fit").addEventListener("click", fitAll);
  document.getElementById("tidy").addEventListener("click", tidy);
  document.getElementById("newPill").addEventListener("click", jumpToFresh);
  document.getElementById("reset").addEventListener("click", () => {
    view.k = 1;
    view.x = 0;
    view.y = 0;
    applyView();
  });

  // ---------- activity rail ------------------------------------------------
  const stopBtn = document.getElementById("stop");
  const railNow = document.getElementById("railNow");
  const railLog = document.getElementById("railLog");
  const railRunning = document.getElementById("railRunning");
  const actEls = new Map();

  function actRow(row) {
    const node = el("div", `act ${row.kind === "reply" ? "reply" : ""} ${row.status}`);
    const top = el("div", "top");
    top.appendChild(el("span", "dot"));
    const name = el("span", "name");
    name.textContent = row.kind === "reply" ? "answer" : row.tool || "tool";
    top.appendChild(name);
    const timing = el("span", "ms");
    timing.textContent = row.durationMs
      ? `${(row.durationMs / 1000).toFixed(row.durationMs < 1000 ? 2 : 1)}s`
      : row.status === "running"
        ? "…"
        : "";
    top.appendChild(timing);
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
    railRunning.textContent = railNow.childElementCount ? String(railNow.childElementCount) : "";
  }

  // ---------- composer -----------------------------------------------------
  const msgBox = document.getElementById("msg");
  const sendBtn = document.getElementById("send");
  const composerHint = document.getElementById("composerHint");
  let sendMode = "queue";
  composerHint.textContent = "waits for this run to finish";

  for (const button of document.querySelectorAll("#composer .modes button")) {
    button.addEventListener("click", () => {
      sendMode = button.dataset.mode === "steer" ? "steer" : "queue";
      for (const other of document.querySelectorAll("#composer .modes button")) {
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

  msgBox.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files.slice(0, 4)) {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const dataUrl = String(reader.result);
        pendingImages.push({
          dataUrl,
          mimeType: file.type,
          data: dataUrl.slice(dataUrl.indexOf(",") + 1),
        });
        drawAttachments();
      });
      reader.readAsDataURL(file);
    }
  });

  async function sendMessage() {
    const text = msgBox.value.trim();
    if (!text && pendingImages.length === 0) return;
    sendBtn.disabled = true;
    try {
      const response = await fetch(`/message?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          mode: sendMode,
          images: pendingImages.map((image) => ({ data: image.data, mimeType: image.mimeType })),
        }),
      });
      if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
      msgBox.value = "";
      pendingImages.length = 0;
      drawAttachments();
      composerHint.textContent = sendMode === "steer" ? "steered" : "queued";
    } catch (error) {
      composerHint.textContent = `failed: ${error.message || error}`;
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
  msgBox.addEventListener("keydown", (event) => {
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
    if (!document.hidden) stopFlash();
  });
  addEventListener("focus", stopFlash);

  function setLive(up) {
    live.classList.toggle("down", !up);
    liveText.textContent = up ? "connected" : "reconnecting";
  }

  function connect() {
    const source = new EventSource(`/events?token=${encodeURIComponent(token)}`);
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
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
        clearBoard();
        for (const row of payload.activity || []) applyActivity(row);
        for (const card of payload.cards || []) applyMessage(card);
        sawFirstCard = (payload.cards || []).length > 0;
        if (cards.length) fitAll();
      } else if (payload.type === "move") {
        const record = byId.get(payload.id);
        if (record && payload.rect) placeCard(record, payload.rect);
      } else if (payload.type === "remove") {
        dropCard({ id: payload.id });
      } else if (payload.type === "activity") {
        applyActivity(payload.row);
      } else if (payload.type === "card" || payload.type === "update") {
        applyMessage(payload.card);
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
      setLive(false);
      liveText.textContent = "missing token";
      return;
    }
    connect();
  };
})();
