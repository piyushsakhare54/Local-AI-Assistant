const { spawn } = require('node:child_process');
const path = require('node:path');

const serverUrl = 'http://127.0.0.1:5173';
const desktopRoot = __dirname;

async function start() {
  let response;
  try {
    response = await fetch(`${serverUrl}/src/SessionView.tsx`, {
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    runVite();
    return;
  }

  if (!response.ok) {
    throw new Error(`Port 5173 is occupied by a non-Vite service (HTTP ${response.status}).`);
  }
  const source = await response.text();
  if (!source.includes('Stop and transcribe') || !source.includes('/transcribe')) {
    throw new Error(
      'An older frontend is already running on port 5173. Stop it, then run `npm run dev` again.',
    );
  }

  console.log('Using the frontend already serving the updated session UI at http://127.0.0.1:5173');
  const keepAlive = setInterval(() => {}, 60_000);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      clearInterval(keepAlive);
      process.exitCode = 0;
    });
  }
}

function runVite() {
  console.log('Starting the frontend...');
  const vite = spawn(
    process.execPath,
    [path.join(desktopRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    { cwd: desktopRoot, stdio: 'inherit' },
  );

  vite.on('error', (error) => {
    console.error(`Failed to start the frontend: ${error.message}`);
    process.exitCode = 1;
  });
  vite.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => vite.kill(signal));
  }
}

start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
