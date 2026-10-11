/**
 * The fold line WorkBuddy prints for one turn, shared by the host tests and
 * the browser bundle.
 *
 * One call reads "verb + object". Several calls of one group name that group.
 * Two or more groups name the two largest around one topic. More than three
 * categories with nothing to name count the categories. A turn that is still
 * running prefixes the line with "正在".
 *
 * The browser bundle imports this file as text and evaluates it, so it stays
 * plain JavaScript: no export statements, no import statements. The names it
 * declares become the module's exports through the wrapper in index and the
 * wrapper in the client bundle.
 */

var GROUP_BARE = {
  read: '查看相关文件',
  search: '搜索相关代码',
  research: '收集资料',
  modify: '修改文件',
  command: '运行命令',
  diagnostics: '检查诊断',
  plan: '整理计划',
  collab: '协作分派',
  external: '调用外部服务',
  other: '处理多个步骤',
  skill: '调用技能',
}

var GROUP_VERB = {
  read: '查看文件',
  search: '搜索',
  research: '收集资料',
  modify: '修改文件',
  command: '运行命令',
  diagnostics: '检查诊断',
  plan: '整理计划',
  collab: '协作分派',
  external: '调用服务',
  other: '处理',
  skill: '调用技能',
}

/** Wire name to its group, single-call verb, settled verb, and object fields. */
var TOOLS = {
  read: { group: 'read', verb: '查看文件', done: '查看文件', fields: ['file_path', 'path', 'filePath', 'name', 'file'] },
  read_file: { group: 'read', verb: '查看文件', done: '查看文件', fields: ['file_path', 'path', 'filePath', 'name', 'file'] },
  Read: { group: 'read', verb: '查看文件', done: '查看文件', fields: ['file_path', 'path', 'filePath', 'name', 'file'] },
  read_image: { group: 'read', verb: '查看图片', done: '查看图片', fields: ['file_path', 'path', 'filePath'] },
  list_dir: { group: 'read', verb: '查看目录', done: '查看目录', fields: ['target_directory', 'root', 'path'] },
  list_files: { group: 'read', verb: '查看目录', done: '查看目录', fields: ['target_directory', 'root', 'path'] },
  glob: { group: 'search', verb: '搜索文件', done: '搜索文件', fields: ['pattern', 'query', 'glob'] },
  search_file: { group: 'search', verb: '搜索文件', done: '搜索文件', fields: ['pattern', 'query', 'key'] },
  Glob: { group: 'search', verb: '搜索文件', done: '搜索文件', fields: ['pattern', 'query', 'glob'] },
  grep: { group: 'search', verb: '搜索', done: '搜索', fields: ['pattern', 'query'] },
  search_content: { group: 'search', verb: '搜索', done: '搜索', fields: ['pattern', 'query'] },
  Grep: { group: 'search', verb: '搜索', done: '搜索', fields: ['pattern', 'query'] },
  web_search: { group: 'research', verb: '搜索资料', done: '搜索资料', fields: ['query', 'q'] },
  WebSearch: { group: 'research', verb: '搜索资料', done: '搜索资料', fields: ['query', 'q'] },
  web_fetch: { group: 'research', verb: '读取网页', done: '读取网页', fields: ['url'] },
  WebFetch: { group: 'research', verb: '读取网页', done: '读取网页', fields: ['url'] },
  write: { group: 'modify', verb: '写入文件', done: '写入文件', fields: ['file_path', 'path', 'filePath'] },
  write_to_file: { group: 'modify', verb: '写入文件', done: '写入文件', fields: ['file_path', 'path', 'filePath'] },
  Write: { group: 'modify', verb: '写入文件', done: '写入文件', fields: ['file_path', 'path', 'filePath'] },
  edit: { group: 'modify', verb: '修改文件', done: '修改文件', fields: ['file_path', 'path', 'filePath'] },
  replace_in_file: { group: 'modify', verb: '修改文件', done: '修改文件', fields: ['file_path', 'path', 'filePath'] },
  Edit: { group: 'modify', verb: '修改文件', done: '修改文件', fields: ['file_path', 'path', 'filePath'] },
  MultiEdit: { group: 'modify', verb: '修改文件', done: '修改文件', fields: ['file_path', 'path', 'filePath'] },
  delete_file: { group: 'modify', verb: '删除文件', done: '删除文件', fields: ['file_path', 'path', 'target_file'] },
  delete_files: { group: 'modify', verb: '删除文件', done: '删除文件', fields: ['file_path', 'path', 'target_file'] },
  bash: { group: 'command', verb: '运行命令', done: '运行命令', fields: ['command', 'cmd'] },
  pwsh: { group: 'command', verb: '运行命令', done: '运行命令', fields: ['command', 'cmd'] },
  execute_command: { group: 'command', verb: '运行命令', done: '运行命令', fields: ['command', 'cmd'] },
  Bash: { group: 'command', verb: '运行命令', done: '运行命令', fields: ['command', 'cmd'] },
  PowerShell: { group: 'command', verb: '运行命令', done: '运行命令', fields: ['command', 'cmd'] },
  read_lints: { group: 'diagnostics', verb: '检查诊断', done: '已检查', fields: ['file_path', 'path'] },
  todo_write: { group: 'plan', verb: '整理任务', done: '已整理', fields: [] },
  TodoWrite: { group: 'plan', verb: '整理任务', done: '已整理', fields: [] },
  task: { group: 'collab', verb: '调用子任务', done: '已调用', fields: ['description', 'name'] },
  Task: { group: 'collab', verb: '调用子任务', done: '已调用', fields: ['description', 'name'] },
  send_message: { group: 'collab', verb: '发送消息', done: '已发送', fields: ['recipient', 'to'] },
  mcp_call_tool: { group: 'external', verb: '调用 MCP', done: '已调用', fields: ['tool', 'name'] },
  skill: { group: 'skill', verb: '调用技能', done: '调用技能', fields: ['skill', 'name', 'command', 'path'] },
  Skill: { group: 'skill', verb: '调用技能', done: '调用技能', fields: ['skill', 'name', 'command', 'path'] },
  use_skill: { group: 'skill', verb: '调用技能', done: '调用技能', fields: ['skill', 'name', 'command', 'path'] },
  UseSkill: { group: 'skill', verb: '调用技能', done: '调用技能', fields: ['skill', 'name', 'command', 'path'] },
  SlashCommand: { group: 'skill', verb: '调用技能', done: '调用技能', fields: ['command', 'name'] },
}

function baseName(value) {
  var text = String(value)
  var slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  var base = slash >= 0 ? text.slice(slash + 1) : text
  return base || text
}

function firstString(args, keys) {
  if (!args || typeof args !== 'object') return ''
  for (var i = 0; i < keys.length; i++) {
    var value = args[keys[i]]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function parseArgs(raw) {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch (e) { return {} }
}

function classify(call) {
  var known = TOOLS[call.name]
  var group = known ? known.group : 'other'
  var verb = known ? known.verb : '执行'
  var raw = known ? firstString(call.args, known.fields) : ''
  var object = ''
  if (raw !== '') object = raw.split('\n')[0]
  return { group: group, verb: verb, object: object }
}

function topicOf(atoms) {
  for (var i = 0; i < atoms.length; i++) if (atoms[i].object) return atoms[i].object
  return ''
}

function groupLine(group, topic) {
  if (!topic) return GROUP_BARE[group]
  if (group === 'read') return '查看文件 ' + topic
  if (group === 'search') return '搜索 ' + topic
  if (group === 'research') return '收集 ' + topic + ' 资料'
  if (group === 'modify') return '修改文件 ' + topic
  if (group === 'command') return '运行命令 ' + topic
  if (group === 'diagnostics') return '检查 ' + topic
  if (group === 'plan') return '整理 ' + topic + ' 计划'
  if (group === 'collab') return '协作处理 ' + topic
  if (group === 'external') return '获取 ' + topic
  return '处理 ' + topic
}

function foldLine(calls, state) {
  var atoms = []
  for (var i = 0; i < calls.length; i++) {
    var atom = classify(calls[i])
    if (atom.group !== 'other' || atom.object) atoms.push(atom)
  }
  var running = state && state.running === true
  if (atoms.length === 0) return running ? '正在处理' : '已思考'
  var text
  if (atoms.length === 1) {
    text = atoms[0].object ? atoms[0].verb + ' ' + atoms[0].object : GROUP_BARE[atoms[0].group]
  } else {
    var order = []
    var byGroup = {}
    for (var j = 0; j < atoms.length; j++) {
      var g = atoms[j].group
      if (!byGroup[g]) { byGroup[g] = []; order.push(g) }
      byGroup[g].push(atoms[j])
    }
    order.sort(function (a, b) { return byGroup[b].length - byGroup[a].length })
    var topic = topicOf(atoms)
    if (order.length === 1) text = groupLine(order[0], topic)
    else if (topic) text = GROUP_VERB[order[0]] + '、' + GROUP_VERB[order[1]] + '：' + topic
    else if (order.length > 3) text = order.length + ' 类操作'
    else text = GROUP_BARE[order[0]]
  }
  return running ? '正在' + text : text
}
