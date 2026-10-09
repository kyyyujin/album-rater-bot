'use strict';

const albumCommandDefinition = {
  name: 'album',
  description: 'Exporta como imagen uno de tus ratings guardados',
  options: [
    { type: 3, name: 'nombre', description: 'Busca o elige un álbum de tus ratings', required: true, autocomplete: true, max_length: 100 },
    { type: 3, name: 'artista', description: 'Artista, para distinguir álbumes con el mismo nombre', max_length: 100 }
  ]
};

const ID_VALUE = /^rating:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// A standalone PostgREST eq filter uses its value literally (pSingleVal).
// Quoting is for in/or grammar, not eq: eq.%22Kyujin%22 matches a username
// containing quotes. URL encoding alone keeps this separate query value safe.
const literal = value => encodeURIComponent(String(value));

// Each full-record lookup re-resolves the immutable Discord ID and filters by
// owner AND rating ID. Autocomplete IDs never grant access to another account.
function createSavedRatingRepository({ read }) {
  async function owner(discordId) {
    if (!/^\d{5,25}$/.test(String(discordId))) return null;
    const rows = await read(`users?discord_id=eq.${encodeURIComponent(discordId)}&select=username&limit=2`);
    if (!Array.isArray(rows)) throw new Error('Invalid account response');
    return rows.length === 1 && rows[0].username ? rows[0].username : null;
  }
  return {
    async list(discordId) {
      const username = await owner(discordId);
      if (!username) return null;
      const ratings = [];
      for (let offset = 0; offset < 10000; offset += 500) {
        const rows = await read(`ratings?user_id=eq.${literal(username)}&select=id,album_title,artist,created_at&order=created_at.desc,id.asc&limit=500&offset=${offset}`);
        if (!Array.isArray(rows)) throw new Error('Invalid ratings response');
        ratings.push(...rows);
        if (rows.length < 500) return ratings;
      }
      throw new Error('Saved rating catalog exceeds limit');
    },
    async get(discordId, id) {
      if (!ID_VALUE.test('rating:' + id)) return null;
      const username = await owner(discordId);
      if (!username) return null;
      const rows = await read(`ratings?user_id=eq.${literal(username)}&id=eq.${encodeURIComponent(id)}&select=id,album_title,artist,cover_url,tracks,final_score,final_rank,year,genre,cover_score&limit=1`);
      if (!Array.isArray(rows)) throw new Error('Invalid rating response');
      return rows[0] || null;
    }
  };
}

function matches(ratings, name, artist = '') {
  const query = normalize(name), performer = normalize(artist);
  if (!query) return [];
  const eligible = ratings.filter(r => !performer || normalize(r.artist).includes(performer));
  const exact = eligible.filter(r => normalize(r.album_title) === query);
  return exact.length ? exact : eligible.filter(r => normalize(r.album_title).includes(query));
}

function suggestions(ratings, query) {
  const search = normalize(query);
  return ratings.filter(r => !search || normalize(`${r.album_title} ${r.artist || ''}`).includes(search))
    .slice(0, 25).map(r => ({
      name: [...`${r.album_title || 'Álbum'} — ${r.artist || 'Sin artista'}`].slice(0, 100).join(''),
      value: `rating:${r.id}`
    }));
}

function beforeDeadline(promise, milliseconds, fallback) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

function createSavedAlbumCommand({ repository, render, now = Date.now, logger = console, autocompleteTimeout = 1800 }) {
  const catalogs = new Map(), cooldowns = new Map();
  function catalog(id) {
    const cached = catalogs.get(id);
    if (cached && cached.expires > now()) return cached.promise;
    if (catalogs.size >= 128) catalogs.delete(catalogs.keys().next().value);
    const entry = { expires: now() + 30000, promise: null };
    entry.promise = repository.list(id).catch(error => { if (catalogs.get(id) === entry) catalogs.delete(id); throw error; });
    catalogs.set(id, entry);
    return entry.promise;
  }

  return async function handle(interaction) {
    if (interaction.commandName !== 'album') return false;
    if (interaction.isAutocomplete()) {
      let choices = [];
      try {
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'nombre') {
          const rows = await beforeDeadline(catalog(interaction.user.id), autocompleteTimeout, null);
          choices = rows ? suggestions(rows, focused.value) : [];
        }
      } catch (_) { logger.warn('Album autocomplete unavailable'); }
      try { await interaction.respond(choices); } catch (_) { logger.warn('Album autocomplete expired'); }
      return true;
    }
    if (!interaction.isChatInputCommand()) return false;
    // Acknowledge before database or Chromium work; Discord's initial deadline
    // is much shorter than a cold render on the free instance.
    await interaction.deferReply();
    const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
    const id = interaction.user.id;
    try {
      const remaining = (cooldowns.get(id) || 0) - now();
      if (remaining > 0) { await reply(`Espera ${Math.ceil(remaining / 1000)} segundos antes de exportar otro álbum.`); return true; }
      const input = interaction.options.getString('nombre', true);
      const artist = interaction.options.getString('artista') || '';
      const selected = ID_VALUE.exec(input);
      let ratingId = selected && selected[1];
      if (!ratingId) {
        // Fresh list for execution; autocomplete cache is only a convenience.
        const ratings = await repository.list(id);
        if (!ratings) { await reply('Vincula tu cuenta de Discord iniciando sesión en https://album-vault.vercel.app/ y vuelve a intentarlo.'); return true; }
        const found = matches(ratings, input, artist);
        if (!found.length) { await reply('No encontré ese álbum entre tus ratings guardados. Prueba con otro nombre o elige una sugerencia.'); return true; }
        if (found.length > 1) { await reply('Hay varios ratings que coinciden. Elige el álbum en las sugerencias de «nombre» o añade «artista».'); return true; }
        ratingId = found[0].id;
      }
      const rating = await repository.get(id, ratingId);
      if (!rating || (artist && !normalize(rating.artist).includes(normalize(artist)))) {
        await reply('Ese rating ya no está disponible en tu cuenta. Busca el álbum de nuevo.'); return true;
      }
      cooldowns.set(id, now() + 15000);
      for (const [user, expires] of cooldowns) if (expires <= now()) cooldowns.delete(user);
      if (cooldowns.size > 1024) cooldowns.delete(cooldowns.keys().next().value);
      let attachment;
      try { attachment = await render(rating); }
      catch (error) { cooldowns.delete(id); throw error; }
      const filename = (normalize(rating.album_title).replace(/ /g, '-').slice(0, 70) || 'album') + '.png';
      await interaction.editReply({ content: 'Tu rating guardado, exportado como imagen.', files: [{ attachment, name: filename }], allowedMentions: { parse: [] } });
    } catch (error) {
      logger.warn('Album export failed:', error.code || error.name || 'Error');
      await reply(error.code === 'RENDER_BUSY'
        ? 'El generador de imágenes está ocupado. Inténtalo de nuevo en unos segundos.'
        : 'No pude generar la imagen ahora. Inténtalo de nuevo en unos momentos.');
    }
    return true;
  };
}

function sameDefinition(existing) {
  if (!existing || existing.description !== albumCommandDefinition.description) return false;
  const fields = ['type', 'name', 'description', 'required', 'autocomplete', 'max_length'];
  const shape = options => (options || []).map(option => fields.map(key => (key === 'max_length' ? option.max_length ?? option.maxLength : option[key]) ?? (key === 'required' || key === 'autocomplete' ? false : null)));
  return JSON.stringify(shape(existing.options)) === JSON.stringify(shape(albumCommandDefinition.options));
}

async function ensureAlbumCommand(manager) {
  const commands = await manager.fetch();
  const existing = commands.find(command => command.name === 'album' && command.type === 1);
  if (sameDefinition(existing)) return 'already registered';
  if (existing) await manager.edit(existing.id, albumCommandDefinition);
  else await manager.create(albumCommandDefinition);
  return existing ? 'updated' : 'registered';
}

module.exports = { albumCommandDefinition, createSavedRatingRepository, createSavedAlbumCommand, ensureAlbumCommand, matches, suggestions };
