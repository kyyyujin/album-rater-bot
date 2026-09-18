'use strict';

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const token = process.env.BOT_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  throw new Error('BOT_TOKEN y CLIENT_ID deben estar configurados para registrar comandos.');
}

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Comprueba si el bot está activo'),
  new SlashCommandBuilder()
    .setName('historial')
    .setDescription('Muestra tus últimos ratings')
    .addStringOption(opt => opt.setName('usuario').setDescription('Nombre de usuario (default: el tuyo)').setRequired(false))
    .addIntegerOption(opt => opt.setName('cantidad').setDescription('Cuántos mostrar (máx 10, default 5)').setMinValue(1).setMaxValue(10).setRequired(false)),
  new SlashCommandBuilder()
    .setName('top')
    .setDescription('Álbumes mejor rankeados')
    .addStringOption(opt => opt.setName('usuario').setDescription('Nombre de usuario (default: el tuyo)').setRequired(false))
    .addIntegerOption(opt => opt.setName('cantidad').setDescription('Cuántos mostrar (máx 10, default 5)').setMinValue(1).setMaxValue(10).setRequired(false)),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Estadísticas generales de ratings')
    .addStringOption(opt => opt.setName('usuario').setDescription('Nombre de usuario (default: el tuyo)').setRequired(false))
].map(command => command.toJSON());

new REST({ version: '10' })
  .setToken(token)
  .put(Routes.applicationCommands(clientId), { body: commands })
  .then(() => console.log('Slash commands registered'))
  .catch(error => {
    console.error('Failed to register slash commands:', error.message);
    process.exitCode = 1;
  });
