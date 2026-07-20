import { formatAwesomeListMessage } from '../src/utils/awesomeFormatter.js';
import AwesomeListsService from '../src/services/AwesomeListsService.js';

const sample = {
    fullName: 'sindresorhus/awesome',
    description: 'Awesome lists about all kinds of interesting topics',
    language: '—',
    totalStars: '300000',
    url: 'https://github.com/sindresorhus/awesome',
};

const msg = formatAwesomeListMessage(sample, 1, 5);
if (!msg.includes('AWESOME LIST') || !msg.includes(sample.url) || !msg.includes(sample.fullName)) {
    console.error('FAIL: format');
    process.exit(1);
}

const service = new AwesomeListsService(5);
const preview = await service.fetchPreviewLists();
if (!preview.length) {
    console.error('FAIL: empty preview');
    process.exit(1);
}
const one = await service.fetchRandomList();
if (!one?.url || !one?.fullName) {
    console.error('FAIL: random list');
    process.exit(1);
}

console.log('preview', preview.length, 'sample', preview[0].fullName);
console.log('random', one.fullName);
console.log('awesome check ok');
