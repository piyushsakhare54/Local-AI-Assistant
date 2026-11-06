const { spawn } = require('node:child_process');
const path = require('node:path');

const backendUrl = 'http://127.0.0.1:8765/api/health';
const repositoryRoot = path.resolve(__dirname, '..');

async function start() {
  let response;
  try {
    response = await fetch(backendUrl, { signal: AbortSignal.timeout(2000) });
  } catch {
    runBackend();
    return;
  }

  if (!response.ok) {
    throw new Error(`Backend health check failed with HTTP ${response.status}`);
  }

  const health = await response.json();
  if (health.status !== 'ok' || health.app !== 'ready') {
    throw new Error('The service on port 8765 is not a ready application backend');
  }
  if (typeof health.speech !== 'string' || typeof health.inference !== 'string') {
    throw new Error(
      'An older backend is already running on port 8765. Stop that process, then run `npm run dev` again.',
    );
  }

  console.log('Using the backend already running at http://127.0.0.1:8765');
  const keepAlive = setInterval(() => {}, 60_000);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      clearInterval(keepAlive);
      process.exitCode = 0;
    });
  }
}

function runBackend() {
  console.log('Starting the backend...');
  const backend = spawn(
    'uv',
    [
      'run',
      'uvicorn',
      'app.main:app',
      '--app-dir',
      'backend',
      '--host',
      '127.0.0.1',
      '--port',
      '8765',
    ],
    { cwd: repositoryRoot, stdio: 'inherit' },
  );

  backend.on('error', (error) => {
    console.error(`Failed to start the backend: ${error.message}`);
    process.exitCode = 1;
  });
  backend.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => backend.kill(signal));
  }
}

start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
