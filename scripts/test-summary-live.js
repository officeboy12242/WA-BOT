/**
 * Live summary test — generates a real summary using DeepSeek V4 Pro Free
 * Usage: node scripts/test-summary-live.js [groupId]
 * 
 * Requires: MONGODB_URI in .env
 */
import { config } from '../src/config/config.js';
import { MongoClient } from 'mongodb';
import GroupChatLogService from '../src/services/GroupChatLogService.js';
import GroupSummaryController from '../src/controllers/GroupSummaryController.js';
import { RECAP_STYLES, pickRecapStyle } from '../src/prompts/recapStyles.js';
import { formatDateLabelIST, getRecapDateStrIST } from '../src/utils/dateIST.js';
import OpenRouterLlmService from '../src/services/OpenRouterLlmService.js';

async function main() {
    const groupId = process.argv[2];
    
    console.log('🔗 Connecting to MongoDB...');
    const client = new MongoClient(config.MONGODB_URI);
    await client.connect();
    const db = client.db();
    console.log('✅ Connected\n');

    // Get messages from last 24 hours or a specific group
    const chatLog = new GroupChatLogService(db, null, config);
    const openrouter = new OpenRouterLlmService(config);
    
    console.log('📊 Fetching messages...');
    let messages;
    if (groupId) {
        messages = await chatLog.getMessages(groupId, { hours: 24 });
        console.log(`✅ Found ${messages.length} messages for group ${groupId}\n`);
    } else {
        // Get any group with recent messages
        const collection = db.collection('group_chat_log');
        const recent = await collection.find().sort({ ts: -1 }).limit(1).toArray();
        if (!recent.length) {
            console.log('❌ No messages found in database');
            await client.close();
            return;
        }
        const recentGroupId = recent[0].group_id;
        messages = await chatLog.getMessages(recentGroupId, { hours: 24 });
        console.log(`✅ Found ${messages.length} messages for group ${recentGroupId}\n`);
        groupId = recentGroupId;
    }

    if (!messages.length) {
        console.log('❌ No messages found. Try running during/after peak hours.');
        await client.close();
        return;
    }

    // Pick a style
    const dateStr = getRecapDateStrIST(Date.now(), 0, 0);
    const dateLabel = formatDateLabelIST(dateStr);
    const style = pickRecapStyle(groupId, dateStr, config.GROUP_SUMMARY_STYLE);
    
    console.log(`🎨 Style: ${style.key}`);
    console.log(`📅 Date: ${dateLabel}\n`);

    // Build prompt with new limits
    const basePrompt = chatLog.buildPrompt(messages, 'Test Group', dateLabel);
    const prompt = `${basePrompt}\n\n${style.persona}`;
    
    console.log(`📝 Prompt length: ${prompt.length} chars`);
    console.log(`📨 Messages sent: ${messages.length}\n`);

    console.log('🤖 Generating summary with DeepSeek V4 Pro Free...\n');
    
    try {
        const summary = await openrouter.chat({
            system: config.SUMMARY_SYSTEM_PROMPT || 'You are a group roastmaster.',
            user: prompt,
            maxTokens: 4000,
            timeoutMs: 120000,
        });

        console.log('=' .repeat(60));
        console.log('📝 RAW AI OUTPUT:');
        console.log('=' .repeat(60));
        console.log(summary);
        console.log('\n' + '=' .repeat(60));
        
        // Try to parse as JSON
        let parsed;
        try {
            parsed = JSON.parse(summary.replace(/```json\n?/g, '').replace(/```\n?/g, ''));
            console.log('\n✅ PARSED JSON:');
            console.log(JSON.stringify(parsed, null, 2));
        } catch (e) {
            console.log('\n⚠️  Could not parse as JSON (raw output above)');
        }

    } catch (err) {
        console.error('❌ Error:', err.message);
    }

    await client.close();
    console.log('\n✅ Done');
}

main().catch(console.error);
