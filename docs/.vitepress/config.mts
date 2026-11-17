import { defineConfig } from 'vitepress'

// The manual is published at https://feiteira.github.io/3dica/manual/, next to the app at /3dica/.
// `npm run build:site` builds the app into dist/ first, then this manual into dist/manual/.
const REPO = 'https://github.com/feiteira/3dica'
const APP = 'https://feiteira.github.io/3dica/'

export default defineConfig({
  title: '3Dica',
  titleTemplate: ':title · 3Dica manual',
  description: 'The 3Dica manual: a browser code-CAD workbench with linked components, built on JSCAD and three.js.',
  lang: 'en-US',
  base: '/3dica/manual/',
  outDir: '../dist/manual',
  cacheDir: './.vitepress/cache',
  srcExclude: ['design/**', 'README.md'],
  cleanUrls: false,
  lastUpdated: false,
  appearance: 'dark',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/3dica/manual/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#1f2329' }],
    ['meta', { property: 'og:image', content: 'https://feiteira.github.io/3dica/manual/shots/overview.png' }],
  ],
  markdown: { lineNumbers: false },
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: '3Dica manual',
    nav: [
      { text: 'Open the app', link: APP },
      { text: 'Guide', link: '/guide/introduction', activeMatch: '^/guide/(?!ai-chat|mcp)' },
      { text: 'Tutorials', link: '/tutorials/first-part', activeMatch: '/tutorials/' },
      { text: 'Reference', link: '/reference/code-api', activeMatch: '/reference/' },
      { text: 'AI', link: '/guide/ai-chat', activeMatch: '^/guide/(ai-chat|mcp)' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Coming from OpenSCAD', link: '/guide/coming-from-openscad' },
          { text: 'AI chat', link: '/guide/ai-chat' },
          { text: 'AI assistants (MCP)', link: '/guide/mcp' },
        ],
      },
      {
        text: 'Tutorials',
        items: [
          { text: '1 · Your first part', link: '/tutorials/first-part' },
          { text: '2 · Linked copies', link: '/tutorials/linked-copies' },
          { text: '3 · Code objects and part()', link: '/tutorials/code-and-parts' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'The 3Dica model', link: '/concepts/model' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Interface', link: '/reference/interface' },
          { text: 'Working with objects', link: '/reference/objects' },
          { text: 'Transforms and the gizmo', link: '/reference/transforms' },
          { text: 'Code API', link: '/reference/code-api' },
          { text: 'Parameters', link: '/reference/parameters' },
          { text: 'Files, autosave and STL', link: '/reference/files' },
          { text: 'Keyboard shortcuts', link: '/reference/shortcuts' },
        ],
      },
      {
        text: 'Help',
        items: [
          { text: 'Troubleshooting', link: '/help/troubleshooting' },
          { text: 'FAQ and limitations', link: '/help/faq' },
        ],
      },
      {
        text: 'Developers',
        items: [
          { text: 'Architecture', link: '/dev/architecture' },
          { text: 'Contributing', link: '/dev/contributing' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: REPO }],
    editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: { message: 'Released under the MIT License.', copyright: 'Copyright © 2026 The 3Dica authors' },
  },
})
