// Local-only end-to-end fixtures. No external comments or AI requests.
import http from 'node:http';
const submissions = [];
const replyActivations = [];
let aiCalls = 0;
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shell = (title, content) => `<!doctype html><html><head><title>${title}</title><meta charset="utf-8"><style>body{max-width:740px;margin:48px auto;font:16px/1.6 system-ui;color:#172234;padding:24px}label{display:block;margin-top:12px}input,textarea{font:inherit;display:block;width:100%;padding:8px;box-sizing:border-box}textarea{height:130px}button,input[type=submit]{width:auto;margin-top:20px;padding:10px 20px}.comment-body{padding:20px;background:#edf5ed}.comment-awaiting-moderation{background:#fff6dd;padding:12px}</style></head><body><h1>${title}</h1><p>Batch Backlink Poster · local verification fixture</p>${content}</body></html>`;
const fields = `<label for="comment">Comment</label><textarea id="comment" name="comment" required></textarea><label for="author">Name</label><input id="author" name="author" required><label for="email">Email</label><input id="email" name="email" type="email" required><label for="url">Website</label><input id="url" name="url" type="url"><input id="submit" name="submit" type="submit" value="Post Comment">`;
const server = http.createServer(async (req, res) => {
 const url = new URL(req.url, 'http://127.0.0.1:8765');
 let raw = ''; for await (const chunk of req) raw += chunk;
 if (url.pathname === '/state') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({submissions,replyActivations,aiCalls})); return; }
 if (url.pathname === '/reply-activated' && req.method === 'POST') { replyActivations.push({at:Date.now()}); res.end('ok'); return; }
 if (url.pathname === '/chat/completions') {
   aiCalls++;
   res.setHeader('Content-Type','application/json');
   const response = {found:true,formType:'comment',confidence:.96,fields:{content:{locator:'css=#entry',required:true}},submit:{locator:'css=#send'}};
   if (raw.includes('fixture-ai-fail')) { res.writeHead(500); res.end(JSON.stringify({error:{message:'Synthetic AI failure'}})); return; }
   res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(response)},finish_reason:'stop'}]})); return;
 }
 if (req.method === 'POST') {
   const data = Object.fromEntries(new URLSearchParams(raw));
   submissions.push({path:url.pathname,...data});
   const id = submissions.length;
   res.writeHead(303, {Location:`/result/${id}?mode=${url.searchParams.get('mode') || ''}#comment-${id}`});res.end();return;
 }
 if (url.pathname.startsWith('/result/')) {
   const id = Number(url.pathname.split('/').pop()), task = submissions[id-1];
   const pending = url.searchParams.get('mode') === 'pending';
   res.end(shell('Submission received', `<article id="comment-${id}" class="comment-body"><p>${escape(task?.comment || task?.entry || '')}</p><p>By ${escape(task?.author || '')}</p>${pending ? '<p class="comment-awaiting-moderation">Your comment is awaiting moderation</p>' : ''}</article>`)); return;
 }
 if (url.pathname === '/noform') { res.end(shell('No comment form', '<form><input type="search" placeholder="Search"><button>Search</button></form><form><input type="email"><button>Subscribe newsletter</button></form><form><input type="password"><textarea placeholder="Message"></textarea><button>Login</button></form>')); return; }
 if (url.pathname === '/ai' || url.pathname === '/ai-fail') { res.end(shell(url.pathname === '/ai-fail' ? 'fixture-ai-fail' : 'A response to this article', '<form action="/post" method="post"><label for="entry">Your perspective</label><textarea name="entry" id="entry" required></textarea><button id="send" type="submit">Send</button></form>')); return; }
 if (url.pathname === '/failed') { res.end(shell('Comment form with no response', `<p class="comment-awaiting-moderation">Your comment is awaiting moderation</p><article class="comment-body" id="comment-old">Existing comment</article><form id="commentform" onsubmit="event.preventDefault()">${fields}</form>`)); return; }
 if (url.pathname === '/challenge') { res.end(shell('Challenge fixture', `<div class="g-recaptcha">CAPTCHA</div><form id="commentform">${fields}</form>`)); return; }
 if (url.pathname === '/controlled') {
   res.end(shell('Controlled comment form', `<form id="commentform" method="post" action="/post">${fields}</form><script>
   for (const el of document.querySelectorAll('textarea,input:not([type=submit])')) {
     let tracked = el.value, state = el.value;
     el._valueTracker = {setValue(value){tracked=value}};
     const proto = Object.getPrototypeOf(el), descriptor = Object.getOwnPropertyDescriptor(proto,'value');
     Object.defineProperty(el,'value',{get(){return descriptor.get.call(this)},set(value){tracked=value;descriptor.set.call(this,value)}});
     el.addEventListener('input',()=>{if(el.value!==tracked){state=el.value;tracked=el.value}setTimeout(()=>descriptor.set.call(el,state),20)});
   }
   </script>`)); return;
 }
 if (url.pathname === '/reply-local') {
   res.end(shell('Threaded comments fixture', `<ol class="comment-list"><li id="comment-101" class="comment"><div class="comment-body"><p>User A</p><p>Existing comment text.</p><div class="reply"><a class="comment-reply-link" href="#respond" data-commentid="101" data-postid="7" data-belowelement="comment-101" data-respondelement="respond">Reply</a></div></div></li></ol><div id="respond-host"></div><script>
   document.querySelector('.comment-reply-link').addEventListener('click', event => {
     event.preventDefault(); fetch('/reply-activated',{method:'POST'});
     const respond=document.createElement('div');respond.id='respond';
     const form=document.createElement('form');form.id='commentform';form.method='post';form.action='/post';form.innerHTML=${JSON.stringify(fields)};
     respond.append(form);document.querySelector('#comment-101').append(respond);location.hash='respond';
   },{once:true});
   </script>`)); return;
 }
 if (url.pathname === '/article-a') {
   res.end(shell('Creator Analytics That Improve Engagement', `<meta name="description" content="A practical guide to engagement rate, follower growth, and content performance analytics."><article><p>Creators can improve engagement rate by comparing saves, thoughtful replies, and returning viewers instead of chasing raw impressions.</p><p>Weekly follower growth and content performance trends reveal which formats earn sustained attention. A useful analytics review connects those signals to a small publishing experiment for the next week.</p></article><form id="commentform" method="post" action="/post">${fields}</form>`)); return;
 }
 if (url.pathname === '/article-b') {
   res.end(shell('Building a Focused Social Media Strategy', `<meta name="description" content="How audience research and campaign measurement shape a durable content strategy."><article><p>A strong social media marketing plan starts with audience questions, channel purpose, and a clear content strategy rather than a crowded publishing calendar.</p><p>Teams should compare campaign performance against a defined goal, then reuse the stories and formats that help the intended audience take the next step.</p></article><form id="commentform" method="post" action="/post">${fields}</form>`)); return;
 }
 res.end(shell('WordPress comment fixture', `<form id="commentform" method="post" action="/post?mode=${url.pathname === '/pending' ? 'pending' : ''}">${fields}</form>`));
});
server.listen(8765, '127.0.0.1', () => console.log('Local fixtures ready at http://127.0.0.1:8765'));
