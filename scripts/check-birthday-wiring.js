/**
 * Self-check for BirthdayService boot wiring.
 *
 * BirthdayService.start() silently no-ops forever (logs "no WhatsApp socket
 * yet" on every scheduled tick, day after day, and never posts) when it is
 * not given a `getSock` — and every other scheduled feature in bot-new.js
 * passes one. check-birthday.js exercises the service directly with a fake
 * getSock injected, so it cannot catch bot-new.js forgetting to pass one at
 * the real call site. This reads the actual source text and asserts the call
 * is wired the same way as its siblings.
 *
 * Run: node scripts/check-birthday-wiring.js
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '../bot-new.js'), 'utf8');

const startCallMatch = /this\.birthdayService\.start\(([^)]*)\)/.exec(src);
assert.ok(startCallMatch, 'bot-new.js must call this.birthdayService.start(...)');

const args = startCallMatch[1];
assert.ok(
    /getSock\s*:/.test(args),
    'birthdayService.start() must be called with a getSock option, ' +
        `same as every other scheduler in bot-new.js — got: start(${args})`
);

console.log('✅ birthdayService.start() is wired with getSock, matching every other scheduler');
