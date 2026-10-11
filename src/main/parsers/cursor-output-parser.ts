/**
 * Cursor CLI Output Parser
 *
 * Parses newline-delimited JSON from
 * `cursor-agent --print --output-format stream-json`.
 *
 * Documented event types (https://cursor.com/docs/cli/reference/output-format):
 *
 *   {"type":"system","subtype":"init","session_id":"...","model":"...","cwd":"..."}
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"session_id":"..."}
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},"session_id":"..."}
 *   {"type":"tool_call","subtype":"started"|"completed","call_id":"...","tool_call":{...},"session_id":"..."}
 *   {"type":"result","subtype":"success"|"error","is_error":false,"result":"...","session_id":"..."}
 *
 * With `--stream-partial-output` (Maestro's batch prefix), assistant events
 * arrive three ways. Only the first carries new text:
 *
 *   timestamp_ms set, no model_call_id  → streaming delta (append)
 *   model_call_id set                    → buffered flush before a tool call (skip)
 *   neither field, after deltas were seen → final flush of the whole turn (skip)
 *
 * Without partial streaming, assistant events are one complete message between
 * tool calls and carry neither field. Those are forwarded as partial text so
 * the live preview still updates. The terminal `result.result` string is the
 * canonical answer (concatenation of the text deltas, not the duplicate flushes).
 *
 * Thinking events are suppressed by the CLI in print mode. A content block
 * typed `thinking` / `reasoning` is still routed as reasoning if one appears.
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

interface CursorContentBlock {
	type?: string;
	text?: string;
}

interface CursorRawMessage {
	type?: string;
	subtype?: string;
	session_id?: string;
	model_call_id?: string;
	timestamp_ms?: number;
	is_error?: boolean;
	result?: unknown;
	message?: unknown;
	call_id?: string;
	tool_call?: unknown;
	error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function sessionIdOf(msg: CursorRawMessage): string | undefined {
	return typeof msg.session_id === 'string' && msg.session_id.trim() ? msg.session_id : undefined;
}

/** Join text blocks. Reasoning-only content is flagged so it stays out of the answer. */
function readMessageText(message: unknown): { text: string; isReasoning: boolean } {
	const record = asRecord(message);
	const content = record?.content;
	if (typeof content === 'string') {
		return { text: content, isReasoning: false };
	}
	if (!Array.isArray(content)) {
		return { text: '', isReasoning: false };
	}

	const textParts: string[] = [];
	const reasoningParts: string[] = [];
	for (const block of content) {
		const item = block as CursorContentBlock;
		if (typeof item?.text !== 'string' || !item.text) continue;
		if (item.type === 'thinking' || item.type === 'reasoning') {
			reasoningParts.push(item.text);
		} else {
			textParts.push(item.text);
		}
	}

	if (textParts.length > 0) {
		return { text: textParts.join(''), isReasoning: false };
	}
	return { text: reasoningParts.join(''), isReasoning: reasoningParts.length > 0 };
}

/** `readToolCall` → `Read`. A `function.name` payload wins when present. */
function toolCallName(
	toolCall: unknown
): { name: string; payload: Record<string, unknown> } | null {
	const record = asRecord(toolCall);
	if (!record) return null;

	const fn = asRecord(record.function);
	if (fn && typeof fn.name === 'string' && fn.name.trim()) {
		return { name: fn.name.trim(), payload: fn };
	}

	const key =
		Object.keys(record).find((candidate) => /toolcall$/i.test(candidate)) ?? Object.keys(record)[0];
	if (!key) return null;

	const stripped = key.replace(/ToolCall$/i, '').replace(/toolCall$/i, '');
	const name = stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : 'Tool';
	return { name, payload: asRecord(record[key]) ?? {} };
}

function toolExecutionState(
	subtype: string | undefined,
	payload: Record<string, unknown>
): {
	status: 'running' | 'completed' | 'failed';
	input?: unknown;
	result?: unknown;
	error?: unknown;
} {
	const input = payload.args ?? payload.arguments ?? payload.input;
	if (subtype !== 'completed') {
		return { status: 'running', input };
	}

	const result = asRecord(payload.result);
	if (
		result &&
		(result.error !== undefined || result.failure !== undefined) &&
		result.success === undefined
	) {
		return {
			status: 'failed',
			input,
			result: payload.result,
			error: result.error ?? result.failure,
		};
	}
	return { status: 'completed', input, result: payload.result };
}

function errorTextFrom(msg: CursorRawMessage): string | null {
	if (msg.type === 'error') {
		if (typeof msg.message === 'string' && msg.message.trim()) return msg.message;
		if (typeof msg.error === 'string' && msg.error.trim()) return msg.error;
		const nested = asRecord(msg.error);
		if (typeof nested?.message === 'string' && nested.message.trim()) return nested.message;
		return 'Cursor agent reported an error';
	}

	const failed = msg.type === 'result' && (msg.is_error === true || msg.subtype === 'error');
	if (!failed) return null;
	if (typeof msg.result === 'string' && msg.result.trim()) return msg.result;
	return 'Cursor agent run failed';
}

/**
 * Parses Cursor CLI stream-json output into normalized ParsedEvents.
 * One instance per process: it remembers whether streaming deltas have been
 * seen so the end-of-turn flush is not appended a second time.
 */
export class CursorOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'cursor';

	/** True once a timestamped assistant delta has arrived this turn. */
	private sawStreamingDelta = false;

	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) return null;
		try {
			return this.parseJsonObject(JSON.parse(line));
		} catch {
			return null;
		}
	}

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		const msg = asRecord(parsed) as CursorRawMessage | null;
		if (!msg || typeof msg.type !== 'string') return null;

		switch (msg.type) {
			case 'system':
				return this.parseSystem(msg);
			case 'user':
				return { type: 'system', sessionId: sessionIdOf(msg), raw: msg };
			case 'assistant':
				return this.parseAssistant(msg);
			case 'tool_call':
				return this.parseToolCall(msg);
			case 'result':
				return this.parseResult(msg);
			case 'error':
				return {
					type: 'error',
					text: errorTextFrom(msg) ?? 'Cursor agent reported an error',
					sessionId: sessionIdOf(msg),
					raw: msg,
				};
			default:
				return { type: 'system', sessionId: sessionIdOf(msg), raw: msg };
		}
	}

	private parseSystem(msg: CursorRawMessage): ParsedEvent {
		if (msg.subtype === 'init') {
			return { type: 'init', sessionId: sessionIdOf(msg), raw: msg };
		}
		return { type: 'system', sessionId: sessionIdOf(msg), raw: msg };
	}

	private parseAssistant(msg: CursorRawMessage): ParsedEvent {
		const sessionId = sessionIdOf(msg);

		// Buffered copies of text we already streamed. See the file header.
		if (typeof msg.model_call_id === 'string' && msg.model_call_id) {
			return { type: 'system', sessionId, raw: msg };
		}
		const hasTimestamp = typeof msg.timestamp_ms === 'number';
		if (!hasTimestamp && this.sawStreamingDelta) {
			return { type: 'system', sessionId, raw: msg };
		}
		if (hasTimestamp) this.sawStreamingDelta = true;

		const { text, isReasoning } = readMessageText(msg.message);
		if (!text) {
			return { type: 'system', sessionId, raw: msg };
		}
		return {
			type: 'text',
			text,
			isPartial: true,
			isReasoning: isReasoning || undefined,
			sessionId,
			raw: msg,
		};
	}

	private parseToolCall(msg: CursorRawMessage): ParsedEvent {
		const extracted = toolCallName(msg.tool_call);
		const sessionId = sessionIdOf(msg);
		if (!extracted) {
			return { type: 'system', sessionId, raw: msg };
		}
		const callId = typeof msg.call_id === 'string' && msg.call_id ? msg.call_id : undefined;
		return {
			type: 'tool_use',
			toolName: extracted.name,
			toolCallId: callId,
			toolState: toolExecutionState(msg.subtype, extracted.payload),
			sessionId,
			raw: msg,
		};
	}

	private parseResult(msg: CursorRawMessage): ParsedEvent {
		this.sawStreamingDelta = false;
		const sessionId = sessionIdOf(msg);
		const failed = msg.is_error === true || msg.subtype === 'error';
		if (failed) {
			return {
				type: 'error',
				text: errorTextFrom(msg) ?? 'Cursor agent run failed',
				sessionId,
				raw: msg,
			};
		}
		const text = typeof msg.result === 'string' ? msg.result : '';
		return { type: 'result', text, sessionId, raw: msg };
	}

	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		if (event.sessionId) return event.sessionId;
		const raw = event.raw as CursorRawMessage | undefined;
		return raw?.session_id || null;
	}

	extractUsage(_event: ParsedEvent): ParsedEvent['usage'] | null {
		// The documented stream-json result carries duration, not token counts.
		return null;
	}

	extractSlashCommands(_event: ParsedEvent): string[] | null {
		return null;
	}

	detectErrorFromLine(line: string): AgentError | null {
		if (!line.trim()) return null;
		try {
			const error = this.detectErrorFromParsed(JSON.parse(line));
			if (error) {
				error.raw = { ...(error.raw as Record<string, unknown>), errorLine: line };
			}
			return error;
		} catch {
			return null;
		}
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		const msg = asRecord(parsed) as CursorRawMessage | null;
		if (!msg) return null;
		const errorText = errorTextFrom(msg);
		if (!errorText) return null;
		return this.toAgentError(errorText, parsed);
	}

	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		if (exitCode === 0) return null;

		const combined = `${stderr}\n${stdout}`;
		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, combined);
		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				raw: { exitCode, stderr, stdout },
			};
		}

		const stderrPreview = stderr?.trim()
			? `: ${stderr.trim().split('\n')[0].substring(0, 200)}`
			: '';
		return {
			type: 'agent_crashed',
			message: `Cursor CLI exited with code ${exitCode}${stderrPreview}`,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode, stderr, stdout },
		};
	}

	private toAgentError(errorText: string, parsed: unknown): AgentError {
		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, errorText);
		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				parsedJson: parsed,
			};
		}
		return {
			type: 'unknown',
			message: errorText,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			parsedJson: parsed,
		};
	}
}
