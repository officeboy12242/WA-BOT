/**
 * Tracks GitHub trending repos posted per chat/group to avoid repeats.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

function hashRepo(fullName) {
    return crypto.createHash('md5').update(fullName.trim().toLowerCase()).digest('hex');
}

class GitHubTrendingDatabase {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.posted = null;
    }

    async init() {
        this.posted = this.mongoDb.collection('posted_github_repos');
        await Promise.all([
            this.posted.createIndex(
                { hash: 1, group_id: 1 },
                { unique: true, name: 'posted_github_repo_per_group' }
            ),
            this.posted.createIndex({ posted_at: 1 }, { name: 'posted_github_repo_posted_at' }),
        ]);
        logger.info('Mongo GitHub trending store ready');
    }

    async isRepoPosted(fullName, groupId) {
        const row = await this.posted.findOne(
            { hash: hashRepo(fullName), group_id: groupId },
            { projection: { _id: 1 } }
        );
        return Boolean(row);
    }

    async markRepoPosted(fullName, groupId) {
        if (!fullName || !groupId) {
            return;
        }
        await this.posted.updateOne(
            { hash: hashRepo(fullName), group_id: groupId },
            {
                $setOnInsert: {
                    hash: hashRepo(fullName),
                    group_id: groupId,
                    full_name: fullName.slice(0, 200),
                    posted_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    async filterUnpostedRepos(repos, groupId) {
        if (!repos?.length || !groupId) {
            return repos || [];
        }
        const unposted = [];
        for (const repo of repos) {
            if (!(await this.isRepoPosted(repo.fullName, groupId))) {
                unposted.push(repo);
            }
        }
        return unposted;
    }

    /** Repos not yet posted to any of the given groups (fresh for everyone). */
    async filterFreshForGroups(repos, groupIds) {
        if (!repos?.length || !groupIds?.length) {
            return repos || [];
        }
        const fresh = [];
        for (const repo of repos) {
            let postedAnywhere = false;
            for (const groupId of groupIds) {
                if (await this.isRepoPosted(repo.fullName, groupId)) {
                    postedAnywhere = true;
                    break;
                }
            }
            if (!postedAnywhere) {
                fresh.push(repo);
            }
        }
        return fresh;
    }

    async pickFreshRepo(repos, groupIds) {
        const fresh = await this.filterFreshForGroups(repos, groupIds);
        return fresh[0] || null;
    }

    async cleanupOldPosted(days = 7) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const result = await this.posted.deleteMany({ posted_at: { $lt: cutoff } });
        return result.deletedCount || 0;
    }

    close() {
        this.posted = null;
    }
}

export default GitHubTrendingDatabase;
