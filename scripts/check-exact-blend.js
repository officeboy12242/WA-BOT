import { buildResumeTailorSystemPrompt, buildTailorUserBlock } from '../src/prompts/resumeTailorPrompt.js';

const exact = buildResumeTailorSystemPrompt('exact');
const related = buildResumeTailorSystemPrompt('related');
const relatedUser = buildTailorUserBlock('BASE', 'Need FastAPI ETL Azure Docker REST APIs', 'related');

if (!/75%/.test(exact) || !/25%/.test(exact)) {
    console.error('exact blend missing');
    process.exit(1);
}
if (/75%/.test(related)) {
    console.error('related should not force 75');
    process.exit(1);
}
if (!/ATS/.test(related) || !/keyword/i.test(related) || !/HR/i.test(related)) {
    console.error('related ATS/HR guidance missing');
    process.exit(1);
}
if (!/ATS keyword/i.test(relatedUser)) {
    console.error('related user block weak');
    process.exit(1);
}
console.log('exact 75/25 + related ATS/HR prompt ok');
