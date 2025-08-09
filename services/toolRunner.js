const Anthropic = require('@anthropic-ai/sdk');
const { loadConfig } = require('../config/loadConfig');
const { TABLES } = require('../config/constants');
const {
  searchAirtable,
  searchTransactions,
  getAllRecords,
  createRecord,
  updateRecord,
  getAllRecords: _getAllRecords,
  getAllRecords: _,
  getAllRecords: __,
  getAllRecords: ___,
  getAllRecords: ____
} = require('./airtableService');
const { findOfficeByFloorAndNumber, listOfficesOnFloor } = require('./airtableService');
const { log } = require('../utils/logger');

const config = loadConfig();
const anthropic = new Anthropic({ apiKey: config.CLAUDE_API_KEY });

async function handleToolUse(toolUse) {
  log('info', `🛠️ מפעיל כלי: ${toolUse.name}`);

  switch (toolUse.name) {
    case 'search_airtable':
      return await searchAirtable(toolUse.input.baseId, toolUse.input.tableId, toolUse.input.searchTerm);

    case 'search_transactions':
      return await searchTransactions(toolUse.input.baseId, toolUse.input.customerId, toolUse.input.projectId);

    case 'get_all_records':
      return await getAllRecords(toolUse.input.baseId, toolUse.input.tableId, toolUse.input.maxRecords);

    case 'create_record':
      if (toolUse.input.tableId === TABLES.TRANSACTIONS) {
        const fields = toolUse.input.fields || {};
        if (!fields['משרד'] || !Array.isArray(fields['משרד']) || fields['משרד'].length === 0) {
          return {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: '❌ לא ניתן ליצור עסקה ללא משרד תואם. אנא ציין את מספר הקומה ומספר המשרד.'
          };
        }
      }
      return await createRecord(toolUse.input.baseId, toolUse.input.tableId, toolUse.input.fields);

    case 'update_record':
      return await updateRecord(
        toolUse.input.baseId,
        toolUse.input.tableId,
        toolUse.input.recordId,
        toolUse.input.fields
      );

    case 'get_table_fields': {
      // emulate get_table_fields by sampling first 5 records and analyzing fields (as in your original)
      const records = await getAllRecords(toolUse.input.baseId, toolUse.input.tableId, 5);
      const allFields = new Set();
      const fieldExamples = {};

      (records || []).forEach(r => {
        Object.keys(r.fields || {}).forEach(field => {
          allFields.add(field);
          fieldExamples[field] = fieldExamples[field] || [];
          const value = r.fields[field];
          if (value !== null && value !== undefined) {
            if (Array.isArray(value)) fieldExamples[field].push(...value);
            else fieldExamples[field].push(value);
          }
        });
      });

      const analyzedFields = {};
      for (const f of allFields) {
        const examples = fieldExamples[f] || [];
        const uniqueValues = [...new Set(examples)];
        analyzedFields[f] = {
          hasValues: examples.length > 0,
          uniqueValues,
          possibleSelectField: uniqueValues.length <= 10 && uniqueValues.length > 1,
          sampleValue: examples[0] || null
        };
      }

      return {
        availableFields: Array.from(allFields),
        fieldAnalysis: analyzedFields,
        sampleRecord: records?.[0]?.fields || {}
      };
    }

    case 'find_office_by_floor_and_number': {
      const office = await findOfficeByFloorAndNumber(
        toolUse.input.baseId,
        toolUse.input.projectId,
        toolUse.input.floorNumber,
        toolUse.input.officeNumber
      );

      if (!office) {
        const list = await listOfficesOnFloor(
          toolUse.input.baseId,
          toolUse.input.projectId,
          toolUse.input.floorNumber
        );

        const fallbackMessage = list.length
          ? `❗ לא נמצא משרד תואם.\nהנה רשימת משרדים בקומה ${toolUse.input.floorNumber}:\n` +
            list.map(r => `- מספר: ${r.fields['מספר משרד'] || r.fields['מס׳ משרד']} (ID: ${r.id})`).join('\n') +
            `\nאנא בחר אחד מהם.`
          : `❗ לא נמצאו משרדים כלל בקומה ${toolUse.input.floorNumber} בפרויקט זה.`;

        return { type: 'tool_result', tool_use_id: toolUse.id, content: fallbackMessage };
      }

      return office;
    }

    default:
      throw new Error(`Unknown tool: ${toolUse.name}`);
  }
}

module.exports = { anthropic, handleToolUse };
