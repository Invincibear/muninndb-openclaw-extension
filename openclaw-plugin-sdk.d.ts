/**
 * Type declarations for the OpenClaw plugin SDK.
 * The actual module is provided by the OpenClaw runtime at load time.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  }

  export interface ToolResult {
    content: Array<{ type: string; text: string }>;
  }

  export interface ToolRegistrationOpts {
    names?: string[];
    optional?: boolean;
  }

  export interface BeforeAgentEvent {
    prompt: string;
    [key: string]: unknown;
  }

  export interface AgentEndEvent {
    success: boolean;
    messages: Array<{ role: string; content: string } | null>;
    [key: string]: unknown;
  }

  export interface CommanderLike {
    command(name: string): CommanderLike;
    description(desc: string): CommanderLike;
    argument(name: string, desc: string): CommanderLike;
    option(flags: string, desc: string, defaultValue?: string): CommanderLike;
    action(fn: (...args: unknown[]) => void | Promise<void>): CommanderLike;
  }

  export interface PluginAPI {
    pluginConfig: Record<string, unknown>;
    logger: PluginLogger;
    registerTool(
      definition: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
      },
      opts?: ToolRegistrationOpts,
    ): void;
    registerService(service: { id: string; start: () => void; stop: () => void }): void;
    registerSystemPromptSection(section: { id: string; title: string; content: string }): void;
    registerMemoryPromptSection(
      handler: (context: { availableTools: Set<string>; citationsMode: string }) => string[],
    ): void;
    registerCli(handler: (context: { program: CommanderLike }) => void, opts?: { commands?: string[] }): void;
    on(
      event: "before_agent_start",
      handler: (event: BeforeAgentEvent) => Promise<{ prependContext: string } | undefined | void>,
    ): void;
    on(event: "agent_end", handler: (event: AgentEndEvent) => Promise<void> | void): void;
    on(event: string, handler: (event: Record<string, unknown>) => unknown): void;
  }

  export function definePluginEntry(definition: {
    id: string;
    name: string;
    description: string;
    kind: string;
    register(api: PluginAPI): void | Promise<void>;
  }): unknown;
}
