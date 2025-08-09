// const { TABLES } = require('../config/constants');

// function validateRecordId(recordId) {
//   return recordId && typeof recordId === 'string' && recordId.startsWith('rec') && recordId.length >= 17;
// }

// function validateTableId(tableId) {
//   return Object.values(TABLES).includes(tableId);
// }

// module.exports = { validateRecordId, validateTableId };



const { TABLES } = require('../config/constants');

const TABLE_ALIASES = {
  // Customers
  'customers': TABLES.CUSTOMERS,
  'customer': TABLES.CUSTOMERS,
  'לקוחות': TABLES.CUSTOMERS,
  // Projects
  'projects': TABLES.PROJECTS,
  'project': TABLES.PROJECTS,
  'פרויקטים': TABLES.PROJECTS,
  'פרוייקטים': TABLES.PROJECTS,
  'פרויקט': TABLES.PROJECTS,
  // Transactions
  'transactions': TABLES.TRANSACTIONS,
  'עסקאות': TABLES.TRANSACTIONS,
  // Leads
  'leads': TABLES.LEADS,
  'לידים': TABLES.LEADS,
  // Offices
  'offices': TABLES.OFFICES,
  'משרדים': TABLES.OFFICES,
  // Flowers / Control / Employees if needed
  'flowers': TABLES.FLOWERS,
  'פרחים': TABLES.FLOWERS,
  'control': TABLES.CONTROL,
  'בקרה': TABLES.CONTROL,
  'employees': TABLES.EMPLOYEES,
  'עובדים': TABLES.EMPLOYEES,
};

function resolveTableId(input) {
  if (!input) return null;
  const idMatch = Object.values(TABLES).includes(input);
  if (idMatch) return input;
  const key = String(input).trim().toLowerCase();
  return TABLE_ALIASES[key] || null;
}

function validateRecordId(recordId) {
  return recordId && typeof recordId === 'string' && recordId.startsWith('rec') && recordId.length >= 17;
}

function validateTableId(tableId) {
  return Object.values(TABLES).includes(tableId);
}

module.exports = { validateRecordId, validateTableId, resolveTableId };
