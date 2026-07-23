'use strict';

// void-notify MCP 진입점 — Transactional Outbox(lib/voidNotify.js)를 MCP 툴로 노출하는 얇은
// stdio 서버.
//
// voidContextMcp.js 처럼 createMcpServer(g.djinn) (dJinn 내장 MCP, vendor/dJinn/src/mcp.js) 를
// 얹지 않는다 — 그러면 graph_doc_put_void_notify 같은 raw 다큐먼트 put 툴이 자동으로 노출돼
// MCP 클라이언트가 lease_owner/lease_expires_at/status 같은 내부 동시성 필드를 직접 덮어써
// 워커의 CAS 클레임을 깨뜨릴 수 있다. 그래서 voidDispatchMcp.js 와 동일하게 plain McpServer(
// @modelcontextprotocol/sdk) + zod 로 손수 툴을 정의하고, lib/voidNotify.js 가 제공하는 안전한
// 함수(putDoc 직접 노출 없음)만 통과시킨다.
//
// voidDispatchMcp.js 와 동일한 dual-role 패턴: require 되면 startVoidNotifyMcpServer 함수만
// 노출하고 부수효과가 없으며(voidNotify require 만으로는 dJinn 을 건드리지 않는다 — getGraph()
// 는 지연 초기화), 직접 실행되면(require.main === module) stdio 서버를 띄운다. 실패 시 조용히
// 넘어가지 않고 stderr 로 알린 뒤 종료한다.

const voidNotify = require('./voidNotify');

async function startVoidNotifyMcpServer() {
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

  const server = new McpServer({ name: 'void-notify', version: '1.0.0' });
  const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const fail = (e) => ok({ ok: false, error: e && e.message ? e.message : String(e) });

  server.registerTool(
    'notify',
    {
      description:
        '메시지 1건을 void-notify 큐에 등록(enqueue)한다. when 이 "now"(기본) 이면 즉시 발송 대상, ' +
        'ISO 타임스탬프면 그 시각 이후 다음 워커 폴링(1분 간격)에서 발송된다. provider_key 채널은 ' +
        'notify_put_channel 로 미리 등록·활성화돼 있어야 한다.',
      inputSchema: {
        when: z.string().optional().describe('"now"(기본) 또는 ISO 타임스탬프'),
        subject: z.string().describe('메시지 제목'),
        content: z.string().describe('메시지 본문'),
        provider_key: z.string().describe('발송에 쓸 채널 alias(notify_list_channels 로 확인)'),
      },
    },
    async ({ when, subject, content, provider_key }) => {
      try {
        return ok(voidNotify.notify({ when, subject, content, provider_key }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'notify_put_channel',
    {
      description:
        '알림 채널(현재 telegram 만)을 등록/갱신한다. api_key 는 평문으로 전달하되 저장 시 ' +
        'AES-256-GCM 으로 암호화되며, 어떤 조회 응답에도 평문/암호문이 노출되지 않는다.',
      inputSchema: {
        alias: z.string().describe("채널 별칭(고유 키, '_' 로 시작 불가)"),
        kind: z.string().optional().describe('채널 종류(기본 telegram, 현재 유일 지원)'),
        label: z.string().optional().describe('표시용 라벨(기본 alias)'),
        api_key: z.string().describe('평문 API 키/봇 토큰 — 저장 시 암호화됨'),
        send_to: z.array(z.string()).describe('수신 대상 chat id 목록(telegram)'),
        enabled: z.boolean().optional().describe('활성화 여부(기본 true)'),
      },
    },
    async ({ alias, kind, label, api_key, send_to, enabled }) => {
      try {
        return ok(voidNotify.putChannel({ alias, kind, label, api_key, send_to, enabled }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'notify_list_channels',
    {
      description: '등록된 채널 목록을 반환한다. api_key(평문/암호문 모두)는 절대 포함되지 않는다.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(voidNotify.listChannels());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'notify_del_channel',
    {
      description: "채널 1건 + 그 아래 큐에 남은 모든 항목을 삭제한다. '_' 로 시작하는 예약 노드는 거부된다.",
      inputSchema: {
        alias: z.string().describe('삭제할 채널 alias'),
      },
    },
    async ({ alias }) => {
      try {
        return ok(voidNotify.delChannel(alias));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'notify_list_queue',
    {
      description: '큐 항목 상태를 읽기 전용으로 조회한다(status/channel_key 로 필터 가능). 비밀정보 없음.',
      inputSchema: {
        channel_key: z.string().optional().describe('이 채널의 큐 항목만'),
        status: z.string().optional().describe('queued|locked|sent|failed 중 하나로 필터'),
        limit: z.number().optional(),
        offset: z.number().optional(),
      },
    },
    async ({ channel_key, status, limit, offset }) => {
      try {
        return ok(voidNotify.listQueue({ channelKey: channel_key, status, limit, offset }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = { startVoidNotifyMcpServer };

if (require.main === module) {
  startVoidNotifyMcpServer().catch(e => {
    console.error(`[voidNotifyMcp] FAILED: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}
