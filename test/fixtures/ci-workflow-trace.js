/**
 * @fileoverview Runs GitHub Actions `run:` scripts of .github/workflows/ci.yml
 * against a stub `docker` that only records its arguments, so tests can check
 * what CI would build, scan, push and index. No real Docker command runs.
 *
 * The reader understands only the YAML shape ci.yml uses (2-space nesting,
 * `run: |` blocks) and fails loudly instead of guessing on anything else.
 */

const assert = require('node:assert');
const {spawnSync} = require('node:child_process');
const {mkdtempSync, readFileSync, rmSync, writeFileSync} =
    require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');

/** Stub docker: one tab-separated line per call; fails on DOCKER_FAIL_ON. */
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\t' "$@" >> "$DOCKER_TRACE"
printf '\\n' >> "$DOCKER_TRACE"
if [[ -n "\${DOCKER_FAIL_ON:-}" && "$*" == *"$DOCKER_FAIL_ON"* ]]; then
  exit 1
fi
`;

/**
 * Skip reason when bash, the Actions step shell, is not installed (the pinned
 * node:22-alpine test image has none); false when traces can run. GitHub's
 * ubuntu runners always have bash.
 */
const BASH_MISSING = spawnSync('bash', ['-c', 'true']).status === 0 ? false :
  'bash 가 없어 Actions step 셸을 재현할 수 없다';

/**
 * @param {string} line
 * @return {number} Leading spaces.
 */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Returns the lines nested under the exact `header` line found at `indent`.
 * @param {!Array<string>} lines
 * @param {string} header Line text without indentation, e.g. `env:`.
 * @param {number} indent
 * @return {!Array<string>}
 */
function block(lines, header, indent) {
  const start = lines.indexOf(`${' '.repeat(indent)}${header}`);
  assert.ok(start >= 0, `${header} not found at indent ${indent}`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= indent) break;
    body.push(line);
  }
  return body;
}

/**
 * Parses `key: value` pairs written directly at `indent`.
 * @param {!Array<string>} lines
 * @param {number} indent
 * @return {!Object<string, string>}
 */
function scalars(lines, indent) {
  const result = {};
  for (const line of lines) {
    if (indentOf(line) !== indent) continue;
    const match = line.trim().match(/^([\w-]+): ?(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

/**
 * Splits a job's `steps:` list (items at indent 6) into step objects with
 * their scalar keys plus `yaml`, the step's own text; a `run: |` block
 * becomes the script text.
 * @param {!Array<string>} stepLines
 * @return {!Array<!Object<string, string>>}
 */
function readSteps(stepLines) {
  const steps = [];
  for (const line of stepLines) {
    if (line.startsWith('      - ')) steps.push([]);
    // Align the first key of an item with its sibling keys at indent 8.
    const aligned = line.replace(/^ {6}- /, ' '.repeat(8));
    if (steps.length) steps.at(-1).push(aligned);
  }
  return steps.map((lines) => {
    const step = {...scalars(lines, 8), yaml: lines.join('\n')};
    if (step.run === '|') {
      const body = block(lines, 'run: |', 8).map((line) => line.slice(10));
      step.run = `${body.join('\n').trimEnd()}\n`;
    }
    return step;
  });
}

/**
 * Reads one job of the workflow.
 * @param {string} workflow ci.yml text.
 * @param {string} jobName
 * @return {{needs: string, env: !Object<string, string>,
 *     steps: !Array<!Object<string, string>>}}
 */
function readJob(workflow, jobName) {
  const job = block(block(workflow.split('\n'), 'jobs:', 0),
      `${jobName}:`, 2);
  const env = job.includes('    env:') ? scalars(block(job, 'env:', 4), 6) :
    {};
  return {
    needs: scalars(job, 4).needs,
    env,
    steps: readSteps(block(job, 'steps:', 4)),
  };
}

/**
 * Turns job env into process env, replacing `${{ expr }}` from expressions
 * and dropping values that still hold an unknown expression.
 * @param {!Object<string, string>} jobEnv
 * @param {!Object<string, string>} expressions
 * @return {!Object<string, string>}
 */
function resolveEnv(jobEnv, expressions) {
  const env = {};
  for (const [name, value] of Object.entries(jobEnv)) {
    const resolved = value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g,
        (match, expr) => expressions[expr] ?? match);
    if (!resolved.includes('${{')) env[name] = resolved;
  }
  return env;
}

/**
 * Runs one step script with `bash -e` (the Actions default on Linux when no
 * shell is set) and the stub docker first on PATH.
 * @param {string} script
 * @param {!Object<string, string>} env
 * @param {string=} failOn Substring of a docker call that makes it exit 1.
 * @return {{status: ?number, calls: !Array<!Array<string>>, stderr: string}}
 */
function runStep(script, env, failOn = '') {
  const dir = mkdtempSync(join(tmpdir(), 'ci-trace-'));
  try {
    writeFileSync(join(dir, 'docker'), DOCKER_STUB, {mode: 0o755});
    writeFileSync(join(dir, 'step.sh'), script);
    const trace = join(dir, 'trace.tsv');
    writeFileSync(trace, '');
    const run = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
      encoding: 'utf8', timeout: 10000,
      env: {...env, PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: join(dir, 'runner-temp'), DOCKER_TRACE: trace,
        DOCKER_FAIL_ON: failOn},
    });
    const calls = readFileSync(trace, 'utf8').split('\n').filter(Boolean)
        .map((line) => line.replace(/\t$/, '').split('\t'));
    return {status: run.status, calls, stderr: run.stderr};
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

/**
 * @param {!Array<string>} args
 * @param {string} flag
 * @return {string|undefined} The argument after flag.
 */
function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

/**
 * Summarizes docker calls into what was built, scanned, pushed and indexed.
 * A scan counts only when trivy reads the tar `docker save` wrote for that
 * image.
 * @param {!Array<!Array<string>>} calls
 * @return {{builds: !Array<!Array<string>>, scanned: !Array<string>,
 *     pushed: !Array<string>, indexes: !Array<!Array<string>>}}
 */
function publishPlan(calls) {
  const plan = {builds: [], scanned: [], pushed: [], indexes: []};
  const saved = new Map();
  for (const args of calls) {
    const command = args.slice(0, 3).join(' ');
    const trivy = args.some((arg) => arg.includes('trivy'));
    if (command.startsWith('buildx build')) {
      plan.builds.push(
          [flagValue(args, '--platform'), flagValue(args, '-t')]);
    } else if (args[0] === 'save') {
      saved.set(flagValue(args, '-o'), args[1]);
    } else if (args[0] === 'run' && trivy) {
      const [source, target] = (flagValue(args, '-v') ?? '').split(':');
      if (target === flagValue(args, '--input')) {
        plan.scanned.push(saved.get(source));
      }
    } else if (args[0] === 'push') {
      plan.pushed.push(args[1]);
    } else if (command === 'buildx imagetools create') {
      plan.indexes.push([flagValue(args, '-t'), ...args.slice(5)]);
    }
  }
  return plan;
}

module.exports = {BASH_MISSING, publishPlan, readJob, resolveEnv, runStep};
