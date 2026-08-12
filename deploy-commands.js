require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const TARGET_USER_ID = process.env.TARGET_USER_ID;
if (!TARGET_USER_ID) {
  console.error('TARGET_USER_ID is missing from your environment/.env file.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const pendingByMessageId = new Map();
const pendingByTargetUser = new Map();

function addPending(record) {
  pendingByMessageId.set(record.dmMessageId, record);
  const queue = pendingByTargetUser.get(record.targetId) ?? [];
  queue.push(record.dmMessageId);
  pendingByTargetUser.set(record.targetId, queue);
}

function removePending(record) {
  pendingByMessageId.delete(record.dmMessageId);
  const queue = pendingByTargetUser.get(record.targetId);
  if (queue) {
    const idx = queue.indexOf(record.dmMessageId);
    if (idx !== -1) queue.splice(idx, 1);
    if (queue.length === 0) pendingByTargetUser.delete(record.targetId);
  }
}

function takePendingForDirectReply(targetId, referencedMessageId) {
  if (!referencedMessageId) return null;
  const record = pendingByMessageId.get(referencedMessageId);
  if (!record || record.targetId !== targetId) return null;
  removePending(record);
  return record;
}

function formatMessage(question, status) {
  return `**Question:** ${question}\n\n${status}`;
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'wubble') return;

  try {
    const question = interaction.options.getString('something');
    const asker = interaction.user;

    if (!question) {
      await interaction.reply({
        content:
          "Missing the question option -- the command definition may be out of date. Try running `npm run deploy-commands` again, then wait a moment and retry.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply(formatMessage(question, '*thinking... give me a sec im a lil stupid...*'));

    let target;
    try {
      target = await client.users.fetch(TARGET_USER_ID);
    } catch (err) {
      await interaction.editReply(formatMessage(question, "*Couldn't reach the configured user -- check TARGET_USER_ID.*"));
      return;
    }

    let dmMessage;
    try {
      const dmChannel = await target.createDM();
      dmMessage = await dmChannel.send(question);
    } catch (err) {
      await interaction.editReply(formatMessage(question, "*Couldn't deliver that -- they may have DMs disabled.*"));
      return;
    }

    addPending({
      dmMessageId: dmMessage.id,
      targetId: target.id,
      askerId: asker.id,
      question,
      interaction,
    });
  } catch (err) {
    console.error('Error handling /ask interaction:', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply('Something went wrong handling that, sorry.');
      } else {
        await interaction.reply({ content: 'Something went wrong handling that, sorry.', ephemeral: true });
      }
    } catch (err2) {
      console.error('Failed to report error back to interaction:', err2);
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.guildId) return;
  if (message.channel.type !== 1) return;

  const referencedId = message.reference?.messageId ?? null;
  const record = takePendingForDirectReply(message.author.id, referencedId);

  if (!record) {
    const stillPending = (pendingByTargetUser.get(message.author.id)?.length ?? 0) > 0;
    if (stillPending) {
      await message.reply(
        "Reply directly to the message you're answering (long-press/right-click it and choose Reply) so I send it back to the right person."
      );
    }
    return;
  }

  const answer = message.content?.trim();
  const files = [...message.attachments.values()].map((a) => a.url);

  if (!answer && files.length === 0) {
    await message.reply("Send some text or a file and I'll relay it back.");
    return;
  }

  const payload = {
    content: formatMessage(record.question, answer || '*(sent a file)*'),
    files: files.length ? files : undefined,
  };

  try {
    await record.interaction.editReply(payload);
  } catch (err) {
    try {
      const asker = await client.users.fetch(record.askerId);
      const dm = await asker.createDM();
      await dm.send(payload);
    } catch (err2) {
      console.error('Failed to deliver answer:', err2);
      await message.reply("Something went wrong sending that back, sorry.");
      return;
    }
  }

  await message.react('✅').catch(() => {});
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

client.login(process.env.DISCORD_TOKEN);