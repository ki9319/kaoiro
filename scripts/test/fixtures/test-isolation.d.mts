export function boundaryEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function registerOwnedRoot(directory: string): void;
export function permitHostAccess(options: {
  kinds: Array<"systemd" | "gh" | "docker" | "network">;
  optIn: string;
  reason: string;
}): boolean;
export function registerForeignRoot(directory: string): void;
export function isolationNodeOptions(): string;
