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
  console.log(`READY as ${client.user.tag}`);
  const [firstGuild] = client.guilds.cache.map(g => g);
  if (firstGuild) await registerCommands(firstGuild.id);
});

const players = new Map(); // guildId -> audioPlayer

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('join_voice').setLabel('Join voice').setStyle(ButtonStyle.Success)
      );
      return interaction.reply({ content: 'Управление голосом', components: [row], ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId === 'join_voice') {
      const vc = interaction.member?.voice?.channel;
      if (!vc) return interaction.reply({ content: 'Зайдите в голосовой канал.', ephemeral: true });

      console.log('[VOICE] Trying to join', vc.id, vc.name);

      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: vc.guild.id,
        adapterCreator: vc.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        console.log('[VOICE] Disconnected');
      });
      connection.on(VoiceConnectionStatus.Destroyed, () => {
        console.log('[VOICE] Destroyed');
      });
      connection.on(VoiceConnectionStatus.Signalling, () => {
        console.log('[VOICE] Signalling');
      });

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        console.log('[VOICE] Ready');
      } catch (e) {
        console.error('[VOICE] Not ready:', e);
        return interaction.reply({ content: 'Не удалось подключиться к голосу.', ephemeral: true });
      }

      let player = players.get(vc.guild.id);
      if (!player) {
        player = createAudioPlayer();
        players.set(vc.guild.id, player);
        connection.subscribe(player);
        console.log('[VOICE] Player created & subscribed');
      }

      // Вешаем подписку на приём аудио
      attachReceiver(connection, vc.guild.id);

      return interaction.reply({ content: `Зашёл в: ${vc.name}. Скажи "${WAKE_WORD}, ..."`, ephemeral: true });
    }
  } catch (e) {
    console.error('Interaction error:', e);
  }
});

function attachReceiver(connection, guildId) {
  const receiver = connection.receiver;
  console.log('[RECV] attachReceiver called');

  receiver.speaking.on('start', (userId) => {
    console.log('[RECV] speaking start from', userId);

    if (receiver.subscriptions.has(userId)) {
      console.log('[RECV] already subscribed to', userId);
      return;
    }

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 }
    });

    const chunks = [];
    audioStream.on('data', (c) => {
      chunks.push(c);
    });

    audioStream.on('end', async () => {
      try {
        const pcm = Buffer.concat(chunks);
        console.log('[RECV] segment end, size=', pcm.length);

        if (pcm.length < 8192) {
          console.log('[RECV] too short, skip');
          return;
        }

        const text = await sttGladia(pcm);
        console.log('[STT] ->', text);

        if (!text || !text.toLowerCase().includes(WAKE_WORD)) {
          console.log('[STT] no wake word, skip');
          return;
        }

        const reply = await askOpenAI(text);
        console.log('[LLM] ->', reply);

        if (!reply) return;

        const audioBuf = await ttsGladia(reply);
        console.log('[TTS] buffer', audioBuf ? audioBuf.length : 'null');

        if (!audioBuf) return;

        let player = players.get(guildId);
        if (!player) {
          player = createAudioPlayer();
          players.set(guildId, player);
          connection.subscribe(player);
          console.log('[VOICE] Player re-created & subscribed');
        }

        const resource = createAudioResource(audioBuf, { inputType: 'arbitrary' });
        player.play(resource);
        console.log('[PLAY] started');
      } catch (e) {
        console.error('[PIPELINE] error:', e);
      }
    });
  });
}

// --------- GLADIA STT ----------
async function sttGladia(pcmBuffer) {
  try {
    const r = await fetch('https://api.gladia.io/audio/text/audio-transcription/', {
      method: 'POST',
      headers: { 'x-gladia-key': GLADIA_API_KEY },
      body: pcmBuffer
    });
    if (!r.ok) {
      const t = await safeText(r);
      console.error('[STT HTTP]', r.status, t);
      return null;
    }
    const data = await r.json();
    return data.prediction || '';
  } catch (e) {
    console.error('[STT] error', e);
    return null;
  }
}

// --------- OPENAI CHAT ----------
async function askOpenAI(question) {
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
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
    if (!r.ok) {
      const t = await safeText(r);
      console.error('[LLM HTTP]', r.status, t);
      return null;
    }
    const data = await r.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (e) {
    console.error('[LLM] error', e);
    return null;
  }
}

// --------- GLADIA TTS ----------
async function ttsGladia(text) {
  try {
    const r = await fetch('https://api.gladia.io/audio/text-to-audio/', {
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
    if (!r.ok) {
      const t = await safeText(r);
      console.error('[TTS HTTP]', r.status, t);
      return null;
    }
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    console.error('[TTS] error', e);
    return null;
  }
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

client.login(process.env.DISCORD_TOKEN);
