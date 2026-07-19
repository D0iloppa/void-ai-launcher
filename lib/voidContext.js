'use strict';

// void-context — 프로젝트 루트의 별도 dJinn 그래프 DB(void-context.djinn.db, gitignored).
// aggregator.djinn.db 와 완전히 독립된 파일/네임스페이스이며 launcher 흐름에는 배선되지 않는다
// (postinstall 로 초기화되고 lib/voidContextMcp.js 를 통해 dJinn 내장 MCP 로만 노출됨 — 이 파일은
// "노출 전용" 스키마 authority: provider enum 검증 + 필수 필드 요구만 담당한다).
//
// 저장 구조 — vendor/dJinn/src/graph.js 의 GraphDriver 3단 고정 깊이:
//   root(node_id=1, 고정)
//   → node(parent_id=1, node_key=task_id) = "컨텍스트" 1개, 필드는 node.child_schema 에 저장
//     ({provider, named_session, workspace, resumes, task_id})
//   → doc(parent_id=해당 node.node_id, child_key=엔트리 id) = task_context 엔트리 1개당 1개.
//     entry_id 생략 시 `${ISO타임스탬프}-${짧은 랜덤}` 으로 발급 — child_key 알파벳순 정렬이
//     곧 시간순 정렬이 되므로 aggregator.js 처럼 별도 order 필드가 필요 없다.
//
// 예약 참고 노드 '_schema' — '기본구성'으로 한 번 시드되는, "실제 컨텍스트가 아닌" 필드 스키마
// 참고 문서(catalog 을 통해 사람이 확인할 수 있게 하는 용도). listContexts/findRecentContexts 는
// 이 노드를 항상 걸러낸다(node_key 가 '_' 로 시작하면 제외) — 진짜 컨텍스트로 오인되지 않도록.
// delContext/vacuumContexts 도 동일한 _isReserved 가드로 '_schema' 삭제를 절대 허용하지 않는다.
//
// dJinn 불가 시 폴백 규율 — configDb.js/aggregator.js 보다 엄격하다: 모든 접근자(읽기 포함)가
// getGraph() null 이면 명확한 Error 를 던진다. 빈 배열을 돌려주면 "이력 없음" 으로 오독되어
// 컨텍스트 유실로 이어질 수 있기 때문(aggregator 는 DEFAULT_ENTRIES 로 대체할 수 있지만 이 파일은
// task 별 실사용 이력이라 대체할 기본값 자체가 없다).

const path = require('path');
const crypto = require('crypto');
const { initVoidGraphLayer } = require('./graphLayer');

const NS = 'void_context'; // GraphDriver.NS_RE 가 하이픈을 거부하므로 언더스코어 고정(파일명은 하이픈 허용)
const PROVIDERS = new Set(['anthropic', 'openai', 'google']);

function voidContextDbFile() {
  return path.join(__dirname, '..', 'void-context.djinn.db');
}

// '기본구성' 시드 — 예약 노드 '_schema' 하나만 멱등하게 생성(존재 여부로 가드).
function seedSchemaNode(g) {
  if (g.graph.getNode(NS, '_schema')) return; // 이미 시드됨 — 재시작/재설치에도 멱등
  g.graph.putNode(NS, '_schema', {
    description: 'void-context 2-level node field schema (reference; not a real context)',
    child_schema: {
      provider: 'anthropic|openai|google',
      named_session: 'nullable named-session name',
      workspace: 'repo root abs path',
      resumes: '...',
      task_id: 'ticket slug',
    },
  });
}

const { getGraph, ensureSeeded, dbPath } = initVoidGraphLayer({
  dbFile: voidContextDbFile(),
  namespace: NS,
  nodeDefs: [],
  seed: seedSchemaNode,
});

function _requireGraph(action) {
  const g = getGraph();
  if (!g) {
    throw new Error(`voidContext.${action}: dJinn 을 사용할 수 없어 void-context 저장소에 접근할 수 없습니다`);
  }
  return g;
}

function shortRandom() {
  return crypto.randomBytes(4).toString('hex');
}

function _isReserved(key) {
  return String(key).startsWith('_');
}

// ── 컨텍스트(level-2 node) ───────────────────────────────────────────────

function putContext({ task_id, provider, named_session = null, workspace, resumes = null } = {}) {
  ensureSeeded();
  if (!task_id) throw new Error('voidContext.putContext: task_id 가 필요합니다');
  if (_isReserved(task_id)) throw new Error("voidContext.putContext: task_id 는 '_' 로 시작할 수 없습니다(예약됨)");
  if (!workspace) throw new Error('voidContext.putContext: workspace 가 필요합니다');
  if (!PROVIDERS.has(provider)) {
    throw new Error(`voidContext.putContext: provider 는 ${[...PROVIDERS].join('|')} 중 하나여야 합니다(got '${provider}')`);
  }
  const g = _requireGraph('putContext');
  const child_schema = { provider, named_session, workspace, resumes, task_id: String(task_id) };
  return g.graph.putNode(NS, task_id, { child_schema });
}

function getContext(task_id) {
  ensureSeeded();
  const g = _requireGraph('getContext');
  if (!task_id || _isReserved(task_id)) return null;
  const node = g.graph.getNode(NS, task_id);
  if (!node) return null;
  return { ...node.child_schema, created_at: node.created_at, modified_at: node.modified_at };
}

function _contextsFromNodes(nodes) {
  return nodes
    .filter(n => !_isReserved(n.node_key))
    .map(n => ({ ...n.child_schema, created_at: n.created_at, modified_at: n.modified_at }));
}

function listContexts({ workspace, limit, offset } = {}) {
  ensureSeeded();
  const g = _requireGraph('listContexts');
  let contexts = _contextsFromNodes(g.graph.childrenOf(NS, 1)); // parent_id=1 → 모든 level-2 node
  if (workspace) contexts = contexts.filter(c => c.workspace === workspace);
  if (offset) contexts = contexts.slice(offset);
  if (limit != null) contexts = contexts.slice(0, limit);
  return contexts;
}

function findRecentContexts({ workspace, limit = 10 } = {}) {
  ensureSeeded();
  const g = _requireGraph('findRecentContexts');
  let contexts = _contextsFromNodes(g.graph.childrenOf(NS, 1));
  if (workspace) contexts = contexts.filter(c => c.workspace === workspace);
  contexts.sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));
  return contexts.slice(0, limit);
}

// ── task_context 엔트리(level-3 doc) ─────────────────────────────────────

function putTaskContext(task_id, entry_id, data) {
  ensureSeeded();
  const g = _requireGraph('putTaskContext');
  if (!task_id) throw new Error('voidContext.putTaskContext: task_id 가 필요합니다');
  if (!g.graph.getNode(NS, task_id)) {
    throw new Error(`voidContext.putTaskContext: 알 수 없는 context 'task_id=${task_id}' — putContext 로 먼저 생성하세요`);
  }
  const childKey = entry_id || `${new Date().toISOString()}-${shortRandom()}`;
  const result = g.graph.putDoc(NS, task_id, childKey, data);
  return { task_id, entry_id: result.child_key, node_id: result.node_id };
}

function getTaskContext(task_id, entry_id) {
  ensureSeeded();
  const g = _requireGraph('getTaskContext');
  const doc = g.graph.getDoc(NS, task_id, entry_id);
  if (!doc) return null;
  return { entry_id: doc.child_key, ...doc.data, created_at: doc.created_at, modified_at: doc.modified_at };
}

function listTaskContext(task_id, { limit, offset } = {}) {
  ensureSeeded();
  const g = _requireGraph('listTaskContext');
  const docs = g.graph.listDocs(NS, task_id, { keysOnly: false, limit, offset }); // child_key(=entry_id) 오름차순
  return docs.map(d => ({ entry_id: d.child_key, ...d.data, created_at: d.created_at, modified_at: d.modified_at }));
}

// ── 삭제 / 청소 ───────────────────────────────────────────────────────────
// GraphDriver 프리미티브 그대로 사용(vendor/dJinn/src/graph.js):
//   delNode(ns, key, { cascade }) — L123, cascade:true 로 손자(docs) 까지 원자적 삭제, { deletedDocs } 반환
//   delDoc(ns, parentKey, childKey) — L209, 존재 여부와 무관하게 no-op(멱등)

// 컨텍스트(level-2 node) 1건 + 그 아래 모든 task_context 엔트리(level-3 docs) 삭제.
// 예약 노드('_'로 시작하는 key, 예: '_schema')는 절대 지우지 않는다.
function delContext(task_id) {
  ensureSeeded();
  if (!task_id) throw new Error('voidContext.delContext: task_id 가 필요합니다');
  if (_isReserved(task_id)) throw new Error("voidContext.delContext: '_' 로 시작하는 예약 노드는 삭제할 수 없습니다");
  const g = _requireGraph('delContext');
  if (!g.graph.getNode(NS, task_id)) return { task_id, existed: false, deletedDocs: 0 };
  const { deletedDocs } = g.graph.delNode(NS, task_id, { cascade: true });
  return { task_id, existed: true, deletedDocs };
}

// task_context 엔트리(level-3 doc) 1건 삭제. delDoc 은 djinn.del 과 동일한 의미론으로
// 존재하지 않아도 에러 없이 넘어간다(멱등) — 엔트리에는 예약 개념이 없으므로 별도 가드가 필요 없다.
function delTaskContext(task_id, entry_id) {
  ensureSeeded();
  if (!task_id) throw new Error('voidContext.delTaskContext: task_id 가 필요합니다');
  if (!entry_id) throw new Error('voidContext.delTaskContext: entry_id 가 필요합니다');
  const g = _requireGraph('delTaskContext');
  g.graph.delDoc(NS, task_id, entry_id);
  return { task_id, entry_id };
}

// 청소 — 예약 노드('_schema')를 제외한 모든 컨텍스트(+그 엔트리들)를 삭제한다.
// workspace 지정 시 그 workspace 소속 컨텍스트만 대상으로 한다. '_schema' 는 _isReserved 필터로
// childrenOf 결과에서 애초에 제외되므로 이 함수는 절대 예약 노드를 건드리지 않는다.
function vacuumContexts({ workspace } = {}) {
  ensureSeeded();
  const g = _requireGraph('vacuumContexts');
  let nodes = g.graph.childrenOf(NS, 1).filter(n => !_isReserved(n.node_key)); // parent_id=1 → 모든 level-2 node
  if (workspace) nodes = nodes.filter(n => n.child_schema && n.child_schema.workspace === workspace);
  let deletedContexts = 0;
  let deletedDocs = 0;
  for (const n of nodes) {
    const result = g.graph.delNode(NS, n.node_key, { cascade: true });
    deletedContexts++;
    deletedDocs += result.deletedDocs;
  }
  return { deletedContexts, deletedDocs };
}

// ── 초기화(postinstall 훅에서 호출) ────────────────────────────────────────

function initVoidContext() {
  ensureSeeded();
  return !!getGraph();
}

module.exports = {
  dbPath,
  getGraph,
  initVoidContext,
  putContext, getContext, listContexts, findRecentContexts,
  putTaskContext, getTaskContext, listTaskContext,
  delContext, delTaskContext, vacuumContexts,
};
