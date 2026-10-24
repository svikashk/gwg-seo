import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GwgError } from './model.js'

export function mcpConfig() {
  return {
    mcpServers: {
      'gwg-seo': {
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./cli.js', import.meta.url)),
          'mcp',
          'serve',
        ],
      },
    },
  }
}
export async function installSkill(parent: string) {
  const root = resolve(parent)
  await mkdir(root, { recursive: true })
  const target = join(root, 'gwg-seo')
  try {
    await mkdir(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new GwgError(
        'SKILL_EXISTS',
        'The gwg-seo skill directory already exists. Review it before replacing it.',
      )
    throw error
  }
  if ((await lstat(target)).isSymbolicLink())
    throw new GwgError(
      'SKILL_PATH',
      'Skill destination must not be a symbolic link.',
    )
  await copyFile(
    fileURLToPath(new URL('../skills/gwg-seo/SKILL.md', import.meta.url)),
    join(target, 'SKILL.md'),
    constants.COPYFILE_EXCL,
  )
  return { installed: target }
}
export async function packageVersion() {
  return (
    JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
  ).version
}
