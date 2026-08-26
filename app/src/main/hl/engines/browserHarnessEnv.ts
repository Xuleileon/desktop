import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SpawnContext } from './types';

export function browserHarnessReplPort(sessionId: string, targetId = ''): string {
  const n = createHash('sha256').update(`${sessionId}:${targetId}`).digest().readUInt16BE(0);
  return String(18_000 + (n % 20_000));
}

export function applyBrowserHarnessEnv(ctx: SpawnContext, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const agentSkillDir = path.join(ctx.harnessDir, 'agent-skill');
  const sdkDir = path.join(ctx.harnessDir, 'browser-harness-js', 'sdk');
  const harnessPath = `${agentSkillDir}${path.delimiter}${sdkDir}`;
  // Windows environment keys are case-insensitive, but Node's env object is
  // not. GUI-launched Electron commonly receives `Path`, while older code
  // added a second `PATH`. CreateProcess keeps only one of those duplicate
  // keys, which could discard the enriched Windows PATH and leave Git Bash
  // unable to find node. Mutate the existing canonical key instead.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const currentPath = env[pathKey];
  env[pathKey] = currentPath ? `${harnessPath}${path.delimiter}${currentPath}` : harnessPath;
  for (const key of Object.keys(env)) {
    if (key !== pathKey && key.toLowerCase() === 'path') delete env[key];
  }
  // These values are resource-ownership boundaries, not user overrides.
  // A desktop process launched from an agent shell may itself inherit an old
  // CDP_REPL_PORT/CDP_REPL_LOG. Preserving those values makes every later
  // conversation post code into the first conversation's persistent REPL.
  env.CDP_REPL_PORT = browserHarnessReplPort(ctx.sessionId, ctx.targetId);
  env.CDP_REPL_LOG = path.join(ctx.harnessDir, `browser-harness-js-${ctx.sessionId}.log`);
  env.BU_SESSION_ID = ctx.sessionId;
  // Watched session outputs dir — any file written here triggers a `file_output`
  // event in runEngine. The Page.captureScreenshot wrapper in repl.ts auto-saves
  // PNGs into this dir so screenshots surface in the chat instead of being
  // dumped as base64 into stdout.
  env.BU_OUTPUTS_DIR = path.join(ctx.harnessDir, 'outputs', ctx.sessionId);
  return env;
}
