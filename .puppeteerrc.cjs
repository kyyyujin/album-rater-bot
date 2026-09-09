const path = require('path');

module.exports = {
  // Render conserva el directorio del proyecto entre build y runtime. Guardar
  // Chromium aquí evita que Puppeteer lo busque en una caché HOME vacía.
  cacheDirectory: path.join(__dirname, '.cache', 'puppeteer')
};
