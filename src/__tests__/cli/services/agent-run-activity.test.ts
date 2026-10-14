import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	ACTIVITY_LINE_MAX,
	ACTIVITY_TAIL_MAX_LINES,
	createActivityBuffer,
	readActivityTail,
} from '../../../cli/services/agent-run-activity';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';

const RUN_ID = 'run_cli-send_1_abcd1234';

function text(partial: string, extra: Partial<ParsedEvent> = {}): ParsedEvent {
	return { type: 'text', text: partial, isPartial: true, ...extra };
}

describe('agent-run activity sidecar', () => {
	let tempDir: string | undefined;
	let previousUserData: string | undefined;

	afterEach(() => {
		vi.useRealTimers();
		if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = previousUserData;
		previousUserData = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it('coalesces partial text onto one line and keeps tools, thinking, and errors', () => {
		const buffer = createActivityBuffer(RUN_ID, { write: () => {}, flushMs: 0 });

		buffer.note(text('Hel'));
		buffer.note(text('lo'));
		buffer.note(text('\nthere'));
		buffer.note({ type: 'tool_use', toolName: 'Shell' });
		buffer.note(text('done'));
		buffer.note(text('hmm', { isReasoning: true }));
		buffer.note(text(' more', { isReasoning: true }));
		buffer.note({ type: 'error', text: 'nope\nreally' });
		buffer.note({
			type: 'text',
			text: 'Looking',
			isPartial: true,
			toolUseBlocks: [{ name: 'Shell' }, { name: 'Shell' }],
		});

		expect(buffer.lines()).toEqual([
			'Hello there',
			'tool: Shell',
			'done',
			'thinking: hmm more',
			'error: nope really',
			'Looking',
			'tool: Shell',
		]);
	});

	it('replaces the open text line when a result extends it', () => {
		const buffer = createActivityBuffer(RUN_ID, { write: () => {}, flushMs: 0 });
		buffer.note(text('Hi'));
		buffer.note({ type: 'result', text: 'Hi there' });
		expect(buffer.lines()).toEqual(['Hi there']);
	});

	it('clips a long line and keeps only the latest tail', () => {
		const buffer = createActivityBuffer(RUN_ID, { write: () => {}, flushMs: 0 });
		buffer.note(text('x'.repeat(ACTIVITY_LINE_MAX + 20)));
		expect(buffer.lines()[0]).toHaveLength(ACTIVITY_LINE_MAX);
		expect(buffer.lines()[0].endsWith('...')).toBe(true);

		for (let i = 0; i < ACTIVITY_TAIL_MAX_LINES + 10; i++) {
			buffer.note({ type: 'tool_use', toolName: `Tool${i}` });
		}
		const lines = buffer.lines();
		expect(lines).toHaveLength(ACTIVITY_TAIL_MAX_LINES);
		expect(lines[0]).toBe('tool: Tool10');
		expect(lines[lines.length - 1]).toBe(`tool: Tool${ACTIVITY_TAIL_MAX_LINES + 9}`);
	});

	it('swallows a thrown writer and still returns the in-memory tail', async () => {
		const buffer = createActivityBuffer(RUN_ID, {
			write: () => {
				throw new Error('disk full');
			},
			flushMs: 0,
		});
		buffer.note(text('pong'));
		await expect(buffer.flush()).resolves.toBeUndefined();
		expect(buffer.lines()).toEqual(['pong']);
	});

	it('reads a written tail and refuses an unsafe run id', async () => {
		previousUserData = process.env.MAESTRO_USER_DATA;
		tempDir = mkdtempSync(join(tmpdir(), 'maestro-activity-'));
		process.env.MAESTRO_USER_DATA = tempDir;

		const buffer = createActivityBuffer(RUN_ID, { flushMs: 0 });
		buffer.note(text('Hel'));
		buffer.note(text('lo'));
		buffer.note({ type: 'tool_use', toolName: 'Shell' });
		await buffer.flush();

		expect(readActivityTail(RUN_ID)).toEqual(['Hello', 'tool: Shell']);
		expect(readActivityTail('run_missing_1_abcd1234')).toEqual([]);
		expect(readActivityTail('../etc/passwd')).toEqual([]);
		expect(readActivityTail('run_../secret')).toEqual([]);
	});

	it('overwrites the sidecar about once a second and does not wait inside note', async () => {
		vi.useFakeTimers();
		const writes: string[] = [];
		const buffer = createActivityBuffer(RUN_ID, {
			write: (_runId, body) => {
				writes.push(body);
			},
			flushMs: 1000,
		});

		buffer.note(text('Hel'));
		expect(writes).toEqual([]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(writes).toEqual(['Hel\n']);

		buffer.note(text('lo'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(writes).toEqual(['Hel\n', 'Hello\n']);
		expect(buffer.lines()).toEqual(['Hello']);
	});
});
