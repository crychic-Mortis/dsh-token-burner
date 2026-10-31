#!/usr/bin/env node
/**
 * dsh-token-burner —— 跨机器 / 跨账号安装脚本
 * ============================================================================
 * 作用：把本目录挂进目标机器的 DSH profile（默认 desktop）：
 *   1. 在 <profile>/node_modules 建 junction / symlink；
 *   2. 在 profile package.json 的 dependencies 写 file: 绝对路径（带备份）；
 *   3. 把包名加入 dsh.profile.bundles 数组（正式安装路径，插件市场「已安装」可见）。
 *
 *   若旧装法在 cordis.patch.yml 里留有同名 insert，会顺手清理（避免重复加载）。
 *
 * 用法：
 *   node install.mjs                          # 装到 ~/.dsh/profiles/desktop
 *   node install.mjs --profile web
 *   node install.mjs --home D:\dsh-home
 *
 * 安装后重启应用（或关闭窗口从托盘重开）让 loader 重新加载。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename, symlink, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_NAME = 'dsh-token-burner'
const ENTRY_ID = 'token-burner'

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && typeof process.argv[index + 1] === 'string') return process.argv[index + 1]
  return fallback
}

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

async function backup(file) {
  if (!existsSync(file)) return null
  const target = `${file}.bak-before-token-burner-${timestamp()}`
  await writeFile(target, await readFile(file))
  return target
}

async function main() {
  const profileName = option('profile', 'desktop')
  const dshHome = resolve(option('home', process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')))
  const pluginDir = resolve(option('plugin', dirname(fileURLToPath(import.meta.url))))
  const profileDir = join(dshHome, 'profiles', profileName)
  const profilePkg = join(profileDir, 'package.json')
  const patchFile = join(profileDir, 'cordis.patch.yml')

  if (!existsSync(profilePkg)) {
    console.error(`找不到 profile：${profileDir}`)
    console.error('请确认 DSH 已启动过该 profile，或检查 --profile / --home 参数。')
    process.exit(1)
  }
  if (!existsSync(join(pluginDir, 'index.js'))) {
    console.error(`插件目录不完整：${pluginDir}（需要 index.js）`)
    process.exit(1)
  }

  // 1) node_modules 软链
  const linkPath = join(profileDir, 'node_modules', PKG_NAME)
  await mkdir(dirname(linkPath), { recursive: true })
  if (existsSync(linkPath)) {
    const current = await realpath(linkPath).catch(() => null)
    if (current !== pluginDir) {
      console.error(`已存在 ${linkPath}，但指向 ${current ?? '未知'}，不是 ${pluginDir}。`)
      console.error('请先手动删除该链接再运行。')
      process.exit(1)
    }
    console.log(`[ok] 软链已存在：${linkPath}`)
  } else {
    await symlink(pluginDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    console.log(`[ok] 已创建软链：${linkPath} -> ${pluginDir}`)
  }

  // 2) profile package.json 依赖
  const pkgText = await readFile(profilePkg, 'utf8')
  const pkg = JSON.parse(pkgText)
  pkg.dependencies = pkg.dependencies ?? {}
  const spec = `file:${pluginDir.replaceAll('\\', '/')}`
  if (pkg.dependencies[PKG_NAME] !== spec) {
    const previous = pkg.dependencies[PKG_NAME]
    pkg.dependencies[PKG_NAME] = spec
    const saved = await backup(profilePkg)
    const tmp = `${profilePkg}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    await rename(tmp, profilePkg)
    console.log(`[ok] 已写入依赖：${PKG_NAME} = ${spec}${previous === undefined ? '' : `（原为 ${previous}）`}`)
    if (saved !== null) console.log(`     备份：${saved}`)
  } else {
    console.log('[ok] 依赖已是目标路径，跳过')
  }

  // 3) 加入 dsh.profile.bundles 数组（正式安装路径，市场「已安装」可见；幂等）
  const pkgAfter = JSON.parse(await readFile(profilePkg, 'utf8'))
  const bundles = pkgAfter.dsh?.profile?.bundles ?? []
  if (bundles.includes(PKG_NAME)) {
    console.log('[ok] dsh.profile.bundles 已包含本插件，跳过')
  } else {
    pkgAfter.dsh = pkgAfter.dsh ?? {}
    pkgAfter.dsh.profile = pkgAfter.dsh.profile ?? {}
    pkgAfter.dsh.profile.bundles = [...bundles, PKG_NAME]
    const saved = await backup(profilePkg)
    const tmp = `${profilePkg}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, `${JSON.stringify(pkgAfter, null, 2)}\n`, 'utf8')
    await rename(tmp, profilePkg)
    console.log(`[ok] 已加入 dsh.profile.bundles：${PKG_NAME}`)
    if (saved !== null) console.log(`     备份：${saved}`)
  }

  // 4) 清理旧装法（若曾在 cordis.patch.yml 里 insert 过同名 entry，去掉避免重复）
  if (existsSync(patchFile)) {
    const patchText = await readFile(patchFile, 'utf8')
    const blockRe = new RegExp(
      '\\n# ' + PKG_NAME + ' install [0-9]+\\n- insert:\\n' +
      '    - id: ' + ENTRY_ID + '\\n      name: ' + PKG_NAME + '\\n' +
      '(?:      disabled: true\\n)?' +
      '      config:\\n(?:        .*\\n)+',
      'm',
    )
    if (blockRe.test(patchText)) {
      const saved = await backup(patchFile)
      await writeFile(patchFile, patchText.replace(blockRe, '\n'), 'utf8')
      console.log('[ok] 已从 cordis.patch.yml 移除旧 insert（改用 bundles 数组）')
      if (saved !== null) console.log(`     备份：${saved}`)
    }
  }

  console.log('')
  console.log('完成。接下来：')
  console.log('  1. 重启 DSH / 关闭窗口从托盘重开，让插件重新加载；')
  console.log('  2. 在对话里让 agent 调用 token_burn 工具（例如："用 token_burn 压测，20 个请求并发 8"）。')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
