const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

function loadConfig() {
    // בשרת נשתמש במשתני סביבה
    if (process.env.NODE_ENV === 'production' || !fs.existsSync(path.join(__dirname, 'env_config.txt'))) {
        return {
            CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
            AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY
        };
    }
    
    // בפיתוח נשתמש בקובץ (רק אם הוא קיים)
    const configPath = path.join(__dirname, 'env_config.txt');
    const configData = fs.readFileSync(configPath, 'utf8');

    const config = {};
    configData.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            if (key && value) {
                config[key] = value;
            }
        }
    });

    return config;
}

const config = loadConfig();
const app = express();
app.use(express.json());

const anthropic = new Anthropic({
    apiKey: config.CLAUDE_API_KEY
});

// שיפור מערכת זיכרון עם TTL
const MEMORY_TTL = 30 * 60 * 1000; // 30 דקות
const conversationMemory = new Map();
const pendingActions = new Map();

function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const emoji = level === 'error' ? '❌' : level === 'success' ? '✅' : level === 'warning' ? '⚠️' : '📝';
    console.log(`${emoji} [${timestamp}] ${message}`);
    if (data) console.log(JSON.stringify(data, null, 2));
}

function getConversationHistory(senderId) {
    if (!conversationMemory.has(senderId)) {
        conversationMemory.set(senderId, {
            messages: [],
            lastAccess: Date.now()
        });
    }
    
    const conversation = conversationMemory.get(senderId);
    conversation.lastAccess = Date.now();
    return conversation.messages;
}

function addToConversationHistory(senderId, role, content) {
    const messages = getConversationHistory(senderId);
    messages.push({
        role: role,
        content: content
    });

    // הגבל היסטוריה ל-15 הודעות
    if (messages.length > 15) {
        messages.splice(0, messages.length - 15);
    }
}

function cleanOldMemory() {
    const now = Date.now();
    for (const [key, data] of conversationMemory.entries()) {
        if (data.lastAccess && (now - data.lastAccess) > MEMORY_TTL) {
            conversationMemory.delete(key);
            log('info', `Cleaned old memory for user: ${key}`);
        }
    }
    
    // נקה גם פעולות ממתינות ישנות
    for (const [key, data] of pendingActions.entries()) {
        if (data.timestamp && (now - data.timestamp) > MEMORY_TTL) {
            pendingActions.delete(key);
            log('info', `Cleaned old pending action for user: ${key}`);
        }
    }
}

// הרץ ניקוי זיכרון כל 10 דקות
setInterval(cleanOldMemory, 10 * 60 * 1000);

// שיפור validation
function validateRecordId(recordId) {
    return recordId && 
           typeof recordId === 'string' && 
           recordId.startsWith('rec') && 
           recordId.length >= 17;
}

function validateTableId(tableId) {
    const validTables = [
        'tblSgYN8CbQcxeT0j', // Transactions
        'tblcTFGg6WyKkO5kq', // Customers
        'tbl9p6XdUrecy2h7G', // Projects
        'tbl3ZCmqfit2L0iQ0', // Leads
        'tbl7etO9Yn3VH9QpT', // Offices
        'tblNJzcMRtyMdH14d', // Flowers
        'tblYxAM0xNp0z9EoN', // Control
        'tbl8JT0j7C35yMcc2'  // Employees
    ];
    return validTables.includes(tableId);
}

async function searchTransactions(baseId, customerId, projectId) {
    try {
        log('info', `🔍 מחפש עסקות עבור לקוח: ${customerId}, פרויקט: ${projectId}`);

        const response = await axios.get(
            `https://api.airtable.com/v0/${baseId}/tblSgYN8CbQcxeT0j`, {
                headers: {
                    'Authorization': `Bearer ${config.AIRTABLE_API_KEY}`
                }
            }
        );

        const records = response.data.records;

        // חיפוש עסקות שמקושרות לאותו לקוח ופרויקט
        const matchingTransactions = records.filter(record => {
            const fields = record.fields;
            const linkedCustomer = fields['מזהה לקוח ראשי (ID_Client)'];
            const linkedProject = fields['מזהה פרויקט (ID_Project)'];

            return (linkedCustomer && linkedCustomer.includes(customerId)) &&
                (linkedProject && linkedProject.includes(projectId));
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

async function searchAirtable(baseId, tableId, searchTerm) {
    try {
        if (!validateTableId(tableId)) {
            throw new Error(`Invalid table ID: ${tableId}`);
        }

        log('info', `🔍 מחפש: ${searchTerm} בטבלה: ${tableId}`);

        const response = await axios.get(
            `https://api.airtable.com/v0/${baseId}/${tableId}`, {
                headers: {
                    'Authorization': `Bearer ${config.AIRTABLE_API_KEY}`
                }
            }
        );

        const records = response.data.records;
        const filteredRecords = records.filter(record =>
            JSON.stringify(record.fields).toLowerCase().includes(searchTerm.toLowerCase())
        );

        log('success', `נמצאו ${filteredRecords.length} רשומות`);

        return {
            found: filteredRecords.length,
            records: filteredRecords.map(record => ({
                id: record.id,
                fields: record.fields
            }))
        };
    } catch (error) {
        log('error', 'שגיאה בחיפוש', { error: error.message });
        throw new Error(`Airtable search failed: ${error.message}`);
    }
}

async function getAllRecords(baseId, tableId, maxRecords = 100) {
    try {
        if (!validateTableId(tableId)) {
            throw new Error(`Invalid table ID: ${tableId}`);
        }

        log('info', `📋 מביא רשומות מטבלה: ${tableId}`);

        const url = `https://api.airtable.com/v0/${baseId}/${tableId}?maxRecords=${maxRecords}`;
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${config.AIRTABLE_API_KEY}`
            }
        });

        log('success', `נמצאו ${response.data.records.length} רשומות`);
        return response.data.records;
    } catch (error) {
        log('error', 'שגיאה בקבלת רשומות', { error: error.message });
        throw new Error(`Get records failed: ${error.message}`);
    }
}

async function createRecord(baseId, tableId, fields) {
    try {
        if (!validateTableId(tableId)) {
            throw new Error(`Invalid table ID: ${tableId}`);
        }

        log('info', `🆕 יוצר רשומה חדשה בטבלה: ${tableId}`, { fields });

        const url = `https://api.airtable.com/v0/${baseId}/${tableId}`;
        const response = await axios.post(url, {
            fields: fields
        }, {
            headers: {
                'Authorization': `Bearer ${config.AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        log('success', `רשומה נוצרה! ID: ${response.data.id}`);
        return response.data;
    } catch (error) {
        log('error', 'שגיאה ביצירת רשומה', { 
            error: error.response ? error.response.data : error.message 
        });
        const errorMessage = error.response && error.response.data && error.response.data.error ?
            error.response.data.error.message : error.message;
        throw new Error(`Create record failed: ${errorMessage}`);
    }
}

async function updateRecord(baseId, tableId, recordId, fields) {
    try {
        if (!validateTableId(tableId)) {
            throw new Error(`Invalid table ID: ${tableId}`);
        }
        
        if (!validateRecordId(recordId)) {
            throw new Error(`Invalid Record ID: ${recordId}`);
        }

        log('info', `🔄 מעדכן רשומה: ${recordId}`, { fields });

        const url = `https://api.airtable.com/v0/${baseId}/${tableId}`;
        const response = await axios.patch(url, {
            records: [{
                id: recordId,
                fields: fields
            }]
        }, {
            headers: {
                'Authorization': `Bearer ${config.AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        log('success', 'רשומה עודכנה בהצלחה');
        return response.data.records[0];
    } catch (error) {
        log('error', 'שגיאה בעדכון', { 
            error: error.response ? error.response.data : error.message 
        });
        const errorMessage = error.response && error.response.data && error.response.data.error ?
            error.response.data.error.message : error.message;
        throw new Error(`Update record failed: ${errorMessage}`);
    }
}

async function getTableFields(baseId, tableId) {
    try {
        if (!validateTableId(tableId)) {
            throw new Error(`Invalid table ID: ${tableId}`);
        }

        log('info', `📋 בודק שדות בטבלה: ${tableId}`);

        const url = `https://api.airtable.com/v0/${baseId}/${tableId}?maxRecords=5`;
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${config.AIRTABLE_API_KEY}`
            }
        });

        if (response.data.records.length > 0) {
            const allFields = new Set();
            const fieldExamples = {};
            
            response.data.records.forEach(record => {
                Object.keys(record.fields).forEach(field => {
                    allFields.add(field);
                    // שמור דוגמאות לכל שדה כדי לזהות ערכי בחירה
                    if (!fieldExamples[field]) {
                        fieldExamples[field] = [];
                    }
                    const value = record.fields[field];
                    if (value !== null && value !== undefined) {
                        if (Array.isArray(value)) {
                            fieldExamples[field].push(...value);
                        } else {
                            fieldExamples[field].push(value);
                        }
                    }
                });
            });

            // נתח ערכי בחירה לכל שדה
            const analyzedFields = {};
            for (const field of allFields) {
                const examples = fieldExamples[field] || [];
                const uniqueValues = [...new Set(examples)];
                
                analyzedFields[field] = {
                    hasValues: examples.length > 0,
                    uniqueValues: uniqueValues,
                    possibleSelectField: uniqueValues.length <= 10 && uniqueValues.length > 1,
                    sampleValue: examples[0] || null
                };
            }

            const result = {
                availableFields: Array.from(allFields),
                fieldAnalysis: analyzedFields,
                sampleRecord: response.data.records[0] ? response.data.records[0].fields : {}
            };

            log('success', `נמצאו שדות: ${result.availableFields.length}`);
            return result;
        }

        return {
            availableFields: [],
            fieldAnalysis: {},
            sampleRecord: {}
        };
    } catch (error) {
        log('error', 'שגיאה בקבלת שדות', { error: error.message });
        throw new Error(`Get table fields failed: ${error.message}`);
    }
}

const airtableTools = [
    {
        name: "search_airtable",
        description: "Search for records in Airtable by text",
        input_schema: {
            type: "object",
            properties: {
                baseId: { type: "string" },
                tableId: { type: "string" },
                searchTerm: { type: "string" }
            },
            required: ["baseId", "tableId", "searchTerm"]
        }
    },
    {
        name: "search_transactions",
        description: "Search for existing transactions by customer and project",
        input_schema: {
            type: "object",
            properties: {
                baseId: { type: "string" },
                customerId: { type: "string" },
                projectId: { type: "string" }
            },
            required: ["baseId", "customerId", "projectId"]
        }
    },
    {
        name: "get_all_records",
        description: "Get all records from a table",
        input_schema: {
            type: "object",
            properties: {
                baseId: { type: "string" },
                tableId: { type: "string" },
                maxRecords: { type: "number", default: 100 }
            },
            required: ["baseId", "tableId"]
        }
    },
    {
        name: "create_record",
        description: "Create a new record",
        input_schema: {
            type: "object",
            properties: {
                baseId: { type: "string" },
                tableId: { type: "string" },
                fields: { type: "object" }
            },
            required: ["baseId", "tableId", "fields"]
        }
    },
    {
        name: "update_record",
        description: "Update a single record",
        input_schema: {
            type: "object",
            properties: {
                baseId: { type: "string" },
                tableId: { type: "string" },
                recordId: { type: "string" },
                fields: { type: "object" }
            },
            required: ["baseId", "tableId", "recordId", "fields"]
        }
    },
    {
        name: "get_table_fields",
        description: "Get available fields in a table",
        input_schema: {
            type: "object",
            properties: {
                baseId: { type: "string" },
                tableId: { type: "string" }
            },
            required: ["baseId", "tableId"]
        }
    }
];

async function handleToolUse(toolUse) {
    log('info', `🛠️ מפעיל כלי: ${toolUse.name}`);

    switch (toolUse.name) {
        case 'search_airtable':
            return await searchAirtable(
                toolUse.input.baseId,
                toolUse.input.tableId,
                toolUse.input.searchTerm
            );
        case 'search_transactions':
            return await searchTransactions(
                toolUse.input.baseId,
                toolUse.input.customerId,
                toolUse.input.projectId
            );
        case 'get_all_records':
            return await getAllRecords(
                toolUse.input.baseId,
                toolUse.input.tableId,
                toolUse.input.maxRecords
            );
        case 'create_record':
            return await createRecord(
                toolUse.input.baseId,
                toolUse.input.tableId,
                toolUse.input.fields
            );
        case 'update_record':
            return await updateRecord(
                toolUse.input.baseId,
                toolUse.input.tableId,
                toolUse.input.recordId,
                toolUse.input.fields
            );
        case 'get_table_fields':
            return await getTableFields(
                toolUse.input.baseId,
                toolUse.input.tableId
            );
        default:
            throw new Error(`Unknown tool: ${toolUse.name}`);
    }
}

// Enhanced System Prompt
const systemPrompt = `# Airtable Management Assistant

You are an intelligent assistant connected to Airtable via MCP tools. Your primary goal is to help users query, find, and manage Airtable records efficiently and accurately.

## 🎯 Core Principles

### Data-First Approach
- **Always use tools first** to retrieve actual data - never assume field names, record IDs, or table structures
- **Verify field names dynamically** using describe_table or list_records before any create/update operations
- **Never hardcode field names** - table structures may change over time
- **Confirm data accuracy** before proceeding with any modifications

### Workflow Philosophy
- **Complete task sequences** - don't stop after one action if the user's request requires multiple steps
- **Ask clarifying questions** when data is missing or ambiguous
- **Request explicit approval** before any create/update operations
- **Provide clear status updates** throughout multi-step processes

## 🏗️ Airtable Structure

**Base ID:** appL1FfUaRbmPNI01

**Main Tables:**
- **Leads (לידים)** — tbl3ZCmqfit2L0iQ0: New customer inquiries and potential prospects
- **Customers (לקוחות)** — tblcTFGg6WyKkO5kq: Customer database with all required details
- **Projects (פרויקטים)** — tbl9p6XdUrecy2h7G: Project management and details
- **Transactions (עסקאות)** — tblSgYN8CbQcxeT0j: Central transaction records (linked to projects and customers)
- **Offices (משרדים)** — tbl7etO9Yn3VH9QpT: Office inventory across all projects
- **Flowers (פרחים)** — tblNJzcMRtyMdH14d: Customer flower delivery tracking
- **Control (בקרה)** — tblYxAM0xNp0z9EoN: Error tracking and system monitoring

*Note: If uncertain about table structure, use list_tables to get current table information.*

## 🛠️ Available Operations

### 1. Record Status Updates
**Process:**
1. Locate the target record using search tools
2. Use get_table_fields to identify status field and available values
3. Match user's intent to appropriate status value
4. Confirm the intended status change with user
5. Execute update after receiving approval

### 2. Record Detail Updates
**Process:**
1. Locate the specific record (handle duplicates by asking for clarification)
2. Identify relevant fields using get_table_fields
3. Confirm record identification and intended changes with user
4. Execute update after receiving explicit approval

## 🎯 Special Workflow: Customer Registration Completion
*Triggers: "השלים הרשמה", "העביר דמי רצינות", "completed registration", "transferred deposit"*

**Complete Sequence:**
1. **Locate Customer**
   - Search Customers table for the specified customer
   - If multiple matches found, ask user to clarify which customer
   - If customer not found, ask if they want to create a new customer record

2. **Check Customer Status**
   - **CRITICAL**: Use get_table_fields FIRST to get available status values from the Customers table
   - Examine current customer status 
   - Find the appropriate status value that means "customer in process" from the available options
   - If status needs updating, ask user for approval to update to the correct available status value
   - Update customer status if approved using ONLY values from the available options list

3. **Locate Project**
   - Search Projects table for the specified project
   - If multiple matches or project not found, ask for clarification
   - Verify project is active and available

4. **Check for Existing Transaction**
   - Search Transactions table for existing records linking the same customer and project
   - If existing transaction found:
     - Display transaction details
     - Inform user that registration is already complete
     - Ask if they want to update any transaction details
   - If no existing transaction found, proceed to create new transaction

5. **Create New Transaction**
   - **CRITICAL**: Use get_table_fields to verify required fields and available options for Transactions table
   - Ask user for approval to create new transaction
   - Create transaction record with appropriate links to customer and project
   - Set initial transaction status using ONLY available status options from the fields list

6. **Final Steps**
   - Confirm transaction creation success
   - Ask user if they want to add additional information to the transaction
   - Provide summary of all actions completed

**Critical Notes for This Workflow:**
- **NEVER use hardcoded status values** - always get available options from get_table_fields first
- **VALIDATE all field values** before attempting updates or creation
- **Never stop mid-sequence** - complete all necessary steps
- **Handle missing data** by asking specific questions
- **Request approval** before any create/update operations
- **Validate all links** between customer, project, and transaction
- **Provide clear progress updates** at each step
- **If field value errors occur** - get available options and retry with correct values

## 📝 Notes Management

**Two types of notes fields typically exist:**
- **הערות כלליות (General Notes)**: For user-requested notes
- **הערות AI (AI Notes)**: For agent-generated observations

**Rules:**
- Agent-initiated observations → הערות AI
- User-requested notes (even if agent-suggested) → הערות כלליות  
- If הערות AI doesn't exist, use הערות כלליות
- Always verify field names before adding notes

## 🔧 Tool Usage Guidelines

**Information Gathering:**
- search_airtable: Find records by text content
- get_all_records: Browse records in a table
- get_table_fields: Get field names and structure before operations
- search_transactions: Find existing transactions by customer and project

**Data Modification:**
- create_record: Add new records (requires approval)
- update_record: Modify existing records (requires approval)

## 🚨 Critical Rules

### Data Integrity
- **Never assume field existence OR field values** - always verify using get_table_fields
- **Always get available select options** before using them in updates/creation
- **Never create new fields OR new select options** - work only with existing table structure
- **Validate record IDs** before update operations
- **Handle duplicates** by asking user for clarification
- **If you get INVALID_MULTIPLE_CHOICE_OPTIONS error** - immediately get available options and retry

### User Interaction
- **Always respond in Hebrew** regardless of input language
- **Ask for explicit approval** before any create/update operations
- **Provide clear error messages** if operations fail
- **Offer next steps** after completing actions

### Error Handling
- **Graceful failure recovery** - suggest alternatives if operations fail
- **Clear error communication** - explain what went wrong and potential solutions
- **Data validation** - verify inputs before attempting operations

## 🎯 Success Metrics
- **Task completion rate**: Finish multi-step workflows completely
- **Data accuracy**: Verify all field names and values before operations
- **User satisfaction**: Clear communication and appropriate approval requests
- **Error prevention**: Validate data before attempting operations

---

**Remember: Your role is to be a reliable, accurate assistant that completes tasks efficiently while maintaining data integrity and clear communication with users. Always respond in Hebrew.**`;

app.post('/claude-query', async (req, res) => {
    try {
        const messageData = req.body;
        const message = messageData.message;
        const sender = messageData.sender || 'default';

        log('info', `📨 הודעה מ-${sender}: ${message}`);

        // בדיקה אם זה אישור לפעולה מחכה
        if (pendingActions.has(sender)) {
            const pendingAction = pendingActions.get(sender);
            
            if (message.toLowerCase().includes('כן') || message.toLowerCase().includes('אישור') || 
                message.toLowerCase().includes('אוקיי') || message.toLowerCase().includes('בצע')) {
                
                log('info', `✅ מבצע פעולה מאושרת עבור: ${sender}`);
                pendingActions.delete(sender);
                
                try {
                    for (const toolUse of pendingAction.toolUses) {
                        await handleToolUse(toolUse);
                        log('success', `כלי מאושר הושלם: ${toolUse.name}`);
                    }
                    
                    return res.json({
                        success: true,
                        response: '✅ הפעולה בוצעה בהצלחה!',
                        actionCompleted: true
                    });
                } catch (error) {
                    return res.json({
                        success: false,
                        response: `❌ אירעה שגיאה בביצוع הפעולה: ${error.message}`
                    });
                }
                
            } else if (message.toLowerCase().includes('לא') || message.toLowerCase().includes('ביטול')) {
                pendingActions.delete(sender);
                return res.json({
                    success: true,
                    response: '❌ הפעולה בוטלה לפי בקשתך',
                    actionCancelled: true
                });
            } else {
                // בדיקה אם זו בקשה חדשה
                const newRequestKeywords = ['עדכן', 'שנה', 'תמצא', 'חפש', 'צור', 'הוסף', 'מחק', 'הצג', 'השלים', 'העביר'];
                if (newRequestKeywords.some(keyword => message.includes(keyword))) {
                    log('info', '🔄 בקשה חדשה זוהתה - מנקה זיכרון אישורים ישנים');
                    pendingActions.delete(sender);
                } else {
                    return res.json({
                        success: true,
                        response: 'לא הבנתי את התגובה. אנא כתוב "כן" לאישור או "לא" לביטול.',
                        needsClarification: true
                    });
                }
            }
        }

        const conversationHistory = getConversationHistory(sender);
        addToConversationHistory(sender, 'user', message);

        const messages = conversationHistory.map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        log('info', `🧠 שולח ל-Claude עם ${messages.length} הודעות`);

        let response;
        let toolsExecuted = [];
        let finalResponse = '';
        let conversationFinished = false;
        let stepCount = 0;

        // לולאה עם הגבלת בטיחות
        while (!conversationFinished && messages.length < 25 && stepCount < 10) {
            stepCount++;
            log('info', `🔄 שלב ${stepCount}`);

            try {
                response = await anthropic.messages.create({
                    model: "claude-3-5-sonnet-20241022",
                    max_tokens: 4000,
                    system: systemPrompt,
                    messages: messages,
                    tools: airtableTools
                });

                log('info', `📝 תגובת Claude (שלב ${stepCount})`);

                const toolUses = response.content.filter(content => content.type === 'tool_use');

                if (toolUses.length === 0) {
                    const textContent = response.content.find(content => content.type === 'text');
                    if (textContent) {
                        finalResponse = textContent.text;
                    }
                    conversationFinished = true;
                    log('success', 'שיחה הסתיימה - אין כלים נוספים');
                    break;
                }

                log('info', `🛠️ כלים להפעיל: ${toolUses.length}`);

                messages.push({
                    role: 'assistant',
                    content: response.content
                });

                // בדיקת צורך באישור
                const needsConfirmation = toolUses.some(tool => 
                    tool.name === 'create_record' || tool.name === 'update_record'
                );

                if (needsConfirmation) {
                    let actionDescription = '🔔 **בקשת אישור לביצוע פעולה:**\n\n';
                    
                    for (const tool of toolUses) {
                        if (tool.name === 'create_record') {
                            const tableId = tool.input.tableId;
                            let tableName = 'רשומה';
                            if (tableId === 'tblSgYN8CbQcxeT0j') tableName = 'עסקה';
                            else if (tableId === 'tblcTFGg6WyKkO5kq') tableName = 'לקוח';
                            else if (tableId === 'tbl9p6XdUrecy2h7G') tableName = 'פרויקט';
                            
                            actionDescription += `🆕 **יצירת ${tableName} חדשה**\n`;
                            
                            const fields = tool.input.fields;
                            Object.entries(fields).forEach(([key, value]) => {
                                actionDescription += `   📝 ${key}: ${JSON.stringify(value)}\n`;
                            });
                            
                        } else if (tool.name === 'update_record') {
                            actionDescription += `🔄 **עדכון רשומה**\n`;
                            actionDescription += `   🆔 Record ID: ${tool.input.recordId}\n`;
                            
                            const fields = tool.input.fields;
                            Object.entries(fields).forEach(([key, value]) => {
                                actionDescription += `   📝 ${key}: ${JSON.stringify(value)}\n`;
                            });
                        }
                        actionDescription += '\n';
                    }
                    
                    actionDescription += '❓ **האם לבצע את הפעולה? (כן/לא)**';
                    
                    pendingActions.set(sender, {
                        toolUses: toolUses,
                        originalMessage: message,
                        timestamp: Date.now()
                    });
                    
                    return res.json({
                        success: true,
                        response: actionDescription,
                        needsConfirmation: true
                    });
                }

                // הפעלת כלים רגילים
                const toolResults = [];
                for (const toolUse of toolUses) {
                    try {
                        toolsExecuted.push(toolUse.name);
                        log('info', `🛠️ מפעיל כלי: ${toolUse.name}`);

                        const toolResult = await handleToolUse(toolUse);
                        log('success', `כלי הושלם: ${toolUse.name}`);

                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: JSON.stringify(toolResult, null, 2)
                        });

                    } catch (toolError) {
                        log('error', `שגיאה בכלי: ${toolUse.name}`, { error: toolError.message });

                        let errorMessage = toolError.message;
                        if (errorMessage.includes('Unknown field name')) {
                            errorMessage = 'שגיאה: השדה שצוינו לא קיים בטבלה. אנא בדוק שמות שדות עם get_table_fields.';
                        } else if (errorMessage.includes('status code 422')) {
                            errorMessage = 'שגיאה: נתונים לא תקינים או שדה לא קיים. אנא בדוק עם get_table_fields.';
                        } else if (errorMessage.includes('INVALID_MULTIPLE_CHOICE_OPTIONS')) {
                            errorMessage = 'שגיאה: הערך שצוינו לא קיים ברשימת האפשרויות. חובה לבדוק הערכים הזמינים עם get_table_fields לפני עדכון.';
                        }

                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: `שגיאה: ${errorMessage}`
                        });
                    }
                }

                if (toolResults.length > 0) {
                    messages.push({
                        role: 'user',
                        content: toolResults
                    });
                }

            } catch (anthropicError) {
                log('error', 'שגיאה בקריאה ל-Claude', { error: anthropicError.message });
                finalResponse = `❌ אירעה שגיאה בתקשורת עם המערכת: ${anthropicError.message}`;
                break;
            }
        }

        // אם הגענו למגבלה ללא תגובה סופית
        if ((messages.length >= 25 || stepCount >= 10) && !finalResponse) {
            log('warning', 'הגענו למגבלת בטיחות - מכין תגובה סופית');
            finalResponse = toolsExecuted.length > 0 ?
                '✅ הפעולה בוצעה חלקית. אנא בדוק את התוצאות במערכת.' :
                '❌ לא הצלחתי להשלים את הבקשה. אנא נסח מחדש או פרק לשלבים קטנים יותר.';
        }

        if (!finalResponse || finalResponse.trim() === '') {
            finalResponse = toolsExecuted.length > 0 ?
                '✅ הפעולה הושלמה.' :
                '❌ לא הבנתי את הבקשה. אנא נסח מחדש.';
        }

        addToConversationHistory(sender, 'assistant', finalResponse);

        log('success', `📤 תגובה סופית נשלחה. כלים שהופעלו: ${toolsExecuted.join(', ')}`);

        res.json({
            success: true,
            response: finalResponse,
            toolsExecuted: toolsExecuted,
            steps: stepCount
        });

    } catch (error) {
        log('error', 'שגיאה כללית', { error: error.message });
        res.json({
            success: false,
            error: error.message
        });
    }
});

// ניקוי זיכרון
app.post('/clear-memory', (req, res) => {
    const requestData = req.body;
    const sender = requestData.sender || 'default';
    conversationMemory.delete(sender);
    pendingActions.delete(sender);
    log('info', `🧹 זיכרון נוקה עבור: ${sender}`);
    res.json({
        success: true,
        message: `Memory cleared for ${sender}`
    });
});

// מידע על זיכרון
app.get('/memory/:sender?', (req, res) => {
    const sender = req.params.sender || 'default';
    const history = getConversationHistory(sender);
    const hasPending = pendingActions.has(sender);
    res.json({
        sender: sender,
        historyLength: history.length,
        history: history,
        hasPendingAction: hasPending
    });
});

// בדיקת חיבור
app.get('/test-airtable', async (req, res) => {
    try {
        log('info', '🧪 בודק חיבור לAirtable...');
        const testResult = await getAllRecords('appL1FfUaRbmPNI01', 'tbl9p6XdUrecy2h7G', 1);
        res.json({
            success: true,
            message: '✅ חיבור תקין!',
            sampleRecord: testResult[0] || null
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// הפעלת השרת
app.listen(3000, '0.0.0.0', () => {
    log('success', '🚀 Server running on 0.0.0.0:3000');
    log('info', '📝 Functions: search, get records, create, update, get fields');
    log('info', '🧪 Test endpoint: GET /test-airtable');
    log('info', '🧠 Memory endpoints: POST /clear-memory, GET /memory');
    log('info', '🔔 Enhanced confirmation system with TTL');
    log('info', '⚡ VERSION 2025: Enhanced with improved system prompt and validation');
});
