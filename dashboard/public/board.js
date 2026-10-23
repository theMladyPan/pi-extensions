/* pi board — canvas client. Cards arrive from the extension over server-sent events. */
(function () {
  "use strict";

  const world = document.getElementById("world");
  const viewport = document.getElementById("viewport");
  const emptyHint = document.getElementById("empty");
  const live = document.getElementById("live");
  const liveText = document.getElementById("liveText");
  const token = new URLSearchParams(location.search).get("token") || "";

  const LINE_HEIGHT = 18;
  const GUTTER = 52;
  const view = { x: 0, y: 0, k: 1 };
  const cards = [];
  const byId = new Map();
  let z = 1;
  const occupied = [];
  const anchors = { source: null, note: null, question: null };
  let sawFirstCard = false;
  let freshCount = 0;

  const GAP = 18;
  const STEP = 24;

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
  const applyView = () => {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
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
      const lines = block.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length > 0 && lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
        const ul = el("ul");
        for (const line of lines) {
          const li = el("li");
          const body = line.replace(/^\s*[-*+]\s+/, "");
          const box = body.match(/^\[([ xX])\]\s*(.*)$/);
          li.innerHTML = box
            ? `<span class="tick">${box[1].trim() ? "☑" : "☐"}</span> ${inlineMd(box[2])}`
            : inlineMd(body);
          ul.appendChild(li);
        }
        holder.appendChild(ul);
        continue;
      }
      for (const line of lines) {
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
        if (!line.trim()) continue;
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
    inner.style.width = `${GUTTER + Math.min(width, 260) * 7.4 + 30}px`;
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

  function bodyFor(data, entry) {
    if (data.type === "source") return { node: sourceBody(data), cls: "" };
    if (data.type === "question") return { node: questionBody(data, entry), cls: "q-body-wrap" };
    return { node: renderMarkdown(data.markdown || ""), cls: "note-body" };
  }

  // ---------- cards --------------------------------------------------------
  function makeCard(data) {
    const isSource = data.type === "source";
    const isQuestion = data.type === "question";
    const kind = data.type;
    const width = isSource ? 660 : isQuestion ? 460 : 420;
    const height = isSource ? 430 : isQuestion ? 300 : 250;

    const anchorRect =
      anchors[kind] ? { x: anchors[kind].x + 40, y: anchors[kind].y + anchors[kind].h + STEP } : viewportCenter();
    const spot = findFreeSpot(width, height, anchorRect);
    occupied.push(spot);
    anchors[kind] = spot;

    const card = el("div", "card");
    card.style.cssText = `left:${spot.x}px; top:${spot.y}px; width:${width}px; height:${height}px; z-index:${z++}`;
    card.dataset.rect = JSON.stringify(spot);
    card.dataset.kind = kind;

    const head = el("div", "head");
    head.innerHTML = `
      <span class="dot ${isSource ? "code" : isQuestion ? "question" : "note"}"></span>
      <span class="title"></span>
      <span class="sub"></span>
      <span class="spacer"></span>
      <span class="chip"></span>
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
      badge.remove();
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

    head.querySelector(".close").addEventListener("click", (event) => {
      event.stopPropagation();
      card.remove();
      cards.splice(cards.indexOf(card), 1);
      byId.delete(entry.id);
      clearFresh();
      releaseSpot(card);
      updateEmpty();
    });

    head.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".close")) return;
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
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
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
    entry.titleEl.textContent = data.title || (isSource ? data.path : data.type === "question" ? "question" : "note");
    entry.titleEl.title = entry.titleEl.textContent;
    entry.subEl.textContent = isSource
      ? `${data.content.split("\n").length} lines`
      : data.type === "question"
        ? data.status === "answered" ? "answered" : "waiting for you"
        : new Date(data.at || Date.now()).toLocaleTimeString();
    entry.chipEl.textContent = isSource && data.line ? `line ${data.line}` : "";
    entry.chipEl.style.display = entry.chipEl.textContent ? "" : "none";

    const { node, cls } = bodyFor(data, entry);
    entry.body.className = cls ? `body ${cls}` : "body";
    entry.body.replaceChildren(node);
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
    anchors.source = null;
    anchors.note = null;
    anchors.question = null;
    freshCount = 0;
    paintPill();
    sawFirstCard = false;
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
    anchors.source = null;
    anchors.note = null;
    anchors.question = null;
    const ordered = [...cards].sort((a, b) => (a.dataset.kind === "source" ? -1 : 0) - (b.dataset.kind === "source" ? -1 : 0));
    let cursor = { x: 60, y: 60 };
    for (const card of ordered) {
      const rect = findFreeSpot(card.offsetWidth, card.offsetHeight, cursor);
      occupied.push(rect);
      card.style.left = `${rect.x}px`;
      card.style.top = `${rect.y}px`;
      card.dataset.rect = JSON.stringify(rect);
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
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    const k = Math.min(3, Math.max(0.25, view.k * factor));
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

  // ---------- transport ----------------------------------------------------
  // ---------- session header -----------------------------------------------
  const shortNum = (value) => {
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
    return String(value);
  };

  function applyMeta(meta) {
    if (!meta) return;
    const folder = meta.folder || "session";
    const sess = document.getElementById("sess");
    sess.innerHTML = "";
    sess.append("board of ");
    const name = document.createElement("b");
    name.textContent = folder;
    sess.append(name);
    sess.title = `${meta.cwd || folder} · port ${meta.port}`;
    document.title = `pi - ${folder}`;
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
        for (const card of payload.cards || []) applyMessage(card);
        sawFirstCard = (payload.cards || []).length > 0;
        if (cards.length) fitAll();
      } else if (payload.type === "card" || payload.type === "update") {
        applyMessage(payload.card);
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
