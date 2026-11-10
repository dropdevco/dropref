#!/usr/bin/env node
// Starts `next dev` with or without the optional local SAM/CV service.
//
//   npm run dev        -> SAM off (works on any machine)
//   npm run dev:sam    -> SAM on  (needs the Python service running)
//
// The flag set here overrides NEXT_PUBLIC_ENABLE_SAM in .env.local, because
// Next.js never overwrites env vars that are already set in the process.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const withSam = args.includes('--sam');
const nextArgs = args.filter((a) => a !== '--sam');

const env = { ...process.env, NEXT_PUBLIC_ENABLE_SAM: withSam ? 'true' : 'false' };
const serviceUrl = (env.NEXT_PUBLIC_SAM_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');

if (withSam) {
  console.log(`\n▶ SAM mode ON — expecting the SAM/CV service at ${serviceUrl}`);
  try {
    // Any HTTP response (even 404) means something is listening.
    await fetch(serviceUrl, { signal: AbortSignal.timeout(1500) });
    console.log('  ✓ service is reachable\n');
  } catch {
    console.warn(
      `  ⚠ nothing answering at ${serviceUrl}. Start it first, e.g.:\n` +
        '      cd ../sam-service && source venv/bin/activate && uvicorn main:app --port 8000\n' +
        '    Analysis will still work (it falls back to the raw video), but the\n' +
        '    Advanced Tracking Layer will show an error until the service is up.\n',
    );
  }
} else {
  console.log('\n▶ SAM mode OFF — run `npm run dev:sam` to enable the local SAM/CV service\n');
}

const nextBin = require.resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, 'dev', ...nextArgs], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
