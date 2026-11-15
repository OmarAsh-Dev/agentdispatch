export class ReconnectableClient {
  constructor(create) { this.create = create; }
  async connect() {
    if (!this.connecting) this.connecting = this.create().then(client => { this.client = client; return client; }).catch(error => { this.connecting = undefined; throw error; });
    return this.connecting;
  }
  async run(operation) {
    const client = await this.connect();
    try { return await operation(client); }
    catch (error) {
      // A lost server-side MCP session is a known rejected request, not a
      // network timeout with an unknown side effect. Retry only this case.
      if (error.code !== 404) throw error;
      if (this.client === client) { this.connecting = undefined; this.client = undefined; await client.close(); }
      return operation(await this.connect());
    }
  }
  async close() { await this.client?.close(); }
}
