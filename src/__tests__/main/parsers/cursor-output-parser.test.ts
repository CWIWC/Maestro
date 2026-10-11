import { describe, it, expect } from 'vitest';
import { CursorOutputParser } from '../../../main/parsers/cursor-output-parser';

const SESSION = 'c6b62c6f-7ead-4fd6-9922-e952131177ff';

function line(value: unknown): string {
	return JSON.stringify(value);
}

describe('CursorOutputParser', () => {
	it('reads the session id from the init event', () => {
		const parser = new CursorOutputParser();
		const event = parser.parseJsonLine(
			line({
				type: 'system',
				subtype: 'init',
				session_id: SESSION,
				model: 'Composer',
				cwd: '/work',
			})
		);

		expect(event?.type).toBe('init');
		expect(parser.extractSessionId(event!)).toBe(SESSION);
	});

	it('ignores the echoed user message', () => {
		const parser = new CursorOutputParser();
		const event = parser.parseJsonLine(
			line({
				type: 'user',
				message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
				session_id: SESSION,
			})
		);

		expect(event?.type).toBe('system');
		expect(event?.text).toBeUndefined();
	});

	it('forwards a complete assistant message as partial text', () => {
		const parser = new CursorOutputParser();
		const event = parser.parseJsonLine(
			line({
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'text', text: 'I will read the file' }] },
				session_id: SESSION,
			})
		);

		expect(event).toMatchObject({
			type: 'text',
			text: 'I will read the file',
			isPartial: true,
		});
	});

	it('appends streaming deltas and skips the duplicate flushes', () => {
		const parser = new CursorOutputParser();
		const delta = parser.parseJsonObject({
			type: 'assistant',
			timestamp_ms: 1,
			message: { content: [{ type: 'text', text: 'Hello' }] },
			session_id: SESSION,
		});
		const beforeTool = parser.parseJsonObject({
			type: 'assistant',
			timestamp_ms: 2,
			model_call_id: 'call-1',
			message: { content: [{ type: 'text', text: 'Hello' }] },
			session_id: SESSION,
		});
		const endFlush = parser.parseJsonObject({
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Hello' }] },
			session_id: SESSION,
		});

		expect(delta).toMatchObject({ type: 'text', text: 'Hello', isPartial: true });
		expect(beforeTool?.type).toBe('system');
		expect(endFlush?.type).toBe('system');
	});

	it('maps tool start and completion onto running and completed states', () => {
		const parser = new CursorOutputParser();
		const started = parser.parseJsonObject({
			type: 'tool_call',
			subtype: 'started',
			call_id: 'tool-1',
			tool_call: { readToolCall: { args: { path: 'README.md' } } },
			session_id: SESSION,
		});
		const completed = parser.parseJsonObject({
			type: 'tool_call',
			subtype: 'completed',
			call_id: 'tool-1',
			tool_call: {
				readToolCall: {
					args: { path: 'README.md' },
					result: { success: { content: '# Project' } },
				},
			},
			session_id: SESSION,
		});

		expect(started).toMatchObject({
			type: 'tool_use',
			toolName: 'Read',
			toolCallId: 'tool-1',
			toolState: { status: 'running', input: { path: 'README.md' } },
		});
		expect(completed).toMatchObject({
			type: 'tool_use',
			toolName: 'Read',
			toolState: { status: 'completed' },
		});
	});

	it('uses function.name when the tool call is a generic function', () => {
		const parser = new CursorOutputParser();
		const event = parser.parseJsonObject({
			type: 'tool_call',
			subtype: 'started',
			call_id: 'fn-1',
			tool_call: { function: { name: 'Shell', arguments: { command: 'ls' } } },
		});

		expect(event).toMatchObject({ toolName: 'Shell', toolCallId: 'fn-1' });
	});

	it('treats the result event as the canonical answer and captures its session id', () => {
		const parser = new CursorOutputParser();
		const event = parser.parseJsonLine(
			line({
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: 'Done',
				session_id: SESSION,
			})
		);

		expect(event?.type).toBe('result');
		expect(event?.text).toBe('Done');
		expect(parser.isResultMessage(event!)).toBe(true);
		expect(parser.extractSessionId(event!)).toBe(SESSION);
	});

	it('classifies an error result and the logged-out stderr', () => {
		const parser = new CursorOutputParser();
		const event = parser.parseJsonObject({
			type: 'result',
			subtype: 'error',
			is_error: true,
			result: 'Authentication required. Run agent login',
			session_id: SESSION,
		});
		expect(event?.type).toBe('error');

		const fromJson = parser.detectErrorFromParsed({
			type: 'result',
			subtype: 'error',
			is_error: true,
			result: 'Authentication required. Run agent login',
		});
		expect(fromJson?.type).toBe('auth_expired');

		const fromExit = parser.detectErrorFromExit(
			1,
			"Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY.",
			''
		);
		expect(fromExit?.type).toBe('auth_expired');
	});

	it('returns null for blank and non-json lines', () => {
		const parser = new CursorOutputParser();
		expect(parser.parseJsonLine('')).toBeNull();
		expect(parser.parseJsonLine('not json')).toBeNull();
	});
});
