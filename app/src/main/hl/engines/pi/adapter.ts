import { mainLogger } from '../../../logger';
import { register } from '../registry';
import { applyBrowserHarnessEnv } from '../browserHarnessEnv';
import { buildSkillIndexPrompt, SKILL_DISCOVERY_AND_LIFECYCLE_LINES, htmlBlockGuidanceLines, optionsBlockGuidanceLines, askBlockGuidanceLines } from '../skillIndexPrompt';
import { resolveThemeMode } from '../../../themeMode';
import { enrichedEnv } from '../pathEnrich';
import { runCliCapture } from '../cliSpawn';
import type { AuthProbe, EngineAdapter, InstallProbe, ParseContext, ParseResult, SpawnContext } from '../types';
import type { HlEvent } from '../../../../shared/session-schemas';

const ID = 'pi';
const DISPLAY = 'Pi Agent';
const BIN = 'pi';

function textContent(message: Record<string, unknown> | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
      ? (part as Record<string, unknown>).text as string
      : '')
    .join('');
}

function resultPreview(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, 4000);
  if (result && typeof result === 'object') {
    const rec = result as Record<string, unknown>;
    if (Array.isArray(rec.content)) {
      const text = rec.content.map((part) => part && typeof part === 'object'
        ? String((part as Record<string, unknown>).text ?? '')
        : '').join('\n');
      if (text) return text.slice(0, 4000);
    }
  }
  try { return JSON.stringify(result).slice(0, 4000); }
  catch { return String(result).slice(0, 4000); }
}

function terminalMessageError(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  if (record.role !== 'assistant') return null;
  if (record.stopReason !== 'error' && record.stopReason !== 'aborted') return null;
  return String(record.errorMessage ?? `Pi ${record.stopReason}`);
}

const piAdapter: EngineAdapter = {
  id: ID,
  displayName: DISPLAY,
  binaryName: BIN,

  async probeInstalled(): Promise<InstallProbe> {
    const result = await runCliCapture(BIN, ['--version']);
    if (!result.ok) return { installed: false, error: result.stderr || result.error || 'pi not found on PATH' };
    return { installed: true, version: result.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0] };
  },

  async probeAuthed(): Promise<AuthProbe> {
    const result = await runCliCapture(BIN, ['--list-models'], 15_000);
    const hasModel = result.ok && result.stdout.split(/\r?\n/).some((line) => /^\S+\s+\S+\s+\d/.test(line.trim()));
    return hasModel
      ? { authed: true }
      : { authed: false, error: result.stderr || result.error || 'No configured Pi model/provider' };
  },

  async openLoginInTerminal(): Promise<{ opened: boolean; error?: string }> {
    return { opened: false, error: 'Configure a provider with `pi` or `pi auth`, then refresh.' };
  },

  wrapPrompt(ctx: SpawnContext): string {
    const lines = [
      'You are driving a specific Chromium browser view on this machine.',
      `Your target is CDP target_id=${ctx.targetId} on port ${ctx.cdpPort} (env BU_TARGET_ID / BU_CDP_PORT).`,
      'Read `./AGENTS.md` for how to drive the browser with Browser Harness JS.',
      ...SKILL_DISCOVERY_AND_LIFECYCLE_LINES,
      ...htmlBlockGuidanceLines(resolveThemeMode()),
      ...optionsBlockGuidanceLines(),
      ...askBlockGuidanceLines(),
      "Use the `browser-harness-js` CLI for browser actions. Start with `browser-harness-js 'await connectToAssignedTarget()'`.",
      'Do not edit harness files unless the user asks or a confirmed Browser Harness JS defect blocks the task.',
      'The `read` tool only reads files that already exist. To create an output file, use `bash` and write it under the absolute directory in BU_OUTPUTS_DIR; do not call `read` as a write operation.',
    ];
    const skillIndex = buildSkillIndexPrompt(ctx.harnessDir);
    if (skillIndex) lines.push('', skillIndex);
    if (ctx.attachmentRefs.length > 0) {
      lines.push('', 'The user attached these files. Read each one before acting:');
      for (const attachment of ctx.attachmentRefs) {
        lines.push(`  - ${attachment.relPath} (${attachment.mime}, ${attachment.size} bytes)`);
      }
    }
    lines.push(
      '',
      `Save requested files to \`./outputs/${ctx.sessionId}/\` and mention the filename in the final answer.`,
      '',
      `Task: ${ctx.prompt}`,
    );
    return lines.join('\n');
  },

  buildSpawnArgs(ctx: SpawnContext): string[] {
    const args = ['--print', '--mode', 'json', '--approve'];
    if (ctx.resumeSessionId) args.push('--session', ctx.resumeSessionId);
    else args.push('--session-id', ctx.sessionId);
    if (ctx.model) args.push('--model', ctx.model);
    return args;
  },

  getStdinPayload(_ctx: SpawnContext, wrappedPrompt: string): string {
    return wrappedPrompt;
  },

  buildEnv(ctx: SpawnContext, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = enrichedEnv(baseEnv);
    env.BU_TARGET_ID = ctx.targetId;
    env.BU_CDP_PORT = String(ctx.cdpPort);
    return applyBrowserHarnessEnv(ctx, env);
  },

  parseLine(line: string, ctx: ParseContext): ParseResult {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return { events: [] }; }
    if (!raw || typeof raw !== 'object') return { events: [] };
    const event = raw as Record<string, unknown>;
    const type = event.type;
    const events: HlEvent[] = [];

    if (type === 'session' && typeof event.id === 'string') {
      return { events, capturedSessionId: event.id };
    }

    if (type === 'turn_start') {
      ctx.iter += 1;
      return { events };
    }

    if (type === 'message_start' || type === 'message_end') {
      const message = event.message && typeof event.message === 'object'
        ? event.message as Record<string, unknown>
        : undefined;
      if (message?.role === 'assistant') {
        if (typeof message.model === 'string') ctx.currentModel = message.model;
        const narrative = textContent(message);
        if (narrative) ctx.lastNarrative = narrative;
        if (type === 'message_end') {
          const terminalError = terminalMessageError(message);
          if (terminalError) {
            return { events: [{ type: 'error', message: terminalError }], terminalError };
          }
          const usage = message.usage && typeof message.usage === 'object' ? message.usage as Record<string, unknown> : null;
          const cost = usage?.cost && typeof usage.cost === 'object' ? usage.cost as Record<string, unknown> : null;
          if (usage) {
            events.push({
              type: 'turn_usage',
              inputTokens: Number(usage.input ?? 0),
              outputTokens: Number(usage.output ?? 0),
              cachedInputTokens: Number(usage.cacheRead ?? 0),
              costUsd: Number(cost?.total ?? 0),
              model: ctx.currentModel,
              source: 'exact',
            });
          }
        }
      }
      return { events };
    }

    if (type === 'message_update') {
      const update = event.assistantMessageEvent && typeof event.assistantMessageEvent === 'object'
        ? event.assistantMessageEvent as Record<string, unknown>
        : {};
      const delta = update.delta ?? update.textDelta ?? update.text;
      if (update.type === 'text_delta' && typeof delta === 'string' && delta) {
        events.push({ type: 'text', text: delta });
      } else if (update.type === 'thinking_delta' && typeof delta === 'string' && delta) {
        events.push({ type: 'thinking', text: delta });
      }
      return { events };
    }

    if (type === 'tool_execution_start') {
      const id = String(event.toolCallId ?? `${event.toolName ?? 'tool'}:${Date.now()}`);
      const name = String(event.toolName ?? 'tool');
      ctx.pendingTools.set(id, { name, startedAt: Date.now(), iter: ctx.iter });
      events.push({ type: 'tool_call', name, args: event.args && typeof event.args === 'object' ? event.args as Record<string, unknown> : {}, iteration: ctx.iter });
      return { events };
    }

    if (type === 'tool_execution_end') {
      const id = String(event.toolCallId ?? 'unknown');
      const pending = ctx.pendingTools.get(id);
      ctx.pendingTools.delete(id);
      events.push({
        type: 'tool_result',
        name: String(event.toolName ?? pending?.name ?? 'tool'),
        ok: event.isError !== true,
        preview: resultPreview(event.result),
        ms: pending ? Date.now() - pending.startedAt : 0,
      });
      return { events };
    }

    if (type === 'auto_retry_end' && event.success === false) {
      const terminalError = String(event.finalError ?? 'Pi retry failed');
      return { events: [{ type: 'error', message: terminalError }], terminalError };
    }

    if (type === 'agent_end' && event.willRetry !== true) {
      const messages = Array.isArray(event.messages) ? event.messages : [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const terminalError = terminalMessageError(messages[i]);
        if (terminalError) {
          return { events: [{ type: 'error', message: terminalError }], terminalError };
        }
      }
      const summary = ctx.lastNarrative?.trim() || 'Pi task completed';
      mainLogger.info('pi.agentEnd', { model: ctx.currentModel, summaryLength: summary.length });
      return { events: [{ type: 'done', summary, iterations: ctx.iter }], terminalDone: true };
    }

    return { events };
  },
};

register(piAdapter);
