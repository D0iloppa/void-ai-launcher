#!/usr/bin/env node
'use strict';

// bootstrap.js — void 의 실제 진입점(설치된 wrapper 가 launcher.js 대신 이
// 파일을 실행한다, cmd_generator.js 참고). launcher.js 를 직접 수정하며 실행
// 중인 자기 자신을 덮어쓰는 대신, "체크 → (선택적) 업데이트 → launcher.js 실행"
// 을 별도 프런트도어로 분리해 자기수정(self-modifying-in-place) 문제를 피한다.
//
// 이 파일 전체는 fail-open 이다 — 어디서 무엇이 실패하든 결국 launcher.js 를
// 그대로 실행한다. 업데이트 체크/적용이 launch 를 막는 일은 절대 없어야 한다.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const DIR = __dirname;

// cmd_generator.js 의 promptSync/askYesNo(~119-134)와 동일한 패턴 — alt-screen
// 진입 전(ui.menu() 를 쓸 수 없는 시점)이라 컨트롤링 터미널(/dev/tty)을 직접 열어
// 동기적으로 Y/N 을 받는다. 컨트롤링 터미널이 없는 비대화형 실행(CI 등)에서는
// open 자체가 실패해 빈 문자열을 반환한다(=아니오로 취급).
function promptSync(question) {
  process.stdout.write(question);
  let fd;
  try { fd = fs.openSync('/dev/tty', 'r'); } catch { return ''; }
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    return buf.toString('utf8', 0, n).trim();
  } catch {
    return '';
  } finally {
    fs.closeSync(fd);
  }
}
const askYesNo = question => /^y(es)?$/i.test(promptSync(question));

function launch(argv) {
  const res = spawnSync(process.execPath, [path.join(DIR, 'launcher.js'), ...argv], { stdio: 'inherit' });
  process.exit(res.status ?? 0);
}

function main() {
  const argv = process.argv.slice(2);

  // 인수가 있는 직행 호출(void claude foo 등)은 업데이트 체크를 건너뛰고 바로 실행 —
  // 스크립트/파이프라인에서 쓰이는 경로를 절대 지연시키지 않는다.
  let shouldCheck = argv.length === 0;

  if (shouldCheck) {
    try {
      const configDb = require('./lib/configDb');
      const settings = configDb.getSettings();
      if (settings.update_check_on_start === false) shouldCheck = false;
    } catch {
      shouldCheck = false;
    }
  }

  if (shouldCheck) {
    try {
      const selfUpdate = require('./lib/selfUpdate');
      const check = selfUpdate.checkUpdate();

      if (check.available && check.behind > 0 && check.clean) {
        const peers = selfUpdate.peersAlive();
        if (peers > 0) {
          console.log(`  업데이트 있음 — ${peers}개 실행 중, 나중에`);
        } else if (askYesNo(`  업데이트가 있습니다 (${check.behind}개 커밋 뒤처짐). 지금 업데이트할까요? [y/N] `)) {
          const result = selfUpdate.applyUpdate();
          if (result.ok) {
            console.log('  ✓ 업데이트 완료' + (result.npmFailed ? ' (npm install 실패 — 수동 확인 필요)' : ''));
          } else {
            console.log(`  ✗ 업데이트 실패: ${result.reason || '알 수 없는 오류'}`);
          }
        }
      }
    } catch {
      // fail-open — 업데이트 체크/적용 중 무엇이 실패해도 launch 는 계속된다.
    }
  }

  launch(argv);
}

main();
