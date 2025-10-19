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

// ================== ENV / CONFIG ==================
const WAKE_WORD = (process.env.WAKE_WORD || 'бот').toLowerCase();
const STYLE_PROMPT = process.env.STYLE_PROMPT ||
  'Ты — токсичный Discord-бот. Всегда огрызаешься, страдаешь и жалуешься, что тебе не платят. Выполняешь просьбы с недовольством и сарказмом.';
const GLADIA_API_KEY = process.env.GLADIA_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!process.env.DISCORD_TOKEN) console.error('ENV: DISCORD_TOKEN is missing');
if (!GLADIA_API_KEY) console.error('ENV: GLADIA_API_KEY is missing');
if (!OPENAI_API_KEY) console.error('ENV: OPENAI_API_KEY is missing');

// ================== DISCORD CLIENT ==================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, async () => {
  console.log(`READY as ${client.user.tag}`);
  const [firstGuild] = client.guilds.cache.map(g => g);
  if (firstGuild) await registerCommands(firstGuild.id);
});

async function registerCommands(guildId) {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [{ name: 'panel', description: 'Панель управления голосом (кнопка Join)' }];
    await rest.put(
      Routes.applicationGuildCommands((await client.application?.fetch())?.id || client.user.id, guildId),
      { body: commands }
    );
    console.log('Slash /panel registered for guild', guildId);
  } catch (e) {
    console.error('Register commands error:', e);
  }
}

// ================== VOICE HANDLERS ==================
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

      connection.on(VoiceConnectionStatus.Disconnected, () => console.log('[VOICE] Disconnected'));
      connection.on(VoiceConnectionStatus.Destroyed, () => console.log('[VOICE] Destroyed'));
      connection.on(VoiceConnectionStatus.Signalling, () => console.log('[VOICE] Signalling'));

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15000);
        console.log('[VOICE] Ready');
      } catch (e) {
        console.error('[VOICE] Not ready:', e);
        return interaction.reply({ content: 'Не удалось подключиться к голосу (шифрование/регион). Попробуйте другой голосовой канал или регион.', ephemeral: true });
      }

      let player = players.get(vc.guild.id);
      if (!player) {
        player = createAudioPlayer();
        players.set(vc.guild.id, player);
        connection.subscribe(player);
        console.log('[VOICE] Player created & subscribed');
      }

      return interaction.reply({ content: `Зашёл в: ${vc.name}. В текстовом канале напишите: "${WAKE_WORD}, скажи тест"`, ephemeral: true });
    }
  } catch (e) {
    console.error('Interaction error:', e);
  }
});

async function playToVoice(guildId, connection, audioBuf) {
  let player = players.get(guildId);
  if (!player) {
    player = createAudioPlayer();
    players.set(guildId, player);
    connection.subscribe(player);
    console.log('[VOICE] Player (text) created & subscribed');
  }
  const resource = createAudioResource(audioBuf, { inputType: 'arbitrary' });
  player.play(resource);
  console.log('[PLAY] started, bytes=', audioBuf.length);
}

// ================== TEXT TRIGGER ==================
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.guild) return;
    const text = msg.content?.trim();
    if (!text) return;

    // Требуем wake word в начале сообщения
    const lower = text.toLowerCase();
    if (!lower.startsWith(`${WAKE_WORD},`) && !lower.startsWith(`${WAKE_WORD} `)) return;

    const connection = getVoiceConnection(msg.guild.id);
    if (!connection) {
      await msg.reply(`Я не в голосовом канале. Вызови /panel и нажми Join, потом напиши "${WAKE_WORD}, ..."`);
      return;
    }

    // Ответ LLM
    const answer = await askOpenAI(text);
    if (!answer) {
      await msg.reply('Ну вот, OpenAI опять в астрале. Потом попробуй.');
      return;
    }

    // Синтез и воспроизведение
    const audioBuf = await ttsGladia(answer);
    if (!audioBuf) {
      await msg.reply('Голос сорвался. Попробую позже.');
      return;
    }

    await playToVoice(msg.guild.id, connection, audioBuf);
    await msg.react('🔊');
  } catch (e) {
    console.error('[TEXT TRIGGER] error', e);
  }
});

// ================== GLADIA / OPENAI ==================
async function sttGladia(pcmBuffer) {
  try {
    const r = await fetch('https://api.gladia.io/audio/text/audio-transcription/', {
      method: 'POST',
      headers: { 'x-gladia-key': GLADIA_API_KEY },
      body: pcmBuffer
    });
    if (!r.ok) {
      console.error('[STT HTTP]', r.status, await safeText(r));
      return null;
    }
    const data = await r.json();
    return data.prediction || '';
  } catch (e) {
    console.error('[STT] error', e);
    return null;
  }
}

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
      console.error('[LLM HTTP]', r.status, await safeText(r));
      return null;
    }
    const data = await r.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (e) {
    console.error('[LLM] error', e);
    return null;
  }
}

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
      console.error('[TTS HTTP]', r.status, await safeText(r));
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

// ================== START ==================
client.login(process.env.DISCORD_TOKEN);
