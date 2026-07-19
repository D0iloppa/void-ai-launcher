'use strict';

// dJinn Graph Catalog 부트스트랩 공유 헬퍼 — lib/aggregator.js 에서 추출.
// aggregator 스택(config 네임스페이스)과 void-context 스택(void_context 네임스페이스)이
// 동일한 "DJinn 인스턴스 생성 → GraphDriver.attach → define()" 절차를 각자 다른 DB 파일에
// 대해 반복하므로, 그 절차만 팩토리로 감싼다. 호출부(aggregator.js/voidContext.js)가 각자의
// dbFile/namespace/nodeDefs/seed 콜백을 넘기고, 이 파일은 db/graph/initAttempted/seeded 상태를
// 호출별 클로저로 격리해 들고 있는다 — 두 스택이 서로의 상태를 절대 공유하지 않는다.
//
// require('./aggregator')/require('./voidContext') 를 하지 않는다(순환 참조 방지) — 이 파일은
// 항상 아래쪽(fs/path/@d0iloppa/djinn)만 바라본다.

const fs = require('fs');

function initVoidGraphLayer({ dbFile, namespace, nodeDefs = [], seed, cacheSize = 64 } = {}) {
  if (!dbFile) throw new Error('initVoidGraphLayer: dbFile 이 필요합니다');
  if (!namespace) throw new Error('initVoidGraphLayer: namespace 가 필요합니다');

  let db = null;    // DJinn 인스턴스
  let graph = null; // GraphDriver 인스턴스
  let initAttempted = false;
  let seeded = false;

  function dbPath() {
    return dbFile;
  }

  // ── DB 부트스트랩 — configDb.js 의 getDb() 패턴을 그대로 따른다 ───────────────────
  // (require 실패는 프로세스 수명 내내 영구 캐시, 인스턴스 생성 실패는 일시적일 수 있으니
  //  initAttempted 로 영구 차단하지 않는다.)
  function getGraph() {
    if (graph) return { djinn: db, graph };
    if (initAttempted) return null;

    let DJinn, GraphDriver;
    try {
      ({ DJinn, GraphDriver } = require('@d0iloppa/djinn'));
    } catch {
      initAttempted = true; // 패키지 자체가 없음 — 재시도해도 소용없으므로 영구 차단
      return null;
    }

    try {
      const isNew = !fs.existsSync(dbFile); // 반드시 new DJinn() 호출 전에 확인
      const instance = new DJinn(dbFile, { cacheSize });
      try { instance.db.pragma('busy_timeout = 3000'); } catch {}
      if (isNew) {
        try { fs.chmodSync(dbFile, 0o600); } catch {}
      }
      const g = GraphDriver.attach(instance);
      g.define(namespace, { nodes: nodeDefs });
      db = instance;
      graph = g;
      return { djinn: db, graph };
    } catch {
      return null; // 일시적 실패 — initAttempted 를 세우지 않으므로 다음 호출에서 재시도됨
    }
  }

  // 시드 — 멱등 보장은 seed 콜백 책임(호출부가 countDocs===0/존재 여부로 직접 가드).
  // getGraph() 가 null 이면(dJinn 불가) seed 콜백을 부르지 않고 바로 리턴 — seeded 플래그도
  // 세우지 않는다(다음 호출에서 dJinn 이 살아나면 다시 시도할 수 있게).
  function ensureSeeded() {
    const g = getGraph();
    if (!g) return;
    if (seeded) return;
    seeded = true;
    if (seed) seed(g);
  }

  return { dbPath, getGraph, ensureSeeded };
}

module.exports = { initVoidGraphLayer };
