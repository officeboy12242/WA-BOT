/**
 * Self-check: public base URL resolution for movie /d/ short links.
 * No PUBLIC_URL env required — Koyeb/Render inject their own domain vars.
 */
import assert from 'node:assert/strict';
import {
    resolvePublicBaseUrl,
    resolveMovieLinkPublicBase,
    learnPublicBaseFromRequest,
    _resetLearnedPublicBaseForTests,
    _setRenderMovieLinkBaseForTests,
} from '../src/utils/publicBaseUrl.js';

_resetLearnedPublicBaseForTests();

assert.equal(
    resolvePublicBaseUrl({ PUBLIC_URL: 'https://bot.example/', RENDER_EXTERNAL_URL: '', KOYEB_PUBLIC_DOMAIN: '' }),
    'https://bot.example',
    'optional PUBLIC_URL still wins'
);
assert.equal(
    resolvePublicBaseUrl({ PUBLIC_URL: '', RENDER_EXTERNAL_URL: 'https://app.onrender.com/', KOYEB_PUBLIC_DOMAIN: '' }),
    'https://app.onrender.com',
    'Render injects RENDER_EXTERNAL_URL'
);
assert.equal(
    resolvePublicBaseUrl({
        PUBLIC_URL: '',
        RENDER_EXTERNAL_URL: '',
        KOYEB_PUBLIC_DOMAIN: 'my-app-org-hash.koyeb.app',
    }),
    'https://my-app-org-hash.koyeb.app',
    'Koyeb injects KOYEB_PUBLIC_DOMAIN — no PUBLIC_URL needed'
);
assert.equal(
    resolvePublicBaseUrl({
        PUBLIC_URL: '',
        RENDER_EXTERNAL_URL: '',
        KOYEB_PUBLIC_DOMAIN: 'https://my-app-org-hash.koyeb.app/',
    }),
    'https://my-app-org-hash.koyeb.app',
    'tolerates scheme on KOYEB_PUBLIC_DOMAIN'
);
assert.equal(
    resolvePublicBaseUrl({ PUBLIC_URL: '', RENDER_EXTERNAL_URL: '', KOYEB_PUBLIC_DOMAIN: '' }),
    '',
    'empty when nothing injected yet'
);

_resetLearnedPublicBaseForTests();
_setRenderMovieLinkBaseForTests('https://whatsappcoursebot.onrender.com');
assert.equal(
    resolveMovieLinkPublicBase({
        PUBLIC_URL: '',
        RENDER_EXTERNAL_URL: '',
        KOYEB_PUBLIC_DOMAIN: 'my-app-org-hash.koyeb.app',
    }),
    'https://whatsappcoursebot.onrender.com',
    'Koyeb movie links use cached Render base'
);
assert.equal(
    resolveMovieLinkPublicBase({
        MOVIE_LINK_PUBLIC_URL: 'https://links.example.com',
        KOYEB_PUBLIC_DOMAIN: 'my-app-org-hash.koyeb.app',
    }),
    'https://links.example.com',
    'MOVIE_LINK_PUBLIC_URL override wins'
);

_resetLearnedPublicBaseForTests();
learnPublicBaseFromRequest({
    headers: {
        host: 'localhost:8000',
        'x-forwarded-host': 'live-app-xxx.koyeb.app',
        'x-forwarded-proto': 'https',
    },
});
assert.equal(
    resolvePublicBaseUrl({ PUBLIC_URL: '', RENDER_EXTERNAL_URL: '', KOYEB_PUBLIC_DOMAIN: '' }),
    'https://live-app-xxx.koyeb.app',
    'learns public host from inbound proxy headers'
);

_resetLearnedPublicBaseForTests();
learnPublicBaseFromRequest({ headers: { host: 'localhost:8000' } });
assert.equal(
    resolvePublicBaseUrl({ PUBLIC_URL: '', RENDER_EXTERNAL_URL: '', KOYEB_PUBLIC_DOMAIN: '' }),
    '',
    'ignores localhost Host — never mint TinyURLs against it'
);

console.log('check-public-url: ok');
