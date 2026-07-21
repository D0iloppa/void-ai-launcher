'use strict';

// 개인비서 "이전 대화 이어하기"(launcher.js 의 대화 피커 → resume)를 위한
// claude jsonl 트랜스크립트 파서. 순수 함수 위주(dJinn/터미널 의존성 없음,
// composerModel.js/assistantSettingsPanel.js 와 같은 이유로 단위 테스트가
// 쉽다) — fs 접근은 맨 아래 readTranscript()/resolveTranscriptPath() 두
// 얇은 wrapper 에만 있다.
//
// 경로 규칙: claude CLI 는 세션의 jsonl 을
//   <configDir>/projects/<cwd 를 '/'와 '.' 모두 '-'로 치환한 이름>/<sessionId>.jsonl
// 에 쓴다. 개인비서 세션의 cwd 는 <configDir>/workspace 이지만, 이 기능
// 도입 이전(workspace 격리 도입 전) 프로필은 cwd 가 configDir 자체였던
// "레거시" jsonl 폴더가 남아 있을 수 있어 둘 다 뒤진다(워크스페이스 우선).
// 치환 규칙은 실제 온디스크 폴더명으로 검증됨 —
//   /home/doil/.assistant-claude-domi/workspace
//     → -home-doil--assistant-claude-domi-workspace
//   /home/doil/.assistant-claude-domi
//     → -home-doil--assistant-claude-domi
// ('.'과 '/' 양쪽 다 전역 치환하기 때문에 "/." 부분이 "--"로 겹쳐 나온다).

const fs   = require('fs');
const path = require('path');

// claude 가 cwd 문자열을 프로젝트 폴더명으로 바꿀 때 쓰는 치환 — '/' 와 '.'
// 을 전부 '-'로 바꾼다(순서 무관, 둘 다 전역 치환이라 겹쳐도 결과가 같다).
function dashedFolderName(cwd) {
  return String(cwd || '').replace(/\//g, '-').replace(/\./g, '-');
}

// workspace cwd 폴더를 먼저, 없으면 legacy(configDir 자체를 cwd로 쓰던 시절)
// 폴더를 본다. 둘 다 없으면 null.
function resolveTranscriptPath(configDir, workspaceDir, sessionId) {
  if (!configDir || !sessionId) return null;
  const candidates = [];
  if (workspaceDir) {
    candidates.push(path.join(configDir, 'projects', dashedFolderName(workspaceDir), `${sessionId}.jsonl`));
  }
  candidates.push(path.join(configDir, 'projects', dashedFolderName(configDir), `${sessionId}.jsonl`));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 권한 등으로 existsSync 자체가 실패해도 다음 후보를 계속 본다.
    }
  }
  return null;
}

// message.content 는 문자열이거나(사용자가 순수 텍스트만 보낸 턴) 블록
// 배열이다(assistant 턴, 또는 tool_result 를 담은 user 턴). 블록 중
// type==='text' 인 것만 이어붙인다 — tool_use/tool_result/thinking 블록은
// 이번 범위에서는 건너뛴다(스펙: "keep display simple, text turns only").
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

// jsonl 텍스트 전체를 순서대로 파싱해 { entries, aiTitle } 를 반환한다.
// - entries: [{ who: 'user'|'assistant', text }, ...] — 순수 텍스트가 전혀
//   없는 턴(예: tool_use/tool_result 블록만 있는 user 턴)은 표시할 게 없으니
//   결과에서 통째로 제외한다.
// - aiTitle: claude 가 best-effort 로 남기는 {"type":"ai-title","aiTitle":...}
//   줄에서 뽑은 제목(없으면 null, 여러 번 나오면 마지막 값을 쓴다).
// - 손상된/파싱 불가 줄은 조용히 건너뛴다(한 줄이 깨졌다고 트랜스크립트 전체
//   를 버리지 않는다).
function parseTranscript(jsonlText) {
  const entries = [];
  let aiTitle = null;
  const lines = typeof jsonlText === 'string' ? jsonlText.split('\n') : [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    if (obj.type === 'ai-title') {
      if (typeof obj.aiTitle === 'string' && obj.aiTitle) aiTitle = obj.aiTitle;
      continue;
    }

    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const msg = obj.message;
    if (!msg) continue;

    const text = extractText(msg.content);
    if (!text) continue;
    entries.push({ who: obj.type, text });
  }

  return { entries, aiTitle };
}

// 순수 함수: parseTranscript()가 뽑아낸 entries를 읽기 좋은 Markdown 문자열로
// 직렬화한다(fs 접근 없음 — 파일에 쓰는 건 호출자 책임). launcher.js의 대화
// 내보내기(onLoadConversation export 액션)에서 쓴다.
function entriesToMarkdown(entries, meta = {}) {
  const title = (meta && meta.title) || '새 대화';
  const lines = [`# ${title}`, ''];
  if (meta && meta.exportedAt) {
    lines.push(`_내보낸 시각: ${meta.exportedAt}_`, '');
  }
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    if (!entry) continue;
    const heading = entry.who === 'assistant' ? '## 🤖 Assistant' : '## 👤 User';
    lines.push(heading, '', String(entry.text || ''), '');
  }
  return lines.join('\n');
}

// 얇은 fs wrapper — 못 읽으면(파일 없음/권한/기타) 빈 결과로 fail-open.
function readTranscript(jsonlPath) {
  try {
    const text = fs.readFileSync(jsonlPath, 'utf8');
    return parseTranscript(text);
  } catch {
    return { entries: [], aiTitle: null };
  }
}

module.exports = { parseTranscript, resolveTranscriptPath, readTranscript, dashedFolderName, entriesToMarkdown };
