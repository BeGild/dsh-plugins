import { highlightTree, classHighlighter } from '@lezer/highlight'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { pythonLanguage } from '@codemirror/lang-python'
import { goLanguage } from '@codemirror/lang-go'
import { rustLanguage } from '@codemirror/lang-rust'
import { javaLanguage } from '@codemirror/lang-java'
import { jsonLanguage } from '@codemirror/lang-json'
import { yamlLanguage } from '@codemirror/lang-yaml'
import { cssLanguage } from '@codemirror/lang-css'
import { htmlLanguage } from '@codemirror/lang-html'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { xmlLanguage } from '@codemirror/lang-xml'

const PARSERS = {
  js: javascriptLanguage.parser,
  py: pythonLanguage.parser,
  go: goLanguage.parser,
  rust: rustLanguage.parser,
  java: javaLanguage.parser,
  json: jsonLanguage.parser,
  yaml: yamlLanguage.parser,
  css: cssLanguage.parser,
  html: htmlLanguage.parser,
  md: markdownLanguage.parser,
  xml: xmlLanguage.parser,
}

const EXT = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js',
  py: 'py', go: 'go', rs: 'rust', java: 'java', json: 'json',
  yml: 'yaml', yaml: 'yaml', css: 'css', html: 'html', md: 'md',
  xml: 'xml', svg: 'xml',
}

export function highlightCode(lang, code) {
  const parser = PARSERS[lang]
  if (!parser) return null
  const tree = parser.parse(code)
  const spans = []
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    spans.push([from, to, classes])
  })
  return spans
}

export function langForFile(file) {
  const name = String(file || '')
  const dot = name.lastIndexOf('.')
  if (dot < 0) return ''
  return EXT[name.slice(dot + 1).toLowerCase()] || ''
}
