export function createDiscordApi({ token, applicationId, apiBase }) {
  async function call(method, apiPath, body) {
    const res = await fetch(`${apiBase}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Discord API ${method} ${apiPath} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    call,
    updateApplication(patch) {
      return call('PATCH', '/applications/@me', patch);
    },
    registerCommands(definitions) {
      return call('PUT', `/applications/${applicationId}/commands`, definitions);
    },
    registerGuildCommands(guildId, definitions) {
      return call('PUT', `/applications/${applicationId}/guilds/${guildId}/commands`, definitions);
    },
    editOriginal(interactionToken, payload) {
      return call('PATCH', `/webhooks/${applicationId}/${interactionToken}/messages/@original`, payload);
    },
    followup(interactionToken, payload) {
      return call('POST', `/webhooks/${applicationId}/${interactionToken}`, payload);
    },
    async downloadAttachment(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
