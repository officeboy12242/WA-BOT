/**
 * Daily GitHub trending repository posts — one repo per message with link preview.
 */

import { logger } from '../utils/logger.js';
import { formatGitHubRepoMessage } from '../utils/githubFormatter.js';
import { sendTextWithLinkPreview } from '../utils/linkPreview.js';
import GitHubTrendingService from '../services/GitHubTrendingService.js';

const GROUP_DELAY_MS = 500;
const REPO_DELAY_MS = 2000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayKey(timezone) {
    return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

class GitHubTrendingController {
    constructor(config, groupManager) {
        this.config = config;
        this.groupManager = groupManager;
        this.service = new GitHubTrendingService(config.GITHUB_TRENDING_COUNT);
    }

    async fetchTrendingRepos() {
        return this.service.fetchTrending();
    }

    async ensureDailyCache(botState) {
        const key = todayKey(this.config.GITHUB_TRENDING_TIMEZONE);
        if (botState.githubTrendingCache?.date === key && botState.githubTrendingCache.repos?.length) {
            return botState.githubTrendingCache.repos;
        }

        const repos = await this.fetchTrendingRepos();
        botState.githubTrendingCache = { date: key, repos };
        return repos;
    }

    async sendRepoMessage(sock, chatId, repo, index, total) {
        const text = formatGitHubRepoMessage(repo, index, total);
        await sendTextWithLinkPreview(sock, chatId, text, repo.url);
    }

    async postSingleRepoToGroups(sock, repo, index, total) {
        if (!sock || !repo) {
            return { posted: 0, groups: 0 };
        }

        const targetGroups = await this.groupManager.getGithubTrendingGroups();
        if (!targetGroups.length) {
            logger.warn('No groups with GitHub trending enabled. Use /activate and /githubon.');
            return { posted: 0, groups: 0 };
        }

        logger.info(`Posting GitHub repo #${index}/${total} (${repo.fullName}) to ${targetGroups.length} group(s)...`);

        let posted = 0;
        for (const group of targetGroups) {
            try {
                await this.sendRepoMessage(sock, group.group_id, repo, index, total);
                posted++;
                logger.info(`🐙 #${index} posted to ${group.group_name || group.group_id}`);
                await delay(GROUP_DELAY_MS);
            } catch (err) {
                logger.error(`GitHub repo #${index} failed for ${group.group_id}: ${err.message}`);
            }
        }

        return { posted, groups: targetGroups.length };
    }

    async postAllReposIndividually(sock, repos) {
        if (!sock || !repos?.length) {
            return { posted: 0, groups: 0, messages: 0 };
        }

        const total = repos.length;
        let totalPosted = 0;
        let groups = 0;

        for (let i = 0; i < repos.length; i++) {
            const { posted, groups: g } = await this.postSingleRepoToGroups(sock, repos[i], i + 1, total);
            totalPosted += posted;
            groups = g;
            if (i < repos.length - 1) {
                await delay(REPO_DELAY_MS);
            }
        }

        return { posted: totalPosted > 0 ? groups : 0, groups, messages: totalPosted };
    }

    /** Post one repo at a scheduled slot (0-based index). */
    async checkAndPostRepo(sock, botState, slotIndex) {
        if (!this.config.GITHUB_TRENDING_ENABLED) {
            return;
        }

        if (!sock) {
            logger.info('Waiting for WhatsApp connection (GitHub trending)...');
            return;
        }

        try {
            const repos = await this.ensureDailyCache(botState);
            const repo = repos[slotIndex];
            if (!repo) {
                logger.info(`No GitHub trending repo for slot ${slotIndex + 1}`);
                return;
            }

            const total = Math.min(repos.length, this.config.GITHUB_TRENDING_COUNT);
            const { posted, groups } = await this.postSingleRepoToGroups(sock, repo, slotIndex + 1, total);
            if (posted > 0) {
                logger.info(`🐙 GitHub trending #${slotIndex + 1} posted to ${posted}/${groups} group(s)`);
            }
        } catch (err) {
            logger.error(`GitHub trending slot ${slotIndex + 1} failed: ${err.message}`);
        }
    }

    async previewAll(sock, chatId, repos) {
        if (!repos?.length) {
            await sock.sendMessage(chatId, {
                text: '📭 No GitHub trending repos found right now. Try again later.',
            });
            return false;
        }

        const total = repos.length;
        for (let i = 0; i < repos.length; i++) {
            await this.sendRepoMessage(sock, chatId, repos[i], i + 1, total);
            if (i < repos.length - 1) {
                await delay(REPO_DELAY_MS);
            }
        }
        return true;
    }
}

export default GitHubTrendingController;
