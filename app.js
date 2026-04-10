/* 本地网页手帐：零依赖，localStorage + 本地加密（WebCrypto） */

const ACCOUNTS_KEY = "diary_mvp_accounts_v1";
const VAULT_PREFIX = "diary_mvp_vault_v1::"; // VAULT_PREFIX + username

/** @typedef {{id:string,text:string,color:string,createdAt:number,updatedAt:number,x:number,y:number}} Note */

const COLORS = [
  { id: "red", hex: "#ff6b7a" },
  { id: "blue", hex: "#68b7ff" },
  { id: "yellow", hex: "#ffd36b" },
  { id: "green", hex: "#74f2b2" },
  { id: "purple", hex: "#c6a6ff" },
  { id: "orange", hex: "#ff9b6b" },
  { id: "ink", hex: "#1f2937" },
  { id: "white", hex: "#f9fafb" },
];

function now() {
  return Date.now();
}

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function fmtDate(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// ------------------ 加密存储（本地） ------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64e(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64d(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

function normUser(u) {
  return String(u || "").trim();
}

function loadAccounts() {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function saveAccounts(m) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(m));
}

async function deriveKey(password, saltU8) {
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltU8,
      iterations: 150_000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptJson(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = enc.encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  return { iv: b64e(iv), ct: b64e(ct) };
}

async function decryptJson(key, ivB64, ctB64) {
  const iv = b64d(ivB64);
  const ct = b64d(ctB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(dec.decode(new Uint8Array(pt)));
}

function vaultKey(username) {
  return VAULT_PREFIX + username;
}

async function vaultLoad(username, key) {
  const raw = localStorage.getItem(vaultKey(username));
  if (!raw) return { notes: [], ui: { color: "yellow", snap: false }, chat: [] };
  const v = JSON.parse(raw);
  return decryptJson(key, v.iv, v.ct);
}

async function vaultSave(username, key, payload) {
  const v = await encryptJson(key, payload);
  localStorage.setItem(vaultKey(username), JSON.stringify(v));
}

function getColorHex(colorId) {
  return COLORS.find((c) => c.id === colorId)?.hex ?? "#ffd36b";
}

function noteTextColor(colorId) {
  if (colorId === "ink") return "#f5f7ff";
  return "#1a1a1a";
}

function noteBg(colorId) {
  const hex = getColorHex(colorId);
  // 轻微渐变，类似 mac 便签的柔和感
  return `linear-gradient(180deg, ${hex}, ${hex}cc)`;
}

function pickImportantNotes(notes, days = 30) {
  const t0 = now() - days * 24 * 3600 * 1000;
  return notes.filter((n) => n.createdAt >= t0 || n.updatedAt >= t0);
}

function tokenize(text) {
  // 极简 token：中文按连续片段；英文按单词；再做 2-3 字 ngram 让关键词更“像中文”
  const tokens = [];
  const parts = String(text)
    .replace(/\s+/g, " ")
    .trim()
    .match(/[\u4e00-\u9fff]+|[a-zA-Z0-9]+/g);
  if (!parts) return tokens;

  for (const p of parts) {
    if (/^[\u4e00-\u9fff]+$/.test(p)) {
      // 2-3 字 ngram
      const s = p;
      for (let n = 2; n <= 3; n++) {
        if (s.length < n) continue;
        for (let i = 0; i <= s.length - n; i++) {
          tokens.push(s.slice(i, i + n));
        }
      }
      // 也保留整段（但会更少见）
      if (s.length <= 6) tokens.push(s);
    } else {
      tokens.push(p.toLowerCase());
    }
  }

  return tokens
    .filter((t) => t.length >= 2)
    .filter((t) => !["今天", "昨天", "事情", "感觉", "一个", "然后", "但是"].includes(t));
}

function extractKeywords(notes, topK = 12) {
  const freq = new Map();
  for (const n of notes) {
    const toks = tokenize(n.text);
    for (const t of toks) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const ranked = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([k, v]) => ({ k, v }));
  return ranked;
}

function extractQuestions(notes, maxN = 8) {
  const out = [];
  const patterns = [/怎么/, /如何/, /为什么/, /能不能/, /该不该/, /\?/, /？/];
  for (const n of notes) {
    const text = String(n.text).trim();
    if (!text) continue;
    const isQ = patterns.some((re) => re.test(text));
    if (isQ) out.push({ id: n.id, text, date: fmtDate(n.createdAt) });
  }
  // 去重（按文本）
  const seen = new Set();
  const uniq = [];
  for (const q of out) {
    const key = q.text.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(q);
  }
  return uniq.slice(0, maxN);
}

function buildAdvice(keywords, questions) {
  const kw = keywords.slice(0, 6).map((x) => x.k);
  const q = questions.slice(0, 3).map((x) => x.text.slice(0, 24));
  const lines = [];
  lines.push("我会用“可解释”的方式帮你做总结：");
  lines.push("");
  lines.push("1) 你的高频主题（来自词频，不是黑盒）：");
  lines.push(kw.length ? `- ${kw.join(" / ")}` : "- 还没有足够多的内容，继续记几条就会更准");
  lines.push("");
  lines.push("2) 你反复出现的疑问（来自包含“怎么/为什么/？”的句子）：");
  lines.push(q.length ? q.map((s) => `- ${s}…`).join("\n") : "- 暂时没检测到明显的提问句");
  lines.push("");
  lines.push("3) 下一步建议（通用但有效）：");
  lines.push("- 把问题缩小到“一个可执行动作”（5分钟能完成）");
  lines.push("- 给每个动作设一个时间点（今天/本周）");
  lines.push("- 记录结果：我做了什么→发生了什么→我学到什么");
  return lines.join("\n");
}

function personaPrefix(persona) {
  if (persona === "mom") return "妈妈版：";
  if (persona === "friend") return "朋友版：";
  return "教练版：";
}

function replyWithPersona(persona, userText, ctx) {
  const t = userText.trim();
  const kws = ctx.keywords.map((x) => x.k).slice(0, 6);
  const qs = ctx.questions.map((x) => x.text).slice(0, 3);

  // 一些“离线但像 AI”的套路：复述 + 归因 + 具体建议
  if (/我最近在纠结什么|我最近在想什么/.test(t)) {
    const s = kws.length ? `你最近反复提到：${kws.join(" / ")}` : "你最近记录还不多，但我能感觉你在认真梳理生活。";
    return `${personaPrefix(persona)}${s}\n如果你愿意，告诉我：最让你卡住的是哪一件？我帮你把它拆成更小的步骤。`;
  }
  if (/三步计划|三步/.test(t)) {
    const topic = kws[0] ?? "这件事";
    return `${personaPrefix(persona)}给你一个“三步计划”（围绕：${topic}）：\n1) 写清楚目标：我想要的结果是什么？\n2) 选一个最小动作：5分钟就能做（发一条消息/写三句话/查一个信息）\n3) 设截止时间：今天几点前做完？做完回来告诉我结果。`;
  }
  if (/关键词|总结|复盘/.test(t)) {
    return `${personaPrefix(persona)}我按“词频+提问句”给你复盘：\n- 关键词：${kws.length ? kws.join(" / ") : "暂无"}\n- 关键问题：${qs.length ? qs.map((s) => s.slice(0, 24) + "…").join("；") : "暂无"}\n你想先解决哪一个？`;
  }

  // 默认：给情绪+行动建议
  if (persona === "mom") {
    return `妈妈版：我先抱抱你。\n你说的是：${t}\n我们先别急着完美，先做一件最小的事：把它写成一句“我现在能做的第一步是……”。你写给我，我帮你改到可执行。`;
  }
  if (persona === "friend") {
    return `朋友版：我懂你。\n你说：${t}\n要不我们用“二选一”逼自己前进：现在你更想（A）把这事做完，还是（B）先把它放下休息？选一个，我陪你。`;
  }
  return `教练版：收到。\n你的表述是：${t}\n我们把它变成可执行：\n- 目标（可衡量）是什么？\n- 你现在的最大阻碍是什么？\n- 下一步 5 分钟动作是什么？`;
}

// ------------------ UI 渲染 ------------------

const state = {
  route: "record",
  notes: [],
  ui: { color: "yellow", snap: false },
  chat: [],
  editingId: null,
  editingColor: "yellow",
  username: null,
  cryptoKey: null,
};

const els = {
  tabs: Array.from(document.querySelectorAll(".tab")),
  pages: {
    record: document.getElementById("page-record"),
    list: document.getElementById("page-list"),
    summary: document.getElementById("page-summary"),
  },
  canvas: document.getElementById("canvas"),
  quickInput: document.getElementById("quickInput"),
  saveBtn: document.getElementById("saveBtn"),
  palette: document.getElementById("colorPalette"),
  snapToggle: document.getElementById("snapToggle"),
  dateFilter: document.getElementById("dateFilter"),
  clearFilterBtn: document.getElementById("clearFilterBtn"),
  addTodayBtn: document.getElementById("addTodayBtn"),
  listGrid: document.getElementById("listGrid"),
  kwChips: document.getElementById("kwChips"),
  questionList: document.getElementById("questionList"),
  adviceBox: document.getElementById("adviceBox"),
  chatLog: document.getElementById("chatLog"),
  chatInput: document.getElementById("chatInput"),
  chatSendBtn: document.getElementById("chatSendBtn"),
  editModal: document.getElementById("editModal"),
  editTextarea: document.getElementById("editTextarea"),
  deleteBtn: document.getElementById("deleteBtn"),
  saveEditBtn: document.getElementById("saveEditBtn"),
  editColorPalette: document.getElementById("editColorPalette"),
  loginModal: document.getElementById("loginModal"),
  loginUser: document.getElementById("loginUser"),
  loginPass: document.getElementById("loginPass"),
  loginBtn: document.getElementById("loginBtn"),
  createBtn: document.getElementById("createBtn"),
  loginMsg: document.getElementById("loginMsg"),
  userLabel: document.getElementById("userLabel"),
  logoutBtn: document.getElementById("logoutBtn"),
};

function setLoginMessage(msg) {
  if (els.loginMsg) els.loginMsg.textContent = msg || "";
}

function setUserLabel() {
  const u = state.username ? `用户：${state.username}` : "未登录";
  if (els.userLabel) els.userLabel.textContent = u;
  if (els.logoutBtn) els.logoutBtn.hidden = !state.username;
}

function requireCrypto() {
  if (!crypto?.subtle) {
    alert("你的浏览器不支持 WebCrypto（无法本地加密）。请用最新版 Chrome/Safari。");
    throw new Error("no webcrypto");
  }
}

function showLogin() {
  els.loginModal.hidden = false;
  setLoginMessage("");
  setTimeout(() => els.loginUser.focus(), 0);
}

function hideLogin() {
  els.loginModal.hidden = true;
}

async function createAccount(username, password) {
  requireCrypto();
  const u = normUser(username);
  if (!u) throw new Error("请输入用户名");
  if (!password || password.length < 4) throw new Error("密码至少 4 位");
  const accounts = loadAccounts();
  if (accounts[u]) throw new Error("这个用户名已存在，请直接登录");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const payload = { notes: [], ui: { color: "yellow", snap: false } };
  await vaultSave(u, key, payload);
  accounts[u] = { salt: b64e(salt), createdAt: now() };
  saveAccounts(accounts);
  return { u, key, payload };
}

async function login(username, password) {
  requireCrypto();
  const u = normUser(username);
  if (!u) throw new Error("请输入用户名");
  const accounts = loadAccounts();
  const acc = accounts[u];
  if (!acc) throw new Error("用户不存在，请先创建账号");
  const salt = b64d(acc.salt);
  const key = await deriveKey(password, salt);
  // 密码对不对：靠解密是否成功
  const payload = await vaultLoad(u, key);
  return { u, key, payload };
}

async function persist() {
  if (!state.username || !state.cryptoKey) return;
  await vaultSave(state.username, state.cryptoKey, { notes: state.notes, ui: state.ui, chat: state.chat });
}

function updateRecordComposerDock() {
  const page = els.pages.record;
  if (!page) return;
  const focused = document.activeElement === els.quickInput;
  const hasText = !!(els.quickInput?.value ?? "").trim();
  const docked = focused || hasText;
  page.classList.toggle("docked", docked);
  page.classList.toggle("idle", !docked);
}

function setRoute(route) {
  state.route = route;
  for (const [k, el] of Object.entries(els.pages)) {
    el.hidden = k !== route;
  }
  for (const t of els.tabs) {
    const active = t.dataset.route === route;
    if (active) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  }
  if (route === "record") renderCanvas();
  if (route === "list") renderList();
  if (route === "summary") renderSummary();
  if (route === "record") updateRecordComposerDock();
}

function renderPalette() {
  els.palette.innerHTML = "";
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = c.hex;
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(state.ui.color === c.id));
    b.title = c.id;
    b.addEventListener("click", () => {
      state.ui.color = c.id;
      persist();
      renderPalette();
    });
    els.palette.appendChild(b);
  }
  els.snapToggle.checked = !!state.ui.snap;
  els.canvas.classList.toggle("snap", !!state.ui.snap);
}

function renderEditPalette() {
  if (!els.editColorPalette) return;
  els.editColorPalette.innerHTML = "";
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = c.hex;
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(state.editingColor === c.id));
    b.title = c.id;
    b.addEventListener("click", () => {
      state.editingColor = c.id;
      renderEditPalette();
    });
    els.editColorPalette.appendChild(b);
  }
}

function createNote(text, colorId, opts = {}) {
  const rect = els.canvas.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const x = typeof opts.x === "number" ? opts.x : cx - 110 + (Math.random() * 160 - 80);
  const y = typeof opts.y === "number" ? opts.y : cy - 80 + (Math.random() * 140 - 70);
  /** @type {Note} */
  const note = {
    id: uid(),
    text: String(text).trim(),
    color: colorId,
    createdAt: now(),
    updatedAt: now(),
    x: clamp(x, 10, Math.max(10, rect.width - 240)),
    y: clamp(y, 10, Math.max(10, rect.height - 140)),
  };
  state.notes.unshift(note);
  persist();
  return note;
}

function updateNote(id, patch) {
  const idx = state.notes.findIndex((n) => n.id === id);
  if (idx < 0) return;
  state.notes[idx] = { ...state.notes[idx], ...patch, updatedAt: now() };
  persist();
}

function deleteNote(id) {
  state.notes = state.notes.filter((n) => n.id !== id);
  persist();
}

function openEditModal(noteId) {
  const n = state.notes.find((x) => x.id === noteId);
  if (!n) return;
  state.editingId = noteId;
  state.editingColor = n.color || "yellow";
  els.editTextarea.value = n.text;
  renderEditPalette();
  els.editModal.hidden = false;
  setTimeout(() => els.editTextarea.focus(), 0);
}

function closeEditModal() {
  state.editingId = null;
  els.editModal.hidden = true;
}

function renderCanvas() {
  els.canvas.innerHTML = "";
  els.canvas.classList.toggle("snap", !!state.ui.snap);

  // 只渲染最近一段（防止太多）
  const max = 80;
  const slice = state.notes.slice(0, max);
  for (const n of slice) {
    const el = document.createElement("div");
    el.className = "note";
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    el.style.background = noteBg(n.color);
    el.style.color = noteTextColor(n.color);

    const top = document.createElement("div");
    top.className = "note-top";
    const date = document.createElement("div");
    date.className = "note-date";
    date.textContent = `${fmtDate(n.createdAt)} ${fmtTime(n.createdAt)}`;
    const dot = document.createElement("div");
    dot.className = "note-dot";
    dot.style.background = getColorHex(n.color);
    top.appendChild(date);
    top.appendChild(dot);

    const text = document.createElement("div");
    text.className = "note-text";
    text.textContent = n.text;

    el.appendChild(top);
    el.appendChild(text);

    el.addEventListener("dblclick", () => openEditModal(n.id));
    enableDrag(el, n.id);
    els.canvas.appendChild(el);
  }
}

function enableDrag(el, noteId) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origX = 0;
  let origY = 0;

  function onDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const n = state.notes.find((x) => x.id === noteId);
    if (!n) return;
    origX = n.x;
    origY = n.y;
    el.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const rect = els.canvas.getBoundingClientRect();
    let nx = origX + dx;
    let ny = origY + dy;
    nx = clamp(nx, 10, Math.max(10, rect.width - 240));
    ny = clamp(ny, 10, Math.max(10, rect.height - 140));
    el.style.left = `${nx}px`;
    el.style.top = `${ny}px`;
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const left = parseFloat(el.style.left || "0");
    const top = parseFloat(el.style.top || "0");
    updateNote(noteId, { x: left, y: top });
    try { el.releasePointerCapture(e.pointerId); } catch {}
  }

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}

function groupByDate(notes) {
  const map = new Map();
  for (const n of notes) {
    const d = fmtDate(n.createdAt);
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(n);
  }
  // 每天按创建时间排序
  for (const [k, arr] of map.entries()) arr.sort((a, b) => a.createdAt - b.createdAt);
  return map;
}

function renderList() {
  const filter = els.dateFilter.value;
  let notes = state.notes.slice();
  if (filter) {
    notes = notes.filter((n) => fmtDate(n.createdAt) === filter);
  }
  const byDate = groupByDate(notes);
  const dates = Array.from(byDate.keys()).sort((a, b) => (a < b ? 1 : -1)); // 新到旧

  els.listGrid.innerHTML = "";
  for (const d of dates) {
    const col = document.createElement("div");
    col.className = "day-col";
    const title = document.createElement("div");
    title.className = "day-title";
    title.textContent = d;
    const sub = document.createElement("div");
    sub.className = "day-sub";
    sub.textContent = `${byDate.get(d).length} 条`;
    const stack = document.createElement("div");
    stack.className = "day-notes";

    for (const n of byDate.get(d)) {
      const mn = document.createElement("div");
      mn.className = "mini-note";
      // “字体颜色为记录里彩色”
      mn.style.color = getColorHex(n.color);
      const t = document.createElement("div");
      t.className = "mini-text";
      t.textContent = n.text;
      const meta = document.createElement("div");
      meta.className = "mini-meta";
      meta.innerHTML = `<span>${fmtTime(n.createdAt)}</span><span>双击编辑</span>`;
      mn.appendChild(t);
      mn.appendChild(meta);
      mn.addEventListener("dblclick", () => openEditModal(n.id));
      stack.appendChild(mn);
    }

    col.appendChild(title);
    col.appendChild(sub);
    col.appendChild(stack);
    els.listGrid.appendChild(col);
  }
}

function renderSummary() {
  const recent = pickImportantNotes(state.notes, 30);
  const kws = extractKeywords(recent, 12);
  const qs = extractQuestions(recent, 8);

  els.kwChips.innerHTML = "";
  for (const x of kws) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = `${x.k} · ${x.v}`;
    els.kwChips.appendChild(chip);
  }

  els.questionList.innerHTML = "";
  if (qs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "qitem";
    empty.textContent = "暂时没检测到明显的提问句。你可以把问题直接写成“我该怎么…？”";
    els.questionList.appendChild(empty);
  } else {
    for (const q of qs) {
      const item = document.createElement("div");
      item.className = "qitem";
      item.textContent = `${q.date} · ${q.text}`;
      item.addEventListener("dblclick", () => openEditModal(q.id));
      els.questionList.appendChild(item);
    }
  }

  els.adviceBox.textContent = buildAdvice(kws, qs);

  // 把 summary 上下文放到 chat ctx
  state._summaryCtx = { keywords: kws, questions: qs };
}

function appendChat(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role === "me" ? "me" : "bot"}`;
  div.textContent = text;
  els.chatLog.appendChild(div);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function renderChat() {
  els.chatLog.innerHTML = "";
  for (const m of state.chat) {
    appendChat(m.role === "user" ? "me" : "bot", m.content);
  }
}

function currentPersona() {
  const el = document.querySelector('input[name="persona"]:checked');
  return el ? el.value : "mom";
}

async function tryDeepSeekReply(userText) {
  // 不把 API Key 放前端：只请求同源 /api/chat（需要用 server.py 启动）
  const persona = currentPersona();
  const ctx = state._summaryCtx ?? { keywords: [], questions: [] };
  const messages = state.chat.slice(-20); // 记忆：最近 20 轮
  const payload = {
    persona,
    userText,
    messages,
    summary: {
      keywords: (ctx.keywords ?? []).map((x) => x.k).slice(0, 10),
      questions: (ctx.questions ?? []).map((x) => x.text).slice(0, 6),
    },
  };

  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let j = {};
  try {
    j = await r.json();
  } catch {
    throw new Error(`接口返回非 JSON（HTTP ${r.status}）`);
  }
  if (!r.ok) {
    throw new Error(String(j?.error || `请求失败 HTTP ${r.status}`));
  }
  const text = String(j?.text ?? "").trim();
  if (!text) throw new Error(j?.error || "模型返回为空");
  return text;
}

function sendChat() {
  const t = els.chatInput.value.trim();
  if (!t) return;
  els.chatInput.value = "";

  // 先写入“记忆”
  state.chat.push({ role: "user", content: t, ts: now() });
  persist();
  appendChat("me", t);

  // 优先走 DeepSeek（如果 server.py 正在跑），失败则回退离线规则版
  (async () => {
    try {
      const rep = await tryDeepSeekReply(t);
      state.chat.push({ role: "assistant", content: rep, ts: now() });
      persist();
      appendChat("bot", rep);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const ctx = state._summaryCtx ?? { keywords: [], questions: [] };
      const rep = replyWithPersona(currentPersona(), t, ctx);
      const combined = `【DeepSeek 未连通】${errMsg}\n\n—— 以下为本地离线参考 ——\n\n${rep}`;
      state.chat.push({ role: "assistant", content: combined, ts: now() });
      persist();
      appendChat("bot", combined);
    }
  })();
}

// ------------------ 事件绑定 ------------------

for (const t of els.tabs) {
  t.addEventListener("click", () => setRoute(t.dataset.route));
}

els.saveBtn.addEventListener("click", () => {
  const text = els.quickInput.value.trim();
  if (!text) return;
  els.quickInput.value = "";
  createNote(text, state.ui.color);
  renderCanvas();
  updateRecordComposerDock();
});

els.quickInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    els.saveBtn.click();
  }
});

els.quickInput.addEventListener("focus", updateRecordComposerDock);
els.quickInput.addEventListener("blur", updateRecordComposerDock);
els.quickInput.addEventListener("input", updateRecordComposerDock);

els.snapToggle.addEventListener("change", () => {
  state.ui.snap = !!els.snapToggle.checked;
  persist();
  els.canvas.classList.toggle("snap", !!state.ui.snap);
});

els.clearFilterBtn.addEventListener("click", () => {
  els.dateFilter.value = "";
  renderList();
});
els.dateFilter.addEventListener("change", () => renderList());

els.addTodayBtn.addEventListener("click", () => {
  const t = prompt("写下此刻的想法：");
  if (!t) return;
  // 列表页添加：不关心位置，给个默认
  createNote(String(t), state.ui.color, { x: 40, y: 40 });
  renderList();
});

els.chatSendBtn.addEventListener("click", sendChat);
els.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

els.editModal.addEventListener("click", (e) => {
  const t = e.target;
  if (t && t.dataset && t.dataset.close) closeEditModal();
});

els.saveEditBtn.addEventListener("click", () => {
  if (!state.editingId) return;
  const text = els.editTextarea.value.trim();
  if (!text) return;
  updateNote(state.editingId, { text, color: state.editingColor });
  closeEditModal();
  if (state.route === "record") renderCanvas();
  if (state.route === "list") renderList();
  if (state.route === "summary") renderSummary();
});

els.deleteBtn.addEventListener("click", () => {
  if (!state.editingId) return;
  if (!confirm("确定删除这条记录？")) return;
  deleteNote(state.editingId);
  closeEditModal();
  if (state.route === "record") renderCanvas();
  if (state.route === "list") renderList();
  if (state.route === "summary") renderSummary();
});

// 初始渲染
async function boot() {
  setUserLabel();
  renderPalette();
  setRoute("record");
  updateRecordComposerDock();
  showLogin();
}

els.createBtn?.addEventListener("click", async () => {
  try {
    setLoginMessage("创建中…");
    const { u, key, payload } = await createAccount(els.loginUser.value, els.loginPass.value);
    state.username = u;
    state.cryptoKey = key;
    state.notes = payload.notes ?? [];
    state.ui = payload.ui ?? { color: "yellow", snap: false };
    state.chat = payload.chat ?? [];
    setUserLabel();
    hideLogin();
    renderPalette();
    renderCanvas();
    renderList();
    renderSummary();
    renderChat();
    if (state.chat.length === 0) {
      state.chat.push({ role: "assistant", content: "妈妈版：欢迎回来。今天想先记一条，还是先复盘一下？", ts: now() });
      persist();
      renderChat();
    }
  } catch (e) {
    setLoginMessage(String(e?.message ?? e));
  }
});

els.loginBtn?.addEventListener("click", async () => {
  try {
    setLoginMessage("登录中…");
    const { u, key, payload } = await login(els.loginUser.value, els.loginPass.value);
    state.username = u;
    state.cryptoKey = key;
    state.notes = payload.notes ?? [];
    state.ui = payload.ui ?? { color: "yellow", snap: false };
    state.chat = payload.chat ?? [];
    setUserLabel();
    hideLogin();
    renderPalette();
    renderCanvas();
    renderList();
    renderSummary();
    renderChat();
    if (state.chat.length === 0) {
      state.chat.push({ role: "assistant", content: "妈妈版：我在这儿。你想先记录，还是先复盘一下最近的关键词？", ts: now() });
      persist();
      renderChat();
    }
  } catch (e) {
    setLoginMessage(String(e?.message ?? e));
  }
});

els.logoutBtn?.addEventListener("click", () => {
  state.username = null;
  state.cryptoKey = null;
  state.notes = [];
  state.ui = { color: "yellow", snap: false };
  state.chat = [];
  setUserLabel();
  showLogin();
  els.chatLog.innerHTML = "";
});

boot();

