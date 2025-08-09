function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const emoji = level === 'error' ? '❌' : level === 'success' ? '✅' : level === 'warning' ? '⚠️' : '📝';
  console.log(`${emoji} [${timestamp}] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

module.exports = { log };
