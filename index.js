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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// messageId (either the DM question, or the public status message) -> record
const pendingByMessageId = new Map();
// targetUserId -> Set of records, just to know "do they have anything pending"
const pendingByTargetUser = new Map();

function addPending(record) {
  pendingByMessageId.set(record.dmMessageId, record);
  if (record.statusMessageId) pendingByMessageId.set(record.statusMessageId, record);
  const set = pendingByTargetUser.get(record.targetId) ?? new Set();
  set.add(record);
  pendingByTargetUser.set(record.targetId, set);
}

function removePending(record) {
  pendingByMessageId.delete(record.dmMessageId);
  if (record.statusMessageId) pendingByMessageId.delete(record.statusMessageId);
  const set = pendingByTargetUser.get(record.targetId);
  if (set) {
    set.delete(record);
    if (set.size === 0) pendingByTargetUser.delete(record.targetId);
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

    // Public message that shows the question right away, and gets edited
    // in place once the answer comes back.
    await interaction.reply(formatMessage(question, '*Waiting for a reply...*'));
    const statusMessage = await interaction.fetchReply().catch(() => null);

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
      statusMessageId: statusMessage?.id ?? null,
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

  const referencedId = message.reference?.messageId ?? null;
  // Only act on genuine Discord replies -- ignore everything else so
  // ordinary chatter (in a server or in DMs) is left alone.
  if (!referencedId) return;

  const record = takePendingForDirectReply(message.author.id, referencedId);

  if (!record) {
    const stillPending = (pendingByTargetUser.get(message.author.id)?.size ?? 0) > 0;
    if (stillPending) {
      await message
        .reply("That's not one of the messages I'm waiting on you to answer -- reply directly to the question (or its status message) instead.")
        .catch(() => {});
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
    // Fills in the asker's status message with the real answer, in place.
    await record.interaction.editReply(payload);
  } catch (err) {
    // Interaction token expired (>~15 min) -- fall back to a direct DM.
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