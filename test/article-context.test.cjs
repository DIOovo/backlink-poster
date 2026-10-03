const assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const {extractArticleContext,MAX_ARTICLE_CONTEXT_CHARS}=require('../.tmp-test/batch/article-context.js');
const context=html=>{const {document}=parseHTML(`<html><head></head><body>${html}</body></html>`);return extractArticleContext(document,'https://example.com/post')};
let count=0;const test=(name,fn)=>{fn();count++;console.log('  ✓ '+name)};

test('article is preferred over main and role=main',()=>{const c=context('<title>T</title><main>Main text</main><div role="main">Role text</div><article>Article text</article>');assert.equal(c.articleText,'Article text')});
test('main and role=main are used in fallback order',()=>{assert.equal(context('<main>Main text</main><div role="main">Role text</div>').articleText,'Main text');assert.equal(context('<div role="main">Role text</div>').articleText,'Role text')});
test('title, description, og fallback and h1 are extracted',()=>{let c=context('<title> Title </title><meta name="description" content=" Primary "><meta property="og:description" content="OG"><h1> Heading </h1><article>Body</article>');assert.deepEqual([c.title,c.description,c.h1],['Title','Primary','Heading']);c=context('<meta property="og:description" content="OG only"><article>Body</article>');assert.equal(c.description,'OG only')});
test('scripts, styles, navigation, footer, header and aside are removed',()=>{const c=context('<article><header>Head nav</header><nav>Nav</nav><script>bad()</script><style>.bad{}</style><noscript>No</noscript><aside>Side</aside><p>Keep this content.</p><footer>Footer</footer></article>');assert.equal(c.articleText,'Keep this content.')});
test('cookie, newsletter, menu, sidebar and share toolbar content is removed',()=>{const c=context('<article><div class="cookie-banner">Cookie</div><div class="newsletter-box">News</div><div class="menu">Menu</div><div id="sidebar-right">Side</div><div class="share-toolbar">Share</div><p>Real article.</p></article>');assert.equal(c.articleText,'Real article.')});
test('long text is capped by the exported 10000-character constant',()=>{const c=context(`<article>${'x'.repeat(12000)}</article>`);assert.equal(MAX_ARTICLE_CONTEXT_CHARS,10000);assert.equal(c.articleText.length,10000)});
test('empty document returns a valid empty context',()=>{const c=context('');assert.equal(c.articleText,'');assert.equal(c.title,'');assert.equal(c.description,'');assert.equal(c.h1,'')});
console.log(`${count} article context tests passed`);
