import { useEffect, useState } from 'react';
import type { AgentRun } from '../../../shared/agent-run';
import { useStickToBottom } from '../../hooks/ui/useStickToBottom';
import type { Theme } from '../../types';
import { agentRunService } from '../../services/agentRun';
import { summarize } from './dashboardHelpers';

export const WATCH_POLL_MS = 2000;

interface WatchGridProps {
	theme: Theme;
	runs: AgentRun[];
}

function WatchCard({ theme, run, lines }: { theme: Theme; run: AgentRun; lines: string[] }) {
	const stickRef = useStickToBottom(lines.join('\n'));
	return (
		<article
			className="min-w-0 rounded-xl border p-4"
			style={{ borderColor: theme.colors.border }}
			data-testid="agent-run-watch-card"
		>
			<div className="flex items-center justify-between gap-2">
				<h3 className="truncate text-sm font-semibold">{run.agentName?.trim() || run.id}</h3>
				<span className="shrink-0 text-xs" style={{ color: theme.colors.textDim }}>
					{run.provider}
				</span>
			</div>
			<p className="mt-1 truncate text-xs" style={{ color: theme.colors.textDim }}>
				{summarize(run.prompt)}
			</p>
			<div
				ref={stickRef}
				className="mt-3 max-h-48 overflow-y-auto rounded-md border p-3 font-mono text-xs"
				style={{
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
					backgroundColor: theme.colors.bgActivity,
				}}
			>
				{lines.length > 0 ? (
					lines.map((line, index) => (
						<div key={`${run.id}-${index}`} className="whitespace-pre-wrap break-all">
							{line}
						</div>
					))
				) : (
					<div>Waiting for output...</div>
				)}
			</div>
		</article>
	);
}

export function WatchGrid({ theme, runs }: WatchGridProps) {
	const [tails, setTails] = useState<Record<string, string[]>>({});
	const runIds = runs.map((run) => run.id).join('\n');

	useEffect(() => {
		const ids = runIds.split('\n').filter((id) => id.length > 0);
		let cancelled = false;

		const load = async () => {
			const next: Record<string, string[]> = {};
			await Promise.all(
				ids.map(async (id) => {
					try {
						next[id] = await agentRunService.activityTail(id);
					} catch {
						next[id] = [];
					}
				})
			);
			if (!cancelled) setTails(next);
		};

		void load();
		const timer = setInterval(() => void load(), WATCH_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [runIds]);

	if (runs.length === 0) {
		return (
			<div className="text-sm" style={{ color: theme.colors.textDim }}>
				No CLI workers are running.
			</div>
		);
	}

	return (
		<div className="grid gap-3 md:grid-cols-2" data-testid="agent-run-watch">
			{runs.map((run) => (
				<WatchCard key={run.id} theme={theme} run={run} lines={tails[run.id] ?? []} />
			))}
		</div>
	);
}
