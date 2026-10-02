/**
 * Runs the branding plan against this checkout (read-only) so an upstream change that
 * breaks a rule shows up here, not in the release build.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { loadBrand, planBranding, renameText } from '../apply-branding'

const root = join(import.meta.dir, '../..')
const brand = loadBrand(root)
const plan = planBranding(root, brand)

function text(rel: string): string {
  const content = plan.writes.get(rel)
  if (typeof content !== 'string') throw new Error(`${rel} is not a planned text write`)
  return content
}

describe('apply-branding', () => {
  it('renames the product but keeps references to Craft sites', () => {
    expect(renameText('Welcome to Craft Agents', brand)).toBe(`Welcome to ${brand.name}`)
    expect(renameText('Help Craft Agent personalize responses', brand)).toBe(`Help ${brand.agentName} personalize responses`)
    expect(renameText('DMG_NAME="Craft-Agents-${ARCH}.dmg"', brand)).toBe(`DMG_NAME="${brand.artifactPrefix}-\${ARCH}.dmg"`)
    expect(renameText('Feed them through PiEventAdapter to convert to Craft AgentEvents.', brand)).toContain('Craft AgentEvents')
    const docs = 'The Craft Agents docs live at https://thecraftagents.com/docs'
    expect(renameText(docs, brand)).toBe(docs)
  })

  it('brands the packaging config and drops the Craft update feed', () => {
    const yml = text('apps/electron/electron-builder.yml')
    expect(yml).toContain(`appId: ${brand.appId}`)
    expect(yml).toContain(`productName: ${brand.name}`)
    expect(yml).toContain(`copyright: ${brand.copyright}`)
    expect(yml).toMatch(/^publish: null$/m)
    expect(yml).toContain(`artifactName: "${brand.artifactPrefix}-\${arch}.dmg"`)
    expect(yml).not.toContain('thecraftagents.com/electron')
    expect(yml).not.toContain('craft.do')
    expect(yml).not.toContain('CFBundleIconName')
  })

  it('sets the app identity electron-builder reads from package.json', () => {
    const pkg = JSON.parse(text('apps/electron/package.json'))
    expect(pkg.author).toEqual({ name: brand.author })
    expect(pkg.homepage).toBe(brand.homepage)
  })

  it('keeps build scripts in step with the new artifact and bundle names', () => {
    expect(text('apps/electron/scripts/build-dmg.sh')).toContain(`DMG_NAME="${brand.artifactPrefix}-\${ARCH}.dmg"`)
    expect(text('apps/electron/scripts/build-linux.sh')).toContain(`APPIMAGE_NAME="${brand.artifactPrefix}-\${ARCH}.AppImage"`)
    expect(text('apps/electron/scripts/afterPack.cjs')).toContain(`'${brand.name}.app'`)
    expect(text('scripts/build/darwin.ts')).toContain(`'${brand.name}.app'`)
  })

  it('leaves no Craft Agent(s) name in shipped text except credits and links to Craft sites', () => {
    for (const [rel, content] of plan.writes) {
      if (typeof content !== 'string') continue
      for (const line of content.split('\n')) {
        if (/thecraftagents\.com|craft\.do|(Based on|fork of) Craft Agents/.test(line)) continue
        expect(`${rel}: ${line}`).not.toMatch(/Craft Agents?\b/)
      }
    }
  })

  it('swaps logos and icons and removes Craft artwork', () => {
    expect(text('apps/electron/src/renderer/components/icons/CraftAgentsSymbol.tsx')).toContain('viewBox="0 0 5 5"')
    expect(text('apps/electron/src/renderer/components/icons/CraftAgentsLogo.tsx')).toContain('viewBox="0 0 29 5"')
    expect(plan.writes.get('apps/electron/resources/icon.icns')).toEqual(readFileSync(join(root, 'branding/assets/icon.icns')))
    expect(plan.writes.get('apps/webui/src/public/favicon.ico')).toEqual(readFileSync(join(root, 'branding/assets/web/favicon.ico')))
    for (const rel of ['apps/electron/resources/Assets.car', 'apps/electron/resources/craft-logos']) {
      if (existsSync(join(root, rel))) expect(plan.deletes).toContain(rel)
    }
  })

  it('changes nothing on a second run', () => {
    const second = planBranding(root, brand, rel => {
      const planned = plan.writes.get(rel)
      if (typeof planned === 'string') return planned
      const path = join(root, rel)
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    })
    const textWrites = [...second.writes].filter(([, content]) => typeof content === 'string').map(([rel]) => rel)
    expect(textWrites).toEqual([])
  })
})
