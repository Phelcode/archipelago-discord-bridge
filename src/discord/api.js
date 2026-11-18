const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDiscordApi({ token, applicationId, apiBase }) {
  // Interaction response endpoints (callback + followup webhooks) can return
  // 404 "Unknown Webhook" (code 10015) for a short window right after the
  // initial interaction response, until Discord's API nodes have registered
  // it (known Discord race, see discord-api-docs#7220/#6851). Retry those
  // briefly with backoff; other 404s are real errors and fail immediately.
  async function call(method, apiPath, body, { retries = 0 } = {}) {
    let attempt = 0;
    for (;;) {
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
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        if (res.status === 404 && parsed?.code === 10015 && attempt < retries) {
          attempt += 1;
          const delay = 250 * 2 ** (attempt - 1);
          console.warn(`Discord API ${method} ${apiPath} -> 404 Unknown Webhook (interaction response not propagated yet); retry ${attempt}/${retries} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(`Discord API ${method} ${apiPath} failed: ${res.status} ${text.slice(0, 300)}`);
      }
      return text ? JSON.parse(text) : null;
    }
  }

  const RETRY_INTERACTION_404 = { retries: 4 };

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
    respondToInteraction(interactionId, interactionToken, responseBody) {
      return call('POST', `/interactions/${interactionId}/${interactionToken}/callback`, responseBody, RETRY_INTERACTION_404);
    },
    editOriginal(interactionToken, payload) {
      return call('PATCH', `/webhooks/${applicationId}/${interactionToken}/messages/@original`, payload, RETRY_INTERACTION_404);
    },
    followup(interactionToken, payload) {
      return call('POST', `/webhooks/${applicationId}/${interactionToken}`, payload, RETRY_INTERACTION_404);
    },
    async downloadAttachment(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
