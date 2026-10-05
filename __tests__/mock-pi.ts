import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import type {
	ExtensionAPI,
	ToolInfo,
	EventBus,
	ExtensionContext,
	SessionEntry,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	defineToolset,
	getRegisteredToolsets,
} from "pi-tool-masking";
import type { ToolsetSpec, RegistryEntry } from "pi-tool-masking";

type ToolsetDefaultsMap = ReturnType<
	typeof import("pi-tool-masking").readMergedToolsetDefaults
>;

// ---------------------------------------------------------------------------
// Temp settings dir — real settings.json files, never the developer's ~/.pi
// ---------------------------------------------------------------------------

let tmpCurrent: {
	tmp: string;
	origCwd: string;
	origAgentDir: string | undefined;
} | null = null;

/**
 * Call once at file scope (module level): isolates `PI_CODING_AGENT_DIR` and the
 * process cwd into a fresh mkdtemp dir per test, so global settings live at
 * `<tmp>/.pi/agent/settings.json` and project settings at
 * `<tmp>/.pi/settings.json`. Missing files read as empty settings.
 */
export function useTempAgentDir(): {
	globalSettings: string;
	projectSettings: string;
	writeJson(path: string, data: unknown): void;
} {
	beforeEach(() => {
		const tmp = mkdtempSync(join(tmpdir(), "tbox-settings-"));
		mkdirSync(join(tmp, ".pi", "agent"), { recursive: true });
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		tmpCurrent = {
			tmp,
			origCwd: process.cwd(),
			origAgentDir: process.env.PI_CODING_AGENT_DIR,
		};
		process.env.PI_CODING_AGENT_DIR = join(tmp, ".pi", "agent");
		process.chdir(tmp);
	});
	afterEach(() => {
		if (tmpCurrent === null) return;
		process.chdir(tmpCurrent.origCwd);
		if (tmpCurrent.origAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = tmpCurrent.origAgentDir;
		}
		rmSync(tmpCurrent.tmp, { recursive: true, force: true });
		tmpCurrent = null;
	});
	return {
		get globalSettings() {
			if (tmpCurrent === null) throw new Error("useTempAgentDir not active");
			return join(tmpCurrent.tmp, ".pi", "agent", "settings.json");
		},
		get projectSettings() {
			if (tmpCurrent === null) throw new Error("useTempAgentDir not active");
			return join(tmpCurrent.tmp, ".pi", "settings.json");
		},
		writeJson(path, data) {
			writeFileSync(path, JSON.stringify(data, null, 2));
		},
	};
}

/**
 * Seed toolset-defaults pins into the temp global settings file (real disk —
 * requires `useTempAgentDir()`).
 */
export function pinSettingsDefaultsForTests(
	defaults: ToolsetDefaultsMap,
): void {
	if (tmpCurrent === null) {
		throw new Error("pinSettingsDefaultsForTests requires useTempAgentDir()");
	}
	writeFileSync(
		join(tmpCurrent.tmp, ".pi", "agent", "settings.json"),
		JSON.stringify({ toolsetDefaults: defaults }, null, 2),
	);
}

/** Snapshot of the mock's session branch (for intent reads). */
export function branchOf(mock: MockPI) {
	return mock.createCommandContext().sessionManager.getBranch();
}

/** The mock's branch reader — masking 2.0.0's required toggle parameter. */
export function readerOf(mock: MockPI) {
	return mock.createCommandContext().sessionManager;
}

// -------------------------------------------------------------------------
// Component mount state (for ctx.ui.custom)
// -------------------------------------------------------------------------

interface MountState {
	component: {
		handleInput(data: string): void;
		render(width: number): string[];
		invalidate(): void;
	} | null;
	pendingKeys: string[];
	doneCalled: boolean;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandRecord {
	name: string;
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface StatusRecord {
	slot: string;
	text: string;
}

export interface NotifyRecord {
	message: string;
	level: string;
}

export interface ExtensionCommandContext {
	ui: {
		setStatus: (slot: string, text: string) => void;
		notify: (message: string, level?: string) => void;
		select: (message: string, options: string[]) => Promise<string>;
		confirm: (message: string) => Promise<boolean>;
		custom: <T>(
			factory: (
				tui: unknown,
				theme: unknown,
				kb: unknown,
				done: (result: T) => void,
			) => unknown,
		) => Promise<T>;
		theme: {
			fg: (color: ThemeColor, text: string) => string;
		};
	};
	sessionManager: ExtensionContext["sessionManager"];
	cwd: string;
	mode: string;
	hasUI: boolean;
	model: undefined;
	signal: undefined;
	abort: () => void;
}

// ---------------------------------------------------------------------------
// MockPI — extended for tbox
// ---------------------------------------------------------------------------

/**
 * Tbox's MockPI — extended from the library's MockPI with surfaces
 * tbox exercises that the library's mock lacks.
 *
 * Supports:
 *   - Everything the library's MockPI supports
 *   - registerCommand / dispatchCommand
 *   - ui.setStatus / ui.notify
 *   - ui.theme.fg (returns markers for assertable color)
 *   - getAllTools with all five sourceInfo.source flavors
 *   - defineFakeToolset (test-only helper)
 */
export class MockPI implements Partial<ExtensionAPI> {
	private _activeTools: string[] = [];
	private _tools: ToolInfo[] = [];
	private _entries: CustomEntryRecord[] = [];
	private _sessionEntries: SessionEntry[] = [];
	private _eventEmitter = new EventEmitter();
	private _handlers = new Map<string, Array<(...args: any[]) => void>>();
	private _eventBus: EventBus | null = null;

	// Command tracking
	private _commands = new Map<string, CommandRecord>();

	// UI recording
	private _statusRecords: StatusRecord[] = [];
	private _notifyRecords: NotifyRecord[] = [];

	// Component mount (for ctx.ui.custom)
	private _mountStates = new Map<string, MountState>();
	private _mountCounter = 0;

	// --- Tool management ---

	registerTool(
		info: Pick<ToolInfo, "name" | "description"> & {
			sourceInfo?: ToolInfo["sourceInfo"];
			exposure?: ToolInfo["exposure"];
			namespace?: ToolInfo["namespace"];
		},
	): void {
		const tool: ToolInfo = {
			name: info.name,
			description: info.description ?? "",
			parameters: undefined as any,
			exposure: info.exposure ?? "direct",
			...(info.namespace ? { namespace: info.namespace } : {}),
			sourceInfo: info.sourceInfo ?? {
				path: "mock.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		};
		this._tools.push(tool);
	}

	getAllTools(): ToolInfo[] {
		return [...this._tools];
	}

	setActiveTools(toolNames: string[]): void {
		// Dedupe like pi's _applyToolLoadout.
		this._activeTools = [...new Set(toolNames)];
	}

	getActiveTools(): string[] {
		return [...this._activeTools];
	}

	// --- Command management ---

	registerCommand(
		name: string,
		opts: {
			description: string;
			handler: (args: string, ctx: any) => Promise<void>;
		},
	): void {
		this._commands.set(name, {
			name,
			description: opts.description,
			handler: opts.handler,
		});
	}

	/**
	 * Dispatch a synthetic `/tbox <args>` call to the registered handler.
	 * Returns the handler's output via the mock UI.
	 */
	async dispatchCommand(args: string): Promise<void> {
		const cmd = this._commands.get("tbox");
		if (!cmd) throw new Error("No 'tbox' command registered");
		const ctx = this.createCommandContext();
		await cmd.handler(args, ctx);
	}

	/**
	 * Get all registered tbox commands (for assertions).
	 * Note: this is tbox-specific, not the ExtensionAPI's getCommands.
	 */
	getTboxCommands(): CommandRecord[] {
		return [...this._commands.values()];
	}

	// --- Persistence ---

	appendEntry<T = unknown>(customType: string, data?: T): void {
		this._entries.push({ customType, data });

		this._sessionEntries.push({
			type: "custom",
			id: `mock-entry-${this._entries.length}`,
			parentId: null,
			timestamp: new Date().toISOString(),
			customType,
			data,
		} as SessionEntry);
	}

	getEntries(customType?: string): CustomEntryRecord[] {
		if (customType !== undefined) {
			return this._entries.filter((e) => e.customType === customType);
		}
		return [...this._entries];
	}

	clearEntries(): void {
		this._entries = [];
		this._sessionEntries = [];
	}

	// --- Entry rendering (no-op — tbox doesn't exercise the render path) ---

	registerEntryRenderer(_customType: string, _renderer: any): void {
		// no-op — tbox doesn't exercise the render path
	}

	// --- Events ---

	on(event: any, handler: any): () => void {
		const key = String(event);
		if (!this._handlers.has(key)) {
			this._handlers.set(key, []);
		}
		this._handlers.get(key)!.push(handler);
		return () => {
			const handlers = this._handlers.get(key);
			if (!handlers) return;
			const i = handlers.indexOf(handler);
			if (i !== -1) handlers.splice(i, 1);
		};
	}

	get events(): EventBus {
		if (!this._eventBus) {
			this._eventBus = {
				emit: (channel: string, data: unknown) => {
					this._eventEmitter.emit(channel, data);
				},
				on: (channel: string, handler: (data: unknown) => void) => {
					this._eventEmitter.on(channel, handler);
					return () => {
						this._eventEmitter.off(channel, handler);
					};
				},
			};
		}
		return this._eventBus;
	}

	handlerCount(event: string): number {
		return this._handlers.get(event)?.length ?? 0;
	}

	fireLifecycleEvent(event: string): void {
		const handlers = this._handlers.get(event) ?? [];
		const ctx = this.createContext();
		const eventObj = {};
		for (const h of handlers) {
			h(eventObj, ctx);
		}
	}

	emit(channel: string, data: unknown): void {
		this._eventEmitter.emit(channel, data);
	}

	// --- Session context ---

	createContext(): ExtensionContext {
		return {
			sessionManager: {
				getBranch: () => [...this._sessionEntries],
				getCwd: () => "/mock",
				getSessionDir: () => "/mock/sessions",
				getSessionId: () => "mock-session-id",
				getSessionFile: () => undefined,
				getLeafId: () => null,
				getLeafEntry: () => undefined,
				getEntry: (_id: string) => undefined,
				getLabel: (_id: string) => undefined,
				getHeader: () => null,
				getEntries: () => [...this._sessionEntries],
				getTree: () => [],
				getSessionName: () => undefined,
			} as any,
			ui: this.createUiStub(),
			mode: "tui",
			hasUI: false,
			cwd: "/mock",
			modelRegistry: {} as any,
			model: undefined,
			scopedModels: [] as const,
			isProjectTrusted: () => false,
			isIdle: () => true,
			signal: undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		};
	}

	/** Create a lightweight theme stub for component tests. */
	private _stubTheme(): any {
		return {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
			dim: (text: string) => text,
		};
	}

	/**
	 * Mount a custom component and drain queued keys.
	 * Returns a promise that resolves with the value passed to `done()`.
	 */
	private _mountCustom<T>(
		factory: (
			tui: unknown,
			theme: unknown,
			kb: unknown,
			done: (result: T) => void,
		) => unknown,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const mountId = `mount-${++this._mountCounter}`;
			const mount: MountState = {
				component: null,
				pendingKeys: [...this._customKeySequence],
				doneCalled: false,
			};
			this._mountStates.set(mountId, mount);

			const theme = this._stubTheme();
			const tuiStub = {};
			const kbStub = { matches: () => false };

			const comp = factory(tuiStub, theme, kbStub, (result: T) => {
				mount.doneCalled = true;
				resolve(result);
			});

			mount.component = comp as MountState["component"];

			// Drain queued keys — synchronous handleInput calls
			if (!mount.component) {
				reject(new Error("factory did not return a component"));
				return;
			}

			while (mount.pendingKeys.length > 0 && !mount.doneCalled) {
				const key = mount.pendingKeys.shift()!;
				mount.component.handleInput(key);
			}

			if (!mount.doneCalled) {
				reject(
					new Error(
						`Custom component key sequence exhausted without done() being called (${this._customKeySequence.length} keys processed)`,
					),
				);
			}
		});
	}

	// --- Command context (for handler invocation) ---

	createCommandContext(): ExtensionCommandContext {
		return {
			ui: this.createUiStub(),
			sessionManager: this.createContext().sessionManager,
			cwd: "/mock",
			mode: "tui",
			hasUI: false,
			model: undefined,
			signal: undefined,
			abort: () => {},
		};
	}

	private createUiStub(): any {
		return {
			setStatus: (slot: string, text: string) => {
				this._statusRecords.push({ slot, text });
			},
			notify: (message: string, level?: string) => {
				this._notifyRecords.push({ message, level: level ?? "info" });
			},
			custom: <T>(
				factory: (
					tui: unknown,
					theme: unknown,
					kb: unknown,
					done: (result: T) => void,
				) => unknown,
			) => this._mountCustom<T>(factory),
			theme: {
				fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
			},
		};
	}

	// --- Test helpers ---

	/** Get all status records (for assertions). */
	getStatusRecords(): StatusRecord[] {
		return [...this._statusRecords];
	}

	/** Get the last status record for a specific slot. */
	getLastStatus(slot: string): StatusRecord | undefined {
		for (let i = this._statusRecords.length - 1; i >= 0; i--) {
			if (this._statusRecords[i]!.slot === slot) {
				return this._statusRecords[i];
			}
		}
		return undefined;
	}

	/** Get all notify records (for assertions). */
	getNotifyRecords(): NotifyRecord[] {
		return [...this._notifyRecords];
	}

	/** Get the last notify message. */
	getLastNotify(): NotifyRecord | undefined {
		return this._notifyRecords[this._notifyRecords.length - 1];
	}

	/** Clear all UI records (for test isolation). */
	clearUiRecords(): void {
		this._statusRecords = [];
		this._notifyRecords = [];
		this._customKeySequence = [];
		this._mountStates.clear();
	}

	// -----------------------------------------------------------------------
	// Custom component test helpers
	// -----------------------------------------------------------------------

	private _customKeySequence: string[] = [];

	/**
	 * Queue key data strings for the next ui.custom() call.
	 * Each string is fed to handleInput() in order.
	 */
	setCustomKeySequence(keys: string[]): void {
		this._customKeySequence = [...keys];
	}

	// -----------------------------------------------------------------------
	// keyFor — map logical action names to key bytes
	// -----------------------------------------------------------------------

	/**
	 * Return the raw key bytes for a given logical action or named key.
	 *
	 * Supported names:
	 *   up / down                 — arrow keys
	 *   confirm / enter            — toggle the focused row
	 *   cancel / escape            — cancel / clear search
	 *   save / ctrl+s              — persist to config
	 *   enableAll / ctrl+a         — enable all (filtered)
	 *   clearAll / ctrl+x          — clear all (filtered)
	 *   backspace                  — delete last search char
	 *   ctrl+c                     — cancel
	 *   Any printable single char  — passed through
	 */
	keyFor(action: string): string {
		const table: Record<string, string> = {
			up: "\x1B[A",
			down: "\x1B[B",
			confirm: "\r",
			enter: "\r",
			escape: "\x1B",
			cancel: "\x1B",
			save: "\x13", // ctrl+s
			"ctrl+s": "\x13",
			enableAll: "\x01", // ctrl+a
			"ctrl+a": "\x01",
			clearAll: "\x18", // ctrl+x
			"ctrl+x": "\x18",
			backspace: "\x7F",
			"ctrl+c": "\x03",
		};
		const v = table[action];
		if (v !== undefined) return v;
		// Single printable character
		if (
			action.length === 1 &&
			action.charCodeAt(0) >= 0x20 &&
			action.charCodeAt(0) <= 0x7e
		) {
			return action;
		}
		throw new Error(`keyFor: unknown action "${action}"`);
	}

	// --- Fake toolset registration (test-only) ---

	/**
	 * Register a fake toolset directly into the shared globalThis registry,
	 * simulating a sibling extension like portal.web/portal.learn.
	 *
	 * Test-only — this pokes library internals so test fixtures can skip
	 * registering restore handlers on the mock pi.
	 */
	defineFakeToolset(spec: ToolsetSpec): RegistryEntry {
		defineToolset(this as unknown as ExtensionAPI, spec);
		const entries = getRegisteredToolsets();
		const entry = entries.find((e: RegistryEntry) => e.spec.id === spec.id);
		if (!entry) {
			throw new Error(`Fake toolset ${spec.id} not found in registry`);
		}
		return entry;
	}

	/**
	 * Reset the globalThis registry and module state (test isolation).
	 */
	static cleanRegistry(): void {
		delete (globalThis as any)["__piToolMaskingRegistry"];
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomEntryRecord {
	customType: string;
	data: unknown;
}
