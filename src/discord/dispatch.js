import { canHost, isOwner } from './permissions.js';
import {
  PERMISSIONS, EPHEMERAL_COMMANDS, ALWAYS_MODAL, MODAL_PERMISSIONS, MODAL_REGISTER,
  handleCommand, handleModal, UserError,
} from './commands.js';

export async function downloadAttachment(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export function chunkContent(text, max = 1900) {
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

// Normalize a discord.js interaction into the plain ctx shape the handlers use.
function interactionToCtx(interaction, { config, db, download }) {
  const userId = interaction.user?.id || interaction.member?.user?.id;
  const userName = interaction.user?.username || interaction.member?.user?.username || userId;
  const ctx = {
    config, db, userId, userName, download,
    options: {}, attachments: {}, subcommand: null, subOptions: {},
    modalCustomId: null, modal: null,
  };
  if (interaction.isModalSubmit?.()) {
    ctx.modalCustomId = interaction.customId;
    const fields = {};
    const files = {};
    for (const [customId, field] of interaction.fields.fields) {
      if (field.type === 19 || field.type === 11) {
        const uploaded = interaction.fields.getUploadedFiles?.(customId);
        files[customId] = uploaded
          ? [...uploaded.values()].map((a) => ({ id: a.id, filename: a.name, size: a.size, url: a.url }))
          : [];
      } else if (field.type === 4) {
        fields[customId] = interaction.fields.getTextInputValue(customId);
      }
    }
    ctx.modal = { fields, files };
    return ctx;
  }
  if (interaction.isChatInputCommand?.()) {
    for (const opt of interaction.options.data ?? []) {
      if (opt.type === 1) {
        ctx.subcommand = opt.name;
        for (const o of opt.options ?? []) {
          ctx.subOptions[o.name] = o.type === 6
            ? (interaction.options.getUser(o.name)?.id ?? o.value)
            : o.value;
        }
      } else if (opt.type === 10) {
        const att = interaction.options.getAttachment(opt.name);
        if (att) ctx.attachments[opt.name] = { id: att.id, filename: att.name, size: att.size, url: att.url };
      } else if (opt.type === 6) {
        ctx.options[opt.name] = interaction.options.getUser(opt.name)?.id ?? opt.value;
      } else {
        ctx.options[opt.name] = opt.value;
      }
    }
  }
  return ctx;
}

async function finishWithResult(interaction, ctx, produce) {
  try {
    const content = String(await produce(ctx));
    const chunks = chunkContent(content);
    await interaction.editReply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, ephemeral: interaction.ephemeral ?? false });
    }
  } catch (err) {
    if (err instanceof UserError) {
      await interaction.editReply(`❌ ${err.message}`);
    } else {
      console.error('Interaction handling failed:', err);
      await interaction.editReply(`❌ Something went wrong: ${err.message}`).catch(() => {});
    }
  }
}

export function createDispatcher({ config, db, download = downloadAttachment }) {
  return async function dispatch(interaction) {
    const userId = interaction.user?.id || interaction.member?.user?.id;
    // When DISCORD_GUILD_ID is set, only interactions from that guild are
    // accepted; user-installed (DM / private channel) interactions have no
    // guild and are rejected in that case.
    if (config.discordGuildId && interaction.guildId !== config.discordGuildId) {
      await interaction.reply({ ephemeral: true, content: '❌ This app is restricted to a specific server.' });
      return;
    }
    // "private responses" preference makes every reply ephemeral for that user
    const wantsPrivate = Boolean(db.getPreference(userId).privateResponses);

    if (interaction.isModalSubmit?.()) {
      const customId = interaction.customId;
      const perm = MODAL_PERMISSIONS[customId];
      if (!perm) {
        await interaction.reply({ ephemeral: true, content: '❌ Unknown form.' });
        return;
      }
      if (perm === 'owner' && !isOwner(config, userId)) {
        await interaction.reply({ ephemeral: true, content: '❌ Only the owner can use this form.' });
        return;
      }
      if (perm === 'host' && !canHost(db, config, userId)) {
        await interaction.reply({ ephemeral: true, content: '❌ Only hosts (or the owner) can use this form.' });
        return;
      }
      const ephemeral = wantsPrivate || customId === MODAL_REGISTER;
      await interaction.deferReply({ ephemeral });
      const ctx = interactionToCtx(interaction, { config, db, download });
      await finishWithResult(interaction, ctx, (c) => handleModal(customId, c));
      return;
    }

    if (!interaction.isChatInputCommand?.()) return; // ignore component interactions etc.
    const name = interaction.commandName;
    const perm = PERMISSIONS[name] || 'all';
    if (perm === 'owner' && !isOwner(config, userId)) {
      await interaction.reply({ ephemeral: true, content: '❌ Only the owner can use this command.' });
      return;
    }
    if (perm === 'host' && !canHost(db, config, userId)) {
      await interaction.reply({ ephemeral: true, content: '❌ Only hosts (or the owner) can use this command.' });
      return;
    }
    // These commands always answer with a modal (file upload / form fields).
    if (ALWAYS_MODAL[name]) {
      await interaction.showModal(ALWAYS_MODAL[name]());
      return;
    }
    const ephemeral = wantsPrivate || EPHEMERAL_COMMANDS.has(name);
    await interaction.deferReply({ ephemeral });
    const ctx = interactionToCtx(interaction, { config, db, download });
    await finishWithResult(interaction, ctx, (c) => handleCommand(name, c));
  };
}
