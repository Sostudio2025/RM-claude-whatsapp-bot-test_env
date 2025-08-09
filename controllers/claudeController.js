const { anthropic, handleToolUse } = require('../services/toolRunner');
const tools = require('../tools/airtableTools');
const systemPrompt = require('../prompts/systemPrompt');
const { log } = require('../utils/logger');
const {
  getConversationHistory,
  addToConversationHistory,
  pendingActions
} = require('../utils/memory');
const { SAFETY_MAX_STEPS, SAFETY_MAX_MESSAGES } = require('../config/constants');

async function postClaudeQuery(req, res) {
  try {
    const messageData = req.body;
    const message = messageData.message;
    const sender = messageData.sender || 'default';

    log('info', `📨 הודעה מ-${sender}: ${message}`);

    // pending approval flow
    if (pendingActions.has(sender)) {
      const pendingAction = pendingActions.get(sender);
      const lower = (message || '').toLowerCase();

      if (lower.includes('כן') || lower.includes('אישור') || lower.includes('אוקיי') || lower.includes('בצע')) {
        log('info', `✅ מבצע פעולה מאושרת עבור: ${sender}`);
        pendingActions.delete(sender);

        try {
          for (const toolUse of pendingAction.toolUses) {
            await handleToolUse(toolUse);
            log('success', `כלי מאושר הושלם: ${toolUse.name}`);
          }
          return res.json({ success: true, response: '✅ הפעולה בוצעה בהצלחה!', actionCompleted: true });
        } catch (error) {
          return res.json({ success: false, response: `❌ אירעה שגיאה בביצוע הפעולה: ${error.message}` });
        }
      } else if (lower.includes('לא') || lower.includes('ביטול')) {
        pendingActions.delete(sender);
        return res.json({ success: true, response: '❌ הפעולה בוטלה לפי בקשתך', actionCancelled: true });
      } else {
        const newRequestKeywords = ['עדכן', 'שנה', 'תמצא', 'חפש', 'צור', 'הוסף', 'מחק', 'הצג', 'השלים', 'העביר'];
        if (!newRequestKeywords.some(k => message.includes(k))) {
          return res.json({
            success: true,
            response: 'לא הבנתי את התגובה. אנא כתוב "כן" לאישור או "לא" לביטול.',
            needsClarification: true
          });
        }
        // falls through to treat as a new request
        pendingActions.delete(sender);
      }
    }

    const conversationHistory = getConversationHistory(sender);
    addToConversationHistory(sender, 'user', message);

    const messages = conversationHistory.map(m => ({ role: m.role, content: m.content }));
    log('info', `🧠 שולח ל-Claude עם ${messages.length} הודעות`);

    let toolsExecuted = [];
    let finalResponse = '';
    let conversationFinished = false;
    let stepCount = 0;

    while (!conversationFinished && messages.length < SAFETY_MAX_MESSAGES && stepCount < SAFETY_MAX_STEPS) {
      stepCount++;
      log('info', `🔄 שלב ${stepCount}`);

      try {
        const response = await anthropic.messages.create({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 4000,
          system: systemPrompt,
          messages,
          tools
        });

        log('info', `📝 תגובת Claude (שלב ${stepCount})`);

        const toolUses = response.content.filter(c => c.type === 'tool_use');

        if (toolUses.length === 0) {
          const text = response.content.find(c => c.type === 'text');
          if (text) finalResponse = text.text;
          conversationFinished = true;
          log('success', 'שיחה הסתיימה - אין כלים נוספים');
          break;
        }

        log('info', `🛠️ כלים להפעיל: ${toolUses.length}`);
        messages.push({ role: 'assistant', content: response.content });

        const needsConfirmation = toolUses.some(t => t.name === 'create_record' || t.name === 'update_record');

        if (needsConfirmation) {
          let actionDescription = '🔔 **בקשת אישור לביצוע פעולה:**\n\n';
          for (const tool of toolUses) {
            if (tool.name === 'create_record') {
              const tableId = tool.input.tableId;
              let tableName = 'רשומה';
              const map = require('../config/constants').TABLES;
              if (tableId === map.TRANSACTIONS) tableName = 'עסקה';
              else if (tableId === map.CUSTOMERS) tableName = 'לקוח';
              else if (tableId === map.PROJECTS) tableName = 'פרויקט';

              actionDescription += `🆕 **יצירת ${tableName} חדשה**\n`;
              for (const [k, v] of Object.entries(tool.input.fields || {})) {
                actionDescription += `   📝 ${k}: ${JSON.stringify(v)}\n`;
              }
            } else if (tool.name === 'update_record') {
              actionDescription += `🔄 **עדכון רשומה**\n`;
              actionDescription += `   🆔 Record ID: ${tool.input.recordId}\n`;
              for (const [k, v] of Object.entries(tool.input.fields || {})) {
                actionDescription += `   📝 ${k}: ${JSON.stringify(v)}\n`;
              }
            }
            actionDescription += '\n';
          }
          actionDescription += '❓ **האם לבצע את הפעולה? (כן/לא)**';

          pendingActions.set(sender, {
            toolUses,
            originalMessage: message,
            timestamp: Date.now()
          });

          return res.json({ success: true, response: actionDescription, needsConfirmation: true });
        }

        // execute tools immediately
        const toolResults = [];
        for (const toolUse of toolUses) {
          try {
            toolsExecuted.push(toolUse.name);
            const result = await handleToolUse(toolUse);
            toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result, null, 2) });
          } catch (toolError) {
            let errorMessage = toolError.message;
            if (errorMessage.includes('Unknown field name')) {
              errorMessage = 'שגיאה: השדה שצוינו לא קיים בטבלה. אנא בדוק שמות שדות עם get_table_fields.';
            } else if (errorMessage.includes('status code 422')) {
              errorMessage = 'שגיאה: נתונים לא תקינים או שדה לא קיים. אנא בדוק עם get_table_fields.';
            } else if (errorMessage.includes('INVALID_MULTIPLE_CHOICE_OPTIONS')) {
              errorMessage = 'שגיאה: הערך שצוינו לא קיים ברשימת האפשרויות. חובה לבדוק הערכים הזמינים עם get_table_fields לפני עדכון.';
            }
            toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `שגיאה: ${errorMessage}` });
          }
        }

        if (toolResults.length > 0) {
          messages.push({ role: 'user', content: toolResults });
        }
      } catch (anthropicError) {
        log('error', 'שגיאה בקריאה ל-Claude', { error: anthropicError.message });
        finalResponse = `❌ אירעה שגיאה בתקשורת עם המערכת: ${anthropicError.message}`;
        break;
      }
    }

    if ((!finalResponse || !finalResponse.trim()) && (messages.length >= SAFETY_MAX_MESSAGES || stepCount >= SAFETY_MAX_STEPS)) {
      finalResponse = toolsExecuted.length > 0
        ? '✅ הפעולה בוצעה חלקית. אנא בדוק את התוצאות במערכת.'
        : '❌ לא הצלחתי להשלים את הבקשה. אנא נסח מחדש או פרק לשלבים קטנים יותר.';
    }

    if (!finalResponse || finalResponse.trim() === '') {
      finalResponse = toolsExecuted.length > 0 ? '✅ הפעולה הושלמה.' : '❌ לא הבנתי את הבקשה. אנא נסח מחדש.';
    }

    addToConversationHistory(sender, 'assistant', finalResponse);
    log('success', `📤 תגובה סופית נשלחה. כלים שהופעלו: ${toolsExecuted.join(', ')}`);

    res.json({ success: true, response: finalResponse, toolsExecuted, steps: stepCount });
  } catch (error) {
    log('error', 'שגיאה כללית', { error: error.message });
    res.json({ success: false, error: error.message });
  }
}

module.exports = { postClaudeQuery };
