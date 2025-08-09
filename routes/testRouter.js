// Test Router (manual testing, zero Claude)

const express = require('express');
const { TABLES } = require('../config/constants');
const {
  searchTransactions,
  listOfficesOnFloor,
  findOfficeByFloorAndNumber,
  searchAirtable,
  getAllRecords,
  createRecord,
  updateRecord
} = require('../services/airtableService');

const router = express.Router();

// simple guard so this isn't exposed by accident
router.use((req, res, next) => {
  const key = req.header('x-test-key');
  if (!process.env.TEST_ROUTER_KEY || key === process.env.TEST_ROUTER_KEY) return next();
  return res.status(403).json({ ok: false, error: 'Forbidden: missing/invalid x-test-key' });
});

// POST /test/search-airtable
router.post('/test/search-airtable', async (req, res) => {
  try {
    const { baseId, tableId, searchTerm } = req.body;
    const out = await searchAirtable(baseId, tableId, searchTerm);
    res.json({ ok: true, out });
  } catch (e) { res.status(400).json({ ok:false, error: e.message }); }
});


// POST /test/search-transactions
router.post('/test/search-transactions', async (req, res) => {
  try {
    const { baseId, customerId, projectId } = req.body;
    const out = await searchTransactions(baseId, customerId, projectId);
    res.json({ ok: true, out });
  } catch (e) { res.status(400).json({ ok:false, error: e.message }); }
});

// POST /test/list-offices
router.post('/test/list-offices', async (req, res) => {
  try {
    const { baseId, projectId, floorNumber } = req.body;
    const out = await listOfficesOnFloor(baseId, projectId, floorNumber);
    res.json({ ok: true, out });
  } catch (e) { res.status(400).json({ ok:false, error: e.message }); }
});

// POST /test/find-office
router.post('/test/find-office', async (req, res) => {
  try {
    const { baseId, projectId, floorNumber, officeNumber } = req.body;
    const out = await findOfficeByFloorAndNumber(baseId, projectId, floorNumber, officeNumber);
    res.json({ ok: true, out });
  } catch (e) { res.status(400).json({ ok:false, error: e.message }); }
});

// POST /test/get-all
router.post('/test/get-all', async (req, res) => {
  try {
    const { baseId, tableId, maxRecords } = req.body;
    const out = await getAllRecords(baseId, tableId, maxRecords);
    res.json({ ok: true, count: out.length, sample: out[0] || null });
  } catch (e) { res.status(400).json({ ok:false, error: e.message }); }
});

// POST /test/create
router.post('/test/create', async (req, res) => {
  try {
    const { baseId, tableId, fields } = req.body;
    // tiny guard for Transactions requiring linked "משרד"
    // if (tableId === TABLES.TRANSACTIONS && !(fields?.['משרד מקושר'] && Array.isArray(fields['משרד מקושר']) && fields['משרד מקושר'].length)) {
    //   return res.status(400).json({ ok:false, error:'Transactions require linked "משרד מקושר" record id array' });
    // }
    const out = await createRecord(baseId, tableId, fields);
    res.json({ ok: true, out });
  } catch (e) { res.status(400).json({ ok:false, error: e.message }); }
});

// POST /test/update
router.post('/test/update', async (req, res) => {
  try {
    const { baseId, tableId, recordId, fields } = req.body;
    const out = await updateRecord(baseId, tableId, recordId, fields);
    res.json({ ok: true, out });
  } catch (e) { res.status(400).json({ ok:false, error: e.message }); }
});

module.exports = router;
