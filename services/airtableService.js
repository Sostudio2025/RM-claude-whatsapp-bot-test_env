// File: src/services/airtableService.js
const Airtable = require('airtable');
const { loadConfig } = require('../config/loadConfig');
const { log } = require('../utils/logger');
const { TABLES } = require('../config/constants');
const { validateRecordId, validateTableId, resolveTableId } = require('../utils/validators');

const config = loadConfig();

// get an Airtable "base" instance for a given baseId
function getBase(baseId) {
  if (!config.AIRTABLE_API_KEY) {
    throw new Error('Missing AIRTABLE_API_KEY');
  }
  return new Airtable({ apiKey: config.AIRTABLE_API_KEY }).base(baseId);
}

/* ------------------------- Helpers ------------------------- */

function quoteIfNeededFloor(floorNumber) {
  const isNumeric = !isNaN(Number(floorNumber));
  return isNumeric ? `{קומה} = ${Number(floorNumber)}` : `{קומה} = "${String(floorNumber).replace(/"/g, '\\"')}"`;
}

// Fetch all records from a select (handles pagination)
async function selectAll(selectQuery) {
  const out = [];
  await selectQuery.eachPage((records, fetchNextPage) => {
    out.push(...records);
    fetchNextPage();
  });
  return out;
}

/* ------------------------- Services ------------------------- */


async function searchTransactions(baseId, customerId, projectId) {
  try {
    log('info', `🔍 מחפש עסקות עבור לקוח: ${customerId}, פרויקט: ${projectId}`);

    const base = getBase(baseId);

    // Pull all transactions (could add filterByFormula here if needed)
    const rows = await selectAll(
      base(TABLES.TRANSACTIONS).select({
        pageSize: 100
      })
    );

    const matchingTransactions = rows.filter(record => {
      const fields = record.fields;

      const linkedCustomer = fields['לקוחות'];
      const linkedProject = fields['פרוייקט'];

      const customerMatch = Array.isArray(linkedCustomer)
        ? linkedCustomer.includes(customerId)
        : linkedCustomer === customerId;

      const projectMatch = Array.isArray(linkedProject)
        ? linkedProject.includes(projectId)
        : linkedProject === projectId;

      return customerMatch && projectMatch;
    });

    log('success', `נמצאו ${matchingTransactions.length} עסקות תואמות`);

    return {
      found: matchingTransactions.length,
      transactions: matchingTransactions.map(record => ({
        id: record.id,
        fields: record.fields
      }))
    };
  } catch (error) {
    log('error', 'שגיאה בחיפוש עסקות', { error: error.message });
    throw new Error(`Transaction search failed: ${error.message}`);
  }
}

async function listOfficesOnFloor(baseId, projectId, floorNumber) {
  const base = getBase(baseId);

  const formula = `AND(
    {קומה} = ${floorNumber}
  )`;

  log('info', `📥 Offices filter formula: ${formula}`);

  const rows = await selectAll(
    base(TABLES.OFFICES).select({
      filterByFormula: formula,
      pageSize: 100
    })
  );

  log('info', `🔄 Fetched ${rows.length} offices from Airtable`);
   const all = rows?.data?.records || [];
 const records = rows.filter(r => {
    const link = r?.fields?.['פרוייקט'];
    return Array.isArray(link) && link.includes(projectId);
  });
  log('info', `🔄 Fetched ${records.length} offices after projectId filter`);
  return records.map(r => ({ id: r.id, fields: r.fields }));
}

async function findOfficeByFloorAndNumber(baseId, projectId, floorNumber, officeNumber) {
  log('info', `📥 Find office in base ${baseId} project ${projectId} floor ${floorNumber} num ${officeNumber}`);

  const officesOnFloor = await listOfficesOnFloor(baseId, projectId, floorNumber);
  log('info', `🔍 Found ${officesOnFloor.length} offices on floor ${floorNumber}`);

  const matching = officesOnFloor.find(record => {
    const f = record.fields || {};
    const num = f['מס׳ משרד duplicate'] || f['מס׳ משרד'] || f['מספר משרד'];
    return String(num).trim() === String(officeNumber).trim();
  });

  if (matching) {
    log('success', `✅ Matching office found: ${matching.id}`, matching.fields);
    return matching;
  }

  log('warning', `❌ No office found with number ${officeNumber} on floor ${floorNumber}`, {
    attemptedOffice: officeNumber,
    attemptedFloor: floorNumber
  });
  return null;
}

async function searchAirtable(baseId, tableId, searchTerm) {
  try {
    tableId = resolveTableId(tableId);
    if (!validateTableId(tableId)) throw new Error(`Invalid table ID: ${tableId}`);
    const base = getBase(baseId);

    log('info', `🔍 מחפש: "${searchTerm}" בטבלה: ${tableId}`);

    // Generic search: pull pages and filter client-side (no universal SEARCH-all-fields)
    const rows = await selectAll(
      base(tableId).select({ pageSize: 100 })
    );

    const term = String(searchTerm || '').toLowerCase();
    const filtered = rows.filter(r => JSON.stringify(r.fields).toLowerCase().includes(term));
    log('success', `נמצאו ${filtered.length} רשומות`);

    return { found: filtered.length, records: filtered.map(r => ({ id: r.id, fields: r.fields })) };
  } catch (error) {
    log('error', 'שגיאה בחיפוש', { error: error.message });
    throw new Error(`Airtable search failed: ${error.message}`);
  }
}

async function getAllRecords(baseId, tableId, maxRecords = null) {
  try {
    tableId = resolveTableId(tableId);
    if (!validateTableId(tableId)) throw new Error(`Invalid table ID: ${tableId}`);
    const base = getBase(baseId);

    log('info', `📋 מביא את כל הרשומות מטבלה: ${tableId}${maxRecords ? ` (מקסימום ${maxRecords})` : ''}`);

    const rows = await selectAll(
      base(tableId).select({ pageSize: 100 })
    );

    const sliced = maxRecords ? rows.slice(0, maxRecords) : rows;
    log('success', `🎉 סה"כ נמשכו ${sliced.length} רשומות מהטבלה ${tableId}`);
    return sliced.map(r => ({ id: r.id, fields: r.fields }));
  } catch (error) {
    log('error', '❌ שגיאה בקבלת כל הרשומות', { error: error.message });
    throw new Error(`Get all records failed: ${error.message}`);
  }
}
async function safeCreate(base, tableId, fields, maxRetries = 10) {
  let attempt = 0;
  let payload =fields?.fields?.fields || fields?.fields || fields ;
  while (attempt < maxRetries) {
    try {
      const rec = await base(tableId).create(payload, { typecast: true });
      return { id: rec.id, fields: rec.fields };
    } catch (e) {
      const msg = e?.message || '';
      console.error('Create error:', msg);
      // Look for: Field "X" cannot accept a value because the field is computed
      const m = msg.match(/Field\s+"([^"]+)"\s+cannot accept a value because the field is computed/i);
      if (!m) throw e;                 // different error → bubble up
      const computedField = m[1];
      delete payload[computedField];    // drop computed field and retry
      attempt += 1;
    }
  }
  throw new Error('Create failed after removing computed fields multiple times');
}


async function createRecord(baseId, tableId, fields) {
  tableId = resolveTableId(tableId);
  if (!validateTableId(tableId)) throw new Error(`Invalid table ID: ${tableId}`);
  const base = getBase(baseId);

  log('info', `🆕 יוצר רשומה חדשה בטבלה: ${tableId}`, { fields });

  // ✅ will auto-remove computed fields if present
  const rec = await safeCreate(base, tableId, fields);

  log('success', `רשומה נוצרה! ID: ${rec.id}`);
  return rec;
}


async function updateRecord(baseId, tableId, recordId, fields) {
  try {
    tableId = resolveTableId(tableId);
    if (!validateTableId(tableId)) throw new Error(`Invalid table ID: ${tableId}`);
    if (!validateRecordId(recordId)) throw new Error(`Invalid Record ID: ${recordId}`);

    const base = getBase(baseId);
    log('info', `🔄 מעדכן רשומה: ${recordId}`, { fields });

    // ✅ Single-record update form
    const rec = await base(tableId).update(recordId, fields, { typecast: true });

    log('success', 'רשומה עודכנה בהצלחה');
    return { id: rec.id, fields: rec.fields };
  } catch (error) {
    log('error', 'שגיאה בעדכון', { error: error.message });
    const msg = error?.message || 'Unknown error';
    throw new Error(`Update record failed: ${msg}`);
  }
}


module.exports = {
  searchTransactions,
  listOfficesOnFloor,
  findOfficeByFloorAndNumber,
  searchAirtable,
  getAllRecords,
  createRecord,
  updateRecord
};


