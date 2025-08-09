const app = require('./app');
const { log } = require('./utils/logger');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  log('success', `🚀 Server running on ${HOST}:${PORT}`);
  log('info', '📝 Functions: search, get records, create, update, get fields');
  log('info', '🧪 Test endpoint: GET /test-airtable');
  log('info', '🧠 Memory endpoints: POST /clear-memory, GET /memory');
  log('info', '🔔 Enhanced confirmation system with TTL');
  log('info', '⚡ VERSION 2025: Enhanced with improved system prompt and validation');
});
