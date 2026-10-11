/**
 * @fileoverview Tests for agent icon constants
 * Tests: dedicated icons for active agents, default fallback for unknown agents
 */

import { describe, it, expect } from 'vitest';
import {
	AGENT_ICONS,
	DEFAULT_AGENT_ICON,
	getAgentIcon,
} from '../../../renderer/constants/agentIcons';

describe('agentIcons', () => {
	it('returns a dedicated icon for cursor (not the default fallback)', () => {
		expect(AGENT_ICONS.cursor).toBeDefined();
		expect(getAgentIcon('cursor')).toBe(AGENT_ICONS.cursor);
		expect(getAgentIcon('cursor')).not.toBe(DEFAULT_AGENT_ICON);
	});

	it('returns a dedicated icon for kimi (not the default fallback)', () => {
		expect(AGENT_ICONS.kimi).toBeDefined();
		expect(getAgentIcon('kimi')).toBe(AGENT_ICONS.kimi);
		expect(getAgentIcon('kimi')).not.toBe(DEFAULT_AGENT_ICON);
	});

	it('returns a dedicated icon for grok (not the default fallback)', () => {
		expect(AGENT_ICONS.grok).toBeDefined();
		expect(getAgentIcon('grok')).toBe(AGENT_ICONS.grok);
		expect(getAgentIcon('grok')).not.toBe(DEFAULT_AGENT_ICON);
	});

	it('returns dedicated icons for the other active agents', () => {
		for (const id of ['claude-code', 'codex', 'opencode', 'factory-droid', 'terminal']) {
			expect(getAgentIcon(id)).not.toBe(DEFAULT_AGENT_ICON);
		}
	});

	it('falls back to the default icon for unknown agents', () => {
		expect(getAgentIcon('unknown-agent')).toBe(DEFAULT_AGENT_ICON);
	});
});
