const { defineConfig } = require('vite')
const react = require('@vitejs/plugin-react')
const path = require('path')
const { browserDependencyGate } = require('../../scripts/browser-dependency-gate.cjs')

module.exports = defineConfig({
  root: __dirname,
  plugins: [react(), browserDependencyGate()],
  base: './',
  build: {
    outDir: path.resolve(__dirname, '../../dist/control-center'),
    emptyOutDir: true
  }
})
