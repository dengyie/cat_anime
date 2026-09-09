'use strict'

function assertBrowserModules(modules) {
  const forbidden = [...modules].filter((id) => /(?:^|\/)node_modules\/(?:.*\/)?zod(?:\/|$)/.test(id.replaceAll('\\', '/')))
  if (forbidden.length) throw new Error(`Production browser graph contains zod:\n${forbidden.join('\n')}`)
}

function browserDependencyGate() {
  return {
    name: 'openpet-browser-dependency-gate',
    apply: 'build',
    generateBundle() {
      const modules = [...this.getModuleIds()]
      assertBrowserModules(modules)
      this.emitFile({ type: 'asset', fileName: 'module-graph.json', source: JSON.stringify({ zodModules: 0, modules: modules.map((id) => id.replace(process.cwd(), '.')) }, null, 2) })
    },
  }
}

module.exports = { assertBrowserModules, browserDependencyGate }
