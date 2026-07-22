'use strict';

// void-dispatch MCP 진입점 — 계정-교차 헤드리스 위임(lib/voidDispatch.js)을 MCP
// 툴로 노출하는 얇은 stdio 서버. 현재 세션의 Claude 가 delegate 툴을 호출하면
// 지정한 named session 프로파일(다른 계정)로 헤드리스 claude/codex 가 1회
// 실행되고, 그 inference 는 해당 계정의 토큰으로 청구된다.
//
// voidContextMcp.js 와 동일한 dual-role 패턴: require 되면 startVoidDispatchMcpServer
// 함수만 노출하고 부수효과가 없으며(voidDispatch require 만으로는 아무 프로세스도
// 띄우지 않는다), 직접 실행되면(require.main === module) stdio 서버를 띄운다.
// 실패 시 조용히 넘어가지 않고 stderr 로 알린 뒤 종료한다.
//
// SDK 사용은 lib/mcp-hub.js 와 동일하게 @modelcontextprotocol/sdk 의 McpServer 를
// 직접 쓴다(voidContextMcp 는 dJinn 그래프를 얹어야 해서 createMcpServer 를 썼지만,
// 여기는 그래프 백엔드가 없는 순수 액션 서버라 McpServer 로 충분하다).

const voidDispatch = require('./voidDispatch');

async function startVoidDispatchMcpServer() {
  let McpServer;
  let StdioServerTransport;
  let z;
  try {
    ({ McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js'));
    ({ StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js'));
    z = require('zod');
  } catch (e) {
    throw new Error(`MCP SDK 를 불러올 수 없습니다: ${e.message}`);
  }

  const server = new McpServer({ name: 'void-dispatch', version: '1.0.0' });
  const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

  server.registerTool(
    'list_profiles',
    {
      description: '헤드리스 위임 대상이 될 수 있는 named session 프로파일 목록과 각 프로파일의 로그인 준비 상태(ready/warnings)를 반환한다. delegate 호출 전에 어느 계정으로 위임 가능한지 확인하는 용도.',
      inputSchema: {
        tool_command: z.string().optional().describe("결과를 특정 tool 로 필터('claude'|'codex' 등). 생략 시 전체."),
      },
    },
    async ({ tool_command }) => {
      try {
        return ok(voidDispatch.listProfiles(tool_command));
      } catch (e) {
        return ok({ ok: false, error: e.message });
      }
    }
  );

  server.registerTool(
    'delegate',
    {
      description:
        '다른 계정 프로파일(named session)로 헤드리스 claude/codex 를 1회 실행해 작업을 위임하고 결과를 반환한다. ' +
        'inference 는 지정한 프로파일 계정의 토큰으로 청구된다 — 현재 세션의 토큰이 부족할 때 별도 구독 계정으로 ' +
        '서브에이전트 작업을 오프로딩하는 용도. 반환값에 result 본문과 usage/costUsd(그 계정이 실제로 쓴 사용량)를 포함한다. ' +
        '파일 편집·명령 실행 등 실작업을 시키려면 permission_mode(예: acceptEdits) 를 지정해야 한다.',
      inputSchema: {
        profile: z.string().describe('위임 대상 named session 이름(list_profiles 로 확인)'),
        prompt: z.string().describe('위임할 작업 프롬프트'),
        tool_command: z.string().optional().describe("대상 tool('claude' 기본 | 'codex')"),
        model: z.string().optional().describe('사용할 모델(선택)'),
        permission_mode: z.string().optional().describe('claude 권한 모드: default|acceptEdits|bypassPermissions|plan (실작업 시 필요)'),
        allowed_tools: z.array(z.string()).optional().describe('허용 툴 목록(선택)'),
        cwd: z.string().optional().describe('작업 디렉토리(기본: 현재 프로세스 cwd)'),
        timeout_ms: z.number().optional().describe('타임아웃 ms(기본 600000 = 10분)'),
      },
    },
    async (a) => {
      try {
        const r = await voidDispatch.delegate(a.prompt, {
          profile: a.profile,
          toolCommand: a.tool_command,
          model: a.model,
          permissionMode: a.permission_mode,
          allowedTools: a.allowed_tools,
          cwd: a.cwd,
          timeoutMs: a.timeout_ms,
        });
        return ok(r);
      } catch (e) {
        return ok({ ok: false, error: e.message });
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = { startVoidDispatchMcpServer };

if (require.main === module) {
  startVoidDispatchMcpServer().catch(e => {
    console.error(`[voidDispatchMcp] FAILED: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}
