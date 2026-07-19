'use strict';

// void-context MCP 진입점 — dJinn 내장 MCP(createMcpServer, vendor/dJinn/src/mcp.js)를 얹는
// 얇은 stdio 서버. void_context 네임스페이스가 이미 attach+define 되어 있으므로
// graph_catalog_void_context / graph_node_*_void_context / graph_doc_*_void_context 툴이
// createMcpServer() 안에서 자동으로 등록된다 — 단건 삭제(그래프 node/doc 1개)는 이 자동 툴만으로
// 이미 충분하다:
//   - graph_doc_del_void_context: task_context 엔트리(level-3 doc) 1건 삭제 — 예약 개념이 없어
//     그대로 써도 안전(voidContext.delTaskContext 와 동일한 delDoc 호출).
//   - graph_node_del_void_context: 컨텍스트(level-2 node) 삭제 — 하지만 key/node_id 아무거나
//     받아들이므로 '_schema' 예약 노드도 지울 수 있어버린다(가드 없음). 그리고 "전체 청소"에
//     해당하는 벌크 연산은 애초에 자동 등록 대상이 아니다(자동 툴은 항상 단건 지정).
//
// 그래서 아래 두 도메인 전용 툴만 최소로 추가한다 — voidContext.js 의 fail-hard 규율(delContext:
// '_' 로 시작하는 key 거부, vacuumContexts: '_schema' 는 _isReserved 필터로 순회 대상에서 애초에
// 제외)을 MCP 클라이언트에게도 그대로 강제하기 위함이다. createMcpServer 를 직접 호출해 server
// 인스턴스를 손에 쥔 뒤 tool 을 추가로 등록하고, 그다음에 stdio 트랜스포트를 연결한다(=serveMcp
// 를 그대로 쓰면 이 여지가 없어 직접 풀어썼다).
//
// lib/mcp-hub.js 와 같은 dual-role 패턴: require 되면 startVoidContextMcpServer 함수만 노출하고
// 부수효과가 없으며(voidContext require 만으로는 dJinn 을 건드리지 않음), 직접 실행되면
// (require.main === module) stdio 서버를 띄운다. 실패 시 조용히 넘어가지 않고 stderr 로 알린 뒤
// 종료한다.

const voidContext = require('./voidContext');

async function startVoidContextMcpServer() {
  let createMcpServer;
  try {
    ({ createMcpServer } = require('@d0iloppa/djinn'));
  } catch (e) {
    throw new Error(`@d0iloppa/djinn 을 불러올 수 없습니다: ${e.message}`);
  }

  let StdioServerTransport;
  let z;
  try {
    ({ StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js'));
    ({ z } = require('zod'));
  } catch (e) {
    throw new Error(`MCP SDK 를 불러올 수 없습니다: ${e.message}`);
  }

  const g = voidContext.getGraph();
  if (!g) {
    throw new Error('voidContext.getGraph() 가 null 을 반환했습니다 — dJinn 을 사용할 수 없습니다(void-context DB 초기화 실패)');
  }

  const server = createMcpServer(g.djinn, { name: 'void-context', version: '1.0.0' });

  const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const err = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }] });

  server.tool(
    'void_context_del',
    "컨텍스트(task_id) 1건 + 그 아래 모든 task_context 엔트리를 삭제한다. '_'로 시작하는 예약 노드(_schema 등)는 거부된다.",
    { task_id: z.string().describe('삭제할 컨텍스트의 task_id') },
    async ({ task_id }) => {
      try {
        return ok(voidContext.delContext(task_id));
      } catch (e) {
        return err(e.message);
      }
    }
  );

  server.tool(
    'void_context_vacuum',
    "예약 노드(_schema)를 제외한 모든 컨텍스트(+엔트리)를 삭제한다. workspace 지정 시 해당 workspace 소속 컨텍스트만 대상으로 한다.",
    { workspace: z.string().optional().describe('지정 시 이 workspace 소속 컨텍스트만 삭제') },
    async ({ workspace }) => {
      try {
        return ok(voidContext.vacuumContexts({ workspace }));
      } catch (e) {
        return err(e.message);
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = { startVoidContextMcpServer };

if (require.main === module) {
  startVoidContextMcpServer().catch(e => {
    console.error(`[voidContextMcp] FAILED: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}
