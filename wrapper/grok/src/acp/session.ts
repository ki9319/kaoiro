import * as acp from "@agentclientprotocol/sdk";

export class AcpSession {
  sessionId: string | undefined;
  newSessionResponse: acp.NewSessionResponse | undefined;
  constructor(readonly connection: acp.ClientConnection) {}

  async open(
    cwd: string,
    mcpServers: acp.McpServer[],
    newSessionMeta?: Record<string, unknown>,
  ) {
    await this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "kaoiro", version: "0.0.0" },
      clientCapabilities: {},
    });
    this.newSessionResponse = await this.connection.agent.request(
      acp.methods.agent.session.new,
      { cwd, mcpServers, ...(newSessionMeta ? { _meta: newSessionMeta } : {}) },
    );
    this.sessionId = this.newSessionResponse.sessionId;
    return this.newSessionResponse;
  }

  prompt(text: string) {
    if (!this.sessionId) throw new Error("ACP session is not initialized");
    return this.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  cancel() {
    if (!this.sessionId) return Promise.resolve();
    return this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.sessionId,
    });
  }
}
