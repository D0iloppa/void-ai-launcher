'use strict';

// void-context MCP 진입점 — dJinn 내장 MCP(createMcpServer/serveMcp, vendor/dJinn/src/mcp.js)를
// 그대로 얹는 얇은 stdio 서버. void_context 네임스페이스가 이미 attach+define 되어 있으므로
// graph_catalog_void_context / graph_node_*_void_context / graph_doc_*_void_context 툴이
// serveMcp() 안에서 자동으로 등록된다 — 이 파일은 도메인 전용 툴(void_context_put 등)을 직접
// 만들지 않는다(MVP 범위: dJinn 내장 MCP 만 사용, 커스텀 MCP 서버 없음).
//
// lib/mcp-hub.js 와 같은 dual-role 패턴: require 되면 startVoidContextMcpServer 함수만 노출하고
// 부수효과가 없으며(voidContext require 만으로는 dJinn 을 건드리지 않음), 직접 실행되면
// (require.main === module) stdio 서버를 띄운다. 실패 시 조용히 넘어가지 않고 stderr 로 알린 뒤
// 종료한다.

const voidContext = require('./voidContext');

async function startVoidContextMcpServer() {
  let serveMcp;
  try {
    ({ serveMcp } = require('@d0iloppa/djinn'));
  } catch (e) {
    throw new Error(`@d0iloppa/djinn 을 불러올 수 없습니다: ${e.message}`);
  }

  const g = voidContext.getGraph();
  if (!g) {
    throw new Error('voidContext.getGraph() 가 null 을 반환했습니다 — dJinn 을 사용할 수 없습니다(void-context DB 초기화 실패)');
  }

  return serveMcp(g.djinn, { name: 'void-context', version: '1.0.0' });
}

module.exports = { startVoidContextMcpServer };

if (require.main === module) {
  startVoidContextMcpServer().catch(e => {
    console.error(`[voidContextMcp] FAILED: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}
