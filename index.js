import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, EndBehaviorType, getVoiceConnection } from '@discordjs/voice';
import fetch from 'node-fetch';

const WAKE_WORD = process.env.WAKE_WORD || 'Шлад';
const STYLE_PROMPT = process.env.STYLE_PROMPT ||
    'Ты — токсичный Discord-бот. Всегда огрызаешься, страдаешь и жалуешься, что тебе не платят. Выполняешь просьбы с недовольством и сарказмом.';

const GLADIA_API_KEY = process.env.GLADIA_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

// Discord slash-команда для вызова панели
async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [
    { name: 'panel', description: 'Панель управления голосом (кнопка Join)' }
  ];
  await rest.put(
    Routes.applicationGuildCommands((await client.application?.fetch())?.id || client.user.id, guildId),
    { body: commands }
  );
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const [firstGuild] = client.guilds.cache.map(g => g);
  if (firstGuild) await registerCommands(firstGuild.id);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Кнопка Join voice
  if (interaction.isButton() && interaction.customId === 'join_voice') {
    const vc = interaction.member?.voice?.channel;
    if (!vc) return interaction.reply({ content: 'Зайдите в голосовой канал.', ephemeral: true });
    joinVoiceChannel({
      channelId: vc.id,
      guildId: vc.guild.id,
      adapterCreator: vc.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });
    return interaction.reply({ content: `Зашёл в: ${vc.name}`, ephemeral: true });
  }
  // Slash /panel
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('join_voice').setLabel('Join voice').setStyle(ButtonStyle.Success)
    );
    return interaction.reply({ content: 'Управление голосом', components: [row], ephemeral: true });
  }
});

// AUDIO логика: слушаем звук от говорящего, реагируем на WAKE_WORD
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  // Только если пользователь зашёл в голос
  if (!newState.channelId || newState.member.user.bot) return;
  
  const guildId = newState.guild.id;
  let connection = getVoiceConnection(guildId);
  if (!connection) return;

  // receiver = поток звука пользователей
  const receiver = connection.receiver;
  receiver.speaking.on('start', (userId) => {
    if (receiver.subscriptions.has(userId)) return;
    
    const audioStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 } });

    // 1. Собираем raw аудио и буферизуем в wav (через промежуточный файл или буфер)
    let audioBuffers = [];
    audioStream.on('data', chunk => audioBuffers.push(chunk));
    audioStream.on('end', async () => {
      // 2. Отправляем аудио в Gladia (STT)
      const audioBuffer = Buffer.concat(audioBuffers);
      const sttText = await sttGladia(audioBuffer);
      if (!sttText) return;

      // 3. Только если есть WAKE_WORD
      if (!sttText.toLowerCase().includes(WAKE_WORD)) return;

      // 4. Диалог через OpenAI (стиль "токсик")
      const answer = await askOpenAI(sttText);
      if (!answer) return;

      // 5. TTS через Gladia (озвучка по-русски)
      const ttsAudio = await ttsGladia(answer);
      if (!ttsAudio) return;

      // 6. Проигрываем в голосовом канале
      const player = createAudioPlayer();
      connection.subscribe(player);
      const resource = createAudioResource(ttsAudio, { inputType: 'arbitrary', inlineVolume: true });
      player.play(resource);
    });
  });
});

// ========== GLADIA API — speech-to-text ==========
async function sttGladia(audioBuffer) {
  try {
    const resp = await fetch('https://api.gladia.io/audio/text/audio-transcription/', {
      method: 'POST',
      headers: {
        'x-gladia-key': GLADIA_API_KEY,
      },
      body: audioBuffer
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.prediction || '';
  } catch (err) {
    console.error('GLADIA STT Error:', err);
    return null;
  }
}

// ========== OPENAI API — toxic dialog ==========
async function askOpenAI(question) {
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: STYLE_PROMPT },
          { role: "user", content: question }
        ],
        max_tokens: 120,
        temperature: 0.7,
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('OpenAI err:', err);
    return null;
  }
}

// ========== GLADIA TTS — text-to-speech ==========
async function ttsGladia(text) {
  try {
    const resp = await fetch('https://api.gladia.io/audio/text-to-audio/', {
      method: 'POST',
      headers: {
        'x-gladia-key': GLADIA_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        language: 'russian',
        speaker: 'female-neutral',
      })
    });
    if (!resp.ok) return null;
    const audioData = await resp.arrayBuffer();
    return Buffer.from(audioData);
  } catch (err) {
    console.error('GLADIA TTS Error:', err);
    return null;
  }
}

client.login(process.env.DISCORD_TOKEN);
