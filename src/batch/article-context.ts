export const MAX_ARTICLE_CONTEXT_CHARS = 10000;

export interface ArticleContext {
  url: string;
  title: string;
  description: string;
  h1: string;
  articleText: string;
}

const REMOVE = [
  'script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
  '[class*="cookie"]', '[id*="cookie"]', '[class*="newsletter"]', '[id*="newsletter"]',
  '[class*="sidebar"]', '[id*="sidebar"]', '[class*="share"]', '[id*="share"]',
  '[class*="social"]', '[class*="menu"]', '[id*="menu"]',
].join(',');

const clean = (value: string | null | undefined) => String(value || '').replace(/\s+/g, ' ').trim();

export function extractArticleContext(doc: Document, url: string): ArticleContext {
  const title = clean(doc.title) || clean(doc.querySelector('title')?.textContent);
  const description = clean(doc.querySelector('meta[name="description"]')?.getAttribute('content')) || clean(doc.querySelector('meta[property="og:description"]')?.getAttribute('content'));
  const h1 = clean(doc.querySelector('h1')?.textContent);
  const source = doc.querySelector('article') || doc.querySelector('main') || doc.querySelector('[role="main"]') || doc.querySelector('.entry-content,.post-content,.article-content') || doc.body;
  let articleText = '';
  if (source) {
    const root = source.cloneNode(true) as Element;
    root.querySelectorAll(REMOVE).forEach(node => node.remove());
    articleText = clean(root.textContent).slice(0, MAX_ARTICLE_CONTEXT_CHARS);
  }
  return { url, title, description, h1, articleText };
}
