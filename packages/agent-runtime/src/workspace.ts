export type ObjectStoreReference = { readonly bucket: string; readonly key: string; readonly version?: string };
export type WorkspaceEntry = { readonly path: string; readonly size: number };
export type WorkspacePath = { readonly path: string };
export type Command = { readonly executable: string; readonly args: readonly string[] };
export type CommandResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export interface AgentWorkspace {
	read(path: string): Promise<Uint8Array>;
	write(path: string, value: Uint8Array): Promise<void>;
	list(path: string): Promise<WorkspaceEntry[]>;
	materialize?(source: ObjectStoreReference): Promise<WorkspacePath>;
}

export interface ComputeEnvironment {
	readonly workspace?: AgentWorkspace;
	exec?(command: Command): Promise<CommandResult>;
	readonly resources?: { readonly cpuClass?: string; readonly memoryClass?: string };
}

function safePath(path: string): string {
	if (path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) throw new Error("Workspace path must be relative");
	return path;
}

/** Small host-neutral workspace useful for deterministic tests and Function tools. */
export class MemoryWorkspace implements AgentWorkspace {
	private readonly files = new Map<string, Uint8Array>();
	async read(path: string): Promise<Uint8Array> {
		const value = this.files.get(safePath(path));
		if (value === undefined) throw new Error(`Workspace file not found: ${path}`);
		return value.slice();
	}
	async write(path: string, value: Uint8Array): Promise<void> { this.files.set(safePath(path), value.slice()); }
	async list(path: string): Promise<WorkspaceEntry[]> {
		const prefix = safePath(path);
		return [...this.files.entries()].filter(([name]) => name === prefix || name.startsWith(`${prefix}/`)).map(([name, value]) => ({ path: name, size: value.byteLength }));
	}
}
