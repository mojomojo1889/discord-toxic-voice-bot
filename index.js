import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events,
  REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle
} from 'discord.js';
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  EndBehaviorType, getVoiceConnection, VoiceConnectionStatus, entersState
} from '@discordjs/voice';
import fetch from 'node-fetch';

const WAKE_WORD = (process.env.WAKE_WORD || 'бот').toLowerCase();
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

async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [{ name: 'panel', description: 'Панель управления голосом (кнопка Join)' }];
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

// Глобальный плеер на соединение — чтобы переиспользовать
const players = new Map(); // guildId -> audioPlayer

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId === 'join_voice') {
    const vc = interaction.member?.voice?.channel;
    if (!vc) return interaction.reply({ content: 'Зайдите в голосовой канал.', ephemeral: true });

    const connection = joinVoiceChannel({
      channelId: vc.id,
      guildId: vc.guild.id,
      adapterCreator: vc.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    // Ждём готовности соединения
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    } catch {
      return interaction.reply({ content: 'Не удалось подключиться к голосовому каналу.', ephemeral: true });
    }

    // Подготовим плеер
    let player = players.get(vc.guild.id);
    if (!player) {
      player = createAudioPlayer();
      players.set(vc.guild.id, player);
      connection.subscribe(player);
    }

    // Подписка на входящий звук
    attachReceiver(connection, vc.guild.id);

    return interaction.reply({ content: `Зашёл в: ${vc.name}. Скажи "${WAKE_WORD}, ..." чтобы обратиться.`, ephemeral: true });
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('join_voice').setLabel('Join voice').setStyle(ButtonStyle.Success)
    );
    return interaction.reply({ content: 'Управление голосом', components: [row], ephemeral: true });
  }
});

// Подписка на входящий голосовой поток
function attachReceiver(connection, guildId) {
  const receiver = connection.receiver;

  // Событие speaking — когда кто-то начинает говорить
  receiver.speaking.on('start', (userId) => {
    try {
      // Уже подписаны на этого пользователя?
      if (receiver.subscriptions.has(userId)) return;

      // Подписываемся на поток пользователя
      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 } // 1.2 сек тишины = конец фразы
      });

      const chunks = [];
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', async () => {
        const pcm = Buffer.concat(chunks);
        if (pcm.length < 6400) return; // слишком коротко

        // Отправляем на STT
        const text = await sttGladia(pcm);
        if (!text) return;

        console.log('STT:', text);

        // Проверяем wake word
        if (!text.toLowerCase().includes(WAKE_WORD)) return;

        // Диалог
        const reply = await askOpenAI(text);
        if (!reply) return;

        console.log('LLM:', reply);

        // TTS
        const audioBuf = await ttsGladia(reply);
        if (!audioBuf) return;

        // Воспроизводим
        let player = players.get(guildId);
        if (!player) {
          player = createAudioPlayer();
          players.set(guildId, player);
          connection.subscribe(player);
        }
        const resource = createAudioResource(audioBuf, { inputType: 'arbitrary' });
        player.play(resource);
      });
    } catch (e) {
      console.error('Receiver error:', e);
    }
  });
}

// ========== GLADIA STT ==========
async function sttGladia(pcmBuffer) {
  try {
    // Gladia принимает файлы; отправим как octet-stream
    const resp = await fetch('https://api.gladia.io/audio/text/audio-transcription/', {
      method: 'POST',
      headers: {
        'x-gladia-key': GLADIA_API_KEY,
        // Без Content-Type, Gladia сам определит по сырым данным или можно multipart/form-data
      },
      body: pcmBuffer
    });
    if (!resp.ok) {
      console.error('STT HTTP', resp.status, await safeText(resp));
      return null;
    }
    const data = await resp.json();
    return data.prediction || '';
  } catch (err) {
    console.error('STT error:', err);
    return null;
  }
}

// ========== OPENAI CHAT ==========
async function askOpenAI(question) {
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: STYLE_PROMPT },
          { role: 'user', content: question }
        ],
        temperature: 0.8,
        max_tokens: 180
      })
    });
    if (!resp.ok) {
      console.error('OpenAI HTTP', resp.status, await safeText(resp));
      return null;
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('OpenAI error:', err);
    return null;
  }
}

// ========== GLADIA TTS ==========
async function ttsGladia(text) {
  try {
    const resp = await fetch('https://api.gladia.io/audio/text-to-audio/', {
      method: 'POST',
      headers: {
        'x-gladia-key': GLADIA_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        language: 'russian',
        speaker: 'female-neutral'
      })
    });
    if (!resp.ok) {
      console.error('TTS HTTP', resp.status, await safeText(resp));
      return null;
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    console.error('TTS error:', err);
    return null;
  }
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

client.login(process.env.DISCORD_TOKEN);
