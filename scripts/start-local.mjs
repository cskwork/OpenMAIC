import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const cwd = fileURLToPath(new URL('..', import.meta.url));
process.chdir(cwd);
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
function run(command, args) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
  children.push(child);
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  return child;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
const db = run('docker', [
  'compose',
  '-p',
  'learn-anything-openmaic',
  '-f',
  'docker-compose.db.yml',
  'up',
  '-d',
  '--wait',
  'postgres',
]);
await new Promise((done, fail) =>
  db.on('exit', (code) =>
    code === 0 ? done() : fail(new Error('Database startup failed. Check Docker Desktop.')),
  ),
).catch((error) => {
  console.error(error.message);
  stop(1);
});
if (!stopping) {
  const speech = run(resolve('.venv-tts/bin/python'), ['-u', 'scripts/qwen-tts-server.py']);
  speech.on('exit', (code) => {
    if (!stopping) stop(code || 1);
  });
  const speechPort = Number(process.env.QWEN_TTS_PORT || 57441);
  let speechReady = false;
  for (let attempt = 0; attempt < 240 && !stopping; attempt++) {
    try {
      speechReady = (await fetch(`http://127.0.0.1:${speechPort}/health`)).ok;
    } catch {}
    if (speechReady) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!speechReady) {
    console.error(
      'Local Qwen3-TTS did not start. Check the runtime and voice profile in LOCAL_SETUP.md.',
    );
    stop(1);
  }
}
if (!stopping) {
  const bridge = run(process.execPath, ['--env-file=.env.local', 'scripts/codex-oauth-bridge.mjs']);
  bridge.on('exit', (code) => {
    if (!stopping) stop(code || 1);
  });
  const port = Number(process.env.CODEX_BRIDGE_PORT || 57440);
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!ready) {
    console.error('Codex adapter did not start. Run codex login, then pnpm local:start.');
    stop(1);
  } else if (!stopping) {
    const appPort = process.env.OPENMAIC_PORT || '3000';
    const app = run(process.execPath, [
      resolve('node_modules/next/dist/bin/next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      appPort,
    ]);
    app.on('exit', (code) => {
      if (!stopping) stop(code || 1);
    });
    console.log(`OpenMAIC: http://localhost:${appPort}`);
  }
}
