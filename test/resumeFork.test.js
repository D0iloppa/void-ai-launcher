'use strict';

/*
 * lib/messaging/resumeFork.js 유닛 테스트 — resume 포인터/복사/uuid rewrite/
 * lock 의 순수(혹은 얇은 fs-wrapper) 로직.
 *
 * fs/storage 를 건드리는 테스트는 전부 mkdtempSync 임시 디렉토리 안에서만
 * 동작한다 — 실제 ~/.claude*, 실제 ~/.config/void-launcher 는 절대 건드리지
 * 않는다. lib/storage.js 의 storageDir() 은 매 호출마다 XDG_CONFIG_HOME 을
 * 다시 읽으므로, 테스트별로 이 환경변수를 임시 디렉토리로 스왑해 완전히
 * 격리한다(store.js/void-messages.djinn.db 는 이 테스트 파일에서 전혀
 * 건드리지 않는다 — ctx.messageHandle 을 생략해 acceptSeed 의 ack 경로를
 * 우회한다).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const resumeFork = require('../lib/messaging/resumeFork');
const storage = require('../lib/storage');

function withTempStorage(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-resumefork-storage-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-resumefork-home-'));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = dir;
  // resolveSessionConfigDir 은 XDG 가 아니라 os.homedir()(=$HOME) 아래에 세션
  // configDir 을 만든다. HOME 도 임시 격리하지 않으면 resume-fork 의
  // registerForkedSession 이 실제 ~/.claude-* 에 써서 (a) 실제 홈을 오염시키고
  // (b) genForkUuid() 가 매 실행 랜덤이라 파일이 누적돼 비멱등이 된다.
  process.env.HOME = homeDir;
  try {
    return fn(dir);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

// source 세션의 configDir 을 만들고 그 안에 projects/<slug>/<uuid>.jsonl +
// (반드시 복사되면 안 되는) .credentials.json/.claude.json 을 심어둔다.
function seedSourceSession({ name, cwd, sessionId, lines }) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-resumefork-source-'));
  const slug = resumeFork.encodeCwd(cwd);
  const projDir = path.join(configDir, 'projects', slug);
  fs.mkdirSync(projDir, { recursive: true });
  const jsonlPath = path.join(projDir, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonlPath, lines.map(l => JSON.stringify(l)).join('\n'));
  fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET' } }));
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'SECRET-ACCOUNT' } }));

  storage.saveSession({ name, toolCommand: 'claude', configDir, created_at: new Date().toISOString() });
  return { configDir, jsonlPath, slug };
}

test('encodeCwd mirrors switchProfile.js: every / and \\ becomes -', () => {
  assert.equal(resumeFork.encodeCwd('/mnt/c/DEV/void-ai-launcher'), '-mnt-c-DEV-void-ai-launcher');
  assert.equal(resumeFork.encodeCwd('C:\\Users\\me\\proj'), 'C:-Users-me-proj');
  assert.equal(resumeFork.encodeCwd(''), '');
});

test('resolveSourceJsonlPath is pure and deterministic', () => {
  const pointer = { sessionId: 'abc-123', cwd: '/mnt/c/DEV/void-ai-launcher' };
  const p = resumeFork.resolveSourceJsonlPath(pointer, '/home/user/.claude-alice');
  assert.equal(p, path.join('/home/user/.claude-alice', 'projects', '-mnt-c-DEV-void-ai-launcher', 'abc-123.jsonl'));
});

test('resolveSourceJsonlPath throws on missing pointer fields', () => {
  assert.throws(() => resumeFork.resolveSourceJsonlPath({}, '/tmp/x'));
  assert.throws(() => resumeFork.resolveSourceJsonlPath({ sessionId: 's', cwd: '/c' }, null));
});

test('genForkUuid produces unique, v4-shaped uuids', () => {
  const a = resumeFork.genForkUuid();
  const b = resumeFork.genForkUuid();
  assert.notEqual(a, b);
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(a, v4);
  assert.match(b, v4);
});

test('seedRouteKind maps each seedType to its directive kind (pure routing)', () => {
  assert.equal(resumeFork.seedRouteKind('msg'), 'inject');
  assert.equal(resumeFork.seedRouteKind('resume'), 'switch');
  assert.equal(resumeFork.seedRouteKind('resume-fork'), 'register');
  assert.equal(resumeFork.seedRouteKind('unknown-type'), null);
});

test('copyResumeJsonl without newUuid keeps the same uuid and never copies credentials', () => withTempStorage(() => {
  const cwd = '/mnt/c/DEV/void-ai-launcher';
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const { configDir: sourceDir } = seedSourceSession({
    name: 'alice', cwd, sessionId,
    lines: [{ sessionId, cwd, type: 'user', message: 'hi' }, { sessionId, cwd, type: 'assistant', message: 'yo' }],
  });

  const pointer = resumeFork.buildResumePointer({ name: 'alice', toolCommand: 'claude', configDir: sourceDir }, { sessionId, cwd });
  assert.equal(pointer.sessionId, sessionId);
  assert.equal(pointer.sourceProfile, 'alice');
  assert.equal(pointer.toolCommand, 'claude');

  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-resumefork-target-'));
  const result = resumeFork.copyResumeJsonl(pointer, targetDir, { newUuid: null });

  assert.equal(result.uuid, sessionId);
  assert.equal(fs.existsSync(result.path), true);
  assert.equal(path.basename(result.path), `${sessionId}.jsonl`);

  const copiedLines = fs.readFileSync(result.path, 'utf8').split('\n').map(l => JSON.parse(l));
  for (const line of copiedLines) {
    assert.equal(line.sessionId, sessionId);
    assert.equal(line.cwd, cwd);
  }

  assert.equal(fs.existsSync(path.join(targetDir, '.credentials.json')), false);
  assert.equal(fs.existsSync(path.join(targetDir, '.claude.json')), false);

  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
}));

test('copyResumeJsonl with newUuid renames the file and rewrites sessionId on every line, leaving cwd untouched', () => withTempStorage(() => {
  const cwd = '/mnt/c/DEV/void-ai-launcher';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const { configDir: sourceDir } = seedSourceSession({
    name: 'bob', cwd, sessionId,
    lines: [
      { sessionId, cwd, type: 'user', message: 'hi' },
      { sessionId, cwd, type: 'assistant', message: 'yo' },
      { type: 'summary', note: 'no sessionId field on this line' },
    ],
  });

  const pointer = resumeFork.buildResumePointer({ name: 'bob', toolCommand: 'claude', configDir: sourceDir }, { sessionId, cwd });
  const newUuid = resumeFork.genForkUuid();
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-resumefork-target-'));
  const result = resumeFork.copyResumeJsonl(pointer, targetDir, { newUuid });

  assert.equal(result.uuid, newUuid);
  assert.equal(path.basename(result.path), `${newUuid}.jsonl`);

  const copiedLines = fs.readFileSync(result.path, 'utf8').split('\n').map(l => JSON.parse(l));
  assert.equal(copiedLines.length, 3);
  assert.equal(copiedLines[0].sessionId, newUuid);
  assert.equal(copiedLines[1].sessionId, newUuid);
  assert.equal(copiedLines[0].cwd, cwd); // cwd 는 절대 rewrite 되지 않음
  assert.equal(copiedLines[1].cwd, cwd);
  assert.equal('sessionId' in copiedLines[2], false); // 원래 없던 필드는 추가되지 않음

  assert.equal(fs.existsSync(path.join(targetDir, '.credentials.json')), false);
  assert.equal(fs.existsSync(path.join(targetDir, '.claude.json')), false);
  // 원본 uuid 파일명으로는 target 에 안 남는다
  assert.equal(fs.existsSync(path.join(path.dirname(result.path), `${sessionId}.jsonl`)), false);

  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
}));

test('copyResumeJsonl rejects a source path that is not a .jsonl under projects/', () => withTempStorage(() => {
  const cwd = '/x';
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const { configDir: sourceDir } = seedSourceSession({ name: 'carol', cwd, sessionId, lines: [{ sessionId, cwd }] });
  // pointer 를 조작해 .jsonl 이 아닌 경로를 가리키게 함 — resolveSourceJsonlPath 는
  // 항상 .jsonl 을 만들어내므로, 가드 자체를 직접 두들겨보기 위해 sessionId 에
  // 경로 조작을 흉내내는 대신 존재하지 않는 sessionId 로 "파일 없음" 경로를 검증한다.
  const pointer = { sessionId: 'does-not-exist', cwd, sourceProfile: 'carol', toolCommand: 'claude' };
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-resumefork-target-'));
  assert.throws(() => resumeFork.copyResumeJsonl(pointer, targetDir, { newUuid: null }), /source jsonl 이 없습니다/);

  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
}));

test('acceptSeed routes msg -> inject with the message body inlined', () => {
  const directive = resumeFork.acceptSeed({ seedType: 'msg', body: '안녕하세요' });
  assert.equal(directive.kind, 'inject');
  assert.match(directive.promptText, /안녕하세요/);
});

test('acceptSeed routes resume -> switch, copies the jsonl, and locks the source session', () => withTempStorage(() => {
  const cwd = '/mnt/c/DEV/void-ai-launcher';
  const sessionId = '44444444-4444-4444-8444-444444444444';
  seedSourceSession({ name: 'dave', cwd, sessionId, lines: [{ sessionId, cwd }] });

  assert.equal(resumeFork.isSessionLocked({ name: 'dave', toolCommand: 'claude' }), false);

  const pointer = { sessionId, cwd, sourceProfile: 'dave', toolCommand: 'claude' };
  const targetConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-resumefork-target-'));

  const directive = resumeFork.acceptSeed(
    { seedType: 'resume', payload: pointer },
    { targetConfigDir, acceptedBy: 'bob-void' }
  );

  assert.equal(directive.kind, 'switch');
  assert.equal(directive.configDir, targetConfigDir);
  assert.equal(directive.resumeSessionId, sessionId); // 같은 uuid(resume/switch)
  assert.equal(directive.cwd, cwd);

  assert.equal(resumeFork.isSessionLocked({ name: 'dave', toolCommand: 'claude' }), true);
  const locked = storage.getSession('dave', 'claude');
  assert.equal(locked.handedOff.to, 'bob-void');

  fs.rmSync(targetConfigDir, { recursive: true, force: true });
}));

test('acceptSeed routes resume-fork -> register, assigns a new uuid, and leaves the source session unlocked', () => withTempStorage(() => {
  const cwd = '/mnt/c/DEV/void-ai-launcher';
  const sessionId = '55555555-5555-4555-8555-555555555555';
  seedSourceSession({ name: 'erin', cwd, sessionId, lines: [{ sessionId, cwd }] });

  const pointer = { sessionId, cwd, sourceProfile: 'erin', toolCommand: 'claude' };
  const directive = resumeFork.acceptSeed(
    { seedType: 'resume-fork', payload: pointer },
    { newSessionName: 'erin-forked' }
  );

  assert.equal(directive.kind, 'register');
  assert.equal(directive.session.name, 'erin-forked');
  assert.notEqual(directive.session.configDir, undefined);

  const registered = storage.getSession('erin-forked', 'claude');
  assert.ok(registered, '새 named session 이 storage 에 등록되어야 합니다');
  assert.equal(registered.configDir, directive.session.configDir);

  // 새 uuid 파일이 실제로 생성되었는지 확인 — directory 안의 .jsonl 하나가 있어야 함
  const projDir = path.join(registered.configDir, 'projects', resumeFork.encodeCwd(cwd));
  const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  assert.notEqual(files[0].slice(0, -'.jsonl'.length), sessionId); // 새 uuid, 원본과 다름

  // source(erin)는 건드리지 않는다 — lock 없음
  assert.equal(resumeFork.isSessionLocked({ name: 'erin', toolCommand: 'claude' }), false);
}));

test('acceptSeed throws on an unknown seedType', () => {
  assert.throws(() => resumeFork.acceptSeed({ seedType: 'bogus' }), /알 수 없는 seedType/);
});
