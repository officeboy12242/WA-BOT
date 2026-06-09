/**
 * News Controller
 * Scrapes Inshorts tech news and posts to activated groups
 */

import { logger } from '../utils/logger.js';
import { formatNewsPost } from '../utils/newsFormatter.js';

class NewsController {
    constructor(newsDatabase, scraper, config, groupManager) {
        this.newsDatabase = newsDatabase;
        this.scraper = scraper;
        this.config = config;
        this.groupManager = groupManager;
    }

    async postNewsToGroup(sock, text, groupId, articleTitles) {
        try {
            await sock.sendMessage(groupId, { text });
            await this.newsDatabase.markNewsPosted(articleTitles, groupId);
            return true;
        } catch (error) {
            logger.error(`Error posting news to ${groupId}: ${error.message}`);
            return false;
        }
    }

    async postNews(sock, articles) {
        if (!sock) {
            logger.error('WhatsApp socket not available for news');
            return;
        }

        if (!articles.length) {
            return;
        }

        const activeGroups = await this.groupManager.getActiveGroups();
        if (!activeGroups.length) {
            logger.warn('No active groups for tech news. Use /activate in a group.');
            return;
        }

        logger.info(`Posting tech news (${articles.length} articles) to ${activeGroups.length} group(s)...`);

        let successCount = 0;
        for (const group of activeGroups) {
            const unposted = [];
            for (const article of articles) {
                if (!(await this.newsDatabase.isNewsPosted(article.title, group.group_id))) {
                    unposted.push(article);
                }
            }

            if (!unposted.length) {
                logger.info(`News already posted to ${group.group_name}`);
                continue;
            }

            const groupText = formatNewsPost(unposted);
            if (!groupText) {
                continue;
            }
            const groupTitles = unposted.map((a) => a.title);
            const ok = await this.postNewsToGroup(sock, groupText, group.group_id, groupTitles);
            if (ok) {
                successCount++;
            }
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }

        if (successCount > 0) {
            logger.info(`Tech news posted to ${successCount} group(s)`);
        }
    }

    async checkAndPostNews(sock, botState) {
        if (!sock) {
            logger.info('Waiting for WhatsApp connection (news)...');
            return;
        }

        if (botState.isPaused) {
            logger.info('Bot is paused. Skipping news check.');
            return;
        }

        logger.info('─── Checking for tech news (Inshorts) ───');
        botState.lastNewsCheckTime = Date.now();

        try {
            await this.scraper.scrapeAndQueue();
            const articles = await this.scraper.getFreshArticlesForPosting(
                this.config.NEWS_MIN_ARTICLES
            );

            if (articles.length) {
                logger.info(`${articles.length} tech article(s) to post.`);
                await this.postNews(sock, articles);
                await this.newsDatabase.clearQueue();
            } else {
                logger.info('No new tech news.');
            }

            const removed = await this.newsDatabase.cleanupOldNews(7);
            if (removed > 0) {
                logger.info(`Cleaned ${removed} old posted_news record(s)`);
            }
        } catch (error) {
            logger.error(`Error in news check: ${error.message}`);
        }

    }

    async scrapeAndQueueOnly() {
        try {
            const count = await this.scraper.scrapeAndQueue();
            if (count > 0) {
                logger.info(`News queue updated (+${count} article(s))`);
            }
            await this.newsDatabase.cleanupOldNews(7);
        } catch (error) {
            logger.error(`News scrape/queue failed: ${error.message}`);
        }
    }

    async previewNews(sock, chatId) {
        const articles = await this.scraper.getFreshArticlesForPosting(
            this.config.NEWS_MIN_ARTICLES
        );
        if (!articles.length) {
            await sock.sendMessage(chatId, {
                text: '📭 No fresh tech news right now. Try again later.',
            });
            return;
        }

        const text = formatNewsPost(articles);
        if (text) {
            await sock.sendMessage(chatId, { text });
        }
    }
}

export default NewsController;
