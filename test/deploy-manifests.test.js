/**
 * @fileoverview 배포 매니페스트의 정적 계약 시험.
 *
 * 1. 트래픽 봇의 run_id 가 팀 INSERT 워커(gitops apps/db-insert-worker)의
 *    job 이름과 겹치지 않는지 확인한다. 두 writer 가 같은 run_id 로 공유 DB
 *    에 쓰면 run_id 별 행 수로 각자의 생산량을 증명할 수 없다.
 * 1. 요청 API 인증(S1) env 계약을 확인한다. 앱은 REQUEST_API_AUTH=required
 *    와 선택적 Secret 참조를, 봇은 같은 Secret 의 필수 참조를 가져야 한다.
 */

const {test} = require('node:test');
const assert = require('node:assert');
const {readFileSync, readdirSync} = require('node:fs');
const {join} = require('node:path');

const REPO_ROOT = join(__dirname, '..');
const K8S_DIR = join(REPO_ROOT, 'k8s');
const APP_MANIFEST = join(K8S_DIR, 'base', 'deployment.yaml');
const BOT_MANIFEST = join(K8S_DIR, 'traffic-bot', 'bot.yaml');
const ENV_EXAMPLE = join(REPO_ROOT, '.env.example');
/** 앱과 봇이 함께 참조하는 요청 API 토큰 Secret 의 이름과 키. */
const API_TOKEN_SECRET = 'name: sample-app-api-token\n    key: token';
/** 봇 CLI 가 받아들이는 BOT_RUN_ID 형식. */
const BOT_RUN_ID_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;
/** 팀 INSERT 워커와 migration.cutover 가 쓰는 job 이름 형식. */
const WORKER_RUN_ID_PATTERN = /^(forward|return)_\d{3}$/;

/**
 * 매니페스트에서 `- name: <name>` 바로 다음 줄의 `value:` 를 읽는다.
 * @param {string} manifest
 * @param {string} name
 * @return {string}
 */
function readEnvValue(manifest, name) {
  const pattern = new RegExp(`- name: ${name}\\n\\s+value: '?([^'\\n]+)'?`);
  const match = manifest.match(pattern);
  assert.ok(match, `${name} 값이 매니페스트에 없다`);
  return match[1].trim();
}

const botRunId = readEnvValue(readFileSync(BOT_MANIFEST, 'utf8'), 'BOT_RUN_ID');

test('봇 매니페스트의 BOT_RUN_ID 는 봇 CLI 형식을 따른다', () => {
  assert.match(botRunId, BOT_RUN_ID_PATTERN);
});

test('봇 매니페스트의 BOT_RUN_ID 는 워커의 forward_NNN·return_NNN 과 겹치지 않는다',
    () => {
      assert.doesNotMatch(botRunId, WORKER_RUN_ID_PATTERN);
    });

/**
 * 매니페스트에서 `- name: <name>` 항목을 모두 찾아 각 항목의 하위 줄을
 * 돌려준다. 하위 줄은 항목 이름 열을 0으로 맞춘 들여쓰기를 유지한다.
 * @param {string} manifest
 * @param {string} name
 * @return {!Array<string>}
 */
function readEnvEntries(manifest, name) {
  const lines = manifest.split('\n');
  const entries = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(\s*)- name: (\S+)$/);
    if (!match || match[2] !== name) return;
    const itemIndent = match[1].length + 2;
    const body = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() === '' || indentOf(next) < itemIndent) break;
      body.push(next.slice(itemIndent));
    }
    entries.push(body.join('\n'));
  });
  return entries;
}

/**
 * 컨테이너 `env:` 목록의 항목 이름을 순서대로 모두 돌려준다.
 * @param {string} manifest
 * @return {!Array<string>}
 */
function readEnvNames(manifest) {
  const lines = manifest.split('\n');
  const start = lines.findIndex((line) => /^\s*env:$/.test(line));
  assert.ok(start >= 0, 'env 목록이 매니페스트에 없다');
  const envIndent = indentOf(lines[start]);
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || indentOf(line) <= envIndent) break;
    const match = line.match(/^\s*- name: (\S+)$/);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * @param {string} line
 * @return {number} 앞 공백 수.
 */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

const appManifest = readFileSync(APP_MANIFEST, 'utf8');
const botManifest = readFileSync(BOT_MANIFEST, 'utf8');

test('앱 매니페스트는 요청 API 인증을 required 로 선언한다', () => {
  assert.deepStrictEqual(readEnvEntries(appManifest, 'REQUEST_API_AUTH'),
      ['value: required']);
});

test('앱의 REQUEST_API_TOKEN 은 공유 Secret 을 optional 로 참조한다', () => {
  assert.deepStrictEqual(readEnvEntries(appManifest, 'REQUEST_API_TOKEN'), [
    `valueFrom:\n  secretKeyRef:\n    ${API_TOKEN_SECRET}\n    optional: true`,
  ]);
});

test('봇의 BOT_API_TOKEN 은 같은 Secret 을 필수로 참조한다', () => {
  assert.deepStrictEqual(readEnvEntries(botManifest, 'BOT_API_TOKEN'), [
    `valueFrom:\n  secretKeyRef:\n    ${API_TOKEN_SECRET}`,
  ]);
});

test('앱과 봇 매니페스트의 env 이름은 중복되지 않는다', () => {
  for (const manifest of [appManifest, botManifest]) {
    const names = readEnvNames(manifest);
    assert.deepStrictEqual(names, [...new Set(names)]);
  }
});

test('k8s/ 어디에도 TLS 인증서 검증 해제 설정이 없다', () => {
  const files = readdirSync(K8S_DIR, {recursive: true})
      .filter((file) => file.endsWith('.yaml'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(join(K8S_DIR, file), 'utf8');
    assert.doesNotMatch(text, /NODE_TLS_REJECT_UNAUTHORIZED/, file);
  }
});

/** 사용자 승인(2026-11-04)으로 정한 sample-app 의 공개 이미지 저장소. */
const DOCKER_HUB_IMAGE = 'docker.io/kty1021/sample-app';
/** image·kustomize images·DeploySpec 에서 레지스트리 경로를 읽는다. */
const IMAGE_REF_PATTERN =
    /^\s*(?:image|- name|repository): (\S*\.\S*\/sample-app)$/gm;

test('sample-app 매니페스트와 deploy.yaml 의 이미지는 Docker Hub 저장소다',
    () => {
      for (const file of [
        'k8s/base/deployment.yaml', 'k8s/base/kustomization.yaml',
        'k8s/traffic-bot/bot.yaml', 'k8s/traffic-bot/kustomization.yaml',
        'deploy.yaml',
      ]) {
        const text = readFileSync(join(REPO_ROOT, file), 'utf8');
        const refs = [...text.matchAll(IMAGE_REF_PATTERN)].map((m) => m[1]);
        assert.deepStrictEqual(refs, [DOCKER_HUB_IMAGE], file);
      }
      // GitHub 저장소 경로는 레지스트리와 별개라 바꾸지 않는다.
      assert.match(readFileSync(join(REPO_ROOT, 'deploy.yaml'), 'utf8'),
          /^ {2}repository: SoftBankHackathon2026\/sample-app$/m);
    });

test('CI 는 Docker Hub 에만 게시하고 latest 태그를 쓰지 않는다', () => {
  const ci = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(ci.includes(DOCKER_HUB_IMAGE));
  assert.doesNotMatch(ci, /ghcr\.io/);
  assert.doesNotMatch(ci, /:latest\b/);
});

/**
 * DeploySpec 의 `image.platforms` 목록을 읽는다.
 * @param {string} spec
 * @return {!Array<string>}
 */
function readImagePlatforms(spec) {
  const match = spec.match(/^ {2}platforms:\n((?: {4}- \S+\n)+)/m);
  assert.ok(match, 'image.platforms 가 deploy.yaml 에 없다');
  return match[1].trim().split('\n').map((line) => line.trim().slice(2));
}

test('deploy.yaml 의 image.platforms 는 CI 가 빌드하는 arch 와 같다', () => {
  const ci = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const build = ci.match(/for arch in ([\w ]+); do\n\s+docker buildx build/);
  assert.ok(build, 'CI 의 arch 별 buildx 반복문이 없다');
  const spec = readFileSync(join(REPO_ROOT, 'deploy.yaml'), 'utf8');
  assert.deepStrictEqual(readImagePlatforms(spec), build[1].split(' '));
});

test('.env.example 은 공개 노출용 required 를 켜고 토큰 값은 주석으로만 둔다',
    () => {
      const lines = readFileSync(ENV_EXAMPLE, 'utf8').split('\n');
      assert.ok(lines.includes('REQUEST_API_AUTH=required'));
      for (const name of ['REQUEST_API_TOKEN', 'BOT_API_TOKEN']) {
        const mentions = lines.filter((line) => line.includes(`${name}=`));
        assert.deepStrictEqual(mentions, [`# ${name}=`], name);
      }
      assert.ok(lines.every((line) => !/TOKEN=\S/.test(line)));
      assert.ok(lines.every(
          (line) => !line.includes('NODE_TLS_REJECT_UNAUTHORIZED')));
    });
