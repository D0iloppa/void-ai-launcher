'use strict';
const readline = require('readline');

let C = {};
const W  = 50;
const IW = W - 2;

function setColors(colors) { C = colors; }

function out(str)    { process.stdout.write(str + '\n'); }
function clear()     { process.stdout.write('\x1b[2J\x1b[H'); }
function hideCursor(){ process.stdout.write('\x1b[?25l'); }
function showCursor(){ process.stdout.write('\x1b[?25h'); }

// ── Render ────────────────────────────────────────────────

function renderMenu(title, items, selectedIndex, opts = {}) {
  const sig = C.signal;
  const rst = C.RESET;

  const titleStr = `── ${title} `;
  const topFill  = '─'.repeat(Math.max(0, IW - titleStr.length));
  out(sig + '┌' + titleStr + topFill + '┐' + rst);

  if (opts.subtitle) {
    const sub = ('  ' + opts.subtitle).padEnd(IW);
    out(sig + '│' + C.muted2 + sub + rst + sig + '│' + rst);
    out(sig + '├' + '─'.repeat(IW) + '┤' + rst);
  }

  out(sig + '│' + ' '.repeat(IW) + sig + '│' + rst);

  items.forEach((item, i) => {
    const isSelected = i === selectedIndex;
    const keyStr  = `[${item.key}]`;
    const descPart = item.desc ? '  ' + item.desc : '';
    const visText  = `  ${keyStr} ${item.label}${descPart}`;
    const display  = visText.length > IW ? visText.slice(0, IW - 1) + '…' : visText;
    const pad      = ' '.repeat(Math.max(0, IW - display.length));

    let row;
    if (item.disabled) {
      row = C.muted + display + pad + rst;
    } else if (isSelected) {
      row = C.signalBg + C.onSignal + C.BOLD + display + pad + rst;
    } else {
      const kc = item.key === 'q' ? sig : C.info;
      const dc = item.desc ? C.muted + '  ' + item.desc + rst : '';
      row = `  ${kc}${keyStr}${rst} ${C.text}${item.label}${rst}${dc}${pad}`;
    }

    out(sig + '│' + row + sig + '│' + rst);
  });

  out(sig + '│' + ' '.repeat(IW) + sig + '│' + rst);
  out(sig + '└' + '─'.repeat(IW) + '┘' + rst);
  out('');
  out(C.muted2 + '  ↑↓ 이동  Enter/숫자 선택  0 뒤로' + rst);
}

// ── Interactive Menu ──────────────────────────────────────

async function menu(title, items, opts = {}) {
  if (!process.stdin.isTTY) return fallbackMenu(title, items, opts);

  return new Promise(resolve => {
    let sel = items.findIndex(it => !it.disabled);
    if (sel === -1) sel = 0;

    const draw = () => { clear(); renderMenu(title, items, sel, opts); };

    const done = item => { cleanup(); resolve(item || null); };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      showCursor();
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }

      if (key.name === 'up') {
        let n = sel;
        do { n = (n - 1 + items.length) % items.length; }
        while (items[n].disabled && n !== sel);
        if (!items[n].disabled) sel = n;
        draw(); return;
      }
      if (key.name === 'down') {
        let n = sel;
        do { n = (n + 1) % items.length; }
        while (items[n].disabled && n !== sel);
        if (!items[n].disabled) sel = n;
        draw(); return;
      }
      if (key.name === 'return') {
        if (!items[sel].disabled) done(items[sel]);
        return;
      }
      if (str === '0' || key.name === 'escape') { done(null); return; }
      if (!str) return;

      const lstr = str.toLowerCase();
      const match = items.find(it => !it.disabled && it.key && it.key.toLowerCase() === lstr);
      if (match) { done(match); return; }
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    hideCursor();
    process.stdin.on('keypress', onKey);
    draw();
  });
}

async function fallbackMenu(title, items, opts = {}) {
  return new Promise(resolve => {
    console.log(`\n  ── ${title} ──`);
    items.forEach(it => {
      if (!it.disabled)
        console.log(`  [${it.key}] ${it.label}${it.desc ? '  ' + it.desc : ''}`);
    });
    console.log('  [0] 뒤로\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  선택: ', ans => {
      rl.close();
      const lans = ans.toLowerCase();
      if (lans === '0' || lans === '') { resolve(null); return; }
      resolve(items.find(it => !it.disabled && it.key && it.key.toLowerCase() === lans) || null);
    });
  });
}

// ── Message / Input ───────────────────────────────────────

async function message(text) {
  clear();
  out('');
  text.split('\n').forEach(line => out('  ' + line));
  out('');
  out('  ' + C.muted2 + 'Enter 키를 눌러 계속...' + C.RESET);

  return new Promise(resolve => {
    if (!process.stdin.isTTY) { resolve(); return; }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'return' || (key.ctrl && key.name === 'c')) {
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(false);
        showCursor();
        if (key.ctrl && key.name === 'c') process.exit(0);
        resolve();
      }
    };
    process.stdin.on('keypress', onKey);
  });
}

async function input(promptText, secret = false) {
  return new Promise(resolve => {
    process.stdout.write('  ' + C.muted2 + promptText + C.RESET);

    if (secret && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let value = '';
      const onData = chunk => {
        const ch = chunk.toString();
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
        } else if (ch === '\x7f' || ch === '\b') {
          if (value.length > 0) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (ch === '\x03') {
          process.exit(0);
        } else if (ch >= ' ') {
          value += ch;
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', ans => { rl.close(); resolve(ans); });
    }
  });
}

module.exports = { setColors, menu, message, input, clear, out, W, IW };
