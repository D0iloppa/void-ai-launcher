'use strict';

// 얇은 shim — 토큰 저장소는 이제 lib/configDb.js (dJinn/SQLite) 로 이관되었다.
// 예전 config.json (repo root) 파일 read-modify-write 방식은 configDb 의
// migrateLegacyConfigJson() 이 최초 1회 흡수한 뒤 config.json.migrated 로 rename 한다.
//
// 외부 소비자(lib/tokens.js, lib/extTokens.js, lib/prompt.js, launcher.js)가 쓰는
// 함수 이름/시그니처를 그대로 유지해 호출부는 전혀 손대지 않는다. 과거 export 중
// load/save/getServiceTokens/CONFIG_PATH 는 외부 소비자가 없어 제거했다.

const configDb = require('./configDb');

const getAllTokens  = ()                          => configDb.getAllTokens();
const getToken      = (service, alias = null)     => configDb.getToken(service, alias);
const setToken      = (service, alias, token)     => configDb.setToken(service, alias, token);
const renameToken   = (service, oldAlias, newAlias) => configDb.renameToken(service, oldAlias, newAlias);
const deleteToken   = (service, alias)            => configDb.deleteToken(service, alias);
const addService    = (service)                   => configDb.addService(service);
const deleteService = (service)                   => configDb.deleteService(service);

module.exports = {
  getAllTokens, getToken,
  setToken, renameToken, deleteToken,
  addService, deleteService,
};
