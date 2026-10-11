import { describe, it, expect } from 'vitest';
import { KimiOutputParser } from '../../../main/parsers/kimi-output-parser';

const SESSION = 'session_c5333536-b1a1-4a02-9e37-02713b864ddc';

function line(value: unknown): string {
	return JSON.stringify(value);
}

describe('KimiOutputParser', () => {
	it('treats a content-only assistant message as the answer', () => {
		const parser = new KimiOutputParser();
		const event = parser.parseJsonLine(line({ role: 'assistant', content: 'pong' }));

		expect(event?.type).toBe('text');
		expect(event?.text).toBe('pong');
		expect(event?.isPartial).toBe(true);
		expect(parser.isResultMessage(event!)).toBe(true);
	});

	it('reads the session id from session.resume_hint and does not treat it as the answer', () => {
		const parser = new KimiOutputParser();
		const event = parser.parseJsonLine(
			line({
				role: 'meta',
				type: 'session.resume_hint',
				session_id: SESSION,
				command: `kimi -r ${SESSION}`,
				content: `To resume this session: kimi -r ${SESSION}`,
			})
		);

		expect(event?.type).toBe('system');
		expect(event?.text).toBeUndefined();
		expect(parser.extractSessionId(event!)).toBe(SESSION);
		expect(parser.isResultMessage(event!)).toBe(false);
	});

	it('maps an assistant tool call and the following tool result', () => {
		const parser = new KimiOutputParser();
		const call = parser.parseJsonLine(
			line({
				role: 'assistant',
				content: 'Checking.',
				tool_calls: [
					{
						type: 'function',
						id: 'tc_1',
						function: { name: 'Shell', arguments: '{"command":"ls"}' },
					},
				],
			})
		);

		expect(call?.type).toBe('text');
		expect(call?.text).toBe('Checking.');
		expect(parser.isResultMessage(call!)).toBe(false);
		expect(call?.toolUseBlocks).toEqual([
			{ name: 'Shell', id: 'tc_1', input: { command: 'ls' } },
		]);

		const result = parser.parseJsonLine(
			line({ role: 'tool', tool_call_id: 'tc_1', content: 'file.py' })
		);
		expect(result?.type).toBe('tool_use');
		expect(result?.toolName).toBe('Shell');
		expect(result?.toolCallId).toBe('tc_1');
		expect(result?.toolState).toEqual({ status: 'completed', result: 'file.py' });
	});

	it('ignores a non-JSON line', () => {
		const parser = new KimiOutputParser();
		expect(parser.parseJsonLine('not json at all')).toBeNull();
	});

	it('classifies an auth error line', () => {
		const parser = new KimiOutputParser();
		const error = parser.detectErrorFromLine('Not logged in. Run kimi login to continue.');

		expect(error?.type).toBe('auth_expired');
		expect(error?.message).toContain('kimi login');
		expect(error?.recoverable).toBe(true);
	});
});
