module.exports = [
  {
    name: 'search_airtable',
    description: 'Search for records in Airtable by text',
    input_schema: {
      type: 'object',
      properties: {
        baseId: { type: 'string' },
        tableId: { type: 'string' },
        searchTerm: { type: 'string' }
      },
      required: ['baseId', 'tableId', 'searchTerm']
    }
  },
  {
    name: 'search_transactions',
    description: 'Search for existing transactions by customer and project',
    input_schema: {
      type: 'object',
      properties: {
        baseId: { type: 'string' },
        customerId: { type: 'string' },
        projectId: { type: 'string' }
      },
      required: ['baseId', 'customerId', 'projectId']
    }
  },
  {
    name: 'get_all_records',
    description: 'Get all records from a table',
    input_schema: {
      type: 'object',
      properties: {
        baseId: { type: 'string' },
        tableId: { type: 'string' },
        maxRecords: { type: 'number', default: 100 }
      },
      required: ['baseId', 'tableId']
    }
  },
  {
    name: 'create_record',
    description: 'Create a new record',
    input_schema: {
      type: 'object',
      properties: {
        baseId: { type: 'string' },
        tableId: { type: 'string' },
        fields: { type: 'object' }
      },
      required: ['baseId', 'tableId', 'fields']
    }
  },
  {
    name: 'update_record',
    description: 'Update a single record',
    input_schema: {
      type: 'object',
      properties: {
        baseId: { type: 'string' },
        tableId: { type: 'string' },
        recordId: { type: 'string' },
        fields: { type: 'object' }
      },
      required: ['baseId', 'tableId', 'recordId', 'fields']
    }
  },
  {
    name: 'get_table_fields',
    description: 'Get available fields in a table',
    input_schema: {
      type: 'object',
      properties: {
        baseId: { type: 'string' },
        tableId: { type: 'string' }
      },
      required: ['baseId', 'tableId']
    }
  },
  {
    name: 'find_office_by_floor_and_number',
    description: 'Find an office record based on floor number and office number within the same project',
    input_schema: {
      type: 'object',
      properties: {
        baseId: { type: 'string' },
        projectId: { type: 'string' },
        floorNumber: { type: 'number' },
        officeNumber: { type: 'number' }
      },
      required: ['baseId', 'projectId', 'floorNumber', 'officeNumber']
    }
  }
];
