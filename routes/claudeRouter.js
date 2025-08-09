const express = require('express');
const { postClaudeQuery } = require('../controllers/claudeController');

const router = express.Router();

router.post('/claude-query', postClaudeQuery);

module.exports = router;
