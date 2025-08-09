const fs = require('fs');
const path = require('path');

function loadConfig() {
  if (process.env.NODE_ENV === 'production' || !fs.existsSync(path.join(__dirname, '../env_config.txt'))) {
    return {
      CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
      AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY
    };
  }

  const configPath = path.join(__dirname, '../env_config.txt');
  const configData = fs.readFileSync(configPath, 'utf8');

  const config = {};
  configData.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim();
      if (key && value) config[key] = value;
    }
  });

  return config;
}

module.exports = { loadConfig };
