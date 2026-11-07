require('dotenv').config();
const { spawn } = require('node:child_process');
const {
  Client,
  GatewayIntentBits,
  ActivityType,
  PresenceUpdateStatus,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
} = require('@discordjs/voice');

const { DISCORD_TOKEN, GUILD_ID, YTDLP_PATH = 'yt-dlp' } = process.env;
// Optional: YouTube cookies (base64 of a Netscape cookies.txt) to get past
// "confirm you're not a bot" blocks on datacenter hosts like Railway.
const fs = require('node:fs');
const ytExtraArgs = [];
if (process.env.YT_COOKIES_B64) {
  try {
    fs.writeFileSync('/tmp/yt-cookies.txt', Buffer.from(process.env.YT_COOKIES_B64, 'base64'));
    ytExtraArgs.push('--cookies', '/tmp/yt-cookies.txt');
    console.log('Using YouTube cookies from YT_COOKIES_B64');
  } catch (e) {
    console.error('Could not write cookies file:', e.message);
  }
}

// Optional: route yt-dlp through a proxy (e.g. a residential proxy) to avoid IP blocks.
if (process.env.YT_PROXY) ytExtraArgs.push('--proxy', process.env.YT_PROXY);

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Client + Do Not Disturb presence                                    */
/* ------------------------------------------------------------------ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  presence: {
    status: PresenceUpdateStatus.DoNotDisturb, // red "Do Not Disturb" dot
    activities: [{ name: '/play', type: ActivityType.Listening }],
  },
});

/* ------------------------------------------------------------------ */
/* Slash command definitions                                           */
/* ------------------------------------------------------------------ */
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube (search or URL)')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name or URL').setRequired(true),
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback, clear the queue and leave'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the volume (1-100)')
    .addIntegerOption((o) =>
      o.setName('level').setDescription('Volume 1-100').setMinValue(1).setMaxValue(100).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set loop mode')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Current track', value: 'track' },
          { name: 'Whole queue', value: 'queue' },
        ),
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const appId = client.application.id;
  if (GUILD_ID) {
    // Guild commands update instantly - best for a single server
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: commands });
    console.log(`Registered ${commands.length} slash commands in guild ${GUILD_ID}`);
  } else {
    // Global commands can take up to an hour to appear
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log(`Registered ${commands.length} global slash commands`);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const queues = new Map(); // guildId -> guild queue

const isUrl = (s) => /^https?:\/\//i.test(s);

function fmtDuration(sec) {
  if (!sec) return 'LIVE';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function runYtDlpInfo(target) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      YTDLP_PATH,
      ['-j', '--no-playlist', '--no-warnings', '-q', ...ytExtraArgs, target],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => reject(new Error(`Could not run yt-dlp: ${e.message}`)));
    proc.on('close', (code) => {
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (code !== 0 || !line) return reject(new Error(err.trim() || 'No results found'));
      try {
        const j = JSON.parse(line);
        resolve({
          title: j.title,
          url: j.webpage_url || j.url,
          duration: j.duration,
          thumbnail: j.thumbnail,
          author: j.uploader || j.channel,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function isYouTubeUrl(u) {
  try {
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
}

// YouTube's oEmbed endpoint returns a video's title without the "not a bot" check,
// so it usually still works from datacenter IPs like Railway.
async function youtubeMetaViaOembed(url) {
  const u = new URL(url);
  let id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
  const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
  if (!id && m) id = m[1];
  const watch = id ? `https://www.youtube.com/watch?v=${id}` : url;
  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`oEmbed returned ${res.status}`);
  const j = await res.json();
  return { title: j.title, author: (j.author_name || '').replace(/ - Topic$/i, '') };
}

// URLs are used as-is. Searches try YouTube first, then SoundCloud as a fallback.
// If a YouTube link is blocked, find the same song on SoundCloud instead.
async function resolveTrack(query) {
  const targets = isUrl(query) ? [query] : [`ytsearch1:${query}`, `scsearch1:${query}`];
  let lastErr;
  for (const target of targets) {
    try {
      return await runYtDlpInfo(target);
    } catch (e) {
      console.error(`yt-dlp lookup failed for "${target}":\n${e.message}`);
      lastErr = e;
    }
  }

  if (isUrl(query) && isYouTubeUrl(query)) {
    try {
      const { title, author } = await youtubeMetaViaOembed(query);
      const search = author && !title.toLowerCase().includes(author.toLowerCase())
        ? `${title} ${author}`
        : title;
      console.log(`YouTube blocked - searching SoundCloud for "${search}"`);
      const track = await runYtDlpInfo(`scsearch1:${search}`);
      track.note = 'YouTube blocked this server, so this is a SoundCloud match.';
      return track;
    } catch (e) {
      console.error(`SoundCloud fallback failed: ${e.message}`);
    }
  }
  throw lastErr;
}

function trackEmbed(title, track, extra) {
  const e = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(`[${track.title}](${track.url})`)
    .addFields(
      { name: 'Duration', value: fmtDuration(track.duration), inline: true },
      { name: 'Requested by', value: track.requestedBy ?? 'Unknown', inline: true },
    );
  if (track.thumbnail) e.setThumbnail(track.thumbnail);
  if (extra) e.setFooter({ text: extra });
  return e;
}

/* ------------------------------------------------------------------ */
/* Per-guild queue / player                                            */
/* ------------------------------------------------------------------ */
async function createGuildQueue(interaction, voiceChannel) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error('Voice connection failed (state: %s):', connection.state.status, err);
    connection.destroy();
    throw new Error('Could not join the voice channel.');
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  connection.subscribe(player);

  const gq = {
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    textChannel: interaction.channel,
    connection,
    player,
    queue: [],
    current: null,
    resource: null,
    proc: null,
    volume: 50,
    loop: 'off',
    forceNext: false,
    leaveTimer: null,
  };

  player.on(AudioPlayerStatus.Idle, () => {
    killProc(gq);
    playNext(gq, true);
  });
  player.on('error', (err) => console.error('Player error:', err.message));

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Moved channels / brief network blip -> it will reconnect on its own
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyQueue(gq.guildId);
    }
  });

  queues.set(gq.guildId, gq);
  return gq;
}

function killProc(gq) {
  if (gq.proc) {
    gq.proc.kill('SIGKILL');
    gq.proc = null;
  }
}

function destroyQueue(guildId) {
  const gq = queues.get(guildId);
  if (!gq) return;
  clearTimeout(gq.leaveTimer);
  gq.player.removeAllListeners();
  gq.player.stop(true);
  killProc(gq);
  if (gq.connection.state.status !== VoiceConnectionStatus.Destroyed) gq.connection.destroy();
  queues.delete(guildId);
}

function playNext(gq, announce) {
  clearTimeout(gq.leaveTimer);

  let next;
  if (gq.loop === 'track' && gq.current && !gq.forceNext) {
    next = gq.current;
  } else {
    if (gq.loop === 'queue' && gq.current) gq.queue.push(gq.current);
    next = gq.queue.shift();
  }
  gq.forceNext = false;

  if (!next) {
    gq.current = null;
    // Leave after 2 minutes of nothing playing
    gq.leaveTimer = setTimeout(() => {
      gq.textChannel?.send('Queue finished - leaving the voice channel.').catch(() => {});
      destroyQueue(gq.guildId);
    }, 120_000);
    return;
  }

  gq.current = next;

  const proc = spawn(
    YTDLP_PATH,
    ['-f', 'bestaudio/best', '-o', '-', '-q', '--no-warnings', '--no-playlist', ...ytExtraArgs, next.url],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stderr.on('data', (d) => console.error('yt-dlp stream:', d.toString().trim()));
  proc.on('error', (e) => console.error('yt-dlp error:', e.message));
  gq.proc = proc;

  const resource = createAudioResource(proc.stdout, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });
  resource.volume.setVolume(gq.volume / 100);
  // Killing yt-dlp mid-song can emit stream errors; log them instead of crashing
  proc.stdout.on('error', () => {});
  resource.playStream.on('error', (e) => console.error('Stream error:', e.message));
  gq.resource = resource;
  gq.player.play(resource);

  if (announce && gq.loop !== 'track') {
    gq.textChannel?.send({ embeds: [trackEmbed('Now playing', next)] }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Command handlers                                                    */
/* ------------------------------------------------------------------ */
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

async function handlePlay(interaction) {
  const voiceChannel = interaction.member.voice?.channel;
  if (!voiceChannel) return interaction.reply(ephemeral('Join a voice channel first.'));

  const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
  if (!perms?.has(['ViewChannel', 'Connect', 'Speak'])) {
    return interaction.reply(ephemeral('I need permission to view, connect and speak in that channel.'));
  }

  let gq = queues.get(interaction.guildId);
  if (gq && gq.channelId !== voiceChannel.id) {
    return interaction.reply(ephemeral("I'm already playing in another voice channel."));
  }

  await interaction.deferReply();

  let track;
  try {
    track = await resolveTrack(interaction.options.getString('query', true));
  } catch (err) {
    console.error(err.message);
    return interaction.editReply("Couldn't find anything for that. Try different keywords or a direct link.");
  }
  track.requestedBy = interaction.member.displayName;

  try {
    gq = queues.get(interaction.guildId) ?? (await createGuildQueue(interaction, voiceChannel));
  } catch (err) {
    return interaction.editReply(err.message);
  }
  gq.textChannel = interaction.channel;
  gq.queue.push(track);

  if (!gq.current) {
    playNext(gq, false);
    return interaction.editReply({ embeds: [trackEmbed('Now playing', track, track.note)] });
  }
  return interaction.editReply({
    embeds: [
      trackEmbed('Added to queue', track, `Position ${gq.queue.length}${track.note ? ' | ' + track.note : ''}`),
    ],
  });
}

const handlers = {
  play: handlePlay,

  async skip(i, gq) {
    // Answer Discord first (it only waits 3 seconds), then move to the next track
    await i.reply('Skipped.');
    gq.forceNext = true;
    if (!gq.player.stop(true)) gq.forceNext = false; // triggers Idle -> next track
  },

  async pause(i, gq) {
    return i.reply(gq.player.pause() ? 'Paused.' : ephemeral('Nothing to pause.'));
  },

  async resume(i, gq) {
    return i.reply(gq.player.unpause() ? 'Resumed.' : ephemeral('Nothing to resume.'));
  },

  async stop(i, gq) {
    destroyQueue(gq.guildId);
    return i.reply('Stopped and disconnected.');
  },

  async queue(i, gq) {
    if (!gq.current && !gq.queue.length) return i.reply(ephemeral('The queue is empty.'));
    const lines = gq.queue
      .slice(0, 10)
      .map((t, n) => `**${n + 1}.** [${t.title}](${t.url}) \`${fmtDuration(t.duration)}\``);
    const more = gq.queue.length > 10 ? `\n...and ${gq.queue.length - 10} more` : '';
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Queue')
      .setDescription(
        (gq.current ? `**Now playing:** [${gq.current.title}](${gq.current.url})\n\n` : '') +
          (lines.length ? lines.join('\n') + more : 'Nothing up next.'),
      )
      .setFooter({ text: `Loop: ${gq.loop} | Volume: ${gq.volume}%` });
    return i.reply({ embeds: [embed] });
  },

  async nowplaying(i, gq) {
    if (!gq.current) return i.reply(ephemeral('Nothing is playing.'));
    const elapsed = Math.floor((gq.resource?.playbackDuration ?? 0) / 1000);
    return i.reply({
      embeds: [
        trackEmbed(
          'Now playing',
          gq.current,
          `${fmtDuration(elapsed)} / ${fmtDuration(gq.current.duration)}`,
        ),
      ],
    });
  },

  async shuffle(i, gq) {
    if (gq.queue.length < 2) return i.reply(ephemeral('Not enough songs in the queue to shuffle.'));
    for (let n = gq.queue.length - 1; n > 0; n--) {
      const k = Math.floor(Math.random() * (n + 1));
      [gq.queue[n], gq.queue[k]] = [gq.queue[k], gq.queue[n]];
    }
    return i.reply('Queue shuffled.');
  },

  async volume(i, gq) {
    gq.volume = i.options.getInteger('level', true);
    gq.resource?.volume?.setVolume(gq.volume / 100);
    return i.reply(`Volume set to **${gq.volume}%**.`);
  },

  async loop(i, gq) {
    gq.loop = i.options.getString('mode', true);
    return i.reply(`Loop mode: **${gq.loop}**.`);
  },
};

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Re-assert DND in case the gateway reset it
  client.user.setPresence({
    status: 'dnd',
    activities: [{ name: '/play', type: ActivityType.Listening }],
  });
  try {
    await registerCommands();
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;

  const handler = handlers[interaction.commandName];
  if (!handler) return;

  try {
    if (interaction.commandName === 'play') return await handler(interaction);

    const gq = queues.get(interaction.guildId);
    if (!gq) return interaction.reply(ephemeral('Nothing is playing right now.'));
    if (interaction.member.voice?.channelId !== gq.channelId) {
      return interaction.reply(ephemeral('You need to be in my voice channel to use that.'));
    }
    return await handler(interaction, gq);
  } catch (err) {
    console.error(err);
    const msg = ephemeral('Something went wrong.');
    if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

// Clean up if everyone leaves or the bot is kicked from voice
client.on('voiceStateUpdate', (oldState, newState) => {
  const gq = queues.get(oldState.guild.id);
  if (!gq) return;
  if (oldState.id === client.user.id && !newState.channelId) return destroyQueue(gq.guildId);

  const channel = oldState.guild.channels.cache.get(gq.channelId);
  if (channel && channel.members.filter((m) => !m.user.bot).size === 0) {
    gq.textChannel?.send('Everyone left - disconnecting.').catch(() => {});
    destroyQueue(gq.guildId);
  }
});

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));
client.login(DISCORD_TOKEN);
