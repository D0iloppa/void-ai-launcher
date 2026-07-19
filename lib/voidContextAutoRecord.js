'use strict';

// void-context 자동 기록의 "순수" 판단 로직만 모아둔 헬퍼.
// 실제 dJinn/그래프 접근(lib/voidContext.js)이나 launcher.js 의 세션 상태와 완전히 분리되어
// 있어야 외부 그래프/DB 없이도 단위 테스트가 가능하다 — 이 파일은 순수 함수만 export 한다
// (부수효과 없음, require('./voidContext') 도 하지 않는다).
//
// launcher.js#launchTool 에서 named-session 실행 시 이 모듈로 "기록해도 되는지 +
// 어떤 값으로 기록할지"만 계산하고, 실제 putContext 호출/에러 스월로우는 launcher.js 쪽
// (fail-open try/catch) 책임이다.

// lib/voidContext.js 의 PROVIDERS = {anthropic, openai, google} 중 launcher 가 실제로
// 다루는 named-session 가능 CLI(claude/codex/agy, launcher.js SESSION_CAPABLE_COMMANDS)에서
// 매핑 가능한 것만 여기 정의한다. agy 는 의도적으로 제외 — PROVIDERS 에 대응 값이 없으므로
// putContext 가 예외를 던지기 전에 여기서 걸러(null 반환) 아예 기록을 스킵한다.
const PROVIDER_BY_TOOL_COMMAND = {
  claude: 'anthropic',
  codex: 'openai',
};

// toolCommand(예: 'claude'/'codex'/'agy'/그 외) → void-context provider 문자열, 매핑 불가 시 null.
function mapProviderFromCommand(toolCommand) {
  const key = String(toolCommand || '').toLowerCase();
  return PROVIDER_BY_TOOL_COMMAND[key] || null;
}

// 기존 컨텍스트(getContext 결과, 없으면 null/undefined)를 바탕으로 다음 resumes 값을 계산한다.
// 스펙: resumes = (existing?.resumes ?? 0) + 1 → 최초 실행이면 1.
function nextResumes(existingContext) {
  const prev = existingContext ? existingContext.resumes : null;
  return (prev ?? 0) + 1;
}

// named-session 실행 시 putContext 에 넘길 payload 를 계산한다.
// toolCommand 가 provider 로 매핑되지 않으면(예: agy) null 을 반환 — 호출부는 이 경우
// putContext 를 아예 호출하지 않아야 한다(호출 시 voidContext.js 가 throw 하므로).
function computeContextUpdate({ toolCommand, existingContext, sessionName, workspace } = {}) {
  const provider = mapProviderFromCommand(toolCommand);
  if (!provider) return null;
  if (!sessionName) return null;
  return {
    task_id: sessionName,
    provider,
    named_session: sessionName,
    workspace,
    resumes: nextResumes(existingContext),
  };
}

module.exports = { mapProviderFromCommand, nextResumes, computeContextUpdate };
