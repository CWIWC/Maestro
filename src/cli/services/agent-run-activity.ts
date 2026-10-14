// Per-run activity sidecar for CLI workers.
//
// The agent-run ledger rewrites its snapshot under an exclusive lock and can
// rotate the event log. Streaming stdout through that path would stall `send`
// and can corrupt the ledger. Activity is a separate small file, one per run,
// overwritten about once a second. The stdout handler never waits on the write,
// and a disk error is swallowed.

import * as fs from 'fs';
import * as path from 'path';
import type { ParsedEvent } from '../../main/parsers/agent-output-parser';
import { getConfigDirectory } from './storage';

export const ACTIVITY_LINE_MAX = 240;
export const ACTIVITY_TAIL_MAX_LINES = 80;
export const ACTIVITY_FLUSH_MS = 1000;

const ACTIVITY_DIR = 'agent-run-activity';
const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]+$/;

export type ActivityWriter = (runId: string, body: string) => void | Promise<void>;

type LineKind = 'text' | 'thinking' | 'tool' | 'error';

interface ActivityLine {
	kind: LineKind;
	text: string;
}

interface ActivityNote {
	kind: LineKind;
	text: string;
	/** delta appends onto the open line of the same kind. replace extends that line when the new text continues it. push always starts a line. */
	mode: 'delta' | 'replace' | 'push';
}

export interface ActivityBuffer {
	note(event: ParsedEvent): void;
	flush(): Promise<void>;
	lines(): string[];
}

export function isActivityRunId(runId: string): boolean {
	return RUN_ID_PATTERN.test(runId);
}

function activityLogPath(runId: string): string | null {
	if (!isActivityRunId(runId)) return null;
	return path.join(getConfigDirectory(), ACTIVITY_DIR, `${runId}.log`);
}

function clip(text: string): string {
	if (text.length <= ACTIVITY_LINE_MAX) return text;
	return `${text.slice(0, ACTIVITY_LINE_MAX - 3)}...`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Keep a streamed chunk on one sidecar line without eating a leading space. */
function streamChunk(text: string): string {
	return text.replace(/\r?\n/g, ' ');
}

function renderLine(kind: LineKind, text: string): string {
	if (kind === 'thinking') {
		const body = text.startsWith('thinking: ') ? text.slice('thinking: '.length) : text;
		return clip(`thinking: ${body}`);
	}
	return clip(text);
}

function applyNote(lines: ActivityLine[], note: ActivityNote): void {
	if (!note.text) return;
	if (note.mode === 'delta') {
		const last = lines[lines.length - 1];
		if (last && last.kind === note.kind) {
			last.text = clip(last.text + note.text);
			return;
		}
		lines.push({ kind: note.kind, text: renderLine(note.kind, note.text) });
		return;
	}
	if (note.mode === 'replace') {
		const rendered = renderLine(note.kind, oneLine(note.text));
		if (!rendered || rendered === 'thinking:') return;
		const last = lines[lines.length - 1];
		if (
			last &&
			last.kind === note.kind &&
			(rendered.startsWith(last.text) || last.text.startsWith(rendered))
		) {
			if (rendered.length >= last.text.length) last.text = rendered;
			return;
		}
		lines.push({ kind: note.kind, text: rendered });
		return;
	}
	const rendered = clip(note.text);
	if (!rendered) return;
	lines.push({ kind: note.kind, text: rendered });
}

function pushTool(notes: ActivityNote[], name: string | undefined): void {
	const label = oneLine(name || '') || 'tool';
	const text = `tool: ${label}`;
	if (notes.some((note) => note.kind === 'tool' && note.text === text)) return;
	notes.push({ kind: 'tool', text, mode: 'push' });
}

/** Short watch lines for one parsed event. Partial text stays on the open line. */
export function activityNotesFromEvent(event: ParsedEvent): ActivityNote[] {
	const notes: ActivityNote[] = [];
	if (event.type === 'error' && event.text?.trim()) {
		notes.push({ kind: 'error', text: `error: ${oneLine(event.text)}`, mode: 'push' });
	} else if (event.type === 'tool_use') {
		pushTool(notes, event.toolName);
	} else if (event.type === 'text' && event.text) {
		if (event.isReasoning) {
			notes.push({
				kind: 'thinking',
				text: event.isPartial === false ? event.text : streamChunk(event.text),
				mode: event.isPartial === false ? 'replace' : 'delta',
			});
		} else if (event.isPartial) {
			notes.push({ kind: 'text', text: streamChunk(event.text), mode: 'delta' });
		} else {
			notes.push({ kind: 'text', text: event.text, mode: 'replace' });
		}
	} else if (event.type === 'result' && event.text) {
		notes.push({ kind: 'text', text: event.text, mode: 'replace' });
	}

	for (const block of event.toolUseBlocks ?? []) {
		pushTool(notes, block.name);
	}
	return notes;
}

async function writeActivitySnapshot(runId: string, body: string): Promise<void> {
	const filePath = activityLogPath(runId);
	if (!filePath) return;
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true });
	const tmp = path.join(dir, `.${runId}.${process.pid}.tmp`);
	await fs.promises.writeFile(tmp, body, 'utf8');
	await fs.promises.rename(tmp, filePath);
}

/**
 * Keep the latest activity lines for one run and overwrite its sidecar.
 * `note` never waits on disk. `flush` writes the current tail and swallows errors.
 */
export function createActivityBuffer(
	runId: string,
	options?: { write?: ActivityWriter; flushMs?: number }
): ActivityBuffer {
	const write = options?.write ?? writeActivitySnapshot;
	const flushMs = options?.flushMs ?? ACTIVITY_FLUSH_MS;
	const lines: ActivityLine[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	let chain: Promise<void> = Promise.resolve();

	function schedule(): void {
		if (timer || flushMs <= 0) return;
		timer = setTimeout(() => {
			timer = null;
			return flush();
		}, flushMs);
		timer.unref?.();
	}

	function note(event: ParsedEvent): void {
		try {
			const notes = activityNotesFromEvent(event);
			if (notes.length === 0) return;
			for (const item of notes) applyNote(lines, item);
			while (lines.length > ACTIVITY_TAIL_MAX_LINES) lines.shift();
			schedule();
		} catch {
			// Observational. A bad event must not change the spawn result.
		}
	}

	function flush(): Promise<void> {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		const body = lines.map((line) => line.text).join('\n');
		if (!body) return chain;
		chain = chain.then(async () => {
			try {
				await write(runId, `${body}\n`);
			} catch {
				// A sidecar failure must not surface to the spawn or the CLI result.
			}
		});
		return chain;
	}

	return {
		note,
		flush,
		lines: () => lines.map((line) => line.text),
	};
}

/** Invoke a spawn activity listener without letting it change the spawn result. */
export function deliverActivity(
	onActivity: ((event: ParsedEvent) => void) | undefined,
	event: ParsedEvent | null
): void {
	if (!onActivity || !event) return;
	try {
		onActivity(event);
	} catch {
		// Observational. A thrown listener must not change the spawn result.
	}
}

/** Latest sidecar lines for a run. A missing file or an unsafe id is an empty tail. */
export function readActivityTail(runId: string, maxLines = ACTIVITY_TAIL_MAX_LINES): string[] {
	const filePath = activityLogPath(runId);
	if (!filePath) return [];
	let text: string;
	try {
		text = fs.readFileSync(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const parsed = text.split(/\r?\n/).filter((line) => line.length > 0);
	if (parsed.length <= maxLines) return parsed;
	return parsed.slice(-maxLines);
}
