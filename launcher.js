#!/usr/bin/env node

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const yaml = require('js-yaml');

const configPath = path.join(__dirname, 'config.yml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
const { tools, settings } = config;

// ── fzf 사용 가능 여부 확인 ──────────────────────────────────────────────────

function hasFzf() {
  const result = spawnSync('which', ['fzf'], { encoding: 'utf8' });
  return result.status === 0;
}

// ── fzf 선택 ────────────────────────────────────────────────────────────────

function fzfSelect(items, prompt) {
  const result = spawnSync('fzf', [
    '--prompt', prompt + ' ',
    '--height', String(settings.fzf_height || 12),
    '--border', 'rounded',
    '--ansi',
    '--no-info',
  ], {
    input: items.join('\n'),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    console.log('\n취소됨.');
    process.exit(0);
  }
  return result.stdout.trim();
}

// ── 번호 선택 메뉴 (fzf fallback) ──────────────────────────────────────────

function numberedSelect(items, title) {
  console.log(`\n  ${title}`);
  console.log('  ' + '─'.repeat(30));
  items.forEach((item, i) => {
    console.log(`  ${i + 1}) ${item}`);
  });
  console.log('  0) 종료');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('  선택: ', (answer) => {
      rl.close();
      const num = parseInt(answer, 10);
      if (num === 0 || isNaN(num)) {
        console.log('취소됨.');
        process.exit(0);
      }
      if (num < 1 || num > items.length) {
        console.error('잘못된 선택.');
        process.exit(1);
      }
      resolve(items[num - 1]);
    });
  });
}

// ── 메인 ────────────────────────────────────────────────────────────────────

async function main() {
  const useFzf = hasFzf();
  const toolNames = tools.map((t) => t.name);
  const modes = ['바로실행', '익명모드실행'];

  let selectedToolName, selectedMode;

  if (useFzf) {
    selectedToolName = fzfSelect(toolNames, 'AI Tool >');
    selectedMode = fzfSelect(modes, `${selectedToolName} >`);
  } else {
    selectedToolName = await numberedSelect(toolNames, 'AI Tool 선택');
    selectedMode = await numberedSelect(modes, `${selectedToolName} — 실행 모드`);
  }

  const tool = tools.find((t) => t.name === selectedToolName);
  const isAnonymous = selectedMode === '익명모드실행';

  const env = { ...process.env };
  let tmpDir = null;

  if (isAnonymous) {
    const prefix = path.join(os.tmpdir(), settings.anonymous_home_prefix || 'ai-anon-');
    tmpDir = fs.mkdtempSync(prefix);
    env.HOME = tmpDir;
    console.log(`\n[익명모드] HOME=${tmpDir}`);

    // 세션 종료 시 임시 HOME 삭제
    const cleanup = () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  }

  const cmd = tool.command;
  const args = (isAnonymous && tool.anonymous_args) ? tool.anonymous_args : (tool.args || []);

  console.log(`\n▶ ${tool.name}${isAnonymous ? ' [익명]' : ''}\n`);

  const result = spawnSync(cmd, args, {
    env,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error(`\n오류: '${cmd}' 명령어를 찾을 수 없습니다. config.yml에서 command를 확인하세요.`);
    } else {
      console.error(`\n오류: ${result.error.message}`);
    }
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
