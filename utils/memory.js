const { MEMORY_TTL_MS } = require('../config/constants');
const { log } = require('./logger');

const conversationMemory = new Map();
const pendingActions = new Map();

function getConversationHistory(senderId) {
  if (!conversationMemory.has(senderId)) {
    conversationMemory.set(senderId, { messages: [], lastAccess: Date.now() });
  }
  const conversation = conversationMemory.get(senderId);
  conversation.lastAccess = Date.now();
  return conversation.messages;
}

function addToConversationHistory(senderId, role, content) {
  const messages = getConversationHistory(senderId);
  messages.push({ role, content });
  if (messages.length > 15) messages.splice(0, messages.length - 15);
}

function clearUserMemory(sender) {
  conversationMemory.delete(sender);
  pendingActions.delete(sender);
}

function startMemorySweeper() {
  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of conversationMemory.entries()) {
      if (data.lastAccess && (now - data.lastAccess) > MEMORY_TTL_MS) {
        conversationMemory.delete(key);
        log('info', `Cleaned old memory for user: ${key}`);
      }
    }
    for (const [key, data] of pendingActions.entries()) {
      if (data.timestamp && (now - data.timestamp) > MEMORY_TTL_MS) {
        pendingActions.delete(key);
        log('info', `Cleaned old pending action for user: ${key}`);
      }
    }
  }, 10 * 60 * 1000);
}

module.exports = {
  conversationMemory,
  pendingActions,
  getConversationHistory,
  addToConversationHistory,
  clearUserMemory,
  startMemorySweeper
};
