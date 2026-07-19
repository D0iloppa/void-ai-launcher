'use strict';

/*
 * lib/voidContext.js 삭제/청소(delContext/delTaskContext/vacuumContexts) 스모크 테스트.
 *
 * voidContext.js 는 lib/messaging/store.js 와 동일한 패턴으로 repo-root 고정 경로의
 * void-context.djinn.db 를 연다(오버라이드 seam 없음 — dbFile 은 path.join(__dirname, '..', ...)
 * 로 하드코딩되어 있고 env 로 바꿀 수 없다). 그래서 test/messaging-store.test.js 가 이미 쓰고
 * 있는 vendor/dJinn smoke-test 관례를 그대로 따른다 — 실행 전/후 모두 db 파일(+wal/shm)을
 * 지워 실제 파일에 흔적을 남기지 않는다(이 리포를 체크아웃한 개발자의 로컬 gitignored 파일이며,
 * 배포된 인스턴스의 데이터가 아니다).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'void-context.djinn.db');
const NS = 'void_context'; // voidContext.js 내부 네임스페이스 상수와 동일(비공개라 테스트에서 직접 참조)

function removeDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch {}
  }
}

test.before(() => removeDbFiles());
test.after(() => removeDbFiles());

const voidContext = require('../lib/voidContext');

function putSample(task_id, workspace) {
  voidContext.putContext({ task_id, provider: 'anthropic', workspace });
  voidContext.putTaskContext(task_id, 'entry-1', { note: 'first' });
  voidContext.putTaskContext(task_id, 'entry-2', { note: 'second' });
}

test('delContext removes the context node and all its task_context docs', () => {
  const taskId = `test-del-${process.pid}-a`;
  putSample(taskId, '/repo/a');

  assert.ok(voidContext.getContext(taskId));
  assert.equal(voidContext.listTaskContext(taskId).length, 2);

  const result = voidContext.delContext(taskId);
  assert.equal(result.existed, true);
  assert.equal(result.deletedDocs, 2);

  assert.equal(voidContext.getContext(taskId), null);
  assert.equal(voidContext.listTaskContext(taskId).length, 0);
});

test('delContext on a non-existent task_id is a no-op (existed:false, no throw)', () => {
  const result = voidContext.delContext(`test-del-${process.pid}-never-existed`);
  assert.deepEqual(result, { task_id: `test-del-${process.pid}-never-existed`, existed: false, deletedDocs: 0 });
});

test('delContext refuses to delete the reserved _schema node', () => {
  assert.throws(() => voidContext.delContext('_schema'), /예약된|reserved|삭제할 수 없습니다/);
  // 살아있는지 내부 그래프로 직접 확인(공개 접근자는 예약 노드를 걸러내므로 우회 조회)
  const g = voidContext.getGraph();
  assert.ok(g.graph.getNode(NS, '_schema'), '_schema 노드가 살아있어야 한다');
});

test('delTaskContext removes a single entry and is idempotent on repeat', () => {
  const taskId = `test-del-${process.pid}-b`;
  putSample(taskId, '/repo/b');

  voidContext.delTaskContext(taskId, 'entry-1');
  assert.equal(voidContext.getTaskContext(taskId, 'entry-1'), null);
  assert.equal(voidContext.getTaskContext(taskId, 'entry-2').note, 'second');

  // 이미 지워진 엔트리를 다시 지워도 에러 없이 넘어간다(delDoc 멱등)
  assert.doesNotThrow(() => voidContext.delTaskContext(taskId, 'entry-1'));

  voidContext.delContext(taskId); // 청소
});

test('vacuumContexts({workspace}) deletes only matching contexts, leaves others + _schema intact', () => {
  const taskA = `test-vac-${process.pid}-a`;
  const taskB = `test-vac-${process.pid}-b`;
  putSample(taskA, '/repo/vac-ws');
  putSample(taskB, '/repo/other-ws');

  const result = voidContext.vacuumContexts({ workspace: '/repo/vac-ws' });
  assert.equal(result.deletedContexts, 1);
  assert.equal(result.deletedDocs, 2);

  assert.equal(voidContext.getContext(taskA), null);
  assert.ok(voidContext.getContext(taskB), 'workspace 가 다른 컨텍스트는 남아있어야 한다');

  voidContext.delContext(taskB); // 청소
});

test('vacuumContexts() with no filter deletes every context but never _schema', () => {
  putSample(`test-vac-${process.pid}-x`, '/repo/x');
  putSample(`test-vac-${process.pid}-y`, '/repo/y');
  putSample(`test-vac-${process.pid}-z`, '/repo/z');

  assert.ok(voidContext.listContexts().length >= 3);

  const result = voidContext.vacuumContexts();
  assert.ok(result.deletedContexts >= 3);
  assert.equal(voidContext.listContexts().length, 0, '청소 후 listContexts 는 비어있어야 한다');

  const g = voidContext.getGraph();
  assert.ok(g.graph.getNode(NS, '_schema'), '청소 후에도 _schema 예약 노드는 살아있어야 한다');
});
