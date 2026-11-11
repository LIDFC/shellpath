// Интерфейс в браузере: терминал, патч-панель уровней, задание, nano, прогресс.
import { S, BLOCKS, BLOCK_ORDER, userOf, exportProgress, importProgress, resetProgress } from '../core/state.js';
import { IO, CANCEL, answerAsk, cancelAsk } from '../core/io.js';
import { runLine, complete } from '../core/shell.js';
import { enterLevel, curMeta, hostFor } from '../core/session.js';
import { HOME } from '../core/state.js';
import { LEVELS } from '../levels/index.js';
import { labHost, displayHostname } from '../netsim/lab.js';
import { PW } from '../worlds/base.js';
import { T } from '../i18n/ru.js';
import { renderMarkdown } from './markdown.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let log, outEl, inp, promptEl;

/* ---------- вывод терминала ---------- */
const clean = (s) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '\uFFFD');
const scrollDown = () => {
  outEl.scrollTop = outEl.scrollHeight;
};
function trimLog() {
  while (log.childNodes.length > 1500) log.removeChild(log.firstChild);
}
function printLine(text, cls) {
  log.appendChild(el('div', 'ln' + (cls ? ' ' + cls : ''), clean(text)));
  trimLog();
  scrollDown();
}
function promptParts() {
  if (!S.user) return ['you@laptop', '~'];
  const h = HOME();
  const p = S.cwd === h ? '~' : S.cwd.startsWith(h + '/') ? '~' + S.cwd.slice(h.length) : S.cwd;
  return [`${S.user}@${displayHostname().split('.')[0]}`, p];
}
function renderPrompt() {
  const row = $('#inrow');
  if (S.ask) {
    row.hidden = false;
    promptEl.textContent = S.ask.label;
    inp.type = S.ask.secret ? 'password' : 'text';
    inp.setAttribute('aria-label', S.ask.label);
    return;
  }
  inp.type = 'text';
  inp.setAttribute('aria-label', T.ui.commandLine);
  row.hidden = S.busy;
  const [u, p] = promptParts();
  promptEl.replaceChildren(el('span', 'pu', u), ':', el('span', 'pp', p), S.user === 'root' ? '# ' : '$ ');
}
function echoLine(text) {
  const d = el('div', 'ln');
  d.append(...[...promptEl.childNodes].map((n) => n.cloneNode(true)), text);
  log.appendChild(d);
}
function echoPlain(text) {
  log.appendChild(el('div', 'ln', text));
}

/* ---------- ввод ---------- */
async function execute(line) {
  S.busy = true;
  renderPrompt();
  try {
    await runLine(line);
  } catch (e) {
    if (e !== CANCEL) printLine(String(e), 'err');
  }
  S.busy = false;
  renderPrompt();
  scrollDown();
  if ($('#editor').hidden) inp.focus({ preventScroll: true });
}

function submit() {
  const v = inp.value;
  inp.value = '';
  if (S.ask) {
    echoPlain(S.ask.label + (S.ask.secret ? '' : v));
    answerAsk(v);
    renderPrompt();
    scrollDown();
    return;
  }
  if (S.busy) return;
  echoLine(v);
  if (v.trim()) S.hist.push(v);
  S.hi = S.hist.length;
  if (v.trim()) execute(v);
  else scrollDown();
}

function onTab() {
  const r = complete(inp.value, inp.selectionStart ?? inp.value.length);
  if (!r) return;
  if (r.list) {
    echoLine(inp.value);
    printLine(r.list.join('  '));
    return;
  }
  inp.value = r.value;
  inp.setSelectionRange(r.pos, r.pos);
}

/** Кнопки для телефона: на экранной клавиатуре нет Tab, стрелок и Ctrl. */
function bindTouchKeys() {
  const bar = $('#touchkeys');
  const keys = [
    ['Tab', () => !S.ask && !S.busy && onTab()],
    ['↑', () => onKey({ key: 'ArrowUp', preventDefault() {} })],
    ['↓', () => onKey({ key: 'ArrowDown', preventDefault() {} })],
    ['Ctrl+C', () => onKey({ key: 'c', ctrlKey: true, preventDefault() {} })],
    ['Ctrl+L', () => onKey({ key: 'l', ctrlKey: true, preventDefault() {} })],
  ];
  bar.replaceChildren(
    ...keys.map(([label, fn]) => {
      const b = el('button', 'tbtn', label);
      b.type = 'button';
      // Не забираем фокус у строки ввода, иначе экранная клавиатура закроется.
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        fn();
        inp.focus({ preventScroll: true });
      });
      return b;
    }),
  );
}

function onKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    if (!S.ask && !S.busy) onTab();
  } else if (e.key === 'ArrowUp' && !S.ask) {
    e.preventDefault();
    if (S.hi > 0) {
      S.hi--;
      inp.value = S.hist[S.hi];
      requestAnimationFrame(() => inp.setSelectionRange(inp.value.length, inp.value.length));
    }
  } else if (e.key === 'ArrowDown' && !S.ask) {
    e.preventDefault();
    if (S.hi < S.hist.length - 1) inp.value = S.hist[++S.hi];
    else {
      S.hi = S.hist.length;
      inp.value = '';
    }
  } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
    e.preventDefault();
    log.replaceChildren();
  } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && inp.selectionStart === inp.selectionEnd) {
    e.preventDefault();
    if (S.ask) {
      echoPlain(S.ask.label + '^C');
      inp.value = '';
      answerAsk(null);
    } else if (!S.busy) {
      echoLine(inp.value + '^C');
      inp.value = '';
    }
    renderPrompt();
    scrollDown();
  }
}

/* ---------- nano ---------- */
let ED = null;
function editorKeys(confirm) {
  const keys = confirm
    ? [['y', 'Y', T.ui.editorYes], ['n', 'N', T.ui.editorNo], ['c', '^C', T.ui.editorCancel]]
    : [['save', '^O', T.ui.editorSave], ['exit', '^X', T.ui.editorExit]];
  $('#ekeys').replaceChildren(
    ...keys.map(([k, key, label]) => {
      const b = el('button');
      b.type = 'button';
      b.dataset.k = k;
      b.append(el('b', null, key), ' ' + label);
      return b;
    }),
  );
}
const editorMsg = (t) => {
  $('#emsg').textContent = t;
};
const editorModified = () => {
  $('#emod').textContent = ED && $('#etext').value !== ED.orig ? T.ui.editorModified : '';
};
function editorSave() {
  const ta = $('#etext');
  const e = ED.save(ta.value);
  if (e) {
    editorMsg(`[ Error writing ${ED.path}: ${e} ]`);
    return false;
  }
  ED.orig = ta.value;
  const n = ta.value.split('\n').filter((x, i, a) => i < a.length - 1 || x).length;
  editorMsg(`[ Wrote ${n} lines ]`);
  editorModified();
  return true;
}
function editorClose() {
  $('#editor').hidden = true;
  const e = ED;
  ED = null;
  if (e) e.res({ code: 0 });
  inp.focus({ preventScroll: true });
}
function editorExit() {
  if ($('#etext').value === ED.orig) return editorClose();
  ED.confirm = true;
  editorMsg(T.ui.editorAsk);
  editorKeys(true);
}
function editorConfirm(k) {
  if (k === 'y') {
    if (editorSave()) editorClose();
  } else if (k === 'n') editorClose();
  else {
    ED.confirm = false;
    editorMsg('');
    editorKeys(false);
    $('#etext').focus();
  }
}
function openEditor({ path, text, msg, save }) {
  return new Promise((res, rej) => {
    ED = { path, orig: text, save, res, rej, confirm: false };
    const ta = $('#etext');
    ta.value = text;
    $('#efile').textContent = path;
    editorMsg(msg);
    editorKeys(false);
    editorModified();
    $('#editor').hidden = false;
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
  });
}
function closeEditorForNavigation() {
  if (!ED) return;
  const e = ED;
  ED = null;
  $('#editor').hidden = true;
  e.rej(CANCEL);
}
function bindEditor() {
  const ta = $('#etext');
  ta.setAttribute('aria-label', T.ui.editorText);
  $('#ekeys').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !ED) return;
    const k = b.dataset.k;
    if (k === 'save') {
      editorSave();
      ta.focus();
    } else if (k === 'exit') editorExit();
    else editorConfirm(k);
  });
  ta.addEventListener('keydown', (e) => {
    if (!ED) return;
    const k = e.key.toLowerCase();
    if (ED.confirm) {
      e.preventDefault();
      if (k === 'y' || k === 'n') editorConfirm(k);
      else if (k === 'escape' || (e.ctrlKey && k === 'c')) editorConfirm('c');
      return;
    }
    if (e.ctrlKey && (k === 'o' || k === 's')) {
      e.preventDefault();
      editorSave();
    } else if (e.ctrlKey && k === 'x') {
      e.preventDefault();
      editorExit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(ta.selectionEnd);
      ta.setSelectionRange(s + 4, s + 4);
      editorModified();
    }
  });
  ta.addEventListener('input', editorModified);
}

/* ---------- боковая панель ---------- */
function go(block, n) {
  cancelAsk();
  closeEditorForNavigation();
  S.busy = false;
  enterLevel(block, n, { fresh: true });
  inp.focus({ preventScroll: true });
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.replaceChildren(
    ...BLOCK_ORDER.map((b) => {
      const t = el('button', 'tab');
      t.type = 'button';
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(S.view === b));
      t.setAttribute('aria-controls', 'panel');
      t.dataset.block = b;
      t.append(el('span', 'tab-name', BLOCKS[b].name), el('span', 'tab-count', T.ui.blockCount(S.u[b], BLOCKS[b].max)));
      t.addEventListener('click', () => {
        S.view = b;
        renderTabs();
        renderPorts();
      });
      return t;
    }),
  );
}

function renderPorts() {
  const b = S.view;
  const max = BLOCKS[b].max;
  $('#panel').dataset.block = b;
  // Ряды заполняются полностью: до 9 портов — один ряд, больше — два ровных ряда.
  const count = max + 1;
  $('#ports').style.setProperty('--cols', String(count <= 9 ? count : Math.ceil(count / 2)));
  $('#panelLabel').textContent = T.ui.levelsOf(BLOCKS[b].name);
  const cur = curMeta();
  const ports = [];
  for (let n = 0; n <= max; n++) {
    const isCur = S.user && cur.block === b && cur.n === n;
    const state = n > S.u[b] ? 'locked' : isCur ? 'current' : n < S.u[b] ? 'done' : 'open';
    const p = el('button', 'port is-' + state);
    p.type = 'button';
    p.append(el('span', 'led'), el('span', 'jack'), el('span', 'num', String(n).padStart(2, '0')));
    const title = `${LEVELS[b][n].title}, ${T.ui.portState[state]}`;
    if (state === 'locked') {
      p.setAttribute('aria-disabled', 'true');
      p.setAttribute('aria-label', `${T.ui.portLocked(n)}`);
      p.title = T.ui.portLocked(n);
    } else {
      p.setAttribute('aria-label', `${n}. ${title}`);
      p.title = b === 'net' ? T.ui.portGoLab(n) : title;
      p.addEventListener('click', () => go(b, n));
    }
    if (isCur) p.setAttribute('aria-current', 'step');
    ports.push(p);
  }
  $('#ports').replaceChildren(...ports);
}

function renderMission() {
  const m = curMeta();
  const L = LEVELS[m.block][m.n];
  const max = BLOCKS[m.block].max;
  const box = $('#mission');
  box.dataset.block = m.block;
  const parts = [el('p', 'mission-kicker', `${BLOCKS[m.block].name}. ${T.ui.levelTitle(m.n, max)}`), el('h2', null, L.title)];
  if (m.block !== 'basic') {
    const host = el('p', 'host');
    const user = m.block === 'net' ? 'root' : userOf(m.block, m.n);
    host.innerHTML = T.ui.hostLine(`<strong>${hostFor(userOf(m.block, m.n))}</strong>`, `<strong>${user}</strong>`);
    parts.push(host);
  }
  const goal = el('div', 'goal');
  goal.innerHTML = renderMarkdown(L.goal);
  parts.push(goal, el('p', 'cmds-label', T.ui.commands));
  const cmds = el('div', 'cmds');
  for (const c of L.commands) {
    const b = el('button', 'chip', c);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (S.busy || S.ask) return;
      const line = 'man ' + c;
      echoLine(line);
      S.hist.push(line);
      S.hi = S.hist.length;
      execute(line);
    });
    cmds.append(b);
  }
  parts.push(cmds);
  const hint = el('details', 'hint');
  const sum = el('summary', null, T.ui.hint);
  const body = el('div', 'hint-body');
  body.innerHTML = renderMarkdown(L.hint);
  hint.append(sum, body);
  parts.push(hint);
  box.replaceChildren(...parts);
}

function renderSideFooter() {
  const m = curMeta();
  const basic = m.block === 'basic';
  $('#passform').hidden = !basic || m.n >= BLOCKS.basic.max;
  $('#how').hidden = basic || m.n >= BLOCKS[m.block].max;
  if (basic) {
    $('#passlabel').textContent = T.ui.passLabel(m.n + 1);
    const msg = $('#passmsg');
    if (!msg.dataset.keep) {
      msg.textContent = '';
      msg.className = 'small';
    }
    delete msg.dataset.keep;
  } else $('#how').textContent = m.block === 'net' ? T.ui.howNet : T.ui.howSsh(m.n + 1);
}

function renderTitle() {
  const lab = labHost();
  $('#ttitle').textContent = !S.user ? T.ui.termLocal : lab ? T.ui.termLab(lab.rt.hostname) : T.ui.termSsh(S.user, S.host);
  $('#tdepth').textContent = S.stack.length ? T.ui.depth(S.stack.length + 1) : '';
  $('#linkLed').classList.toggle('off', !S.user);
}

function refresh() {
  const m = curMeta();
  document.body.dataset.block = m.block;
  $('#term').dataset.block = m.block;
  renderTabs();
  renderPorts();
  renderMission();
  renderSideFooter();
  renderTitle();
  renderPrompt();
}

/* ---------- пароль и прогресс ---------- */
function bindPassForm() {
  $('#passin').placeholder = T.ui.passPlaceholder;
  $('#passBtn').textContent = T.ui.passCheck;
  $('#passform').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#passin').value.trim();
    const m = curMeta();
    const n = m.n + 1;
    const msg = $('#passmsg');
    if (!v) {
      msg.textContent = T.ui.passEmpty;
      msg.className = 'small msg-bad';
      return;
    }
    if (v !== PW[n]) {
      msg.textContent = T.ui.passWrong;
      msg.className = 'small msg-bad';
      return;
    }
    $('#passin').value = '';
    msg.textContent = T.ui.passOk(n);
    msg.className = 'small msg-ok';
    msg.dataset.keep = '1';
    cancelAsk();
    closeEditorForNavigation();
    S.busy = false;
    enterLevel('basic', n, {});
  });
}

function bindProgress() {
  const btn = $('#progressBtn');
  const panel = $('#progressPanel');
  btn.textContent = T.ui.progress;
  $('#exportBtn').textContent = T.ui.exportProgress;
  $('#importLabel').textContent = T.ui.importProgress;
  $('#importCode').placeholder = T.ui.importPlaceholder;
  $('#importBtn').textContent = T.ui.importApply;
  $('#resetBtn').textContent = T.ui.reset;
  const toggle = (open) => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => toggle(panel.hidden));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      toggle(false);
      btn.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) toggle(false);
  });
  $('#exportBtn').addEventListener('click', () => {
    const code = exportProgress();
    const area = $('#exportCode');
    const msg = $('#exportMsg');
    const manual = () => {
      area.hidden = false;
      area.value = code;
      area.select();
      msg.textContent = T.ui.exportManual;
    };
    try {
      navigator.clipboard.writeText(code).then(() => {
        msg.textContent = T.ui.exportDone;
      }, manual);
    } catch {
      manual();
    }
  });
  $('#importBtn').addEventListener('click', () => {
    const msg = $('#importMsg');
    if (!importProgress($('#importCode').value)) {
      msg.textContent = T.ui.importBad;
      msg.className = 'small msg-bad';
      return;
    }
    msg.textContent = T.ui.importOk;
    msg.className = 'small msg-ok';
    const m = curMeta();
    go(m.block, m.n);
  });
  let armed = null;
  $('#resetBtn').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (!armed) {
      b.textContent = T.ui.resetConfirm;
      armed = setTimeout(() => {
        armed = null;
        b.textContent = T.ui.reset;
      }, 3500);
      return;
    }
    clearTimeout(armed);
    armed = null;
    b.textContent = T.ui.reset;
    resetProgress();
    toggle(false);
    go('basic', 0);
  });
}

/* ---------- запуск ---------- */
export function startUI() {
  log = $('#log');
  outEl = $('#out');
  inp = $('#cmd');
  promptEl = $('#prompt');
  $('#tagline').textContent = T.ui.tagline;
  $('#tclear').textContent = T.ui.clear;
  $('#term').setAttribute('aria-label', T.ui.terminal);

  IO.print = printLine;
  IO.clear = () => log.replaceChildren();
  IO.refresh = refresh;
  IO.onAsk = () => {
    renderPrompt();
    scrollDown();
    inp.focus({ preventScroll: true });
  };
  IO.openEditor = openEditor;

  inp.addEventListener('keydown', onKey);
  outEl.addEventListener('mouseup', () => {
    if (!String(window.getSelection())) inp.focus({ preventScroll: true });
  });
  $('#tclear').addEventListener('click', () => {
    log.replaceChildren();
    inp.focus();
  });
  bindEditor();
  bindTouchKeys();
  bindPassForm();
  bindProgress();
}

export function focusTerminal() {
  if (matchMedia('(min-width: 901px)').matches) inp.focus({ preventScroll: true });
}
