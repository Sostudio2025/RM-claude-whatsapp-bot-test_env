const express = require('express');
const { loadConfig } = require('./config/loadConfig');
const { anthropic } = require('./services/toolRunner'); // single Anthropic client instance
const claudeRouter = require('./routes/claudeRouter');
const utilityRouter = require('./routes/utilityRouter');
const testRouter = require('./routes/testRouter');
const { startMemorySweeper } = require('./utils/memory');


const app = express();
app.use(express.json());

// routers
app.use('/', claudeRouter);
app.use('/', utilityRouter);
app.use('/', testRouter);

// start TTL sweeper
startMemorySweeper();

module.exports = app;
