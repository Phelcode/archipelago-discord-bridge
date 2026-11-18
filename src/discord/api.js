const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDiscordApi({ token, applicationId, apiBase }) {
  // Retries: 429 rate limits (honoring retry_after), transient 5xx, and the
  // 404 "Unknown Webhook" (code 10015) race on interaction response endpoints
  // that can occur for a short window right after the initial interaction
  // response until Discord's API nodes register it (known race, see
  // discord-api-docs#7220/#6851). Other 4xx are real errors and fail at once.
  async function call(method, apiPath, body, { retries = 4 } = {}) {
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
        const isUnknownWebhookRace = res.status === 404 && parsed?.code === 10015;
        const isRateLimited = res.status === 429;
        const isServerError = res.status >= 500;
        if ((isUnknownWebhookRace || isRateLimited || isServerError) && attempt < retries) {
          attempt += 1;
          let delay;
          if (isRateLimited) {
            const retryAfterSec = Number(res.headers.get('retry-after') ?? parsed?.retry_after ?? 1);
            delay = Math.min(Math.ceil(retryAfterSec * 1000), 10000);
          } else {
            delay = Math.min(250 * 2 ** (attempt - 1), 5000);
          }
          console.warn(`Discord API ${method} ${apiPath} -> ${res.status}${isUnknownWebhookRace ? ' (10015 Unknown Webhook race)' : ''}; retry ${attempt}/${retries} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(`Discord API ${method} ${apiPath} failed: ${res.status} ${text.slice(0, 300)}`);
      }
      return text ? JSON.parse(text) : null;
    }
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
    respondToInteraction(interactionId, interactionToken, responseBody) {
      return call('POST', `/interactions/${interactionId}/${interactionToken}/callback`, responseBody);
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
