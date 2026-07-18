'use strict';

// 모델 라우팅 애그리게이터 — dJinn (vendor/dJinn, @d0iloppa/djinn) 0.2.0 Graph Catalog 백엔드.
//
// /mnt/c/DEV/docker/models/router.py + tasks/_common.py + tasks/*.py + models.json 의
// "라우팅 로직" 을 Node 로 이식한 모듈이다. 파일 산출(--out/저장 경로), codex 서브프로세스,
// imggen.py 위임, dGraph 이력 기록, 원격/로컬 STT 는 v1 범위 밖(design 문서 4번 항목) —
// 이 모듈은 in-memory Buffer/문자열/객체만 돌려주고 영속화는 호출부 책임이다.
//
// 저장 구조 — vendor/dJinn/src/graph.js 의 GraphDriver: root(node_id=1, 고정) →
// node(parent_id=1, task 당 1개) → doc(parent_id=해당 node.node_id, 라우팅 항목 1개당 1개).
// docId = `${task}::${entry.id}` (GraphDriver.makeDocId 내부 규약).
//
// configDb.js/usageDb.js 와 관심사를 분리하기 위해 별도 SQLite 파일(aggregator.djinn.db)을 쓴다
// — 같은 storageDir() 안에 있지만 다른 파일이므로 그 두 모듈의 'config'/'usage_cache' 컬렉션과는
// 물리적으로 완전히 독립이다(이 파일 안에서 namespace 이름으로 'config' 를 재사용해도 충돌 없음).
//
// ── dJinn 불가 시 폴백 (usageDb.js 가 아니라 configDb.js 의 비대칭 폴백 규율을 따름) ──────
// 채팅/이미지생성/TTS/STT/임베딩 라우팅 설정은 앱이 도구를 실행하는 데 필수인 부팅 데이터에
// 준한다 — dJinn 이 어떤 이유로든 불가능해도 DEFAULT_ENTRIES/DEFAULT_IMAGEGEN_CHAIN 메모리
// 상수로 항상 "쓸 수 있는 무언가" 를 돌려준다(configDb.getTools 가 dJinn 불가 시 DEFAULT_TOOLS
// 로 폴백하는 것과 동일한 이유). 반면 쓰기(putEntry/setImagegenChain)는 영속화할 곳이 없으면
// 조용히 성공한 척 하지 않고 명확한 Error 를 던진다 — 침묵 무시가 사용자에게 "저장됐다"는
// 착각을 주는 게 더 위험하기 때문.

const fs   = require('fs');
const path = require('path');
const { Readable } = require('node:stream');
const { storageDir } = require('./storage');
const config = require('./config');

const NS = 'config'; // GraphDriver 네임스페이스(이 파일 전용 DB 안이므로 configDb.js 의 'config' 컬렉션과 무관)

// 실제로 호출 가능한 라우팅 task. imagegen_chain/_catalog 는 이 목록에 넣지 않는다 —
// 그 둘은 "선택 가능한 항목의 목록" 이 아니라 각각 폴백 체인/참고 카탈로그라는 별도 개념이라
// getImagegenChain()/getCatalogInfo() 로 따로 접근한다.
const TASKS = ['chat', 'imagegen', 'tts', 'stt', 'embedding'];

// graph.define() 시드용 노드 정의 — task 당 1개 + 체인/카탈로그 노드.
const NODE_DEFS = [
  { key: 'chat',           description: 'LLM 채팅 라우팅 항목' },
  { key: 'imagegen',       description: '이미지 생성 라우팅 항목' },
  { key: 'imagegen_chain', description: '이미지 생성 폴백 체인(그룹별 provider:model 후보, order=그룹 순번)' },
  { key: 'tts',            description: 'TTS(음성 합성) 라우팅 항목' },
  { key: 'stt',            description: 'STT(음성 전사) 라우팅 항목' },
  { key: 'embedding',      description: '임베딩 라우팅 항목' },
  { key: '_catalog',       description: 'NVIDIA NIM 등 참고용 모델 카탈로그(정보 제공 전용, 실행 경로 아님)' },
];

// ── 기본값 — models.json 의 코드측 미러 (외부 파일을 읽지 않는다. configDb.js 의
//    DEFAULT_TOOLS 패턴과 동일하게 이 파일 안에 하드코딩해 최초 실행에서도 항상 시드된다) ──
// codex/imggen/remote/local provider 항목도 카탈로그 완전성을 위해 그대로 포함하지만,
// 이 모듈은 그 provider 들을 실행할 수 없다(call/callStream 이 명확한 Error 로 거부).
const DEFAULT_ENTRIES = {
  chat: [
    { id: 'NVIDIA_MASTER', provider: 'nvidia', model: 'nvidia/llama-3.3-nemotron-super-49b-v1.5' },
  ],
  imagegen: [
    { id: 'gemini',        provider: 'imggen', model: 'gemini-3.1-flash-image' },
    { id: 'NVIDIA_MASTER', provider: 'nvidia', model: 'black-forest-labs/flux.1-dev', params: { steps: 20 } },
    { id: 'codex',         provider: 'codex' },
  ],
  tts: [
    { id: 'gemini', provider: 'gemini', model: 'gemini-2.5-flash-preview-tts', voice: 'Kore' },
  ],
  stt: [
    { id: 'whisper_remote', provider: 'remote', language: '', timeout: 600 },
    { id: 'local',          provider: 'local', model: 'base', sandbox: 'dobis-sandbox:latest', timeout: 1800 },
    { id: 'gemini',         provider: 'gemini', model: 'gemini-2.5-flash' },
  ],
  embedding: [
    { id: 'NVIDIA_MASTER', provider: 'nvidia', model: 'nvidia/llama-nemotron-embed-1b-v2', input_type: 'query' },
    { id: 'gemini',        provider: 'gemini', model: 'gemini-embedding-001' },
  ],
};

// models.json 최상위 imagegen_chain — 바깥 배열 순서대로 provider 그룹을 시도하고,
// 각 그룹에서는 0번(첫 항목)만 자동 폴백 후보로 쓴다(나머지는 --id 로 명시 선택할 때의 메뉴).
const DEFAULT_IMAGEGEN_CHAIN = [
  ['NVIDIA_MASTER:flux.2-klein-4b'],
  ['codex:gpt-5.4'],
  ['gemini:gemini-3.1-flash-image', 'gemini:gemini-2.0-flash-preview-image-generation'],
];

// models.json 의 "_catalog" — NVIDIA_MASTER 키로 호출 가능한 NIM 모델 전체 목록(정보 제공용,
// 실행 경로에서 참조되지 않음). 2026-07-03 /v1/models 조회 기준 원본 그대로 이식.
const DEFAULT_CATALOG = {
  note: 'NVIDIA_MASTER 키로 사용 가능한 NIM 모델 전체 (2026-07-03 /v1/models 조회, 121개). ' +
        '다른 모델을 쓰려면 해당 task 에 model 오버라이드로 지정하거나 항목으로 승격. ' +
        'flux.1-schnell 은 무응답(EOL 추정) — flux.1-dev 검증됨.',
  chat: [
    '01-ai/yi-large', 'abacusai/dracarys-llama-3.1-70b-instruct', 'ai21labs/jamba-1.5-large-instruct',
    'aisingapore/sea-lion-7b-instruct', 'bytedance/seed-oss-36b-instruct', 'databricks/dbrx-instruct',
    'deepseek-ai/deepseek-v4-flash', 'deepseek-ai/deepseek-v4-pro', 'google/gemma-2-2b-it',
    'google/gemma-2b', 'google/gemma-3-12b-it', 'google/gemma-3-4b-it', 'google/gemma-3n-e2b-it',
    'google/gemma-3n-e4b-it', 'google/gemma-4-31b-it', 'google/recurrentgemma-2b',
    'ibm/granite-3.0-3b-a800m-instruct', 'ibm/granite-3.0-8b-instruct', 'meta/llama-3.1-70b-instruct',
    'meta/llama-3.1-8b-instruct', 'meta/llama-3.2-1b-instruct', 'meta/llama-3.2-3b-instruct',
    'meta/llama-3.3-70b-instruct', 'meta/llama-4-maverick-17b-128e-instruct', 'meta/llama2-70b',
    'microsoft/phi-3.5-moe-instruct', 'microsoft/phi-4-mini-instruct', 'minimaxai/minimax-m2.7',
    'minimaxai/minimax-m3', 'mistralai/ministral-14b-instruct-2512', 'mistralai/mistral-7b-instruct-v0.3',
    'mistralai/mistral-large', 'mistralai/mistral-large-2-instruct', 'mistralai/mistral-large-3-675b-instruct-2512',
    'mistralai/mistral-medium-3.5-128b', 'mistralai/mistral-nemotron', 'mistralai/mistral-small-4-119b-2603',
    'mistralai/mixtral-8x22b-v0.1', 'mistralai/mixtral-8x7b-instruct-v0.1', 'moonshotai/kimi-k2.6',
    'nv-mistralai/mistral-nemo-12b-instruct', 'nvidia/llama-3.1-nemotron-51b-instruct',
    'nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia/llama-3.1-nemotron-nano-8b-v1',
    'nvidia/llama-3.1-nemotron-ultra-253b-v1', 'nvidia/llama-3.3-nemotron-super-49b-v1',
    'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'nvidia/llama3-chatqa-1.5-70b',
    'nvidia/mistral-nemo-minitron-8b-8k-instruct', 'nvidia/nemotron-3-nano-30b-a3b',
    'nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/nemotron-4-340b-instruct', 'nvidia/nemotron-mini-4b-instruct', 'nvidia/nemotron-nano-3-30b-a3b',
    'nvidia/nvidia-nemotron-nano-9b-v2', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
    'qwen/qwen3-next-80b-a3b-instruct', 'qwen/qwen3.5-122b-a10b', 'qwen/qwen3.5-397b-a17b',
    'sarvamai/sarvam-m', 'stepfun-ai/step-3.5-flash', 'stepfun-ai/step-3.7-flash',
    'stockmark/stockmark-2-100b-instruct', 'upstage/solar-10.7b-instruct', 'writer/palmyra-creative-122b',
    'writer/palmyra-fin-70b-32k', 'writer/palmyra-med-70b', 'writer/palmyra-med-70b-32k',
    'z-ai/glm-5.2', 'zyphra/zamba2-7b-instruct',
  ],
  code: [
    'bigcode/starcoder2-15b', 'deepseek-ai/deepseek-coder-6.7b-instruct', 'google/codegemma-1.1-7b',
    'google/codegemma-7b', 'ibm/granite-34b-code-instruct', 'ibm/granite-8b-code-instruct',
    'meta/codellama-70b', 'mistralai/codestral-22b-instruct-v0.1',
  ],
  embedding: [
    'baai/bge-m3', 'nvidia/embed-qa-4', 'nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1',
    'nvidia/llama-3.2-nv-embedqa-1b-v1', 'nvidia/llama-nemotron-embed-1b-v2',
    'nvidia/llama-nemotron-embed-vl-1b-v2', 'nvidia/nv-embed-v1', 'nvidia/nv-embedcode-7b-v1',
    'nvidia/nv-embedqa-e5-v5', 'nvidia/nv-embedqa-mistral-7b-v2', 'snowflake/arctic-embed-l',
  ],
  etc: [
    'google/diffusiongemma-26b-a4b-it', 'nvidia/ai-synthetic-video-detector',
    'nvidia/ising-calibration-1-35b-a3b', 'nvidia/nemoretriever-parse',
    'nvidia/nemotron-4-340b-reward', 'nvidia/nemotron-parse',
  ],
  safety: [
    'meta/llama-guard-4-12b', 'nvidia/gliner-pii', 'nvidia/llama-3.1-nemoguard-8b-content-safety',
    'nvidia/llama-3.1-nemoguard-8b-topic-control', 'nvidia/llama-3.1-nemotron-safety-guard-8b-v3',
    'nvidia/nemotron-3-content-safety', 'nvidia/nemotron-3.5-content-safety',
    'nvidia/nemotron-content-safety-reasoning-4b',
  ],
  translate: ['nvidia/riva-translate-4b-instruct', 'nvidia/riva-translate-4b-instruct-v1.1'],
  vision: [
    'adept/fuyu-8b', 'google/deplot', 'meta/llama-3.2-11b-vision-instruct',
    'meta/llama-3.2-90b-vision-instruct', 'microsoft/kosmos-2', 'microsoft/phi-3-vision-128k-instruct',
    'microsoft/phi-4-multimodal-instruct', 'nvidia/cosmos-reason2-8b',
    'nvidia/llama-3.1-nemotron-nano-vl-8b-v1', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    'nvidia/nemotron-nano-12b-v2-vl', 'nvidia/neva-22b', 'nvidia/nvclip', 'nvidia/vila',
  ],
};

// 'provider' 또는 'provider:model' 문자열에서 provider 별칭 해석용 기본 테이블
// (router.py 의 NVIDIA_ID_ALIASES 이식 — 소문자 키로 매칭).
const DEFAULT_ALIAS_MAP = { nvidia: 'NVIDIA_MASTER' };

// NVIDIA genai 로 생성 가능한 이미지 모델의 짧은 이름 → 실제 슬러그 (router.py NVIDIA_IMAGE_MODELS 이식).
const NVIDIA_IMAGE_MODELS = {
  'flux.1-dev':               'black-forest-labs/flux.1-dev',
  'flux.2-klein-4b':          'black-forest-labs/flux.2-klein-4b',
  'flux.1-schnell':           'black-forest-labs/flux.1-schnell',
  'stable-diffusion-3-medium': 'stabilityai/stable-diffusion-3-medium',
};

const DEFAULT_STT_PROMPT = '이 오디오를 원문 그대로 전사하라. 전사 텍스트만 출력하고 다른 말은 붙이지 마라.';

let db    = null; // DJinn 인스턴스
let graph = null; // GraphDriver 인스턴스
let initAttempted = false;
let seeded = false;

function dbPath() {
  return path.join(storageDir(), 'aggregator.djinn.db');
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
    return null; // 모든 공개 접근자는 DEFAULT_ENTRIES/DEFAULT_IMAGEGEN_CHAIN 메모리 폴백으로 동작
  }

  try {
    const file = dbPath();
    const isNew = !fs.existsSync(file); // 반드시 new DJinn() 호출 전에 확인 — configDb.js 와 동일 순서
    const instance = new DJinn(file, { cacheSize: 64 });
    try { instance.db.pragma('busy_timeout = 3000'); } catch {}
    if (isNew) {
      try { fs.chmodSync(file, 0o600); } catch {}
    }
    const g = GraphDriver.attach(instance);
    g.define(NS, { nodes: NODE_DEFS });
    db = instance;
    graph = g;
    return { djinn: db, graph };
  } catch {
    return null;
  }
}

// 시드 — 멱등, 사용자가 이미 편집한 항목은 절대 덮어쓰지 않는다(task 당 countDocs===0 일 때만).
// dJinn 불가 시 아무 것도 하지 않는다(모든 읽기 경로가 DEFAULT_* 상수로 직접 폴백하므로 여기서
// 할 일이 없음) — seeded 플래그는 "그래프에 실제로 시드했음" 만 의미하고, dJinn 불가 상태는
// 매 호출 getGraph() 가 즉시 null 을 재확인해주므로(캐시된 initAttempted) 영구 차단할 필요 없음.
function ensureSeeded() {
  const g = getGraph();
  if (!g) return;
  if (seeded) return;
  seeded = true;

  for (const task of TASKS) {
    if (g.graph.countDocs(NS, task) === 0) {
      (DEFAULT_ENTRIES[task] || []).forEach((entry, i) => {
        g.graph.putDoc(NS, task, entry.id, { ...entry, order: i }, { autoCreateNode: true });
      });
    }
  }
  if (g.graph.countDocs(NS, 'imagegen_chain') === 0) {
    DEFAULT_IMAGEGEN_CHAIN.forEach((specs, i) => {
      g.graph.putDoc(NS, 'imagegen_chain', String(i), { specs: [...specs], order: i }, { autoCreateNode: true });
    });
  }
  if (g.graph.countDocs(NS, '_catalog') === 0) {
    g.graph.putDoc(NS, '_catalog', 'nvidia', { ...DEFAULT_CATALOG }, { autoCreateNode: true });
  }
}

// *** 정렬 트랩 — graph.listDocs() 는 child_key(=entry.id) 알파벳순으로 정렬해 돌려준다.
//     models.json 의 의미론은 "배열의 첫 항목 = 기본값" 이므로, 이 알파벳 정렬을 그대로 쓰면
//     사전순으로 앞선 id 를 가진 항목이 조용히 기본값이 되어버린다(예: 'AAA_TEST' 를 하나
//     넣기만 해도 원래 기본값이 밀려남). 그래서 모든 doc 은 data.order(원본 배열 인덱스)를
//     반드시 들고 있고, 아래 정렬 함수로 읽기 시점에 항상 재정렬한다 — 이 파일에서 가장 위험한
//     버그 지점이므로 절대 생략하지 말 것. ***
function sortByOrder(entries) {
  return [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function docsToEntries(docs) {
  return docs.map(d => ({ ...d.data }));
}

// ── 카탈로그 CRUD ──────────────────────────────────────────────────────────

function listTasks() {
  ensureSeeded();
  return [...TASKS];
}

function listEntries(task) {
  ensureSeeded();
  const g = getGraph();
  if (!g) {
    // dJinn 불가 — 메모리 기본값에도 명시적으로 order 를 채워 동일한 재정렬 경로를 태운다.
    return sortByOrder((DEFAULT_ENTRIES[task] || []).map((e, i) => ({ order: i, ...e })));
  }
  const docs = g.graph.listDocs(NS, task); // child_key(=id) 알파벳순 — 아래에서 반드시 재정렬
  return sortByOrder(docsToEntries(docs)); // *** order 재정렬 (위 트랩 주석 참고) ***
}

function getEntry(task, id) {
  ensureSeeded();
  const g = getGraph();
  if (!g) {
    const e = (DEFAULT_ENTRIES[task] || []).find(x => x.id === id);
    return e ? { ...e } : null;
  }
  const doc = g.graph.getDoc(NS, task, id);
  return doc ? { ...doc.data } : null;
}

function putEntry(task, entry) {
  ensureSeeded();
  if (!entry || typeof entry !== 'object' || !entry.id) {
    throw new Error("aggregator.putEntry: entry.id 가 필요합니다");
  }
  const id = String(entry.id);
  if (id.includes('::')) {
    // GraphDriver._assertKey 도 이걸 걸러내지만, 원인이 뭔지 알 수 없는 제네릭 에러를 던지므로
    // 여기서 먼저 잡아 실행 가능한(actionable) 메시지를 준다.
    throw new Error(`aggregator.putEntry: entry.id 에 '::' 를 포함할 수 없습니다 (got '${id}')`);
  }
  const g = getGraph();
  if (!g) {
    throw new Error('aggregator.putEntry: dJinn 을 사용할 수 없어 저장할 곳이 없습니다(읽기 전용 메모리 폴백 모드)');
  }
  let order = entry.order;
  if (order == null) {
    const existing = listEntries(task);
    order = existing.length ? Math.max(...existing.map(e => e.order ?? 0)) + 1 : 0;
  }
  const data = { ...entry, id, order };
  return g.graph.putDoc(NS, task, id, data, { autoCreateNode: true });
}

function deleteEntry(task, id) {
  ensureSeeded();
  const g = getGraph();
  if (!g) return false; // 메모리 폴백 모드 — 지울 영속 저장소 자체가 없음
  const existed = !!g.graph.getDoc(NS, task, id);
  if (existed) g.graph.delDoc(NS, task, id);
  return existed;
}

// entryId 생략('') → 기본 항목(=order 0). 있는데 못 찾으면 RuntimeError(Python 쪽 관례 미러).
function taskCfg(task, entryId = '') {
  ensureSeeded();
  const entries = listEntries(task); // 이미 order 로 정렬됨
  if (entryId) {
    const found = entries.find(e => e.id === entryId);
    if (!found) {
      throw new Error(`aggregator.taskCfg: '${task}' 에 id='${entryId}' 항목이 없습니다`);
    }
    return { ...found };
  }
  return entries.length ? { ...entries[0] } : {};
}

function getImagegenChain() {
  ensureSeeded();
  const g = getGraph();
  if (!g) {
    return DEFAULT_IMAGEGEN_CHAIN.map(specs => [...specs]);
  }
  const docs = g.graph.listDocs(NS, 'imagegen_chain'); // child_key(='0','1',...) 문자열 알파벳순
  // *** order 재정렬 — 문자열 정렬이면 '10' 이 '2' 보다 앞에 오는 것도 방지된다 ***
  const sorted = [...docs].sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0));
  return sorted.map(d => [...(d.data.specs || [])]);
}

function setImagegenChain(chain) {
  ensureSeeded();
  if (!Array.isArray(chain)) {
    throw new Error('aggregator.setImagegenChain: chain 은 배열이어야 합니다');
  }
  const g = getGraph();
  if (!g) {
    throw new Error('aggregator.setImagegenChain: dJinn 을 사용할 수 없어 저장할 곳이 없습니다(읽기 전용 메모리 폴백 모드)');
  }
  // 전체 교체 — 기존 그룹을 모두 지운 뒤 새 순서로 다시 쓴다(멱등한 upsert 대신 clean rewrite).
  // transaction 으로 감싸 중간에 끊겨도(프로세스 kill 등) 반쪽짜리 체인이 남지 않게 한다.
  g.djinn.transaction(() => {
    const existing = g.graph.listDocs(NS, 'imagegen_chain', { keysOnly: true });
    for (const d of existing) g.graph.delDoc(NS, 'imagegen_chain', d.child_key);
    chain.forEach((specs, i) => {
      g.graph.putDoc(NS, 'imagegen_chain', String(i), { specs: [...specs], order: i }, { autoCreateNode: true });
    });
  });
}

function getCatalogInfo() {
  ensureSeeded();
  const g = getGraph();
  if (!g) return { ...DEFAULT_CATALOG };
  const doc = g.graph.getDoc(NS, '_catalog', 'nvidia');
  return doc ? { ...doc.data } : null;
}

// ── provider spec 파싱 (router.py _parse_provider_spec 이식, 순수 함수) ───────────────
// 'codex' → {providerId:'codex', modelOverride:''} / 'NVIDIA:flux.1-dev' →
// {providerId:'NVIDIA_MASTER', modelOverride:'flux.1-dev'}
function parseProviderSpec(spec, aliasMap = DEFAULT_ALIAS_MAP) {
  const str = String(spec);
  const idx = str.indexOf(':'); // python str.partition(":") 과 동일하게 첫 ':' 기준으로만 분리
  const pid = idx === -1 ? str : str.slice(0, idx);
  const model = idx === -1 ? '' : str.slice(idx + 1);
  const providerId = Object.prototype.hasOwnProperty.call(aliasMap, pid.toLowerCase())
    ? aliasMap[pid.toLowerCase()]
    : pid;
  return { providerId, modelOverride: model };
}

// ── API 키 해석 — entry.id 가 곧 configDb 의 service 이름이다(별도 키 스킴을 만들지 않는다) ──
function resolveApiKey(entry, alias = null) {
  const service = entry && entry.id;
  const token = service ? config.getToken(service, alias) : null;
  if (!token) {
    throw new Error(
      `aggregator: '${service}' 서비스의 API 키가 없습니다 — Tokens 메뉴에서 서비스 '${service}' 를 등록하세요`
    );
  }
  return token;
}

// ── 직접 REST 호출 ──────────────────────────────────────────────────────────
// fetch 에는 timeout 옵션이 없다 — 반드시 AbortSignal.timeout() 으로 걸어야 한다(잊으면 hang).

async function callGemini(model, payload, { apiKey, method = 'generateContent', timeout = 120000 } = {}) {
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}`);
  url.searchParams.set('key', apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// method 가 절대 URL(genai 등 ai.api.nvidia.com 계열)이면 그대로 쓰고, 아니면
// integrate.api.nvidia.com/v1/<method>(OpenAI 호환)로 조립한다.
async function callNvidia(model, payload, { apiKey, method = 'chat/completions', timeout = 120000 } = {}) {
  const url = method.startsWith('http') ? method : `https://integrate.api.nvidia.com/v1/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// SSE 파싱 공통 — 청크 경계에서 잘린 멀티바이트 문자를 위해 단일 TextDecoder 를 스트림
// 전체에 걸쳐 재사용(stream:true)한다. line 단위로 잘라 'data: ' 이벤트를 누적하고,
// 모델이 content 안에 실제 개행을 그대로 보내는 경우(json.parse 실패)엔 다음 줄과 이어붙여
// 재시도한다 — _common.py 의 _stream_nvidia/_stream_gemini 버퍼링 규칙을 그대로 이식.
async function* _sseLines(res) {
  const decoder = new TextDecoder('utf-8');
  let carry = ''; // 아직 개행이 오지 않은 미완성 라인
  for await (const chunk of Readable.fromWeb(res.body)) {
    carry += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = carry.indexOf('\n')) !== -1) {
      let line = carry.slice(0, idx);
      carry = carry.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      yield line;
    }
  }
  carry += decoder.decode(); // 남은 멀티바이트 flush
  if (carry) yield carry;
}

async function* streamGemini(model, payload, { apiKey, timeout = 120000 } = {}) {
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('alt', 'sse');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  }
  let buf = ''; // 'data: ' 이벤트 누적 버퍼(멀티라인 JSON 대비)
  for await (const line of _sseLines(res)) {
    if (!buf) {
      if (!line || !line.startsWith('data: ')) continue; // keep-alive/빈 줄/주석 skip
      buf = line.slice('data: '.length);
    } else {
      buf += '\n' + line; // 실제 개행이 content 안에 온 경우 — 이어붙여 재파싱 시도
    }
    let chunk;
    try {
      chunk = JSON.parse(buf);
    } catch {
      continue; // 아직 불완전한 JSON — 다음 줄과 이어붙여 재시도
    }
    buf = '';
    const parts = (((chunk.candidates || [])[0] || {}).content || {}).parts || [];
    for (const part of parts) {
      if (part.text) yield part.text;
    }
  }
}

async function* streamNvidia(model, payload, { apiKey, timeout = 120000 } = {}) {
  // payload 는 호출측(chat 등)이 이미 model 필드를 채워 넘긴다 — _stream_nvidia 와 동일하게
  // 여기서 model 인자 자체는 URL/payload 조립에 쓰지 않는다(시그니처 통일을 위해서만 받음).
  const body = { ...payload, stream: true };
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  }
  let buf = '';
  for await (const line of _sseLines(res)) {
    if (!buf) {
      if (!line || !line.startsWith('data: ')) continue;
      buf = line.slice('data: '.length);
    } else {
      buf += '\n' + line;
    }
    if (buf === '[DONE]') return; // 종료 센티널
    let obj;
    try {
      obj = JSON.parse(buf);
    } catch {
      continue;
    }
    buf = '';
    const choices = obj.choices || [];
    if (!choices.length) continue; // 마지막 usage-only 청크 등 choices 빈 경우
    const delta = (choices[0].delta || {}).content || '';
    if (delta) yield delta;
  }
}

const _PROVIDERS        = { gemini: callGemini, nvidia: callNvidia };
const _STREAM_PROVIDERS = { gemini: streamGemini, nvidia: streamNvidia };

// entry(카탈로그 항목)의 provider 로 API 호출. model 인자로 entry.model 오버라이드.
// codex/imggen/remote/local 처럼 이 모듈이 실행할 수 없는 provider 는 명확한 Error 로 거부한다
// (해당 항목들은 카탈로그 완전성을 위해 시드되어 있을 뿐 실행 경로가 없다).
async function call(entry, payload, { method, timeout = 120000, model } = {}) {
  const provider = entry.provider || 'gemini';
  const fn = _PROVIDERS[provider];
  if (!fn) {
    throw new Error(`aggregator: 지원하지 않는 provider '${provider}' (가능: ${Object.keys(_PROVIDERS).join(', ')})`);
  }
  const apiKey = resolveApiKey(entry);
  const resolvedModel = model || entry.model;
  const opts = { apiKey, timeout };
  if (method !== undefined) opts.method = method;
  return fn(resolvedModel, payload, opts);
}

async function* callStream(entry, payload, { timeout = 120000, model } = {}) {
  const provider = entry.provider || 'gemini';
  const fn = _STREAM_PROVIDERS[provider];
  if (!fn) {
    throw new Error(
      `aggregator: provider '${provider}' 는 스트리밍을 지원하지 않습니다 (가능: ${Object.keys(_STREAM_PROVIDERS).join(', ')})`
    );
  }
  const apiKey = resolveApiKey(entry);
  const resolvedModel = model || entry.model;
  yield* fn(resolvedModel, payload, { apiKey, timeout });
}

// ── WAV — Gemini TTS 는 raw PCM(L16, 기본 24kHz mono) 을 base64 로 반환한다.
//    라이브러리 없이 44바이트 RIFF/WAVE 헤더를 직접 써서 감싼다. ──
function wrapPcmAsWav(pcm, sampleRate, numChannels = 1, bitsPerSample = 16) {
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);         // 이후 남은 바이트 수(RIFF 청크 크기)
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);                   // fmt 청크 크기(PCM=16)
  header.writeUInt16LE(1, 20);                    // audio format = 1(PCM, 무압축)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// 응답 JSON 어디에 있든 base64 이미지 문자열을 찾는다(NIM 응답 필드명이 모델마다 다름:
// artifacts[].base64 / data[].b64_json / image 등) — router.py _find_b64 verbatim 이식.
function findB64(res) {
  if (res && typeof res === 'object' && !Array.isArray(res)) {
    for (const k of ['b64_json', 'base64', 'image']) {
      const v = res[k];
      if (typeof v === 'string' && v.length > 100 && !v.startsWith('http')) return v;
    }
    for (const v of Object.values(res)) {
      const r = findB64(v);
      if (r) return r;
    }
  } else if (Array.isArray(res)) {
    for (const v of res) {
      const r = findB64(v);
      if (r) return r;
    }
  }
  return null;
}

// ── task 헬퍼 — tasks/*.py 의 payload 구성 + 응답 파싱 이식 ────────────────────────

async function chat(prompt, { id = '', model = '', system = '', maxTokens = 1024 } = {}) {
  const entry = taskCfg('chat', id);
  const useModel = model || entry.model;
  const isNvidia = (entry.provider || 'nvidia') === 'nvidia';
  let payload;
  if (isNvidia) {
    const msgs = system ? [{ role: 'system', content: system }] : [];
    msgs.push({ role: 'user', content: prompt });
    payload = { model: useModel, messages: msgs, max_tokens: maxTokens };
  } else {
    payload = { contents: [{ parts: [{ text: prompt }] }] };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
  }
  if (isNvidia) {
    const res = await call(entry, payload, { method: 'chat/completions', timeout: 180000, model: useModel });
    return (res.choices[0].message.content || '').trim();
  }
  const res = await call(entry, payload, { timeout: 180000, model: useModel });
  const text = (res.candidates[0].content.parts || []).map(p => p.text || '').join('');
  return text.trim();
}

// 스트리밍은 chat() 의 flag 가 아니라 별도 함수 — 설계상 명시적으로 분리(호출부가 async
// generator 소비 코드를 항상 준비해야 함을 함수 시그니처로 드러내기 위함).
async function* chatStream(prompt, { id = '', model = '', system = '', maxTokens = 1024 } = {}) {
  const entry = taskCfg('chat', id);
  const useModel = model || entry.model;
  const isNvidia = (entry.provider || 'nvidia') === 'nvidia';
  let payload;
  if (isNvidia) {
    const msgs = system ? [{ role: 'system', content: system }] : [];
    msgs.push({ role: 'user', content: prompt });
    payload = { model: useModel, messages: msgs, max_tokens: maxTokens };
  } else {
    payload = { contents: [{ parts: [{ text: prompt }] }] };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
  }
  yield* callStream(entry, payload, { timeout: 180000, model: useModel });
}

async function embed(texts, { id = '', model = '' } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  const entry = taskCfg('embedding', id);
  const useModel = model || entry.model;
  const provider = entry.provider || 'gemini';
  const embeddings = [];
  for (const t of list) {
    let values;
    if (provider === 'nvidia') {
      // NVIDIA retrieval 모델은 OpenAI 호환 /v1/embeddings — input_type(query|passage) 필수.
      const payload = {
        model: useModel, input: [t], encoding_format: 'float',
        input_type: entry.input_type || 'query', truncate: 'NONE',
      };
      const res = await call(entry, payload, { method: 'embeddings', timeout: 60000, model: useModel });
      values = res.data[0].embedding;
    } else {
      const payload = { content: { parts: [{ text: t }] } };
      const res = await call(entry, payload, { method: 'embedContent', timeout: 60000, model: useModel });
      values = res.embedding.values;
    }
    embeddings.push({ text: t, values });
  }
  return { model: useModel, dims: embeddings.length ? embeddings[0].values.length : 0, embeddings };
}

async function tts(text, { id = '', model = '', voice = '' } = {}) {
  const entry = taskCfg('tts', id);
  const useVoice = voice || entry.voice || 'Kore';
  const payload = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: useVoice } } },
    },
  };
  const res = await call(entry, payload, { timeout: 120000, model: model || entry.model });
  const part = res.candidates[0].content.parts[0].inlineData;
  const pcm = Buffer.from(part.data, 'base64');
  const m = /rate=(\d+)/.exec(part.mimeType || '');
  const sampleRate = m ? parseInt(m[1], 10) : 24000;
  const buffer = wrapPcmAsWav(pcm, sampleRate, 1, 16);
  return { buffer, sampleRate, mimeType: 'audio/wav' };
}

// stt 기본 항목(entryId='')은 whisper_remote(provider='remote') — v1 은 remote/local 을
// 지원하지 않으므로, gemini 항목을 쓰려면 호출부가 반드시 id='gemini' 를 명시해야 한다.
async function sttGemini(audioBuffer, { id = '', model = '', prompt = DEFAULT_STT_PROMPT, mimeType = 'audio/wav' } = {}) {
  const entry = taskCfg('stt', id);
  if ((entry.provider || '') !== 'gemini') {
    throw new Error(`aggregator.sttGemini: provider='gemini' 항목에서만 동작합니다(got '${entry.provider}', id='${entry.id}') — id:'gemini' 를 지정하세요`);
  }
  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: audioBuffer.toString('base64') } },
      ],
    }],
  };
  const res = await call(entry, payload, { timeout: 180000, model: model || entry.model });
  const text = (res.candidates[0].content.parts || []).map(p => p.text || '').join('');
  return text.trim();
}

// NIM genai 직접 호출(https://ai.api.nvidia.com/v1/genai/<model>). params 를 명시하면 그것을,
// 아니면(모델 오버라이드가 없을 때만) 항목에 정의된 기본 params(steps 등)를 적용한다 —
// router.py _try_nvidia 의 "모델 오버라이드 시 항목 기본 params 미적용" 규칙 이식.
async function imagegenNvidia(prompt, { id = 'NVIDIA_MASTER', model = '', params = null } = {}) {
  const entry = taskCfg('imagegen', id);
  if ((entry.provider || '') !== 'nvidia') {
    throw new Error(`aggregator.imagegenNvidia: provider='nvidia' 항목에서만 동작합니다(got '${entry.provider}', id='${entry.id}')`);
  }
  const expandedModel = NVIDIA_IMAGE_MODELS[model] || model; // 짧은 이름 → 실제 슬러그 확장
  const useModel = expandedModel || entry.model;
  const payload = { prompt };
  if (params) {
    Object.assign(payload, params);
  } else if (useModel === entry.model) {
    Object.assign(payload, entry.params || {});
  }
  const apiKey = resolveApiKey(entry);
  const res = await callNvidia(useModel, payload, {
    apiKey,
    method: `https://ai.api.nvidia.com/v1/genai/${useModel}`,
    timeout: 180000,
  });
  const b64 = findB64(res);
  if (!b64) {
    throw new Error(`aggregator.imagegenNvidia: 응답에서 이미지를 찾지 못함: ${JSON.stringify(res).slice(0, 200)}`);
  }
  const buffer = Buffer.from(b64, 'base64');
  // 매직바이트로 실제 포맷 판별(flux 는 JPEG 로 반환하는 경우가 있음) — router.py 이식.
  const ext = buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ? 'jpg' : 'png';
  return { buffer, ext, model: useModel };
}

// imggen.py 위임(v1 범위 밖) 대신 Gemini REST 를 직접 호출하는 이미지 생성 경로.
// generateContent + generationConfig.responseModalities:['IMAGE'] — 응답 inlineData 를 그대로 반환.
// chat/embed/tts/sttGemini 와 동일하게 model||entry.model 순으로 해석한다 — entry 는 taskCfg 로
// 직접 다시 조회한다(호출부가 이미 조회한 entry 를 넘겨받지 않는 이유: imagegenGemini 는 단독으로도
// 호출될 수 있는 공개 API 이므로 자체적으로 entry.model 을 해석할 수 있어야 한다).
async function imagegenGemini(prompt, { id = 'gemini', model = '' } = {}) {
  const entry = taskCfg('imagegen', id);
  const useModel = model || entry.model || 'gemini-2.0-flash-preview-image-generation';
  const apiKey = resolveApiKey(entry);
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };
  const res = await callGemini(useModel, payload, { apiKey, timeout: 120000 });
  const parts = (((res.candidates || [])[0] || {}).content || {}).parts || [];
  const inline = parts.find(p => p.inlineData && p.inlineData.data);
  if (!inline) {
    throw new Error(`aggregator.imagegenGemini: 응답에서 이미지를 찾지 못함: ${JSON.stringify(res).slice(0, 200)}`);
  }
  const buffer = Buffer.from(inline.inlineData.data, 'base64');
  const mime = inline.inlineData.mimeType || '';
  const ext = mime.includes('png') ? 'png'
    : (mime.includes('jpeg') || mime.includes('jpg')) ? 'jpg'
    : (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ? 'jpg' : 'png');
  return { buffer, ext, model: useModel };
}

// task-cfg 항목의 provider 로 실제 이미지 생성을 위임 — imagegenNvidia/imagegenGemini 로 분기.
// codex 등 이 모듈이 실행할 수 없는 provider 는 명확한 Error 를 던진다(체인 폴백에서는 이걸
// catch 해 다음 그룹으로 넘어가고, --id 로 명시 지정했을 때는 그대로 호출부에 전파된다).
async function _dispatchImagegen(entry, prompt, model) {
  if (entry.provider === 'nvidia') {
    // entry.params 를 여기서 넘기지 않는다 — imagegenNvidia 가 taskCfg 로 자신의 entry 를 다시
    // 조회해 "모델 오버라이드가 없을 때만 entry.params 적용" 규칙(useModel===entry.model)을
    // 스스로 판단하게 둔다. 여기서 미리 넘기면 그 규칙이 무조건 참이 되어(params 인자가 항상
    // truthy) 모델을 오버라이드해도 원래 모델용 params 가 새 나가는 버그가 된다.
    const result = await imagegenNvidia(prompt, { id: entry.id, model });
    return { ...result, provider: 'nvidia' };
  }
  if (entry.provider === 'gemini' || entry.provider === 'imggen') {
    const result = await imagegenGemini(prompt, { id: entry.id, model });
    return { ...result, provider: 'gemini' };
  }
  throw new Error(`aggregator.imagegen: 지원하지 않는 provider '${entry.provider}'(id='${entry.id}') — 실행 가능: nvidia, gemini`);
}

// --id 지정 시 그 provider·모델만 시도(폴백 없음). 생략 시 getImagegenChain() 순서대로
// 각 그룹의 0번 항목만 성공할 때까지 폴백 시도(auto) — router.py run_imagegen 이식.
// refs 는 v1 범위 밖(design 문서 4번 항목) — nvidia(flux) 그룹을 건너뛰는 판단에만 쓰이고
// 실제 참조 이미지 첨부는 하지 않는다.
async function imagegen(prompt, { id = '', model = '', refs = [] } = {}) {
  if (id) {
    const { providerId, modelOverride } = parseProviderSpec(id);
    const entry = taskCfg('imagegen', providerId); // 못 찾으면 여기서 바로 throw(폴백 없음)
    return _dispatchImagegen(entry, prompt, modelOverride || model);
  }

  const errors = [];
  for (const group of getImagegenChain()) {
    if (!group || !group.length) continue;
    const spec = group[0];
    const { providerId, modelOverride } = parseProviderSpec(spec);
    let entry;
    try {
      entry = taskCfg('imagegen', providerId);
    } catch (e) {
      errors.push(`${providerId}: ${e.message}`);
      continue;
    }
    if (entry.provider === 'nvidia' && refs && refs.length) {
      continue; // flux 는 참조 이미지 미지원 — 체인에서 스킵
    }
    try {
      return await _dispatchImagegen(entry, prompt, modelOverride || model);
    } catch (e) {
      errors.push(`${providerId}: ${e.message}`); // 지원하지 않는 provider(codex 등)도 여기서 스킵됨
    }
  }
  throw new Error(`aggregator.imagegen: 이미지 생성 실패(모든 provider): ${errors.join(' | ')}`);
}

module.exports = {
  dbPath,
  getGraph, ensureSeeded,
  listTasks, listEntries, getEntry, putEntry, deleteEntry, taskCfg,
  getImagegenChain, setImagegenChain, getCatalogInfo,
  parseProviderSpec, resolveApiKey,
  callGemini, callNvidia, streamGemini, streamNvidia,
  call, callStream,
  chat, chatStream, embed, tts, sttGemini,
  imagegenNvidia, imagegenGemini, imagegen,
};
