const express = require('express');
const { clearUserMemory, getConversationHistory, pendingActions } = require('../utils/memory');
const { BASE_ID, TABLES } = require('../config/constants');
const { getAllRecords } = require('../services/airtableService');
const { log } = require('../utils/logger');

const router = express.Router();

// ניקוי זיכרון
router.post('/clear-memory', (req, res) => {
  const sender = (req.body && req.body.sender) || 'default';
  clearUserMemory(sender);
  log('info', `🧹 זיכרון נוקה עבור: ${sender}`);
  res.json({ success: true, message: `Memory cleared for ${sender}` });
});

// מידע על זיכרון
router.get('/memory/:sender?', (req, res) => {
  const sender = req.params.sender || 'default';
  const history = getConversationHistory(sender);
  const hasPending = pendingActions.has(sender);
  res.json({ sender, historyLength: history.length, history, hasPendingAction: hasPending });
});

// בדיקת חיבור
router.get('/test-airtable', async (_req, res) => {
  try {
    log('info', '🧪 בודק חיבור לAirtable...');
    const testResult = await getAllRecords(BASE_ID, TABLES.PROJECTS, 1);
    res.json({
      success: true,
      message: '✅ חיבור תקין!',
      sampleRecord: testResult[0] || null
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

module.exports = router;
