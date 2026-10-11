/**
 * Kimi Code CLI Output Parser
 *
 * Parses newline-delimited JSON from `kimi -p --output-format stream-json`
 * (Kimi Code CLI 0.43.1).
 *
 *   {"role":"meta","type":"system.version","version":"2.1.1"}
 *   {"role":"assistant","content":"..."}
 *   {"role":"assistant","content":"...","tool_calls":[{"id":"...","type":"function","function":{"name":"...","arguments":"..."}}]}
 *   {"role":"tool","tool_call_id":"...","content":"..."}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>","command":"kimi -r session_<uuid>"}
 *
 * A content-only assistant message is the turn's answer. An assistant message
 * that carries tool_calls is narration plus the calls, not the answer: the
 * desktop handler emits a result only once, so marking the narration as a
 * result would drop the real reply. The resume hint's `content` is a command
 * the user can re-run; it is a session id, not answer text. Reasoning is not
 * on this stream.
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

interface KimiToolCall {
	id?: string;
	name?: string;
	function?: {
		name?: string;
		arguments?: unknown;
	};
}

interface KimiMessage {
	role?: string;
	type?: string;
	content?: unknown;
	message?: unknown;
	error?: unknown;
	tool_calls?: KimiToolCall[];
	tool_call_id?: string;
	session_id?: string;
}

interface MappedToolCall {
	name: string;
	id?: string;
	input: unknown;
}

function textFromContent(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === 'string') {
			if (part) parts.push(part);
			continue;
		}
		if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
			const text = (part as { text: string }).text;
			if (text) parts.push(text);
		}
	}
	return parts.join('');
}

function toolInput(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function callName(call: KimiToolCall): string {
	const fromFunction = call.function?.name;
	if (typeof fromFunction === 'string' && fromFunction.trim()) return fromFunction.trim();
	if (typeof call.name === 'string' && call.name.trim()) return call.name.trim();
	return '';
}

function sessionIdOf(msg: KimiMessage): string | undefined {
	return typeof msg.session_id === 'string' && msg.session_id ? msg.session_id : undefined;
}

function hasToolCalls(msg: KimiMessage): boolean {
	return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

export class KimiOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'kimi';

	/** tool_call id -> name, so a later role:tool line can name the badge. */
	private readonly toolNames = new Map<string, string>();

	parseJsonLine(line: string): ParsedEvent | null {
		try {
			return this.parseJsonObject(JSON.parse(line));
		} catch {
			return null;
		}
	}

	parseJsonObject(json: unknown): ParsedEvent | null {
		if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
		const msg = json as KimiMessage;
		const sessionId = sessionIdOf(msg);

		if (msg.role === 'meta') {
			return { type: 'system', sessionId, raw: json };
		}

		if (msg.role === 'user') return null;

		if (msg.role === 'tool') {
			const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : undefined;
			const toolName = (toolCallId && this.toolNames.get(toolCallId)) || 'tool';
			return {
				type: 'tool_use',
				sessionId,
				toolName,
				toolCallId,
				toolState: { status: 'completed', result: textFromContent(msg.content) },
				raw: json,
			};
		}

		if (msg.role === 'error' || msg.type === 'error') {
			const text =
				textFromContent(msg.content) ||
				textFromContent(msg.message) ||
				(typeof msg.error === 'string' ? msg.error : '') ||
				'Kimi Code error';
			return { type: 'error', text, sessionId, raw: json };
		}

		if (msg.role !== 'assistant') return null;

		const text = textFromContent(msg.content);
		const calls = this.mapToolCalls(msg.tool_calls);
		if (calls.length > 0) {
			const blocks = calls.map((call) => ({ name: call.name, id: call.id, input: call.input }));
			if (!text) {
				const [first, ...rest] = calls;
				return {
					type: 'tool_use',
					sessionId,
					toolName: first.name,
					toolCallId: first.id,
					toolState: { status: 'running', input: first.input },
					toolUseBlocks: rest.map((call) => ({ name: call.name, id: call.id, input: call.input })),
					raw: json,
				};
			}
			return {
				type: 'text',
				text,
				isPartial: true,
				sessionId,
				toolUseBlocks: blocks,
				raw: json,
			};
		}

		if (!text) return null;
		return {
			type: 'text',
			text,
			isPartial: true,
			sessionId,
			raw: json,
		};
	}

	isResultMessage(event: ParsedEvent): boolean {
		if (event.type !== 'text' || !event.text) return false;
		const raw = event.raw;
		if (!raw || typeof raw !== 'object') return false;
		const msg = raw as KimiMessage;
		return msg.role === 'assistant' && !hasToolCalls(msg);
	}

	extractSessionId(event: ParsedEvent): string | null {
		if (typeof event.sessionId === 'string' && event.sessionId) return event.sessionId;
		const raw = event.raw as KimiMessage | undefined;
		return raw && typeof raw.session_id === 'string' && raw.session_id ? raw.session_id : null;
	}

	extractUsage(_event: ParsedEvent): ParsedEvent['usage'] | null {
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
			return this.matchLine(line);
		}
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') return null;
		const msg = parsed as KimiMessage;
		if (msg.role !== 'error' && msg.type !== 'error' && typeof msg.error !== 'string') {
			return null;
		}
		const text =
			textFromContent(msg.content) ||
			textFromContent(msg.message) ||
			(typeof msg.error === 'string' ? msg.error.trim() : '') ||
			'Kimi Code error';
		return this.toAgentError(text, parsed);
	}

	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		if (exitCode === 0) return null;

		const combined = `${stderr}\n${stdout}`;
		const match = matchErrorPattern(getErrorPatterns(this.agentId), combined);
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

		const stderrPreview = stderr.trim()
			? `: ${stderr.trim().split('\n')[0].substring(0, 200)}`
			: '';
		return {
			type: 'agent_crashed',
			message: `Kimi Code exited with code ${exitCode}${stderrPreview}`,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode, stderr, stdout },
		};
	}

	private mapToolCalls(calls: KimiToolCall[] | undefined): MappedToolCall[] {
		if (!Array.isArray(calls)) return [];
		const mapped: MappedToolCall[] = [];
		for (const call of calls) {
			const name = callName(call);
			if (!name) continue;
			const id = typeof call.id === 'string' && call.id ? call.id : undefined;
			if (id) this.toolNames.set(id, name);
			mapped.push({
				name,
				id,
				input: toolInput(call.function?.arguments),
			});
		}
		return mapped;
	}

	private matchLine(line: string): AgentError | null {
		const match = matchErrorPattern(getErrorPatterns(this.agentId), line);
		if (!match) return null;
		return {
			type: match.type,
			message: match.message,
			recoverable: match.recoverable,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { errorLine: line },
		};
	}

	private toAgentError(errorText: string, parsed: unknown): AgentError {
		const match = matchErrorPattern(getErrorPatterns(this.agentId), errorText);
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
