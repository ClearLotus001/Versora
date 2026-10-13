import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/** Wait for both child close and output close before returning or deleting a lease. */
export async function streamCommandToFile(
  command: string,
  args: string[],
  destination: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const errors: Buffer[] = [];
  let errorBytes = 0;
  let launchError: Error | null = null;
  let timedOut = false;
  const cancel = () => { child.kill(); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  child.stderr.on('data', (chunk: Buffer) => {
    const kept = chunk.subarray(0, Math.max(0, 256 * 1024 - errorBytes));
    if (kept.length) { errors.push(kept); errorBytes += kept.length; }
  });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 120_000);
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', error => { launchError = error; });
    child.once('close', code => {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', cancel);
      if (options.signal?.aborted) {
        const reason: unknown = options.signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason))); return;
      }
      if (launchError) { reject(launchError); return; }
      if (timedOut) { reject(new Error(`${command} snapshot timed out.`)); return; }
      if (code !== 0) { reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `${command} exited with code ${code}.`)); return; }
      resolve();
    });
  });
  const output = pipeline(child.stdout, createWriteStream(destination, { flags: 'wx' }), {
    ...(options.signal ? { signal: options.signal } : {}),
  }).catch(error => { child.kill(); throw error; });
  const [exitResult, outputResult] = await Promise.allSettled([exit, output]);
  if (exitResult.status === 'rejected') throw exitResult.reason;
  if (outputResult.status === 'rejected') throw outputResult.reason;
}
