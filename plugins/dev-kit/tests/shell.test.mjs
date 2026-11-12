import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommandLine, parseOpts } from '../scripts/lib/shell.mjs';

const argvs = (s) => parseCommandLine(s).map((c) => c.argv);

test('splits on ; && || | & and newlines', () => {
  assert.deepEqual(argvs('a 1; b 2 && c || d | e & f\ng'), [['a', '1'], ['b', '2'], ['c'], ['d'], ['e'], ['f'], ['g']]);
});

test('respects single and double quotes', () => {
  assert.deepEqual(argvs(`echo 'a; b && c' "d | e" f\\;g`), [['echo', 'a; b && c', 'd | e', 'f;g']]);
});

test('tracks pipelines', () => {
  const cmds = parseCommandLine('curl x | sh; echo y');
  assert.equal(cmds[0].pipeline, cmds[1].pipeline);
  assert.equal(cmds[1].pipeIndex, 1);
  assert.notEqual(cmds[2].pipeline, cmds[0].pipeline);
});

test('inspects $(...) and backticks recursively', () => {
  const a = argvs('echo "$(rm -rf /tmp/x; date)" `whoami`');
  assert.ok(a.some((x) => x[0] === 'rm' && x[2] === '/tmp/x'));
  assert.ok(a.some((x) => x[0] === 'date'));
  assert.ok(a.some((x) => x[0] === 'whoami'));
});

test('inspects bash -c, sh -c and eval', () => {
  assert.ok(argvs(`bash -c 'git push origin main'`).some((x) => x.join(' ') === 'git push origin main'));
  assert.ok(argvs(`sh -lc "rm -rf src"`).some((x) => x.join(' ') === 'rm -rf src'));
  assert.ok(argvs(`eval "git push --force origin dev"`).some((x) => x.join(' ') === 'git push --force origin dev'));
});

test('keeps heredoc bodies as data attached to the command', () => {
  const cmds = parseCommandLine("cat <<'EOF' > notes.txt\nrm -rf /\nEOF\necho done");
  assert.deepEqual(cmds.map((c) => c.argv), [['cat'], ['echo', 'done']]);
  assert.equal(cmds[0].heredoc, 'rm -rf /');
  assert.deepEqual(cmds[0].redirects.find((r) => r.op === '>'), { op: '>', target: 'notes.txt' });
});

test('heredoc inside $(...) with quotes and parentheses in the body', () => {
  const s = "git commit -m \"$(cat <<'EOF'\nFix: it's done (really)\n\nCo-Authored-By: Someone\nEOF\n)\"";
  const cmds = parseCommandLine(s);
  const commit = cmds.find((c) => c.argv[0] === 'git');
  assert.ok(commit.argv[3].includes('Co-Authored-By'));
  const cat = cmds.find((c) => c.argv[0] === 'cat');
  assert.match(cat.heredoc, /really\)/);
});

test('a heredoc fed to a shell is parsed as commands', () => {
  assert.ok(argvs('bash <<EOF\ngit push origin main\nEOF').some((x) => x.join(' ') === 'git push origin main'));
});

test('strips env assignments and wrappers', () => {
  const [c] = parseCommandLine('FOO=bar BAZ="a b" sudo -u root env X=1 timeout 5 nice -n 10 nohup git status');
  assert.deepEqual(c.argv, ['git', 'status']);
  assert.deepEqual(c.envAssignments, { FOO: 'bar', BAZ: 'a b', X: '1' });
  assert.deepEqual(c.wrappers, ['sudo', 'env', 'timeout', 'nice', 'nohup']);
});

test('xargs and find -exec are unwrapped', () => {
  const x = parseCommandLine('ls | xargs -n 1 rm -rf');
  assert.deepEqual(x[1].argv, ['rm', '-rf']);
  assert.equal(x[1].fromXargs, true);
  const f = parseCommandLine('find . -name "*.log" -exec rm -rf {} \\;');
  assert.ok(f.some((c) => c.fromFind && c.argv.join(' ') === 'rm -rf {}'));
});

test('a bare wrapper stays the command', () => {
  assert.deepEqual(argvs('env'), [['env']]);
  assert.deepEqual(argvs('time'), [['time']]);
});

test('redirects and fd numbers', () => {
  const [c] = parseCommandLine('node x.js > out.log 2>&1');
  assert.deepEqual(c.argv, ['node', 'x.js']);
  assert.deepEqual(c.redirects.map((r) => r.op), ['>', '>&']);
});

test('comments are ignored', () => {
  assert.deepEqual(argvs('echo hi # rm -rf /'), [['echo', 'hi']]);
});

test('parseOpts handles clusters, values and --', () => {
  const o = parseOpts(['-am', 'msg', '--file=x', '-n', '--', '-y'], { short: 'm', long: ['file'] });
  assert.ok(o.flags.has('a') && o.flags.has('n'));
  assert.deepEqual(o.values.m, ['msg']);
  assert.deepEqual(o.values.file, ['x']);
  assert.deepEqual(o.pos, ['-y']);
});

test('PowerShell dialect: backslash is literal, backtick escapes, doubled single quotes', () => {
  const ps = (s) => parseCommandLine(s, { dialect: 'powershell' }).map((c) => c.argv);
  assert.deepEqual(ps(String.raw`Remove-Item C:\temp\x -Recurse; Get-Content 'it''s.txt'`), [
    ['Remove-Item', String.raw`C:\temp\x`, '-Recurse'],
    ['Get-Content', "it's.txt"],
  ]);
  assert.deepEqual(ps('Write-Output "a`"b" | Out-Null'), [['Write-Output', 'a"b'], ['Out-Null']]);
  assert.equal(parseCommandLine('git status', { dialect: 'powershell' })[0].dialect, 'powershell');
});

test('pwsh -Command and cmd /c are inspected in the PowerShell dialect', () => {
  assert.ok(argvs(String.raw`pwsh -NoProfile -Command "Remove-Item C:\data -Recurse"`).some((x) => x[0] === 'Remove-Item'));
  assert.ok(argvs('cmd /c "rd /s /q build"').some((x) => x.join(' ') === 'rd /s /q build'));
});
