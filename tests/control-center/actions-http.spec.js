const { test, expect } = require('@playwright/test')

const action = (id) => ({ id, label: id, kind: 'custom', frameCount: 1, frameMs: 100, frameWidth: 8, frameHeight: 8, sprite: '' })
const animations = { defaultAction: 'idle', clickAction: 'idle', actions: [action('idle'), action('http-wave')], triggerRules: [], triggerProposalInbox: [] }
const imported = { ok: true, canceled: false, animations, result: { importedAction: action('http-wave') } }
const success = (data) => ({ ok: true, data, meta: { requestId: 'actions-browser', elapsedMs: 1 } })

for (const terminal of ['succeeded', 'failed', 'canceled']) {
  test('Actions HTTP import stays busy until Job ' + terminal + ' and preserves the correct selection state', async ({ page }) => {
    let jobStatus = 'queued'
    const imports = []
    await page.goto('/')
    await page.getByRole('button', { name: 'Actions', exact: true }).click()
    await expect(page.getByLabel('Action ID')).toBeVisible()
    await page.route('**/api/v1/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname
      let data
      let status = 200
      if (pathname === '/api/v1/actions/frames/import') {
        imports.push(route.request().postDataJSON())
        status = 202
        data = { jobId: 'http-import-1' }
      } else if (pathname === '/api/v1/jobs/http-import-1') {
        data = { jobId: 'http-import-1', kind: 'actions.import-frames', status: jobStatus,
          progress: jobStatus === 'queued' ? { phase: 'queued', message: '正在导入动作…', percent: 0 } : null,
          result: jobStatus === 'succeeded' ? imported : null,
          error: jobStatus === 'failed' ? { code: 'CONFLICT', message: 'Active pack changed' } : null }
      } else if (pathname === '/api/v1/actions') data = animations
      else if (pathname === '/api/v1/actions/triggers/preview') data = { ok: true, applied: false, actionId: 'http-wave', type: 'click', binding: 'clickAction', code: 'will_apply', message: 'Preview' }
      else if (pathname === '/api/v1/jobs') data = { items: [], total: 0 }
      else if (pathname === '/api/v1/pet-packs') data = { activePackId: 'legacy-cat', packs: [] }
      else return route.abort('failed')
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(success(data)) })
    })
    await page.evaluate(async () => {
      const { demoControlCenterAPI } = await import('/src/api/demo-control-center-api.ts')
      const { configureSse } = await import('/src/hooks/useSse.ts')
      const backend = { baseUrl: location.origin + '/api/v1', sessionToken: 'actions-browser-token' }
      window.openpetBackend = { getBackend: () => backend }
      window.controlCenterAPI = {
        ...demoControlCenterAPI,
        inspectActionFrames: async ({ actionId }) => ({ canceled: false, selectionId: 'native-browser-selection', folderName: 'browser-frames', actionId,
          inspection: { valid: true, frameCount: 1, maxWidth: 8, maxHeight: 8, frames: [], errors: [], warnings: [], skippedFiles: [] } }),
      }
      window.actionsEventStreams = new Set()
      configureSse({ getBackend: () => backend, fetchImpl: async (url, init) => {
        if (!String(url).includes('/events?')) return fetch(url, init)
        return new Response(new ReadableStream({ start(controller) {
          window.actionsEventStreams.add(controller)
          init.signal.addEventListener('abort', () => { window.actionsEventStreams.delete(controller); controller.close() }, { once: true })
        } }), { headers: { 'content-type': 'text/event-stream' } })
      } })
    })
    await page.getByLabel('Action ID').fill('http-wave')
    await page.locator('header').getByRole('button', { name: '选择并检查' }).click()
    await expect(page.locator('.inspection-row').first()).toContainText('browser-frames')
    const confirm = page.getByRole('button', { name: '确认导入', exact: true })
    await confirm.click()
    await expect(confirm).toBeDisabled()
    await expect(page.locator('.status-line')).toContainText('正在导入动作')
    expect(imports).toEqual([{ selectionId: 'native-browser-selection', actionId: 'http-wave', label: '' }])
    await expect.poll(() => page.evaluate(() => window.actionsEventStreams.size)).toBeGreaterThan(0)
    jobStatus = terminal
    await page.evaluate((status) => {
      const frame = new TextEncoder().encode('id: action-terminal\nevent: job.' + status + '\ndata: {"jobId":"http-import-1"}\n\n')
      for (const stream of window.actionsEventStreams) stream.enqueue(frame)
    }, terminal)
    if (terminal === 'succeeded') {
      await expect(page.locator('.status-line')).toContainText('已导入 http-wave')
      await expect(page.locator('.inspection-row')).toHaveCount(0)
      await expect(page.locator('header').getByRole('button', { name: '选择并检查' })).toBeEnabled()
    } else {
      await expect(page.locator('.status-line')).toContainText(terminal === 'failed' ? 'Active pack changed' : '已取消导入')
      await expect(confirm).toBeEnabled()
      await expect(page.locator('.inspection-row').first()).toContainText('browser-frames')
    }
  })
}
