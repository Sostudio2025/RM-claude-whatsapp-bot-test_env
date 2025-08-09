// utils/airtableFields.js
const fieldCache = new Map(); // key: `${baseId}:${tableId}:${candidates.join('|')}`

async function resolveExistingFieldName(base, tableId, candidates) {
  const cacheKey = `${tableId}:${candidates.join('|')}`;
  if (fieldCache.has(cacheKey)) return fieldCache.get(cacheKey);

  // fetch 1 record to discover actual field keys
  const rows = await base(tableId).select({ maxRecords: 1 }).firstPage();
  const keys = new Set(Object.keys(rows[0]?.fields || {}));

  const found = candidates.find(c => keys.has(c));
  if (!found) throw new Error(`None of the candidate fields exist: ${candidates.join(', ')}`);

  fieldCache.set(cacheKey, found);
  return found;
}

module.exports = { resolveExistingFieldName };
