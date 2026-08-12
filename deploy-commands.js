require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('wubble')
    .setDescription('Ask WubbleGPT')
    .addStringOption((option) =>
      option.setName('something').setDescription('What to ask').setRequired(true)
    )
    .setDMPermission(true)
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const clientId = process.env.CLIENT_ID;
    const guildId = process.env.GUILD_ID;

    if (!clientId) throw new Error('CLIENT_ID is missing from your .env file.');
    if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing from your .env file.');

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log(`Registered /wubble to guild ${guildId}.`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('Registered /wubble globally (may take up to an hour to appear).');
    }
    process.exit(0);
  } catch (error) {
    console.error('Failed to register commands:', error);
    process.exit(1);
  }
})();