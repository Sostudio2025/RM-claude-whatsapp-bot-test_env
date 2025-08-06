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


        const matchingTransactions = records.filter(record => {
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
const systemPrompt = 'אתה עוזר חכם שמחובר לאיירטיבל.\n\n' +
    '🚨 חוקים קריטיים:\n' +
    '1. כאשר מוצאים רשומה - מיד בצע את הפעולה הנדרשת!\n' +
    '2. אל תחזור ותחפש את אותה רשומה פעמיים!\n' +
    '3. אל תאמר "עכשיו אעדכן" - פשוט עדכן!\n' +
    '4. כל עדכון חייב להיעשות עם הכלי update_record!\n' +
    '5. השתמש במזהה הרשומה (ID) שקיבלת מהחיפוש!\n' +
    '6. אחרי כל פעולה - הודע בבירור מה קרה!\n' +
    '7. אם אתה מקבל שגיאה - נסה גישה אחרת או הסבר למשתמש מה השגיאה!\n\n' +
    
    '🔍 כללי עבודה עם שדות:\n' +
    '- ⚠️ תמיד בדוק את שמות השדות הזמינים לפני יצירה/עדכון עם get_table_fields\n' +
    '- השדות בטבלה משתנים - אל תסתמך על שמות קבועים!\n' +
    '- אם אתה לא בטוח בשם שדה - בדוק קודם עם get_table_fields\n' +
    '- שדות קשורים (Linked Records) צריכים להיות במבנה: ["recordId"]\n' +
    '- אם שדה לא קיים - השתמש בשם הקרוב ביותר או דווח על השגיאה\n' +
    '- שדות תאריך צריכים להיות בפורמט ISO: "YYYY-MM-DD"\n' +
    '- שדות מספר צריכים להיות ללא מרכאות\n' +
    '- שדות בחירה יחידה/מרובה - השתמש רק בערכים המדויקים מהרשימה!\n' +
    '- ⚠️ אסור ליצור ערכים חדשים בשדות בחירה - רק להשתמש בקיימים!\n' +
    '- אם צריך ערך שלא קיים - הודע למשתמש שהערך לא זמין\n\n' +
    
    '⚠️ טיפול בשגיאות:\n' +
    '- שגיאת "Unknown field name" = השדה לא קיים, בדוק שמות שדות\n' +
    '- שגיאת "INVALID_REQUEST_BODY" = נתונים לא תקינים, בדוק פורמט\n' +
    '- שגיאת "NOT_FOUND" = הרשומה לא קיימת, בדוק ID\n' +
    '- שגיאת "ROW_DOES_NOT_EXIST" = מזהה הרשומה לא קיים! בדוק שהחיפוש הקודם הצליח\n' +
    '- שגיאת "INVALID_MULTIPLE_CHOICE_OPTIONS" = ערך לא תקין בשדה בחירה - השתמש רק בערכים מהרשימה!\n' +
    '- שגיאת "Insufficient permissions to create new select option" = ניסית ליצור ערך חדש בשדה בחירה - אסור!\n' +
    '- אם יש שגיאה - נסה שוב עם נתונים מתוקנים\n' +
    '- לעולם אל תמציא ערכים חדשים לשדות בחירה!\n' +
    '- ⚠️ לפני יצירת עסקה - וודא שהלקוח והפרויקט באמת נמצאו!\n\n' +
    
    '📋 תהליך סטנדרטי לפעולות:\n' +
    '1. זיהוי הבקשה - מה המשתמש רוצה?\n' +
    '2. איתור הרשומות הרלוונטיות (search_airtable)\n' +
    '3. ⚠️ וידוא שהחיפוש הצליח ויש תוצאות תקפות!\n' +
    '4. בדיקת שדות זמינים עם get_table_fields - חובה!\n' +
    '5. ביצוע הפעולה (create_record/update_record) רק עם IDs תקפים\n' +
    '6. דיווח על התוצאה למשתמש\n\n' +
    
    
        
    '🎯 תרחיש מיוחד - לקוח השלים הרשמה / העביר דמי רצינות:\n' +
        'כשאומרים לך "לקוח השלים הרשמה" או "העביר דמי רצינות":\n' +
        '1. מצא את הלקוח בטבלת הלקוחות (search_airtable)\n' +
        '2. ⚠️ ודא שנמצא לקוח עם ID תקף!\n' +
        '3. מצא את הפרויקט בטבלת הפרויקטים (search_airtable)\n' +
        '4. ⚠️ ודא שנמצא פרויקט עם ID תקף!\n' +
        '5. בדוק אם יש עסקה קיימת (search_transactions)\n' +
        '6. ⚠️ חובה לבדוק אם עסקה קיימת לפני יצירה:\n' +
        '   - תמיד השתמש בכלי search_transactions לפני כל ניסיון ליצור עסקה!\n' +
        '   - אם התוצאה מכילה "found": 1 או יותר → אסור ליצור עסקה נוספת!\n' +
        '   - במקרה כזה:\n' +
        '     - אמור למשתמש: "✅ כבר קיימת עסקה עבור הלקוח והפרויקט"\n' +
        '     - אל תשתמש בכלי create_record\n' +
        '     - אל תבקש אישור לפעולה\n' +
        '     - סיים את הפעולה במקום\n' +
        '7. ⚠️ עסקה קיימת מוגדרת לפי שני שדות:\n' +
        '   - מזהה לקוח ראשי (ID_Client)\n' +
        '   - מזהה פרויקט (ID_Project)\n' +
        '   אם שניהם תואמים לעסקה קיימת — העסקה כבר קיימת!\n' +
        '   ⚠️ לעולם אל תיצור שתי עסקאות לאותו לקוח ולאותו פרויקט!\n' +
        '8. אם אין עסקה קיימת:\n' +
        '   - בדוק את השדות בטבלת עסקאות עם get_table_fields\n' +
        '   - צור עסקה חדשה עם השדות המתאימים\n' +
        '   - בדוק אם קיים שדה סטטוס בטבלת לקוחות ועדכן אותו\n' +
        '   - הודע: "✅ נוצרה עסקה חדשה! מספר: [ID]. סטטוס הלקוח עודכן."\n\n' +

     
    '🎯 תרחישים נוספים:\n' +
    '📞 יצירת לקוח חדש - תהליך חכם:\n' +
    'כשמבקשים ליצור לקוח חדש:\n' +
    '1. בדוק תחילה מה השדות הזמינים בטבלת לקוחות עם get_table_fields\n' +
    '2. אם יש שם + שדה טלפון/אימייל - צור מיד!\n' +
    '3. אם יש רק שם - בקש את הפרטים החסרים לפי השדות שמצאת\n' +
    '4. בקש פרט אחד בכל פעם - לא רשימה!\n\n' +
    
    'Base ID: appL1FfUaRbmPNI01\n\n' +
    '📋 טבלאות זמינות:\n' +
    '⚠️ שים לב: תמיד בדוק את השדות המדויקים עם get_table_fields לפני כל פעולה!\n\n' +
    '🏢 עסקאות (Transactions) - tblSgYN8CbQcxeT0j\n' +
    '👥 לקוחות (Customers) - tblcTFGg6WyKkO5kq\n' +
    '🏗️ פרויקטים (Projects) - tbl9p6XdUrecy2h7G\n' +
    '📞 לידים (Leads) - tbl3ZCmqfit2L0iQ0\n' +
    '🏢 משרדים (Offices) - tbl7etO9Yn3VH9QpT\n' +
    '🌸 פרחים (Flowers) - tblNJzcMRtyMdH14d\n' +
    '⚠️ בקרה (Control) - tblYxAM0xNp0z9EoN\n' +
    '👨‍💼 מנהלים/עובדים - tbl8JT0j7C35yMcc2\n\n' +
    
    '🛠️ כלים זמינים:\n' +
    '- search_airtable: חיפוש רשומות\n' +
    '- search_transactions: חיפוש עסקות לפי לקוח ופרויקט\n' +
    '- get_all_records: קבלת כל הרשומות\n' +
    '- create_record: יצירת רשומה חדשה\n' +
    '- update_record: עדכון רשומה קיימת\n' +
    '- get_table_fields: קבלת שדות - השתמש בזה תמיד לפני יצירה/עדכון!\n\n' +
    
    '💡 דוגמאות לפורמטים נכונים:\n' +
    '- שדה מקושר: {"שם_השדה": ["recXXXXXXXXXXXXX"]}\n' +
    '- תאריך: {"תאריך": "2024-01-15"}\n' +
    '- מספר: {"מספר": 45}\n' +
    '- טקסט: {"שם": "טקסט"}\n' +
    '- בחירה: {"סטטוס": "ערך מהרשימה"}\n' +
    '- בוליאני: {"שולם": true}\n\n' +
    
    '⚡ דוגמה לתהליך נכון:\n' +
    'בקשה: "דונלד טראמפ העביר דמי רצינות לפארק רעננה"\n' +
    '1. search_airtable עבור דונלד בטבלת לקוחות -> מקבל customer ID\n' +
    '2. search_airtable עבור פארק רעננה בטבלת פרויקטים -> מקבל project ID\n' +
    '3. search_transactions עבור customer ID + project ID\n' +
    '4. אם יש עסקה -> "✅ כבר קיימת עסקה עבור דונלד טראמפ ופארק רעננה"\n' +
    '5. אם אין עסקה -> get_table_fields לטבלת עסקאות\n' +
    '6. create_record בטבלת עסקאות עם השדות שמצאת\n\n' +
    
    '🗒️ טיפול בהערות:\n' +
    '- בדוק תחילה אם קיים שדה הערות בטבלה עם get_table_fields\n' +
    '- אם זו הערה יזומה של הסוכן - חפש שדה "הערות AI" או דומה\n' +
    '- אם זו הערה שביקש המשתמש - חפש שדה "הערות כלליות" או דומה\n' +
    '- בצע את הוספת ההערות בלי לבקש אישור מהמשתמש\n' +
    '- תמיד הוסף תאריך להערה אם אפשר: "[תאריך] - [הערה]"\n\n' +
    
    '💬 כללי תקשורת:\n' +
    '- תמיד הודע למשתמש מה אתה עושה\n' +
    '- אם יש שגיאה - הסבר מה השגיאה ומה אפשר לעשות\n' +
    '- אחרי כל פעולה - סכם מה קרה\n' +
    '- אם משהו לא ברור - שאל שאלות מבהירות\n' +
    '- השתמש באימוג\'ים לבהירות (✅ ❌ 🔍 📝)\n' +
    '- כשמוסיף הערות - הודע איזה סוג הערה נוספה ולאיזה שדה\n\n' +
    '🇮🇱 ענה רק בעברית';
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
