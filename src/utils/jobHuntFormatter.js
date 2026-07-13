/**
 * WhatsApp message formatting for job hunt digests & drafts.
 */

export function formatJobHuntDigest(topJobs, { scanDate, softNote = '' } = {}) {
    const dateLabel = scanDate
        ? new Date(`${scanDate}T12:00:00+05:30`).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
          })
        : new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

    if (!topJobs?.length) {
        return (
            `╔════════════════════════════╗\n` +
            `║  💼 *JOB HUNT* — ${dateLabel}\n` +
            `╚════════════════════════════╝\n\n` +
            `📭 No new matches ≥ min score today.\n` +
            `_Try \`/jobhunt scan\` later or lower filters._`
        );
    }

    let msg = `╔════════════════════════════╗\n`;
    msg += `║  💼 *JOB HUNT* — ${dateLabel}\n`;
    msg += `╚════════════════════════════╝\n\n`;
    msg += `🎯 *${topJobs.length} match(es)* found\n`;
    if (softNote) msg += `${softNote}\n`;
    msg += `─────────────────────────────\n\n`;

    topJobs.forEach((job, i) => {
        const title = job.extracted_title || job.title || 'Role';
        msg += `*#${i + 1} | ${job.company}* | ${title}\n`;
        msg += `📍 ${job.location_remote || job.location || '—'}\n`;
        if (job.stack) msg += `🔧 ${job.stack}\n`;
        if (job.reason) msg += `✅ ${job.reason}\n`;
        msg += `⭐ *Score:* ${job.score}/100\n`;
        msg += `🔗 ${job.url}\n\n`;
    });

    msg += `─────────────────────────────\n`;
    msg += `✏️ Draft: \`/jobhunt draft 1\`\n`;
    msg += `📋 List: \`/jobhunt top\` · 🔄 \`/jobhunt scan\``;
    return msg;
}

export function formatJobHuntLimitAlert(warnings = [], errors = []) {
    let msg = `⚠️ *Job Hunt — API limits / errors*\n\n`;
    if (warnings.length) {
        msg += `*Limits:*\n`;
        warnings.slice(0, 8).forEach((w) => {
            msg += `• ${w}\n`;
        });
        msg += `\n`;
    }
    if (errors.length) {
        msg += `*Errors:*\n`;
        errors.slice(0, 8).forEach((e) => {
            msg += `• ${e}\n`;
        });
    }
    msg += `\n_Fallback: Gemini → Groq → NVIDIA when OpenRouter fails. TinyFish limits stop discovery early._`;
    return msg;
}

export function formatJobHuntDraft(job, { cover, resumeBullets, provider } = {}) {
    const title = job.extracted_title || job.title || 'Role';
    let msg = `╔════════════════════════════╗\n`;
    msg += `║  📝 *APPLICATION DRAFT*\n`;
    msg += `╚════════════════════════════╝\n\n`;
    msg += `*${job.company}* — ${title}\n`;
    msg += `⭐ ${job.score != null ? `${job.score}/100` : '—'} · 🔗 ${job.url}\n`;
    if (provider) msg += `_Drafted via ${provider}_\n`;
    msg += `─────────────────────────────\n\n`;
    msg += `*Cover letter*\n${cover || '—'}\n\n`;
    msg += `─────────────────────────────\n`;
    msg += `*Resume focus (tailored bullets)*\n${resumeBullets || '—'}\n\n`;
    msg += `_Review & submit yourself — bot never auto-applies._`;
    return msg;
}

export function formatJobHuntStatus({
    enabledDm,
    groupCount,
    companyCount,
    sourceLabel,
    mode,
    minScore,
    topN,
    busy,
    lastRun,
} = {}) {
    let msg = `╔════════════════════════════╗\n`;
    msg += `║  💼 *JOB HUNT STATUS*\n`;
    msg += `╚════════════════════════════╝\n\n`;
    msg += `📩 *Owner DM alerts:* ${enabledDm ? '✅ ON' : '❌ OFF'}\n`;
    msg += `👥 *Groups enabled:* ${groupCount ?? 0}\n`;
    msg += `🇮🇳 *Mode:* ${mode || 'india'}\n`;
    msg += `🔎 *Sources:* ${sourceLabel || `companies (${companyCount ?? 0})`}\n`;
    msg += `🎯 *min_score / top_n:* ${minScore}/${topN}\n`;
    msg += `⚙️ *Scan:* ${busy ? '🟡 running…' : '🟢 idle'}\n`;
    if (lastRun) {
        msg += `🕒 *Last run:* ${lastRun.status} · ${lastRun.jobs_found ?? 0} jobs\n`;
    }
    msg += `\n*Commands*\n`;
    msg += `• \`/jobhunt on|off\` — group alerts\n`;
    msg += `• \`/jobhunt dm on|off\` — owner DM alerts\n`;
    msg += `• \`/jobhunt scan\` — run now (owner)\n`;
    msg += `• \`/jobhunt top\` — latest matches\n`;
    msg += `• \`/jobhunt draft N\` — cover + resume tips\n`;
    msg += `• \`/jobhunt resume\` — set resume text (owner)`;
    return msg;
}
